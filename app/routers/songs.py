"""
Endpoints de canciones y letras:
  - GET  /api/canciones            → listado con flags (letra/karaoke cache)
  - POST /api/descargar            → descarga vía yt-dlp (audio_downloader)
  - GET  /api/letra/{stem}         → obtener texto de la letra
  - POST /api/letra/{stem}         → guardar/actualizar letra
  - POST /api/canciones/{stem}/recortar → recorta un fragmento como copia nueva
"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from audio_downloader import is_url, resolve_audio_source
from audio_trim import MIN_DURATION, trim_audio
from library_metadata import get_metadata, mark_as_clip, save_metadata
from library_artwork import apply_custom_cover, invalidate_cover, resolve_cover, search_catalog_covers
from lyrics_sync import sync_cache_is_current

from ..config import CANCIONES_DIR
from ..jobs import start_job
from ..utils import (
    cached_stem_is_current, find_song, instrumental_path_for, list_songs, lyrics_path_for, obtener_duracion,
    sync_cache_path_for, vocals_path_for,
)

router = APIRouter(tags=["songs"])


def _has_playable_sync(song) -> bool:
    lyrics_path = lyrics_path_for(song.stem)
    cache_path = sync_cache_path_for(song.stem)
    if not lyrics_path.is_file() or not cache_path.is_file():
        return False
    try:
        import json

        data = json.loads(cache_path.read_text(encoding="utf-8"))
        return bool(
            sync_cache_is_current(data, str(song), str(lyrics_path))
            and data.get("quality", {}).get("playable")
        )
    except (OSError, ValueError, TypeError):
        return False


@router.get("/api/canciones")
def api_canciones():
    canciones = []
    for p in list_songs():
        metadata = get_metadata(p)
        inst_path = instrumental_path_for(p.stem)
        has_pista = cached_stem_is_current(inst_path, p)
        voc_path = vocals_path_for(p.stem)
        has_vocals = voc_path.is_file()
        canciones.append({
            "nombre": p.name,
            "stem": p.stem,
            "duracion": obtener_duracion(p),
            **metadata,
            "tiene_letra": lyrics_path_for(p.stem).is_file(),
            "tiene_sync": _has_playable_sync(p),
            "tiene_pista": has_pista,
            "pista_url": f"/vocals/{inst_path.name}" if has_pista else None,
            "tiene_vocals": has_vocals,
            "vocals_url": f"/vocals/{voc_path.name}" if has_vocals else None,
        })
    return {"canciones": canciones}


class DescargaRequest(BaseModel):
    url: str
    nombre: Optional[str] = None


@router.post("/api/descargar")
def api_descargar(payload: DescargaRequest):
    if not is_url(payload.url):
        raise HTTPException(400, "La fuente debe ser una URL válida (YouTube, etc.)")
    def task(progress_cb):
        progress_cb("Descargando y convirtiendo audio", None)
        resultado = resolve_audio_source(
            payload.url, output_dir=str(CANCIONES_DIR),
            filename=payload.nombre or None,
        )
        progress_cb("Actualizando biblioteca", 100)
        return {"archivo": resultado.name}

    key = f"download:{payload.url}:{payload.nombre or ''}"
    return {"job_id": start_job(task, key=key)}


@router.get("/api/letra/{stem}")
def api_obtener_letra(stem: str):
    path = lyrics_path_for(stem)
    if not path.is_file():
        return {"existe": False, "texto": ""}
    return {"existe": True, "texto": path.read_text(encoding="utf-8")}


class LetraRequest(BaseModel):
    texto: str


class MetadataRequest(BaseModel):
    title: str
    artist: str = ""


@router.post("/api/canciones/{stem}/metadata")
def api_guardar_metadata(stem: str, payload: MetadataRequest):
    song = find_song(stem)
    try:
        metadata = save_metadata(song.stem, payload.title, payload.artist)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    invalidate_cover(song)
    resolve_cover(song)
    return {"status": "ok", "metadata": metadata}


@router.get("/api/canciones/{stem}/cover")
def api_cover_cancion(stem: str):
    song = find_song(stem)
    cover = resolve_cover(song)
    if not cover:
        # Sin no-store el navegador cachea el 404 por heurística y sigue
        # mostrando el hueco aunque la canción ya tenga portada (por ejemplo,
        # un recorte que hereda la del original).
        raise HTTPException(
            404, "No hay carátula disponible",
            headers={"Cache-Control": "no-store"},
        )
    return FileResponse(
        cover,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.post("/api/canciones/{stem}/cover/refresh")
def api_refresh_cover(stem: str):
    song = find_song(stem)
    invalidate_cover(song)
    cover = resolve_cover(song)
    return {"status": "ok", "has_cover": bool(cover)}


@router.get("/api/canciones/{stem}/cover/search")
def api_search_cover(stem: str, q: Optional[str] = None):
    song = find_song(stem)
    metadata = get_metadata(song)
    title = (q or "").strip() or metadata.get("title") or song.stem
    artist = metadata.get("artist") or ""
    candidates = search_catalog_covers(title, artist, limit=8)
    return {"candidates": candidates}


class CoverApplyRequest(BaseModel):
    image_url: Optional[str] = None


@router.post("/api/canciones/{stem}/cover/apply")
def api_apply_cover(stem: str, payload: CoverApplyRequest):
    song = find_song(stem)
    if not payload.image_url:
        raise HTTPException(400, "Debe proporcionar una URL de imagen.")
    success = apply_custom_cover(song, image_url=payload.image_url)
    if not success:
        raise HTTPException(400, "No se pudo descargar o procesar la imagen seleccionada.")
    return {"status": "ok"}


@router.post("/api/canciones/{stem}/cover/upload")
async def api_upload_cover(stem: str, request: Request):
    song = find_song(stem)
    contents = await request.body()
    if len(contents) > 10_000_000:
        raise HTTPException(400, "La imagen es demasiado pesada (máximo 10MB).")
    if not contents:
        raise HTTPException(400, "No se recibieron datos de imagen.")
    success = apply_custom_cover(song, image_data=contents)
    if not success:
        raise HTTPException(400, "El archivo subido no es una imagen válida (debe ser JPG o PNG).")
    return {"status": "ok"}


class RecorteRequest(BaseModel):
    start: float = Field(default=0.0, ge=0)
    end: Optional[float] = Field(default=None, gt=0)
    nombre_salida: Optional[str] = None
    fade_in: float = Field(default=0.0, ge=0, le=10)
    fade_out: float = Field(default=0.0, ge=0, le=10)


@router.post("/api/canciones/{stem}/recortar")
def api_recortar_cancion(stem: str, payload: RecorteRequest):
    """Guarda el tramo elegido como una canción nueva. El original no se toca:
    la letra y el karaoke del tema completo siguen siendo válidos."""
    song = find_song(stem)
    if payload.end is not None and payload.end - payload.start < MIN_DURATION:
        raise HTTPException(400, f"El fragmento debe durar al menos {MIN_DURATION:g} segundos.")

    nombre = (payload.nombre_salida or "").strip() or None
    if nombre and Path(nombre).name != nombre:
        raise HTTPException(400, "El nombre del recorte no puede incluir carpetas.")

    def task(progress_cb):
        progress_cb("Preparando recorte", None)
        # La portada del original viaja al recorte: el corte descarta las pistas
        # de video del archivo, que es donde vive la carátula incrustada.
        recorte = trim_audio(
            song,
            start=payload.start, end=payload.end,
            output_dir=CANCIONES_DIR, filename=nombre,
            fade_in=payload.fade_in, fade_out=payload.fade_out,
            cover=resolve_cover(song),
            progress_cb=progress_cb,
        )
        # Sin ficha propia el recorte aparecería con el nombre crudo del
        # archivo; hereda la del original para no perder el artista.
        origen = get_metadata(song)
        try:
            save_metadata(
                recorte.stem,
                recorte.stem if nombre else f"{origen['title']} (recorte)",
                origen.get("artist", ""),
            )
        except ValueError:
            pass  # La ficha es un extra: el recorte ya está en disco.
        # La marca sobrevive a cualquier renombrado de la ficha, así que la
        # interfaz puede separar canciones de recortes sin mirar el nombre.
        mark_as_clip(recorte.stem, song.stem)
        return {
            "archivo": recorte.name,
            "stem": recorte.stem,
            "duracion": obtener_duracion(recorte),
        }

    key = (f"trim:{stem}:{payload.start}:{payload.end}:{nombre or ''}:"
           f"{payload.fade_in}:{payload.fade_out}")
    return {"job_id": start_job(task, key=key)}


@router.post("/api/letra/{stem}")
def api_guardar_letra(stem: str, payload: LetraRequest):
    find_song(stem)  # 404 si no existe la canción
    path = lyrics_path_for(stem)
    path.write_text(payload.texto.strip() + "\n", encoding="utf-8")
    # Una palabra editada basta para desplazar toda la alineación posterior.
    cache_path = sync_cache_path_for(stem)
    cache_invalidada = cache_path.is_file()
    if cache_invalidada:
        cache_path.unlink()
    return {"status": "ok", "cache_invalidada": cache_invalidada}
