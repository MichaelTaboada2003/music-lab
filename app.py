"""
app.py
========
Backend único de Music Lab. Expone TODA la funcionalidad del proyecto
(antes solo disponible por terminal en music_lab.py) como una API que
consume la interfaz web servida desde static/index.html:

  - Listar canciones ya descargadas
  - Descargar una canción nueva desde una URL (YouTube, etc.)
  - Ver / guardar la letra de una canción
  - Sincronizar la letra con el audio (Whisper) para modo karaoke
  - Reproducir el karaoke sincronizado directamente en el navegador
  - Generar el video estilo TikTok y previsualizarlo

Ejecutar con:
    uvicorn app:app --reload
y abrir http://127.0.0.1:8000 en el navegador.
"""

import json
import subprocess
import threading
import uuid
import urllib.request
import urllib.error
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import urllib.parse
import base64
from pydantic import BaseModel

from audio_downloader import is_url, resolve_audio_source
from lyrics_sync import align_lyrics_to_audio
import tiktok_generator

BASE_DIR = Path(__file__).resolve().parent
CANCIONES_DIR = BASE_DIR / "canciones"
LETRAS_DIR = BASE_DIR / "letras"
VIDEOS_DIR = BASE_DIR / "videos"
STATIC_DIR = BASE_DIR / "static"

for _dir in (CANCIONES_DIR, LETRAS_DIR, VIDEOS_DIR, STATIC_DIR):
    _dir.mkdir(parents=True, exist_ok=True)

AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".webm", ".ogg"}

env_file = BASE_DIR / ".env"
if env_file.is_file():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip()

app = FastAPI(title="Music Lab")

# La interfaz vive en el mismo servidor, pero se deja CORS abierto por si
# se sirve el HTML de otra forma (ej. extensión Live Server) durante desarrollo.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/canciones", StaticFiles(directory=str(CANCIONES_DIR)), name="canciones")
app.mount("/videos", StaticFiles(directory=str(VIDEOS_DIR)), name="videos")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------------------------------------------------------------------
# Manejo de tareas largas (sincronizar letra / generar video) en background,
# para que la interfaz no se quede "colgada" esperando y pueda mostrar
# progreso mientras Whisper transcribe o moviepy renderiza.
# ---------------------------------------------------------------------------

_jobs: dict = {}
_jobs_lock = threading.Lock()


def _start_job(fn) -> str:
    """Lanza `fn(progress_cb)` en un hilo. `progress_cb(phase: str, pct: float | None)`
    permite a la tarea reportar en qué fase está y (si se conoce) qué porcentaje
    lleva. Cuando pct es None, el frontend muestra una barra indeterminada.
    """
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "running", "result": None, "error": None,
            "progress": {"phase": "En cola", "pct": None},
        }

    def progress_cb(phase: str, pct=None):
        pct_val = None
        if pct is not None:
            try:
                pct_val = max(0, min(100, float(pct)))
            except (TypeError, ValueError):
                pct_val = None
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is not None:
                j["progress"] = {"phase": phase, "pct": pct_val}

    def target():
        try:
            result = fn(progress_cb)
            with _jobs_lock:
                _jobs[job_id]["status"] = "done"
                _jobs[job_id]["result"] = result
                _jobs[job_id]["progress"] = {"phase": "Listo", "pct": 100}
        except Exception as e:
            with _jobs_lock:
                _jobs[job_id]["status"] = "error"
                _jobs[job_id]["error"] = str(e)

    threading.Thread(target=target, daemon=True).start()
    return job_id


@app.get("/api/job/{job_id}")
def api_job_status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job no encontrado")
    return job


# ---------------------------------------------------------------------------
# Interfaz web
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    """Sirve el index inyectando un cache buster (?v=<mtime>) a los assets
    para que los navegadores siempre recojan la última versión de app.js y
    style.css después de un cambio."""
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for asset in ("app.js", "style.css"):
        asset_path = STATIC_DIR / asset
        if asset_path.is_file():
            version = int(asset_path.stat().st_mtime)
            html = html.replace(f"/static/{asset}", f"/static/{asset}?v={version}")
    return HTMLResponse(
        html,
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )

