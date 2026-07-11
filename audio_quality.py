"""Medición local de loudness para un Soundcheck no destructivo."""

import json
import math
import os
import re
import subprocess
import tempfile
import threading
from pathlib import Path

TARGET_LUFS = -14.0
TRUE_PEAK_CEILING_DB = -1.5
MAX_GAIN_DB = 12.0
CACHE_VERSION = 1
CACHE_PATH = Path(__file__).resolve().parent / ".audio_quality.json"
_CACHE_LOCK = threading.Lock()


def _signature(audio_path: Path) -> dict:
    path = audio_path.resolve()
    stat = path.stat()
    return {"path": str(path), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def _read_cache() -> dict:
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {"version": CACHE_VERSION, "tracks": {}}
    except (OSError, json.JSONDecodeError):
        return {"version": CACHE_VERSION, "tracks": {}}


def _write_cache(data: dict) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=".audio-quality.", dir=CACHE_PATH.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_name, CACHE_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def get_cached_quality(audio_path: Path) -> dict | None:
    """Devuelve la medición solo si pertenece al archivo actual."""
    try:
        signature = _signature(audio_path)
    except OSError:
        return None
    with _CACHE_LOCK:
        cache = _read_cache()
        if cache.get("version") != CACHE_VERSION:
            return None
        entry = cache.get("tracks", {}).get(signature["path"])
    if not entry or entry.get("signature") != signature:
        return None
    return entry.get("analysis")


def _parse_loudnorm_output(output: str) -> dict:
    matches = re.findall(r"\{\s*\"input_i\".*?\n\}", output, flags=re.DOTALL)
    if not matches:
        raise RuntimeError("ffmpeg no devolvió una medición de loudness válida.")
    try:
        payload = json.loads(matches[-1])
        return {key: float(payload[key]) for key in ("input_i", "input_tp", "input_lra")}
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("No se pudo interpretar la medición de loudness.") from exc


def analyze_audio(audio_path: Path, progress_cb=None) -> dict:
    """Mide EBU R128 y guarda una ganancia segura, sin modificar el audio."""
    audio_path = Path(audio_path)
    if progress_cb:
        progress_cb("Midiendo volumen (EBU R128)", None)

    command = [
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(audio_path),
        "-af", f"loudnorm=I={TARGET_LUFS}:TP={TRUE_PEAK_CEILING_DB}:LRA=11:print_format=json",
        "-f", "null", "-",
    ]
    try:
        result = subprocess.run(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, check=False, timeout=900,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ffmpeg no está instalado; no se puede medir el volumen.") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("La medición de volumen tardó demasiado.") from exc

    if result.returncode != 0:
        raise RuntimeError("ffmpeg no pudo analizar esta canción.")

    measured = _parse_loudnorm_output(result.stderr)
    if not all(math.isfinite(value) for value in measured.values()):
        raise RuntimeError("La canción no tiene una medición de volumen utilizable.")

    requested_gain = TARGET_LUFS - measured["input_i"]
    safe_gain = min(requested_gain, TRUE_PEAK_CEILING_DB - measured["input_tp"])
    gain_db = max(-MAX_GAIN_DB, min(MAX_GAIN_DB, safe_gain))
    analysis = {
        "integrated_lufs": round(measured["input_i"], 2),
        "true_peak_db": round(measured["input_tp"], 2),
        "loudness_range": round(measured["input_lra"], 2),
        "target_lufs": TARGET_LUFS,
        "gain_db": round(gain_db, 2),
    }

    signature = _signature(audio_path)
    with _CACHE_LOCK:
        cache = _read_cache()
        cache["version"] = CACHE_VERSION
        tracks = cache.setdefault("tracks", {})
        tracks[signature["path"]] = {"signature": signature, "analysis": analysis}
        _write_cache(cache)

    if progress_cb:
        progress_cb("Soundcheck listo", 100)
    return analysis
