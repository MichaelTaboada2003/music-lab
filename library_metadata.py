"""Metadatos de biblioteca locales sin modificar los archivos de audio."""

import json
import os
import re
import subprocess
import tempfile
import threading
from pathlib import Path

_METADATA_PATH = Path(__file__).resolve().parent / ".library_metadata.json"
_LOCK = threading.Lock()
_NOISE_RE = re.compile(r"\s*(?:\[?(?:official\s*)?(?:audio|video|lyrics?|video\s*letra)\]?|\(\s*(?:official\s*)?(?:audio|video|lyrics?)\s*\))\s*$", re.IGNORECASE)


def _clean(value: str) -> str:
    value = _NOISE_RE.sub("", value or "")
    return re.sub(r"\s+", " ", value).strip(" -_.,")


def _read_overrides() -> dict:
    try:
        data = json.loads(_METADATA_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_overrides(data: dict) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=".library-metadata.", dir=_METADATA_PATH.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_name, _METADATA_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def _embedded_tags(song: Path) -> tuple[str, str]:
    command = [
        "ffprobe", "-v", "error", "-show_entries", "format_tags=title,artist",
        "-of", "json", str(song),
    ]
    try:
        result = subprocess.run(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=8, check=False,
        )
        tags = json.loads(result.stdout).get("format", {}).get("tags", {})
        return _clean(tags.get("title", "")), _clean(tags.get("artist", ""))
    except (OSError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired):
        return "", ""


def _infer_from_filename(stem: str) -> tuple[str, str]:
    if re.search(r"\s{2,}", stem):
        artist, title = re.split(r"\s{2,}", stem, maxsplit=1)
        return _clean(title), _clean(artist)
    name = _clean(stem)

    if " - " not in name:
        return name, ""

    raw_left, raw_right = name.split(" - ", 1)
    # Formato frecuente: "Título, Artista, Video Letra - canal".
    pieces = [_clean(piece) for piece in raw_left.split(",")]
    if len(pieces) >= 3 and "video letra" in raw_left.lower():
        return pieces[0], pieces[1]
    left, right = _clean(raw_left), _clean(raw_right)
    # En archivos de lyric-video el título puede venir antes y en mayúsculas.
    if left.isupper():
        return left, right
    return right, left


def get_metadata(song: Path) -> dict:
    """Resuelve ficha en orden: edición local, tags, nombre de archivo."""
    with _LOCK:
        manual = _read_overrides().get(song.stem, {})
    tag_title, tag_artist = _embedded_tags(song)
    inferred_title, inferred_artist = _infer_from_filename(song.stem)
    title = _clean(manual.get("title", "")) or tag_title or inferred_title or song.stem
    artist = _clean(manual.get("artist", "")) or tag_artist or inferred_artist
    source = "manual" if manual else "tags" if tag_title or tag_artist else "filename"
    return {"title": title, "artist": artist, "metadata_source": source}


def save_metadata(stem: str, title: str, artist: str) -> dict:
    title, artist = _clean(title), _clean(artist)
    if not title:
        raise ValueError("El título no puede estar vacío.")
    with _LOCK:
        data = _read_overrides()
        data[stem] = {"title": title, "artist": artist}
        _write_overrides(data)
    return {"title": title, "artist": artist, "metadata_source": "manual"}
