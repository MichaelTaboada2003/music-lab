"""Letra de un recorte a partir de la canción completa.

Dos fuentes, de más a menos precisa:

1. La sincronización por palabra de la canción (``.sync.json``): el recorte
   hereda sus versos **y** su karaoke, desplazado al nuevo reloj. No hace falta
   volver a pasar Whisper.
2. Los tiempos por verso del catálogo (``.lrc``): el recorte hereda solo el
   texto de los versos que caen dentro; se sincroniza después como siempre.
"""

import json
from pathlib import Path

from lyrics_catalog import lrc_path_for, parse_lrc
from lyrics_sync import (
    CACHE_VERSION,
    MIN_WORD_DURATION,
    _atomic_json_write,
    _audio_signature,
    _lyrics_signature,
    quality_from_stanzas,
    sync_cache_is_current,
)

_BASE_DIR = Path(__file__).resolve().parent
LETRAS_DIR = _BASE_DIR / "letras"
# Un verso entra en el recorte si al menos esta parte suena dentro de él.
_MIN_LINE_OVERLAP = 0.6


def _stanzas_from_sync(data: dict, start: float, end: float) -> list:
    """Estrofas del tramo [start, end] con los tiempos en el reloj del recorte."""
    length = end - start
    result = []
    cursor = 0.0
    for stanza in data.get("stanzas", []):
        kept = []
        for line in stanza:
            words = line.get("words") or []
            line_start, line_end = line.get("start"), line.get("end")
            if not words or not isinstance(line_start, (int, float)) or not isinstance(line_end, (int, float)):
                continue
            span = max(line_end - line_start, 1e-6)
            inside = min(line_end, end) - max(line_start, start)
            if inside / span < _MIN_LINE_OVERLAP:
                continue
            new_words = []
            for word in words:
                # Monótono y con duración mínima: el wipe del karaoke no puede
                # retroceder ni dividir por cero en los bordes del corte.
                w_start = min(max(word["start"] - start, cursor), max(0.0, length - MIN_WORD_DURATION))
                w_end = min(max(word["end"] - start, w_start + MIN_WORD_DURATION), length)
                cursor = w_end
                new_words.append({**word, "start": round(w_start, 3), "end": round(w_end, 3)})
            kept.append({
                "text": line.get("text", ""),
                "start": new_words[0]["start"],
                "end": new_words[-1]["end"],
                "words": new_words,
            })
        if kept:
            result.append(kept)
    return result


def _stanzas_from_lrc(lrc_text: str, start: float, end: float) -> list[list[str]]:
    lines = parse_lrc(lrc_text)
    stanzas, current = [], []
    for index, (moment, text) in enumerate(lines):
        next_moment = lines[index + 1][0] if index + 1 < len(lines) else moment + 4.0
        if not text:
            if current:
                stanzas.append(current)
                current = []
            continue
        span = max(next_moment - moment, 1e-6)
        inside = min(next_moment, end) - max(moment, start)
        # Los versos del catálogo duran hasta el siguiente: basta con que
        # empiecen dentro o con que suenen en su mayor parte.
        if start - 0.3 <= moment < end - 0.4 or inside / span >= _MIN_LINE_OVERLAP:
            current.append(text)
    if current:
        stanzas.append(current)
    return stanzas


def _write_lyrics(path: Path, stanzas_text: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n\n".join("\n".join(stanza) for stanza in stanzas_text) + "\n", encoding="utf-8")


def derive_clip_lyrics(source: Path, clip: Path, start: float, end: float, clip_duration: float) -> dict:
    """Escribe la letra (y el karaoke si se puede) del recorte.

    Devuelve ``{"versos": n, "karaoke": bool}``; sin fuente fiable, n = 0."""
    nothing = {"versos": 0, "karaoke": False}
    clip_lyrics = LETRAS_DIR / f"{clip.stem}.txt"
    if clip_lyrics.exists():
        return nothing  # nunca se pisa una letra escrita a mano

    source_lyrics = LETRAS_DIR / f"{source.stem}.txt"
    source_sync = LETRAS_DIR / f"{source.stem}.sync.json"
    if source_lyrics.is_file() and source_sync.is_file():
        try:
            data = json.loads(source_sync.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        if (
            data
            and sync_cache_is_current(data, str(source), str(source_lyrics))
            and (data.get("quality") or {}).get("playable")
        ):
            stanzas = _stanzas_from_sync(data, start, end)
            if stanzas:
                _write_lyrics(clip_lyrics, [[line["text"] for line in stanza] for stanza in stanzas])
                cache = {
                    "cache_version": CACHE_VERSION,
                    "audio": str(clip),
                    "lyrics": str(clip_lyrics),
                    "lyrics_mtime": clip_lyrics.stat().st_mtime,
                    "audio_signature": _audio_signature(str(clip)),
                    "lyrics_signature": _lyrics_signature(str(clip_lyrics)),
                    "language": data.get("language"),
                    "duration": clip_duration,
                    "config": data.get("config"),
                    "inherited_from": source.stem,
                    "stanzas": stanzas,
                }
                cache["quality"] = quality_from_stanzas(stanzas)
                _atomic_json_write(LETRAS_DIR / f"{clip.stem}.sync.json", cache)
                return {
                    "versos": sum(len(stanza) for stanza in stanzas),
                    "karaoke": bool(cache["quality"].get("playable")),
                }

    lrc = lrc_path_for(source.stem)
    if lrc.is_file():
        try:
            stanzas_text = _stanzas_from_lrc(lrc.read_text(encoding="utf-8"), start, end)
        except OSError:
            stanzas_text = []
        if stanzas_text:
            _write_lyrics(clip_lyrics, stanzas_text)
            return {"versos": sum(len(stanza) for stanza in stanzas_text), "karaoke": False}
    return nothing
