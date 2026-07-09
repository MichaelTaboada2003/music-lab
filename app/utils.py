"""
app.utils
=============
Helpers compartidos entre routers: rutas a letras/sync cache, listado de
canciones locales, duración vía ffprobe y normalización de parámetros de
sincronización.
"""

import json
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from .config import AUDIO_EXTS, CANCIONES_DIR, LETRAS_DIR, VOCALS_DIR


def obtener_duracion(ruta_archivo: Path) -> str:
    """Devuelve la duración del audio como 'M:SS' usando ffprobe. Si falla
    (ffprobe no instalado o archivo corrupto), devuelve 'Desconocida'."""
    try:
        comando = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json", str(ruta_archivo),
        ]
        resultado = subprocess.run(
            comando, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        if resultado.returncode == 0:
            info = json.loads(resultado.stdout)
            duracion_segundos = float(info["format"]["duration"])
            minutos = int(duracion_segundos // 60)
            segundos = int(duracion_segundos % 60)
            return f"{minutos}:{str(segundos).zfill(2)}"
    except Exception:
        pass
    return "Desconocida"


def lyrics_path_for(stem: str) -> Path:
    return LETRAS_DIR / f"{stem}.txt"


def sync_cache_path_for(stem: str) -> Path:
    return LETRAS_DIR / f"{stem}.sync.json"


def vocals_path_for(stem: str) -> Path:
    return VOCALS_DIR / f"{stem}.vocals.wav"


def list_songs():
    if not CANCIONES_DIR.is_dir():
        return []
    return sorted(
        (p for p in CANCIONES_DIR.iterdir()
         if p.is_file() and p.suffix.lower() in AUDIO_EXTS),
        key=lambda p: p.stem.lower(),
    )


def find_song(stem: str) -> Path:
    """Busca una canción por stem. Lanza 404 HTTPException si no existe."""
    for p in list_songs():
        if p.stem == stem:
            return p
    raise HTTPException(404, "Canción no encontrada")


def vad_value(vad: Optional[str]):
    """Normaliza el parámetro VAD para pasarlo a lyrics_sync:
    'none'/'no'/'off'/'' → None (desactiva); otro string se propaga tal cual."""
    if not vad or str(vad).lower() in ("none", "no", "off", ""):
        return None
    return vad
