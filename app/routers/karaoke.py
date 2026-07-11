"""
Endpoints de karaoke (sincronización letra ↔ audio con Whisper).
  - GET  /api/karaoke/{stem}       → lee la cache .sync.json si existe
  - POST /api/sincronizar/{stem}   → lanza job de sincronización
"""

import json
import math
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lyrics_sync import (
    _atomic_json_write,
    align_lyrics_to_audio,
    quality_from_stanzas,
    sync_cache_is_current,
    upgrade_sync_cache,
)

from ..jobs import start_job
from ..utils import find_song, lyrics_path_for, sync_cache_path_for, vad_value, vocals_path_for

router = APIRouter(tags=["karaoke"])


@router.get("/api/karaoke/{stem}")
def api_karaoke_cache(stem: str):
    song = find_song(stem)
    lyrics_path = lyrics_path_for(stem)
    cache = sync_cache_path_for(stem)
    tiene_vocals = vocals_path_for(stem).is_file()
    if not cache.is_file():
        return {"existe": False, "actual": False, "tiene_vocals": tiene_vocals}

    try:
        with open(cache, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"existe": False, "actual": False, "stale": True, "tiene_vocals": tiene_vocals}

    actual = lyrics_path.is_file() and sync_cache_is_current(
        data, str(song), str(lyrics_path)
    )
    if actual and upgrade_sync_cache(data):
        _atomic_json_write(cache, data)
    quality = data.get("quality") if actual else None
    return {
        "existe": bool(actual and quality and quality.get("playable")),
        "actual": actual,
        "stale": not actual,
        "datos": data if actual else None,
        "calidad": quality,
        "tiene_vocals": tiene_vocals,
    }


class SyncRequest(BaseModel):
    language: str = "es"
    model: str = "small"
    force: bool = False
    vad: Optional[str] = "auditok"
    separate_vocals: bool = True


class TimingAdjustment(BaseModel):
    stanza: int
    line: int
    word: int
    start: float
    end: float


class TimingAdjustmentsRequest(BaseModel):
    adjustments: list[TimingAdjustment]


def _all_words(stanzas):
    for stanza_index, stanza in enumerate(stanzas):
        for line_index, line in enumerate(stanza):
            for word_index, word in enumerate(line.get("words", [])):
                yield stanza_index, line_index, word_index, line, word


@router.post("/api/karaoke/{stem}/ajustes")
def api_guardar_ajustes(stem: str, payload: TimingAdjustmentsRequest):
    """Guarda tiempos manuales sin perder las firmas que validan el caché."""
    if not payload.adjustments:
        raise HTTPException(400, "No hay ajustes para guardar.")

    song = find_song(stem)
    lyrics_path = lyrics_path_for(stem)
    cache_path = sync_cache_path_for(stem)
    if not cache_path.is_file():
        raise HTTPException(404, "No existe una sincronización para esta canción.")

    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(409, "La sincronización no se puede leer. Vuelve a crearla.") from exc

    if not sync_cache_is_current(data, str(song), str(lyrics_path)):
        raise HTTPException(409, "La letra o el audio cambiaron. Vuelve a sincronizar antes de ajustar.")

    duration = data.get("duration")
    if not isinstance(duration, (int, float)) or duration <= 0:
        raise HTTPException(409, "La sincronización no tiene una duración válida. Vuelve a crearla.")

    lookup = {
        (stanza_index, line_index, word_index): (line, word)
        for stanza_index, line_index, word_index, line, word in _all_words(data.get("stanzas", []))
    }
    seen = set()
    for adjustment in payload.adjustments:
        key = (adjustment.stanza, adjustment.line, adjustment.word)
        if key in seen or key not in lookup:
            raise HTTPException(400, "Uno de los ajustes no corresponde a una palabra de esta canción.")
        seen.add(key)
        if not (
            math.isfinite(adjustment.start)
            and math.isfinite(adjustment.end)
            and 0 <= adjustment.start < adjustment.end <= duration
        ):
            raise HTTPException(400, "Cada palabra debe tener un inicio y fin válidos dentro de la canción.")

    for adjustment in payload.adjustments:
        line, word = lookup[(adjustment.stanza, adjustment.line, adjustment.word)]
        word["start"] = round(adjustment.start, 3)
        word["end"] = round(adjustment.end, 3)
        word["synced"] = True
        word["manual"] = True
        word["timing_repaired"] = False
        word["confidence"] = None

    previous_end = 0.0
    for _, _, _, line, word in _all_words(data["stanzas"]):
        start, end = word.get("start"), word.get("end")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or start < previous_end or end <= start:
            raise HTTPException(
                400,
                "Los tiempos deben mantenerse en el orden de la letra y no solaparse.",
            )
        previous_end = end
        line["start"] = line["words"][0]["start"]
        line["end"] = line["words"][-1]["end"]

    data["quality"] = quality_from_stanzas(data["stanzas"])
    _atomic_json_write(cache_path, data)
    return {"status": "ok", "datos": data, "calidad": data["quality"]}


@router.post("/api/sincronizar/{stem}")
def api_sincronizar(stem: str, payload: SyncRequest):
    song = find_song(stem)
    lp = lyrics_path_for(stem)
    if not lp.is_file():
        raise HTTPException(400, "Esta canción no tiene letra guardada todavía.")

    def _tarea(progress_cb):
        return align_lyrics_to_audio(
            str(song), str(lp),
            language=payload.language, model_name=payload.model, force=payload.force,
            vad=vad_value(payload.vad), separate_vocals=payload.separate_vocals,
            progress_cb=progress_cb,
        )

    job_id = start_job(_tarea, key=f"sync:{stem}")
    return {"job_id": job_id}
