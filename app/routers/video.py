"""
Endpoints del generador de video estilo TikTok.
  - POST /api/video/{stem}         → lanza job de renderizado
  - GET  /api/videos               → lista mp4 generados
"""

import io
import json
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

import lyric_styles
import tiktok_generator
from library_artwork import resolve_cover

from ..config import VIDEOS_DIR
from ..jobs import start_job
from ..utils import find_song, lyrics_path_for, sync_cache_path_for, vad_value

router = APIRouter(tags=["video"])


class VideoRequest(BaseModel):
    language: str = "auto"
    model: str = "medium"
    force_sync: bool = False
    nombre_salida: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    titulo: Optional[str] = None
    artista: Optional[str] = None
    vad: Optional[str] = "auditok"
    separate_vocals: bool = True
    layout_style: Literal["player", "terminal", "color"] = "player"
    audio_volume: float = Field(default=1.0, ge=0.0, le=1.0)
    lyric_style: Literal["karaoke", "typing"] = "karaoke"
    lyric_flow: Literal["block", "line"] = "block"
    theme: Literal["terminal", "midnight", "sunset", "cloud"] = "terminal"
    font_family: Literal["mono", "modern", "editorial"] = "mono"
    font_size: Literal["compact", "balanced", "large"] = "balanced"
    bg_color: str = Field(default="#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    text_color: str = Field(default="#FFFFFF", pattern=r"^#[0-9a-fA-F]{6}$")


@router.post("/api/video/{stem}")
def api_generar_video(stem: str, payload: VideoRequest):
    song = find_song(stem)
    lp = lyrics_path_for(stem)
    if not lp.is_file():
        raise HTTPException(400, "Esta canción no tiene letra guardada todavía.")

    default_suffix = (
        "reproductor"
        if payload.layout_style == "player"
        else "color"
        if payload.layout_style == "color"
        else ("escritura" if payload.lyric_style == "typing" else "karaoke")
    )
    if payload.lyric_flow == "line":
        default_suffix = f"{default_suffix} - linea"
    # Tema, tipografía y estilo progresivo pertenecen únicamente a Terminal.
    # El Reproductor replica su identidad visual fija y no debe heredar una
    # selección oculta de la terminal ni reflejarla en el nombre del archivo.
    if payload.layout_style == "terminal":
        if payload.theme != "terminal":
            default_suffix = f"{default_suffix} - {payload.theme}"
        if payload.font_family != "mono" or payload.font_size != "balanced":
            default_suffix = f"{default_suffix} - {payload.font_family}-{payload.font_size}"
    if payload.layout_style == "color" and payload.lyric_style == "typing":
        default_suffix = f"{default_suffix} - escritura"
    audio_volume = payload.audio_volume if payload.layout_style == "player" else 1.0
    output_name = (payload.nombre_salida or f"{stem} - {default_suffix}").strip()
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
            layout_style=payload.layout_style, audio_volume=audio_volume,
            lyric_style=payload.lyric_style, lyric_flow=payload.lyric_flow,
            theme=payload.theme,
            font_family=payload.font_family, font_size=payload.font_size,
            bg_color=payload.bg_color, text_color=payload.text_color,
            progress_cb=progress_cb,
        )
        return {"video": output_path.name}

    job_id = start_job(
        _tarea,
        key=(f"video:{stem}:{output_name}:{payload.layout_style}:{audio_volume}:"
             f"{payload.lyric_style}:{payload.lyric_flow}:{payload.theme}:"
             f"{payload.font_family}:{payload.font_size}:{payload.bg_color}:{payload.text_color}:"
             f"{payload.start_time}:{payload.end_time}"),
    )
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


_SYNC_STANZAS: dict = {}


def _stanzas_for(stem: str):
    """Letra sincronizada del cache; se relee solo si el archivo cambió."""
    path = sync_cache_path_for(stem)
    if not path.is_file():
        raise HTTPException(400, "Sincroniza la canción antes de previsualizar.")
    stamp = path.stat().st_mtime_ns
    cached = _SYNC_STANZAS.get(stem)
    if cached is None or cached[0] != stamp:
        data = json.loads(path.read_text(encoding="utf-8"))
        cached = (stamp, data.get("stanzas") or [])
        _SYNC_STANZAS[stem] = cached
    return cached[1]


@router.get("/api/video/{stem}/frame")
def api_video_frame(
    stem: str,
    t: float = Query(0.0, ge=0.0),
    layout_style: Literal["terminal", "color"] = "color",
    theme: Literal["terminal", "midnight", "sunset", "cloud"] = "terminal",
    font_family: Literal["mono", "modern", "editorial"] = "modern",
    font_size: Literal["compact", "balanced", "large"] = "balanced",
    lyric_style: Literal["karaoke", "typing"] = "karaoke",
    lyric_flow: Literal["block", "line"] = "block",
    bg_color: str = Query("#5B21F5", pattern=r"^#[0-9a-fA-F]{6}$"),
    text_color: str = Query("#FFE14D", pattern=r"^#[0-9a-fA-F]{6}$"),
    start: Optional[float] = None,
    end: Optional[float] = None,
    titulo: Optional[str] = None,
    artista: Optional[str] = None,
    width: int = Query(540, ge=180, le=1080),
):
    """Un frame de la exportación (mismo código que el video) para la vista previa."""
    song = find_song(stem)
    stanzas = _stanzas_for(stem)
    try:
        cover = resolve_cover(song)
    except Exception:
        cover = None
    common = dict(
        size=tiktok_generator.VIDEO_SIZE, title=titulo or stem, artist=artista, cover_path=cover,
        font_family=font_family, font_size=font_size, lyric_style=lyric_style,
        lyric_flow=lyric_flow, fragment_start=start, fragment_end=end,
    )
    if layout_style == "color":
        frame = lyric_styles.render_color_frame(
            stanzas, t,
            bg=tiktok_generator.parse_hex_color(bg_color),
            text=tiktok_generator.parse_hex_color(text_color), **common,
        )
    else:
        frame = lyric_styles.render_terminal_frame(
            stanzas, t, theme=tiktok_generator._theme_for(theme), **common,
        )
    from PIL import Image
    image = Image.fromarray(frame)
    height = round(width * image.height / image.width)
    image = image.resize((width, height), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=86)
    return Response(buffer.getvalue(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})
