"""
app.config
==============
Configuración estática del proyecto: rutas base, extensiones aceptadas y
variables de entorno derivadas. Este módulo NO importa nada del framework
para poder ser consumido por scripts CLI y tests sin arrastrar FastAPI.
"""

import os
from pathlib import Path

# La raíz del proyecto es el directorio padre del paquete app/.
BASE_DIR = Path(__file__).resolve().parent.parent

CANCIONES_DIR = BASE_DIR / "canciones"
LETRAS_DIR = BASE_DIR / "letras"
VIDEOS_DIR = BASE_DIR / "videos"
STATIC_DIR = BASE_DIR / "static"
VOCALS_DIR = BASE_DIR / "vocals"
COVERS_DIR = BASE_DIR / ".covers"

for _dir in (CANCIONES_DIR, LETRAS_DIR, VIDEOS_DIR, STATIC_DIR, COVERS_DIR):
    _dir.mkdir(parents=True, exist_ok=True)

AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".webm", ".ogg"}

# Carga sencilla de .env: no queremos añadir python-dotenv como dependencia
# solo para leer 3 líneas de config.
_env_file = BASE_DIR / ".env"
if _env_file.is_file():
    for _line in _env_file.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

# Base URL pública del servidor: usada para construir el redirect_uri del
# OAuth de Spotify. Se puede sobreescribir con APP_BASE_URL cuando corres
# en un puerto/host distinto del habitual. Debe coincidir EXACTAMENTE con
# la Redirect URI registrada en el Spotify Developer Dashboard.
APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
SPOTIFY_REDIRECT_URI = f"{APP_BASE_URL}/callback"

# Cache del token de Spotify en disco. En .gitignore.
SPOTIFY_CACHE = BASE_DIR / "spotify_auth.json"
