"""
music_lab.py
================
Lanzador de Music Lab: arranca el servidor FastAPI y abre la interfaz web
en el navegador. Toda la funcionalidad (descargar canciones, escribir
letras, sincronizar karaoke, generar videos y reproducir música) vive en
la interfaz web servida por app.py.

Config por entorno:
    APP_HOST (default 127.0.0.1)
    APP_PORT (default 8000)
    APP_BASE_URL — si difiere de http://APP_HOST:APP_PORT (ej. detrás de
    un proxy), setéalo también para que el OAuth de Spotify funcione.

Uso:
    python music_lab.py
"""

import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Carga .env manualmente para que el lanzador respete la misma config
# que app.py cuando lo importan como módulo.
env_file = BASE_DIR / ".env"
if env_file.is_file():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

HOST = os.environ.get("APP_HOST", "127.0.0.1")
PORT = os.environ.get("APP_PORT", "8000")
URL = os.environ.get("APP_BASE_URL", f"http://{HOST}:{PORT}").rstrip("/")


def main():
    print(f"Iniciando Music Lab en {URL}")
    print("Presiona Ctrl+C para detener el servidor.")

    proceso = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", HOST, "--port", PORT],
        cwd=str(BASE_DIR),
    )

    # Dar un momento al servidor antes de abrir el navegador.
    time.sleep(1.5)
    webbrowser.open(URL)

    try:
        proceso.wait()
    except KeyboardInterrupt:
        print("\nDeteniendo servidor...")
        proceso.terminate()


if __name__ == "__main__":
    main()
