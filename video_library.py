"""Biblioteca de videos generados: metadatos, portadas y acciones sobre archivos.

El nombre de cada mp4 lo arma la API de video como ``{canción} - {formato}[ - opciones]``;
aquí se invierte ese convenio para mostrar cada video con su título, formato y
etiquetas de estilo, y se cachean las sondas de ffprobe y las portadas.
"""

import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from library_metadata import display_info

_ROOT = Path(__file__).resolve().parent
_INDEX_PATH = _ROOT / ".video_index.json"
POSTERS_DIR = _ROOT / ".video_posters"
POSTERS_DIR.mkdir(parents=True, exist_ok=True)
_LOCK = threading.Lock()
_POSTER_LOCKS: dict = {}

_KIND_TOKENS = {"reproductor": "player", "karaoke": "terminal", "escritura": "typing", "color": "color"}
_FLOW_TOKEN = "linea"
_THEME_TOKENS = {"midnight": "Medianoche", "sunset": "Atardecer", "cloud": "Nube"}
_FONT_RE = re.compile(r"^(mono|modern|editorial)-(compact|balanced|large)$")
_FONT_LABELS = {"modern": "Moderna", "editorial": "Editorial", "mono": "Monoespaciada"}
_SIZE_LABELS = {"compact": "compacta", "balanced": "equilibrada", "large": "grande"}
_CLIP_RE = re.compile(r"\s*\(recorte\)(\s*\(\d+\))?", re.IGNORECASE)

KIND_LABELS = {"player": "Reproductor", "terminal": "Terminal", "color": "Color", "other": "Video"}


def parse_video_name(stem: str) -> dict:
    """Separa el título de la canción de las opciones codificadas en el nombre."""
    parts = stem.split(" - ")
    tokens = []
    while len(parts) > 1 and (
        parts[-1] in _KIND_TOKENS or parts[-1] == _FLOW_TOKEN
        or parts[-1] in _THEME_TOKENS or _FONT_RE.match(parts[-1])
    ):
        tokens.append(parts.pop())
    tokens.reverse()
    title = " - ".join(parts)

    kind_token = next((t for t in tokens if t in _KIND_TOKENS), None)
    typing = "escritura" in tokens
    if kind_token == "color":
        kind = "color"
    elif kind_token == "reproductor":
        kind = "player"
    elif kind_token in ("karaoke", "escritura"):
        kind = "terminal"
    else:
        kind = None
    tags = []
    if _FLOW_TOKEN in tokens:
        tags.append("Una línea")
    if typing:
        tags.append("Escritura")
    elif kind == "terminal":
        tags.append("Karaoke")
    for token in tokens:
        if token in _THEME_TOKENS:
            tags.append(_THEME_TOKENS[token])
        match = _FONT_RE.match(token)
        if match:
            tags.append(f"{_FONT_LABELS[match.group(1)]} {_SIZE_LABELS[match.group(2)]}")
    return {"title": title, "kind": kind, "tags": tags}


# ------------------------------------------------------------------ ffprobe --

def _read_index() -> dict:
    try:
        data = json.loads(_INDEX_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_index(data: dict) -> None:
    fd, temp = tempfile.mkstemp(prefix=".video-index.", dir=_ROOT, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False)
        os.replace(temp, _INDEX_PATH)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _probe(path: Path) -> dict:
    command = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration", "-of", "json", str(path),
    ]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=15, check=False)
        data = json.loads(result.stdout)
        stream = (data.get("streams") or [{}])[0]
        return {
            "width": int(stream.get("width") or 0),
            "height": int(stream.get("height") or 0),
            "duration": round(float(data.get("format", {}).get("duration") or 0.0), 2),
        }
    except (OSError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return {"width": 0, "height": 0, "duration": 0.0}


def describe_all(directory: Path) -> list[dict]:
    """Ficha de cada mp4 de la carpeta, del más reciente al más antiguo."""
    files = [p for p in directory.iterdir() if p.is_file() and p.suffix.lower() == ".mp4"]
    with _LOCK:
        index = _read_index()
        fresh, items, changed = {}, [], False
        for path in files:
            stat = path.stat()
            entry = index.get(path.name)
            if not entry or entry.get("size") != stat.st_size or entry.get("mtime_ns") != stat.st_mtime_ns:
                entry = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, **_probe(path)}
                changed = True
            fresh[path.name] = entry
            items.append(_item(path, stat, entry))
        if changed or set(index) != set(fresh):
            _write_index(fresh)
    items.sort(key=lambda item: item["mtime"], reverse=True)
    return items


