"""
Sirve el HTML de la SPA con cache-busting basado en mtime, para que los
navegadores siempre recojan la última versión de js/main.js y style.css
tras un cambio.
"""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from ..config import STATIC_DIR

router = APIRouter(tags=["frontend"])


@router.get("/")
def index():
    """Sirve el index inyectando ?v=<mtime> en los assets principales para
    que el navegador descargue siempre la versión más reciente sin hard-reload.
    Cubre style.css y el módulo de entrada js/main.js."""
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    # Pares (ruta en HTML, ruta en disco)
    assets = [
        ("/static/style.css",     STATIC_DIR / "style.css"),
        ("/static/js/main.js",    STATIC_DIR / "js" / "main.js"),
    ]
    for href, disk_path in assets:
        if disk_path.is_file():
            version = int(disk_path.stat().st_mtime)
            html = html.replace(href, f"{href}?v={version}")
    return HTMLResponse(
        html,
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@router.get("/favicon.ico")
def favicon():
    return {}
