"""
Endpoints y cliente OAuth2 para la sección Descubrir (Spotify Web API).

Endpoints expuestos:
  - GET /api/spotify/login                       → redirige al flow OAuth
  - GET /callback                                 → recibe el code y guarda tokens
  - GET /api/spotify/top?limit&time_range         → top tracks del usuario
  - GET /api/spotify/top-artists?limit&time_range → top artists
  - GET /api/spotify/playlists?limit              → playlists del usuario
  - GET /api/spotify/playlist/{id}/tracks         → tracks (embebidos, ver notas)

Notas de restricciones de la Web API (Nov. 2024):
  - /v1/playlists/{id}/tracks responde 403 en apps sin extended quota mode.
    Usamos /v1/playlists/{id} con `fields` que sí incluye los tracks
    embebidos y los aplanamos al shape uniforme.
  - /v1/me/playlists devuelve tracks:null; el conteo real solo se obtiene
    al pedir la playlist individual.
"""

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse

from ..config import SPOTIFY_CACHE, SPOTIFY_REDIRECT_URI

router = APIRouter(tags=["spotify"])


# ---------------------------------------------------------------------------
# Manejo del token cacheado en disco (spotify_auth.json)
# ---------------------------------------------------------------------------

def _load_token():
    if SPOTIFY_CACHE.is_file():
        return json.loads(SPOTIFY_CACHE.read_text())
    return None


def _save_token(data):
    SPOTIFY_CACHE.write_text(json.dumps(data))


def _refresh_token(refresh_token: str):
    """Cambia un refresh_token por un access_token nuevo. Guarda el par
    actualizado en disco; conserva el refresh_token si Spotify no manda uno."""
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")

    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }).encode("utf-8")

    auth_b64 = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()

    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token", data=data, method="POST"
    )
    req.add_header("Authorization", f"Basic {auth_b64}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urllib.request.urlopen(req, timeout=12) as response:
        new_data = json.loads(response.read().decode("utf-8"))
        if "refresh_token" not in new_data:
            new_data["refresh_token"] = refresh_token
        _save_token(new_data)
        return new_data["access_token"]


def _api_request(endpoint: str, method: str = "GET", body=None):
    """Llamada autenticada a la Web API de Spotify con retry automático en
    401 (refresca token y reintenta una sola vez)."""
    token_data = _load_token()
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
        with urllib.request.urlopen(req, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))

    try:
        return make_req(access_token)
    except urllib.error.HTTPError as e:
        if e.code == 401 and "refresh_token" in token_data:
            try:
                new_token = _refresh_token(token_data["refresh_token"])
                return make_req(new_token)
            except Exception:
                raise HTTPException(401, "Sesión expirada y no se pudo renovar.")
        err_msg = e.read().decode("utf-8")
        raise HTTPException(e.code, f"Error de Spotify: {err_msg}")
    except Exception as e:
        raise HTTPException(500, f"Fallo al conectar con Spotify: {str(e)}")


# ---------------------------------------------------------------------------
# OAuth: login + callback
# ---------------------------------------------------------------------------

@router.get("/api/spotify/login")
def spotify_login():
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    if not client_id:
        raise HTTPException(500, "Falta SPOTIFY_CLIENT_ID en .env")
    # user-top-read: top tracks/artists (favoritas y recap).
    # playlist-read-private: leer playlists privadas del usuario.
    # playlist-read-collaborative: leer playlists colaborativas.
    scope = "user-top-read playlist-read-private playlist-read-collaborative"
    url = (
        "https://accounts.spotify.com/authorize"
        f"?client_id={client_id}&response_type=code"
        f"&redirect_uri={urllib.parse.quote(SPOTIFY_REDIRECT_URI)}"
        f"&scope={urllib.parse.quote(scope)}"
    )
    return RedirectResponse(url)


@router.get("/callback")
def spotify_callback(code: str):
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")

    data = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": SPOTIFY_REDIRECT_URI,
    }).encode("utf-8")

    auth_b64 = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()

    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token", data=data, method="POST"
    )
    req.add_header("Authorization", f"Basic {auth_b64}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            token_data = json.loads(response.read().decode("utf-8"))
            _save_token(token_data)
            return RedirectResponse("/#view-spotify")
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode("utf-8")}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Descubrir: top tracks/artists, playlists
# ---------------------------------------------------------------------------

_TIME_RANGES = {"short_term", "medium_term", "long_term"}


def _norm_time_range(tr: str) -> str:
    """Valida y normaliza el parámetro time_range de Spotify."""
    return tr if tr in _TIME_RANGES else "long_term"


@router.get("/api/spotify/top")
def api_spotify_top(limit: int = 20, time_range: str = "long_term"):
    """Top tracks. time_range: short_term (4 semanas) | medium_term (6 meses) | long_term (años)."""
    tr = _norm_time_range(time_range)
    return _api_request(f"v1/me/top/tracks?time_range={tr}&limit={limit}")


@router.get("/api/spotify/top-artists")
def api_spotify_top_artists(limit: int = 10, time_range: str = "long_term"):
    tr = _norm_time_range(time_range)
    return _api_request(f"v1/me/top/artists?time_range={tr}&limit={limit}")


@router.get("/api/spotify/playlists")
def api_spotify_playlists(limit: int = 50):
    """Playlists del usuario (propias y guardadas)."""
    return _api_request(f"v1/me/playlists?limit={limit}")


@router.get("/api/spotify/playlist/{playlist_id}/tracks")
def api_spotify_playlist_tracks(playlist_id: str):
    """Canciones de una playlist. El endpoint dedicado /v1/playlists/{id}/tracks
    devuelve 403 en apps sin extended quota mode (restricción de la Web API
    de nov. 2024). Usamos /v1/playlists/{id} que sí incluye las canciones
    embebidas bajo un paginador anidado (items.items[].item), y las
    aplanamos al shape uniforme {items: [{track: ...}]} que espera el
    frontend. Devolvemos también `total` para el header del sub-view."""
    fields = "items(total,items(item(id,name,artists(name),album(images),preview_url)))"
    res = _api_request(
        f"v1/playlists/{playlist_id}?fields={urllib.parse.quote(fields)}"
    )
    paginator = res.get("items") or {}
    inner = paginator.get("items") or []
    return {
        "total": paginator.get("total") if paginator.get("total") is not None else len(inner),
        "items": [{"track": entry.get("item")} for entry in inner if entry.get("item")],
    }