def describe(path: Path) -> dict:
    stat = path.stat()
    with _LOCK:
        index = _read_index()
        entry = index.get(path.name)
        if not entry or entry.get("size") != stat.st_size or entry.get("mtime_ns") != stat.st_mtime_ns:
            entry = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, **_probe(path)}
            index[path.name] = entry
            _write_index(index)
    return _item(path, stat, entry)


def _item(path: Path, stat, entry: dict) -> dict:
    parsed = parse_video_name(path.stem)
    raw_title = parsed["title"]
    is_clip = bool(_CLIP_RE.search(raw_title))
    info = display_info(_CLIP_RE.sub("", raw_title).strip()) if raw_title else {"title": path.stem, "artist": ""}
    width, height = entry.get("width", 0), entry.get("height", 0)
    landscape = width > height > 0
    kind = parsed["kind"] or ("player" if landscape else "other")
    tags = list(parsed["tags"])
    if is_clip:
        tags.insert(0, "Recorte")
    return {
        "name": path.name,
        "title": info["title"] or path.stem,
        "artist": info["artist"],
        "kind": kind,
        "kind_label": KIND_LABELS[kind],
        "tags": tags,
        "is_clip": is_clip,
        "size": entry["size"],
        "mtime": stat.st_mtime,
        "duration": entry.get("duration", 0.0),
        "width": width,
        "height": height,
        "orientation": "landscape" if landscape else "portrait",
    }


# ------------------------------------------------------------------ portadas --

def _poster_path(path: Path) -> Path:
    stat = path.stat()
    digest = hashlib.sha1(path.name.encode("utf-8")).hexdigest()[:16]
    return POSTERS_DIR / f"{digest}-{stat.st_mtime_ns}.jpg"


_POSTER_CANDIDATES = (0.30, 0.42, 0.54, 0.66)


def _motion_score(path: Path, moment: float):
    """Diferencia media entre dos miniaturas separadas 0.2 s; None si falla."""
    command = [
        "ffmpeg", "-v", "error", "-ss", f"{moment:.2f}", "-i", str(path),
        "-vf", "fps=5,scale=96:-2,format=gray", "-frames:v", "2", "-f", "rawvideo", "-",
    ]
    try:
        raw = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             timeout=20, check=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    half = len(raw) // 2
    if half == 0 or len(raw) != half * 2:
        return None
    first, second = np.frombuffer(raw[:half], np.uint8), np.frombuffer(raw[half:], np.uint8)
    return float(np.abs(first.astype(np.int16) - second.astype(np.int16)).mean())


def _stable_moment(path: Path, duration: float) -> float:
    """Instante con menos movimiento entre candidatos, para no caer en plena
    transición de versos (texto superpuesto) al elegir la portada."""
    if duration <= 1.0:
        return 0.0
    moments = [duration * fraction for fraction in _POSTER_CANDIDATES]
    with ThreadPoolExecutor(max_workers=len(moments)) as pool:
        scores = list(pool.map(lambda m: _motion_score(path, m), moments))
    scored = [(score, moment) for score, moment in zip(scores, moments) if score is not None]
    return min(scored)[1] if scored else duration * 0.33


def poster_for(path: Path) -> Path | None:
    """Un frame representativo del video, generado una sola vez."""
    target = _poster_path(path)
    if target.is_file():
        return target
    lock = _POSTER_LOCKS.setdefault(path.name, threading.Lock())
    with lock:
        if target.is_file():
            return target
        seek = _stable_moment(path, describe(path)["duration"] or 0.0)
        temp = target.with_suffix(".tmp.jpg")
        command = [
            "ffmpeg", "-y", "-v", "error", "-ss", f"{seek:.2f}", "-i", str(path),
            "-frames:v", "1", "-vf", "scale=-2:640", "-q:v", "4", str(temp),
        ]
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return None
        if result.returncode != 0 or not temp.is_file():
            temp.unlink(missing_ok=True)
            return None
        for stale in POSTERS_DIR.glob(f"{target.name.split('-')[0]}-*.jpg"):
            if stale != temp:
                stale.unlink(missing_ok=True)
        os.replace(temp, target)
        return target


def forget(path: Path) -> None:
    """Borra la portada y la ficha cacheadas de un video eliminado o renombrado."""
    digest = hashlib.sha1(path.name.encode("utf-8")).hexdigest()[:16]
    for poster in POSTERS_DIR.glob(f"{digest}-*.jpg"):
        poster.unlink(missing_ok=True)
    with _LOCK:
        index = _read_index()
        if index.pop(path.name, None) is not None:
            _write_index(index)
