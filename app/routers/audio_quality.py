"""Endpoints de Soundcheck: medición local y ganancia de reproducción."""

from fastapi import APIRouter

from audio_quality import analyze_audio, get_cached_quality

from ..jobs import start_job
from ..utils import find_song

router = APIRouter(tags=["audio-quality"])


@router.get("/api/audio-calidad/{stem}")
def api_audio_quality(stem: str):
    song = find_song(stem)
    analysis = get_cached_quality(song)
    return {"existe": analysis is not None, "datos": analysis}


@router.post("/api/audio-calidad/{stem}")
def api_analyze_audio_quality(stem: str):
    song = find_song(stem)

    def task(progress_cb):
        return analyze_audio(song, progress_cb=progress_cb)

    return {"job_id": start_job(task, key=f"soundcheck:{stem}")}
