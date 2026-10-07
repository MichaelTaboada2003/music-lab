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
# Los recortes creados antes de que existiera la marca solo se reconocen por el
# sufijo con el que los bautiza audio_trim.
_CLIP_SUFFIX_RE = re.compile(r"\(recorte\)(\s*\(\d+\))?$", re.IGNORECASE)
_NOISE_PATTERNS = [
    # Variantes en paréntesis o corchetes: inglés y español
    r"\s*[\(\[](?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|lyric\s*video|video\s*letra|video\s*con\s*letra|visualizer)[\)\]]",
    r"\s*[\(\[](?:video|audio|letra|video\s*letra|video\s*con\s*letra)\s*oficial[\)\]]",
    r"\s*[\(\[](?:en\s*vivo|en\s*directo|live(?:\s*session)?|remaster(?:ed|izado)?)[\)\]]",
    r"\s*[\(\[](?:lyrics?|letra|audio|video)[\)\]]",
    # Sufijo de álbum o canal separado por pleca | o ｜
    r"\s*[\|｜].*$",
]
_NOISE_RE = re.compile("|".join(_NOISE_PATTERNS), re.IGNORECASE)
_TRAILING_LYRICS_RE = re.compile(r"\s+lyrics?$", re.IGNORECASE)


def _clean(value: str) -> str:
    if not value:
        return ""
    value = _NOISE_RE.sub("", value)
    value = _TRAILING_LYRICS_RE.sub("", value)
    return re.sub(r"\s+", " ", value).strip(" -_.,")


def split_artists(artist_str: str) -> list[str]:
    """Separa una cadena de artistas con colaboradores ('x', 'feat', 'ft', '&', ',')."""
    if not artist_str:
        return []
    s = re.sub(r"[\(\[]\s*(?:feat\.?|ft\.?|featuring|con)\s+([^\]\)]+)[\)\]]", r", \1", artist_str, flags=re.IGNORECASE)
    normalized = re.sub(r"\s+(?:feat\.?|ft\.?|featuring|con|x|&)\s+", ",", s, flags=re.IGNORECASE)
    parts = [_clean(p) for p in normalized.split(",")]
    return [p for p in parts if p]


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
    # Si ambos lados van en mayúsculas ("BAD BUNNY - LA DROGA") no hay pista de
    # orden: se asume el estándar "Artista - Título".
    if left.isupper() and not right.isupper():
        return left, right
    return right, left


def clip_info(song: Path) -> tuple[bool, str]:
    """Indica si la canción es un recorte y de cuál proviene, sin lanzar ffprobe.

    Es el dato que necesita cada petición de portada; leer los tags embebidos
    con ffprobe en cada una añadía decenas de milisegundos."""
    with _LOCK:
        manual = _read_overrides().get(song.stem, {})
    es_recorte = manual.get("kind") == "clip" or bool(_CLIP_SUFFIX_RE.search(song.stem.strip()))
    return es_recorte, (manual.get("clip_of", "") if es_recorte else "")


def display_info(stem: str) -> dict:
    """Título y artista para mostrar, sin ffprobe: edición local o nombre de archivo."""
    with _LOCK:
        manual = _read_overrides().get(stem, {})
    title, artist = _infer_from_filename(stem)
    return {
        "title": _clean(manual.get("title", "")) or title or stem,
        "artist": _clean(manual.get("artist", "")) or artist,
    }


def get_metadata(song: Path) -> dict:
    """Resuelve ficha en orden: edición local, tags, nombre de archivo."""
    with _LOCK:
        manual = _read_overrides().get(song.stem, {})
    tag_title, tag_artist = _embedded_tags(song)
    inferred_title, inferred_artist = _infer_from_filename(song.stem)
    title = _clean(manual.get("title", "")) or tag_title or inferred_title or song.stem
    artist = _clean(manual.get("artist", "")) or tag_artist or inferred_artist
    source = "manual" if manual else "tags" if tag_title or tag_artist else "filename"
    es_recorte = manual.get("kind") == "clip" or bool(_CLIP_SUFFIX_RE.search(song.stem.strip()))
    return {
        "title": title,
        "artist": artist,
        "metadata_source": source,
        "kind": "clip" if es_recorte else "song",
        "clip_of": manual.get("clip_of", "") if es_recorte else "",
    }


def save_metadata(stem: str, title: str, artist: str) -> dict:
    title, artist = _clean(title), _clean(artist)
    if not title:
        raise ValueError("El título no puede estar vacío.")
    with _LOCK:
        data = _read_overrides()
        # Conserva las marcas que no edita el usuario (kind, clip_of).
        data[stem] = {**data.get(stem, {}), "title": title, "artist": artist}
        _write_overrides(data)
    return {"title": title, "artist": artist, "metadata_source": "manual"}


def pop_override(stem: str) -> dict | None:
    """Quita (y devuelve) la ficha editada de una canción, para poder restaurarla."""
    with _LOCK:
        data = _read_overrides()
        entry = data.pop(stem, None)
        if entry is not None:
            _write_overrides(data)
        return entry


def set_override(stem: str, entry: dict) -> None:
    """Restaura una ficha editada previamente retirada con pop_override."""
    with _LOCK:
        data = _read_overrides()
        data[stem] = entry
        _write_overrides(data)


def mark_as_clip(stem: str, source_stem: str = "") -> None:
    """Marca un stem como recorte de `source_stem` para poder filtrarlos en la
    interfaz sin depender de cómo se llame el archivo."""
    with _LOCK:
        data = _read_overrides()
        data[stem] = {**data.get(stem, {}), "kind": "clip", "clip_of": source_stem}
        _write_overrides(data)
