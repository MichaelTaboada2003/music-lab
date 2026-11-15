"""Letras automáticas desde LRCLIB (catálogo abierto, sin clave).

Al descargar una canción se busca su letra y se guarda como ``letras/<stem>.txt``.
Si el catálogo trae además tiempos por verso y la duración coincide con el
audio local, se guarda ``letras/<stem>.lrc``: sirve para saber qué versos caen
dentro de un recorte aunque la canción completa no se haya sincronizado.
"""

import json
import re
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from library_artwork import _match_score
from library_metadata import get_metadata, split_artists

_BASE_DIR = Path(__file__).resolve().parent
LETRAS_DIR = _BASE_DIR / "letras"
_API = "https://lrclib.net/api/search"
_USER_AGENT = "music-lab-local/1.0"
_LRC_LINE_RE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$")
# Con más diferencia, los tiempos del catálogo ya no describen este audio
# (videoclips con intro, versiones extendidas…).
LRC_DURATION_TOLERANCE = 2.5
# La letra en sí vale aunque el audio tenga una intro algo distinta.
TEXT_DURATION_TOLERANCE = 25.0


def lrc_path_for(stem: str) -> Path:
    return LETRAS_DIR / f"{stem}.lrc"


def _search(params: dict) -> list[dict]:
    request = Request(f"{_API}?{urlencode(params)}", headers={"User-Agent": _USER_AGENT})
    try:
        with urlopen(request, timeout=8) as response:
            data = json.loads(response.read().decode("utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _clean_text(value) -> str:
    # Algunas fichas del catálogo traen bytes nulos al final.
    return (value or "").replace("\x00", "").strip() if isinstance(value, str) else ""


def find_lyrics(title: str, artist: str = "", duration: float | None = None) -> dict | None:
    """Mejor letra del catálogo para la canción, o None si nada es fiable."""
    title, artist = (title or "").strip(), (artist or "").strip()
    if not title:
        return None
    artists = split_artists(artist)
    primary = artists[0] if artists else ""

    queries = []
    if primary:
        queries.append({"track_name": title, "artist_name": primary})
    queries.append({"q": f"{title} {primary}".strip()})

    best, best_rank = None, None
    seen = set()
    for params in queries:
        for item in _search(params):
            if item.get("id") in seen or item.get("instrumental"):
                continue
            seen.add(item.get("id"))
            plain = _clean_text(item.get("plainLyrics"))
            synced = _clean_text(item.get("syncedLyrics"))
            if not plain and not synced:
                continue
            score = _match_score(
                title, artist, _clean_text(item.get("trackName")), _clean_text(item.get("artistName")))
            if score < 0.5:
                continue
            item_duration = item.get("duration")
            gap = (
                abs(float(item_duration) - duration)
                if duration and isinstance(item_duration, (int, float)) else None
            )
            if gap is not None and gap > TEXT_DURATION_TOLERANCE:
                continue  # otra versión (remix, directo): la letra no encajaría
            timed = bool(synced) and gap is not None and gap <= LRC_DURATION_TOLERANCE
            # Primero lo que permite recortar con letra, luego título y duración.
            rank = (timed, round(score, 2), -(gap if gap is not None else 60.0), bool(synced))
            if best_rank is None or rank > best_rank:
                best_rank = rank
                best = {
                    "plain": plain or lrc_to_plain(synced),
                    "synced": synced if timed else "",
                    "title": _clean_text(item.get("trackName")),
                    "artist": _clean_text(item.get("artistName")),
                }
        if best and best["synced"]:
            break
    return best


def parse_lrc(text: str) -> list[tuple[float, str]]:
    """Versos con su segundo de inicio; las líneas vacías marcan pausas."""
    lines = []
    for raw in (text or "").splitlines():
        match = _LRC_LINE_RE.match(raw.strip())
        if match:
            lines.append((int(match.group(1)) * 60 + float(match.group(2)), match.group(3).strip()))
    return lines


def lrc_to_plain(text: str) -> str:
    return "\n".join(line for _, line in parse_lrc(text)).strip()


def save_for_song(song: Path, lyrics_path: Path, duration: float | None, overwrite: bool = False) -> dict | None:
    """Busca la letra de `song` y la guarda. Devuelve el resultado o None.

    Nunca lanza por fallos de red: la letra automática es un extra."""
    if lyrics_path.is_file() and not overwrite:
        return None
    metadata = get_metadata(song)
    found = find_lyrics(metadata.get("title") or song.stem, metadata.get("artist") or "", duration)
    if not found or not found["plain"]:
        return None
    lyrics_path.parent.mkdir(parents=True, exist_ok=True)
    lyrics_path.write_text(found["plain"].strip() + "\n", encoding="utf-8")
    lrc_path = lrc_path_for(song.stem)
    if found["synced"]:
        lrc_path.write_text(found["synced"].strip() + "\n", encoding="utf-8")
    else:
        lrc_path.unlink(missing_ok=True)
    return {
        "texto": found["plain"].strip(),
        "versos": sum(1 for line in found["plain"].splitlines() if line.strip()),
        "con_tiempos": bool(found["synced"]),
        "titulo": found["title"],
        "artista": found["artist"],
    }
