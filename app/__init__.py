"""
app
=======
Backend de Music Lab (FastAPI). Expone la API que consume la SPA servida
desde static/index.html:

  - Listar canciones y descargarlas (yt-dlp)
  - Ver / guardar la letra de una canción
  - Sincronizar letra con audio (Whisper) para modo karaoke
  - Generar el video estilo TikTok
  - Traer canciones desde Spotify (Descubrir)

Cada dominio vive en su propio router bajo `app/routers/`. Este módulo
solo crea la instancia FastAPI, aplica middleware y monta los routers y
los estáticos.

Ejecutar con:
    uvicorn app:app --reload
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import CANCIONES_DIR, STATIC_DIR, VIDEOS_DIR, VOCALS_DIR
from .jobs import router as jobs_router
from .routers import frontend, karaoke, songs, spotify, video

app = FastAPI(title="Music Lab")

# CORS abierto: la SPA vive en el mismo origen, pero se deja permisivo
# por si se sirve el HTML de otra forma (Live Server, extensión, etc.)
# durante desarrollo. En producción convendría restringir orígenes.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Estáticos: audio, videos, voces y los assets de la SPA.
app.mount("/canciones", StaticFiles(directory=str(CANCIONES_DIR)), name="canciones")
app.mount("/videos", StaticFiles(directory=str(VIDEOS_DIR)), name="videos")
app.mount("/vocals", StaticFiles(directory=str(VOCALS_DIR)), name="vocals")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Routers por dominio.
app.include_router(jobs_router)
app.include_router(frontend.router)
app.include_router(songs.router)
app.include_router(karaoke.router)
app.include_router(video.router)
app.include_router(spotify.router)
