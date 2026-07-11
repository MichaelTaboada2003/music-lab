"""
Endpoints del generador de video estilo TikTok.
  - POST /api/video/{stem}         → lanza job de renderizado
  - GET  /api/videos               → lista mp4 generados
"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import tiktok_generator

from ..config import VIDEOS_DIR
from ..jobs import start_job
from ..utils import find_song, lyrics_path_for, vad_value

router = APIRouter(tags=["video"])


class VideoRequest(BaseModel):
    language: str = "es"
    model: str = "small"
    force_sync: bool = False
    nombre_salida: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    titulo: Optional[str] = None
    artista: Optional[str] = None
    vad: Optional[str] = "auditok"
    separate_vocals: bool = True


@router.post("/api/video/{stem}")
def api_generar_video(stem: str, payload: VideoRequest):
    song = find_song(stem)
    lp = lyrics_path_for(stem)
    if not lp.is_file():
        raise HTTPException(400, "Esta canción no tiene letra guardada todavía.")

    output_name = (payload.nombre_salida or stem).strip() or stem
    if Path(output_name).name != output_name:
        raise HTTPException(400, "El nombre de salida no puede incluir carpetas.")
    output_name = Path(output_name).stem.strip()
    if not output_name:
        raise HTTPException(400, "El nombre de salida no es válido.")
    output_path = VIDEOS_DIR / f"{output_name}.mp4"

    def _tarea(progress_cb):
        tiktok_generator.create_tiktok_video(
            str(song), str(lp), str(output_path),
            language=payload.language, model=payload.model,
            force_sync=payload.force_sync,
            start_time=payload.start_time, end_time=payload.end_time,
            title=payload.titulo or stem, artist=payload.artista,
            vad=vad_value(payload.vad), separate_vocals=payload.separate_vocals,
            progress_cb=progress_cb,
        )
        return {"video": output_path.name}

    job_id = start_job(_tarea, key=f"video:{stem}")
    return {"job_id": job_id}


@router.get("/api/videos")
def api_videos():
    if not VIDEOS_DIR.is_dir():
        return {"videos": []}
    return {
        "videos": sorted(
            p.name for p in VIDEOS_DIR.iterdir() if p.suffix.lower() == ".mp4"
        )
    }
