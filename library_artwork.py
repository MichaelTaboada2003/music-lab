"""Resolución y caché de carátulas para canciones locales.

La biblioteca sigue siendo local: primero usamos el arte incrustado en el
archivo y solo consultamos catálogos (Deezer / iTunes) cuando no hay portada.
Los aciertos y los fallos se recuerdan para no repetir procesos ni peticiones al navegar.
Se valida la relevancia del título para evitar asociar portadas de canciones erróneas.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unicodedata
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

_BASE_DIR = Path(__file__).resolve().parent
CANCIONES_DIR = _BASE_DIR / "canciones"
COVERS_DIR = _BASE_DIR / ".covers"
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".webm", ".ogg"}
COVERS_DIR.mkdir(parents=True, exist_ok=True)

from library_metadata import clip_info, get_metadata, split_artists

_CACHE_PATH = COVERS_DIR / "index.json"
# Subir al cambiar el criterio de búsqueda: reevalúa portadas de catálogo y fallos previos.
_CATALOG_VERSION = 2
_LOCK = threading.Lock()
_USER_AGENT = "Music-Lab/1.0 (local artwork resolver; +https://github.com)"
# Recortes anteriores a la marca kind/clip_of: el origen se deduce del nombre.
_CLIP_SUFFIX_RE = re.compile(r"\s*\(recorte\)(\s*\(\d+\))?$", re.IGNORECASE)

_STOPWORDS = {
    "de", "la", "el", "los", "las", "un", "una", "unos", "unas", "en", "y", "del", "al",
    "the", "a", "an", "and", "in", "on", "of", "to", "for", "with", "by", "from",
}


_FEAT_RE = re.compile(r"[\(\[]\s*(?:feat\.?|ft\.?|featuring|con|with)\s+[^\)\]]*[\)\]]", re.IGNORECASE)


def _normalize_tokens(text: str) -> set[str]:
    """Extrae palabras normalizadas sin tildes ni caracteres especiales."""
    text = _FEAT_RE.sub(" ", text or "")
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return set(text.split())


def _match_score(target_title: str, target_artist: str, cand_title: str, cand_artist: str) -> float:
    """Calcula similitud de relevancia entre la canción buscada y el candidato del catálogo.
    Si no hay coincidencia en las palabras clave del título, devuelve 0.0 para evitar
    asignar portadas completamente ajenas (ej. álbum OASIS para Volando Remix).
    """
    t_words = _normalize_tokens(target_title)
    c_words = _normalize_tokens(cand_title)
    if not t_words:
        return 0.0

    meaningful_t = {w for w in t_words if len(w) > 1 and w not in _STOPWORDS}
    if not meaningful_t:
        meaningful_t = t_words

    intersection = meaningful_t.intersection(c_words)
    if not intersection:
        return 0.0
    # Penaliza palabras extra del candidato ("La Droga (Adicto A Ti)" no es "La Droga").
    c_meaningful = {w for w in c_words if len(w) > 1 and w not in _STOPWORDS} or c_words
    title_score = len(intersection) / max(len(meaningful_t), len(c_meaningful))

    a_words = _normalize_tokens(target_artist)
    c_a_words = _normalize_tokens(cand_artist)
    meaningful_a = {w for w in a_words if len(w) > 1 and w not in _STOPWORDS}
    artist_overlap = bool(meaningful_a.intersection(c_a_words)) if meaningful_a else True

    score = title_score * 0.7 + (0.3 if artist_overlap else 0.0)
    if meaningful_a and not artist_overlap:
        # Mismo título de otro artista: nunca debe superar el umbral automático.
        score = min(score, 0.4)
    return round(score, 3)


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


def _download_image(url: str, output: Path) -> bool:
    """Descarga una imagen validando su contenido."""
    if not url:
        return False
    try:
        request = Request(url, headers={"User-Agent": _USER_AGENT})
        with urlopen(request, timeout=6) as response:
            data = response.read(6_000_000)
        # Validar tamaño mínimo y encabezado JPEG (\xff\xd8) o PNG (\x89PNG)
        if len(data) < 1024:
            return False
        if not (data.startswith(b"\xff\xd8") or data.startswith(b"\x89PNG")):
            return False
        output.write_bytes(data)
        return True
    except (OSError, ValueError, UnicodeDecodeError):
        return False


def search_catalog_covers(title: str, artist: str = "", limit: int = 8) -> list[dict]:
    """Busca carátulas candidatas en Deezer e iTunes con evaluación de relevancia."""
    title = (title or "").strip()
    artist = (artist or "").strip()
    if not title:
        return []

    candidates: list[dict] = []
    seen_urls: set[str] = set()

    artists_list = split_artists(artist)
    primary_artist = artists_list[0] if artists_list else ""

    queries = []
    if primary_artist:
        queries.append(f"{title} {primary_artist}")
    if artist and artist != primary_artist:
        queries.append(f"{title} {artist}")
    queries.append(title)

    headers = {"User-Agent": _USER_AGENT}

    # 1. Deezer (Excelente cobertura de música urbana/latina, carátulas 1000x1000 sin compresión)
    for q in queries[:2]:
        try:
            url = f"https://api.deezer.com/search?q={quote(q)}"
            req = Request(url, headers=headers)
            with urlopen(req, timeout=4) as resp:
                data = json.loads(resp.read().decode("utf-8")).get("data", [])
            for item in data[:6]:
                album = item.get("album") or {}
                cover_url = album.get("cover_xl") or album.get("cover_big")
                if not cover_url or cover_url in seen_urls:
                    continue
                c_title = item.get("title", "")
                c_artist = (item.get("artist") or {}).get("name", "")
                c_album = album.get("title", "")
                score = _match_score(title, artist, c_title, c_artist)
                if score >= 0.35:
                    seen_urls.add(cover_url)
                    candidates.append({
                        "title": c_title,
                        "artist": c_artist,
                        "album": c_album,
                        "cover_url": cover_url,
                        "preview_url": album.get("cover_medium") or cover_url,
                        "source": "deezer",
                        "score": score,
                        "rank": item.get("rank", 0) or 0,
                    })
        except Exception:
            pass

    # 2. iTunes (Respaldo secundario)
    for q in queries[:2]:
        try:
            url = "https://itunes.apple.com/search?" + urlencode({
                "term": q, "entity": "song", "limit": 5,
            })
            req = Request(url, headers=headers)
            with urlopen(req, timeout=4) as resp:
                results = json.loads(resp.read().decode("utf-8")).get("results", [])
            for item in results:
                raw_cover = item.get("artworkUrl100", "")
                if not raw_cover:
                    continue
                cover_url = raw_cover.replace("100x100bb", "600x600bb")
                if cover_url in seen_urls:
                    continue
                c_title = item.get("trackName", "")
                c_artist = item.get("artistName", "")
                c_album = item.get("collectionName", "")
                score = _match_score(title, artist, c_title, c_artist)
                if score >= 0.35:
                    seen_urls.add(cover_url)
                    candidates.append({
                        "title": c_title,
                        "artist": c_artist,
                        "album": c_album,
                        "cover_url": cover_url,
                        "preview_url": raw_cover,
                        "source": "itunes",
                        "score": score,
                        "rank": 0,
                    })
        except Exception:
            pass

    candidates.sort(key=lambda x: (x["score"], x["rank"]), reverse=True)
    return candidates[:limit]


def _download_catalog_artwork(song: Path, output: Path) -> bool:
    """Busca una portada en catálogos y la descarga solo si supera el umbral de relevancia."""
    metadata = get_metadata(song)
    title = metadata.get("title") or ""
    artist = metadata.get("artist") or ""
    if not title:
        return False

    candidates = search_catalog_covers(title, artist, limit=6)
    for candidate in candidates:
        if candidate.get("score", 0.0) >= 0.45:
            cover_url = candidate.get("cover_url")
            if cover_url and _download_image(cover_url, output):
                return True
    return False


def _song_by_stem(stem: str) -> Path | None:
    if not stem:
        return None
    for extension in AUDIO_EXTS:
        candidate = CANCIONES_DIR / f"{stem}{extension}"
        if candidate.is_file():
            return candidate
    return None


def _origin_of_clip(song: Path) -> Path | None:
    """Canción de la que salió un recorte, si sigue en la biblioteca."""
    es_recorte, clip_of = clip_info(song)
    if not es_recorte:
        return None
    origen = _song_by_stem(clip_of)
    if origen is None:
        # Respaldo para recortes creados antes de que existiera la marca.
        origen = _song_by_stem(_CLIP_SUFFIX_RE.sub("", song.stem).strip())
    return origen if origen and origen != song else None


def resolve_cover(song: Path) -> Path | None:
    """Devuelve una carátula local o ``None`` si corresponde usar el fallback UI."""
    origen = _origin_of_clip(song)
    cover_origen = resolve_cover(origen) if origen else None

    fingerprint = song.stat().st_mtime_ns
    output = _cover_path(song)
    with _LOCK:
        cache = _read_cache()
        entry = cache.get(song.stem, {})
        vigente = entry.get("fingerprint") == fingerprint
        if entry.get("source") == "catalog" or entry.get("status") == "missing":
            vigente = vigente and entry.get("catalog_v") == _CATALOG_VERSION
        # Si la canción es un recorte y el tema original tiene portada, asegurarse
        # de que el recorte mantenga la portada del original actualizada: se
        # vuelve a copiar cuando el original cambió de portada.
        origin_stamp = cover_origen.stat().st_mtime_ns if cover_origen is not None else None
        if cover_origen is not None and (
            not vigente
            or entry.get("source") != "clip-origin"
            or entry.get("origin_stamp") != origin_stamp
        ):
            vigente = False

        if vigente:
            if entry.get("status") == "ready" and output.is_file():
                return output
            if entry.get("status") == "missing":
                return None

        output.unlink(missing_ok=True)
        temp_output = output.with_suffix(".tmp.jpg")
        temp_output.unlink(missing_ok=True)

        source = ""
        if cover_origen is not None:
            try:
                shutil.copyfile(cover_origen, temp_output)
                source = "clip-origin"
            except OSError:
                source = ""
        if not source:
            source = "embedded" if _extract_embedded(song, temp_output) else ""
        if not source:
            source = "catalog"
        if source == "catalog" and not _download_catalog_artwork(song, temp_output):
            temp_output.unlink(missing_ok=True)
            cache[song.stem] = {"fingerprint": fingerprint, "status": "missing", "catalog_v": _CATALOG_VERSION}
            _write_cache(cache)
            return None

        os.replace(temp_output, output)
        cache[song.stem] = {
            "fingerprint": fingerprint, "status": "ready", "source": source,
            "catalog_v": _CATALOG_VERSION,
        }
        if source == "clip-origin":
            cache[song.stem]["origin_stamp"] = origin_stamp
        _write_cache(cache)
        return output


def apply_custom_cover(song: Path, image_data: bytes | None = None, image_url: str | None = None) -> bool:
    """Aplica una carátula personalizada (por bytes o descargada de una URL) y actualiza la caché."""
    output = _cover_path(song)
    temp_output = output.with_suffix(".tmp.jpg")
    temp_output.unlink(missing_ok=True)

    success = False
    if image_url:
        success = _download_image(image_url, temp_output)
    elif image_data:
        if len(image_data) >= 1024 and (image_data.startswith(b"\xff\xd8") or image_data.startswith(b"\x89PNG")):
            temp_output.write_bytes(image_data)
            success = True

    if not success or not temp_output.is_file():
        temp_output.unlink(missing_ok=True)
        return False

    with _LOCK:
        os.replace(temp_output, output)
        cache = _read_cache()
        cache[song.stem] = {
            "fingerprint": song.stat().st_mtime_ns,
            "status": "ready",
            "source": "manual",
        }
        _write_cache(cache)

    return True


def invalidate_cover(song: Path) -> None:
    """Obliga a reevaluar la búsqueda si se corrigen título o artista."""
    with _LOCK:
        cache = _read_cache()
        cache.pop(song.stem, None)
        _write_cache(cache)
        _cover_path(song).unlink(missing_ok=True)
