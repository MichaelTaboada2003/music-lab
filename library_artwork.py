"""Resolución y caché de carátulas para canciones locales.

La biblioteca sigue siendo local: primero usamos el arte incrustado en el
archivo y solo consultamos iTunes cuando no hay portada. Los aciertos y los
fallos se recuerdan para no repetir procesos ni peticiones al navegar.
"""

import hashlib
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from app.config import COVERS_DIR
from library_metadata import get_metadata

_CACHE_PATH = COVERS_DIR / "index.json"
_LOCK = threading.Lock()
_USER_AGENT = "Music-Lab/1.0 (local artwork resolver)"


def _cache_key(song: Path) -> str:
    return hashlib.sha1(song.stem.encode("utf-8")).hexdigest()


def _cover_path(song: Path) -> Path:
    return COVERS_DIR / f"{_cache_key(song)}.jpg"


def _read_cache() -> dict:
    try:
        data = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_cache(data: dict) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=".cover-index.", dir=COVERS_DIR, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_name, _CACHE_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def _extract_embedded(song: Path, output: Path) -> bool:
    """Extrae únicamente la primera pista visual, sin recodificar el audio."""
    command = [
        "ffmpeg", "-y", "-v", "error", "-i", str(song), "-an",
        "-map", "0:v:0", "-frames:v", "1", "-vf", "scale='min(960,iw)':-2",
        "-q:v", "3", str(output),
    ]
    try:
        result = subprocess.run(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=12, check=False,
        )
        return result.returncode == 0 and output.is_file() and output.stat().st_size > 1024
    except (OSError, subprocess.TimeoutExpired):
        return False


def _download_catalog_artwork(song: Path, output: Path) -> bool:
    """Busca una portada como respaldo; un error de red no afecta la biblioteca."""
    metadata = get_metadata(song)
    query = " ".join(filter(None, [metadata.get("artist"), metadata.get("title")]))
    if not query:
        return False
    try:
        search_url = "https://itunes.apple.com/search?" + urlencode({
            "term": query, "entity": "song", "limit": 1,
        })
        request = Request(search_url, headers={"User-Agent": _USER_AGENT})
        with urlopen(request, timeout=4) as response:
            results = json.loads(response.read().decode("utf-8")).get("results", [])
        artwork_url = (results[0].get("artworkUrl100") if results else "") or ""
        if not artwork_url:
            return False
        artwork_url = artwork_url.replace("100x100bb", "600x600bb")
        request = Request(artwork_url, headers={"User-Agent": _USER_AGENT})
        with urlopen(request, timeout=6) as response:
            data = response.read(3_000_000)
        if len(data) < 1024 or not data.startswith(b"\xff\xd8"):
            return False
        output.write_bytes(data)
        return True
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return False


def resolve_cover(song: Path) -> Path | None:
    """Devuelve una carátula local o ``None`` si corresponde usar el fallback UI."""
    fingerprint = song.stat().st_mtime_ns
    output = _cover_path(song)
    with _LOCK:
        cache = _read_cache()
        entry = cache.get(song.stem, {})
        if entry.get("fingerprint") == fingerprint:
            if entry.get("status") == "ready" and output.is_file():
                return output
            if entry.get("status") == "missing":
                return None

        output.unlink(missing_ok=True)
        temp_output = output.with_suffix(".tmp.jpg")
        temp_output.unlink(missing_ok=True)
        source = "embedded" if _extract_embedded(song, temp_output) else "catalog"
        if source == "catalog" and not _download_catalog_artwork(song, temp_output):
            temp_output.unlink(missing_ok=True)
            cache[song.stem] = {"fingerprint": fingerprint, "status": "missing"}
            _write_cache(cache)
            return None

        os.replace(temp_output, output)
        cache[song.stem] = {"fingerprint": fingerprint, "status": "ready", "source": source}
        _write_cache(cache)
        return output


def invalidate_cover(song: Path) -> None:
    """Obliga a reevaluar la búsqueda si se corrigen título o artista."""
    with _LOCK:
        cache = _read_cache()
        cache.pop(song.stem, None)
        _write_cache(cache)
        _cover_path(song).unlink(missing_ok=True)