@app.get("/favicon.ico")
def favicon():
    return {}


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def _obtener_duracion(ruta_archivo: Path) -> str:
    try:
        comando = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json", str(ruta_archivo),
        ]
        resultado = subprocess.run(comando, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if resultado.returncode == 0:
            info = json.loads(resultado.stdout)
            duracion_segundos = float(info["format"]["duration"])
            minutos = int(duracion_segundos // 60)
            segundos = int(duracion_segundos % 60)
            return f"{minutos}:{str(segundos).zfill(2)}"
    except Exception:
        pass
    return "Desconocida"


def _lyrics_path_for(stem: str) -> Path:
    return LETRAS_DIR / f"{stem}.txt"


def _sync_cache_path_for(stem: str) -> Path:
    return LETRAS_DIR / f"{stem}.sync.json"


def _list_songs():
    if not CANCIONES_DIR.is_dir():
        return []
    return sorted(
        (p for p in CANCIONES_DIR.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS),
        key=lambda p: p.stem.lower(),
    )


def _find_song(stem: str) -> Path:
    for p in _list_songs():
        if p.stem == stem:
            return p
    raise HTTPException(404, "Canción no encontrada")


# ---------------------------------------------------------------------------
# Canciones
# ---------------------------------------------------------------------------

@app.get("/api/canciones")
def api_canciones():
    canciones = []
    for p in _list_songs():
        canciones.append({
            "nombre": p.name,
            "stem": p.stem,
            "duracion": _obtener_duracion(p),
            "tiene_letra": _lyrics_path_for(p.stem).is_file(),
            "tiene_sync": _sync_cache_path_for(p.stem).is_file(),
        })
    return {"canciones": canciones}


class DescargaRequest(BaseModel):
    url: str
    nombre: Optional[str] = None


@app.post("/api/descargar")
def api_descargar(payload: DescargaRequest):
    if not is_url(payload.url):
        raise HTTPException(400, "La fuente debe ser una URL válida (YouTube, etc.)")
    try:
        resultado = resolve_audio_source(
            payload.url, output_dir=str(CANCIONES_DIR), filename=payload.nombre or None
        )
        return {"status": "ok", "archivo": resultado.name}
    except Exception as e:
        # Los errores del recurso (DRM, video privado, edad, etc.) son 422:
        # el servidor entendió la petición pero el recurso remoto no está
        # disponible. Reservamos 500 para fallos internos reales.
        msg = str(e).lower()
        if any(k in msg for k in ("drm", "sign in", "age", "confirm", "protegido")):
            raise HTTPException(422, str(e))
        raise HTTPException(500, str(e))


# ---------------------------------------------------------------------------
# Letras
# ---------------------------------------------------------------------------

@app.get("/api/letra/{stem}")
def api_obtener_letra(stem: str):
    path = _lyrics_path_for(stem)
    if not path.is_file():
        return {"existe": False, "texto": ""}
    return {"existe": True, "texto": path.read_text(encoding="utf-8")}


class LetraRequest(BaseModel):
    texto: str


@app.post("/api/letra/{stem}")
def api_guardar_letra(stem: str, payload: LetraRequest):
    _find_song(stem)
    path = _lyrics_path_for(stem)
    path.write_text(payload.texto.strip() + "\n", encoding="utf-8")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Karaoke (sincronización letra <-> audio)
# ---------------------------------------------------------------------------

@app.get("/api/karaoke/{stem}")
def api_karaoke_cache(stem: str):
    cache = _sync_cache_path_for(stem)
    if not cache.is_file():
        return {"existe": False}
    with open(cache, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {"existe": True, "datos": data}


class SyncRequest(BaseModel):
    language: str = "es"
    model: str = "small"
    force: bool = False
    vad: Optional[str] = "auditok"
    separate_vocals: bool = True


def _vad_value(vad: Optional[str]):
    if not vad or str(vad).lower() in ("none", "no", "off", ""):
        return None
    return vad


@app.post("/api/sincronizar/{stem}")
def api_sincronizar(stem: str, payload: SyncRequest):
    song = _find_song(stem)
    lyrics_path = _lyrics_path_for(stem)
    if not lyrics_path.is_file():
        raise HTTPException(400, "Esta canción no tiene letra guardada todavía.")

    def _tarea(progress_cb):
        return align_lyrics_to_audio(
            str(song), str(lyrics_path),
            language=payload.language, model_name=payload.model, force=payload.force,
            vad=_vad_value(payload.vad), separate_vocals=payload.separate_vocals,
            progress_cb=progress_cb,
        )

    job_id = _start_job(_tarea)
    return {"job_id": job_id}


# ---------------------------------------------------------------------------
# Video estilo TikTok
# ---------------------------------------------------------------------------

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


@app.post("/api/video/{stem}")
def api_generar_video(stem: str, payload: VideoRequest):
    song = _find_song(stem)
    lyrics_path = _lyrics_path_for(stem)
    if not lyrics_path.is_file():
        raise HTTPException(400, "Esta canción no tiene letra guardada todavía.")

    output_name = (payload.nombre_salida or stem).strip() or stem
    output_path = VIDEOS_DIR / f"{output_name}.mp4"

    def _tarea(progress_cb):
        tiktok_generator.create_tiktok_video(
            str(song), str(lyrics_path), str(output_path),
            language=payload.language, model=payload.model, force_sync=payload.force_sync,
            start_time=payload.start_time, end_time=payload.end_time,
            title=payload.titulo or stem, artist=payload.artista,
            vad=_vad_value(payload.vad), separate_vocals=payload.separate_vocals,
            progress_cb=progress_cb,
        )
        return {"video": output_path.name}

    job_id = _start_job(_tarea)
    return {"job_id": job_id}


@app.get("/api/videos")
def api_videos():
    if not VIDEOS_DIR.is_dir():
        return {"videos": []}
    return {"videos": sorted(p.name for p in VIDEOS_DIR.iterdir() if p.suffix.lower() == ".mp4")}


# ---------------------------------------------------------------------------
# Compatibilidad con el endpoint que usaba la interfaz anterior
# ---------------------------------------------------------------------------

@app.get("/lista_canciones")
def lista_canciones_legacy():
    return api_canciones()

# ---------------------------------------------------------------------------
# Spotify Integración (OAuth2)
# ---------------------------------------------------------------------------

SPOTIFY_CACHE = BASE_DIR / "spotify_auth.json"

def _load_spotify_token():
    if SPOTIFY_CACHE.is_file():
        return json.loads(SPOTIFY_CACHE.read_text())
    return None

def _save_spotify_token(data):
    SPOTIFY_CACHE.write_text(json.dumps(data))

@app.get("/api/spotify/login")
def spotify_login():
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    if not client_id:
        raise HTTPException(500, "Falta SPOTIFY_CLIENT_ID en .env")
    redirect_uri = "http://127.0.0.1:8000/callback"
    # user-top-read: top tracks/artists (favoritas y recap).
    # playlist-read-private: leer playlists privadas del usuario.
    # playlist-read-collaborative: leer playlists colaborativas.
    scope = "user-top-read playlist-read-private playlist-read-collaborative"
    url = (
        "https://accounts.spotify.com/authorize"
        f"?client_id={client_id}&response_type=code"
        f"&redirect_uri={urllib.parse.quote(redirect_uri)}"
        f"&scope={urllib.parse.quote(scope)}"
    )
    return RedirectResponse(url)

@app.get("/callback")
def spotify_callback(code: str):
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    redirect_uri = "http://127.0.0.1:8000/callback"
    
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }).encode("utf-8")
    
    auth_b64 = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    
    req = urllib.request.Request("https://accounts.spotify.com/api/token", data=data, method="POST")
    req.add_header("Authorization", f"Basic {auth_b64}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    
    try:
        with urllib.request.urlopen(req) as response:
            token_data = json.loads(response.read().decode("utf-8"))
            _save_spotify_token(token_data)
            return RedirectResponse("/#view-spotify")
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode("utf-8")}
    except Exception as e:
        return {"error": str(e)}

def _refresh_spotify_token(refresh_token: str):
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }).encode("utf-8")
    
    auth_b64 = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    
    req = urllib.request.Request("https://accounts.spotify.com/api/token", data=data, method="POST")
    req.add_header("Authorization", f"Basic {auth_b64}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    
    with urllib.request.urlopen(req) as response:
        new_data = json.loads(response.read().decode("utf-8"))
        if "refresh_token" not in new_data:
            new_data["refresh_token"] = refresh_token
        _save_spotify_token(new_data)
        return new_data["access_token"]

def _spotify_request(endpoint: str, method: str = "GET", body=None):
    token_data = _load_spotify_token()
    if not token_data or "access_token" not in token_data:
        raise HTTPException(401, "No has iniciado sesión en Spotify")
        
    access_token = token_data["access_token"]
    
    def make_req(tk):
        url = f"https://api.spotify.com/{endpoint}"
        req = urllib.request.Request(url, method=method)
        req.add_header("Authorization", f"Bearer {tk}")
        if body is not None:
            req.add_header("Content-Type", "application/json")
            req.data = json.dumps(body).encode("utf-8")
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode("utf-8"))
            
    try:
        return make_req(access_token)
    except urllib.error.HTTPError as e:
        if e.code == 401 and "refresh_token" in token_data:
            try:
                new_token = _refresh_spotify_token(token_data["refresh_token"])
                return make_req(new_token)
            except Exception as refresh_err:
                raise HTTPException(401, f"Sesión expirada y no se pudo renovar.")
        err_msg = e.read().decode("utf-8")
        raise HTTPException(e.code, f"Error de Spotify: {err_msg}")
    except Exception as e:
        raise HTTPException(500, f"Fallo al conectar con Spotify: {str(e)}")

