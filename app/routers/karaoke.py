"""
Endpoints de karaoke (sincronización letra ↔ audio con Whisper).
  - GET  /api/karaoke/{stem}       → lee la cache .sync.json si existe
  - POST /api/sincronizar/{stem}   → lanza job de sincronización
"""

import json
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lyrics_sync import align_lyrics_to_audio

from ..jobs import start_job
from ..utils import find_song, lyrics_path_for, sync_cache_path_for, vad_value, vocals_path_for

router = APIRouter(tags=["karaoke"])


@router.get("/api/karaoke/{stem}")
def api_karaoke_cache(stem: str):
    cache = sync_cache_path_for(stem)
    tiene_vocals = vocals_path_for(stem).is_file()
    if not cache.is_file():
        return {"existe": False, "tiene_vocals": tiene_vocals}
    with open(cache, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {"existe": True, "datos": data, "tiene_vocals": tiene_vocals}


class SyncRequest(BaseModel):
    language: str = "es"
    model: str = "small"
    force: bool = False
    vad: Optional[str] = "auditok"
    separate_vocals: bool = True


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

    job_id = start_job(_tarea)
    return {"job_id": job_id}