_TIME_RANGES = {"short_term", "medium_term", "long_term"}


def _norm_time_range(tr: str) -> str:
    """Valida y normaliza el parámetro time_range de Spotify."""
    return tr if tr in _TIME_RANGES else "long_term"


@app.get("/api/spotify/top")
def api_spotify_top(limit: int = 20, time_range: str = "long_term"):
    """Top tracks. time_range: short_term (4 semanas) | medium_term (6 meses) | long_term (años)."""
    tr = _norm_time_range(time_range)
    return _spotify_request(f"v1/me/top/tracks?time_range={tr}&limit={limit}")


@app.get("/api/spotify/top-artists")
def api_spotify_top_artists(limit: int = 10, time_range: str = "long_term"):
    tr = _norm_time_range(time_range)
    return _spotify_request(f"v1/me/top/artists?time_range={tr}&limit={limit}")


@app.get("/api/spotify/playlists")
def api_spotify_playlists(limit: int = 50):
    """Playlists del usuario (propias y guardadas)."""
    return _spotify_request(f"v1/me/playlists?limit={limit}")


@app.get("/api/spotify/playlist/{playlist_id}/tracks")
def api_spotify_playlist_tracks(playlist_id: str):
    """Canciones de una playlist. El endpoint dedicado /v1/playlists/{id}/tracks
    devuelve 403 en apps sin extended quota mode (restricción de la Web API
    de nov. 2024). Usamos /v1/playlists/{id} que sí incluye las canciones
    embebidas bajo un paginador anidado (items.items[].item), y las
    aplanamos al shape uniforme {items: [{track: ...}]} que espera el
    frontend."""
    # Pedimos también items.total porque /me/playlists devuelve tracks:null
    # y necesitamos el conteo real para mostrarlo en la UI.
    fields = "items(total,items(item(id,name,artists(name),album(images),preview_url)))"
    res = _spotify_request(
        f"v1/playlists/{playlist_id}?fields={urllib.parse.quote(fields)}"
    )
    paginator = res.get("items") or {}
    inner = paginator.get("items") or []
    return {
        "total": paginator.get("total") if paginator.get("total") is not None else len(inner),
        "items": [{"track": entry.get("item")} for entry in inner if entry.get("item")],
    }
