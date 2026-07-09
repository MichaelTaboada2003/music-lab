"""
audio_downloader.py
======================
Descarga audio desde una URL (YouTube, SoundCloud, etc. - lo que soporte
yt-dlp) y lo convierte a MP3 usando ffmpeg. Pensado para usarse con audio
del que tienes derechos (contenido propio, licencia libre/Creative Commons,
dominio público) o con la librería de sonidos con licencia de la propia
plataforma donde vayas a publicar. Descargar y republicar música protegida
por derechos de autor sin autorización no es responsabilidad de esta
herramienta, sino de cómo la uses.

Uso como script:
    python audio_downloader.py "https://youtube.com/watch?v=..." -o descargas

Uso como librería:
    from audio_downloader import download_audio, is_url
    path = download_audio("https://youtube.com/watch?v=...")
"""

import argparse
import re
from pathlib import Path

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def is_url(value: str) -> bool:
    """True si el string parece una URL (http/https) o un ytsearch, False si es una ruta local."""
    val = value.strip()
    return bool(_URL_RE.match(val)) or val.startswith("ytsearch:")


def download_audio(url: str, output_dir: str = ".", filename: str = None,
                    force: bool = False, quiet: bool = False) -> Path:
    """
    Descarga el audio de una URL y lo deja como .mp3 en output_dir.
    Si el archivo de destino ya existe y force=False, no vuelve a descargar
    (evita re-bajar la misma canción cada vez que corres el script).

    Devuelve la ruta (Path) al archivo .mp3 resultante.
    """
    if yt_dlp is None:
        raise RuntimeError(
            "yt-dlp no está instalado. Instálalo con: pip install yt-dlp"
        )

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if filename:
        stem = Path(filename).stem
        target = output_dir / f"{stem}.mp3"
        if target.is_file() and not force:
            print(f"El audio ya existe, usando cache: {target}")
            return target
        outtmpl = str(output_dir / f"{stem}.%(ext)s")
    else:
        outtmpl = str(output_dir / "%(title)s.%(ext)s")

    base_opts = {
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        "noplaylist": True,
        "quiet": quiet,
        "no_warnings": quiet,
    }

    # YouTube ha ido restringiendo el cliente "web" (SABR streaming, formatos
    # sin url). Probamos varios clientes alternativos como fallback.
    client_attempts = [None, "android", "ios", "tv"]
    last_error = None

    print(f"Descargando audio de: {url}")
    for client in client_attempts:
        ydl_opts = dict(base_opts)
        if client:
            ydl_opts["extractor_args"] = {"youtube": {"player_client": [client]}}
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                if filename:
                    result_path = target
                else:
                    base = ydl.prepare_filename(info)
                    result_path = Path(base).with_suffix(".mp3")
            if result_path.is_file():
                print(f"Audio listo: {result_path}")
                return result_path
        except yt_dlp.utils.DownloadError as e:
            last_error = e
            if client:
                print(f"Falló con cliente '{client}', probando siguiente opción...")
            continue

    raise RuntimeError(
        f"No se pudo descargar el audio tras varios intentos. Último error: {last_error}"
    )


def resolve_audio_source(source: str, output_dir: str = ".", filename: str = None,
                          force: bool = False) -> Path:
    """
    Punto de entrada único: si `source` es una URL, la descarga y devuelve
    la ruta local del mp3. Si ya es una ruta local, la devuelve tal cual
    (validando que exista).
    """
    if is_url(source):
        return download_audio(source, output_dir=output_dir, filename=filename, force=force)

    path = Path(source)
    if not path.is_file():
        raise FileNotFoundError(f"El archivo de audio '{source}' no existe.")
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Descarga audio desde una URL (YouTube y similares) y lo convierte a MP3."
    )
    parser.add_argument("url", help="URL del video/audio a descargar.")
    parser.add_argument("-o", "--output-dir", default=".", help="Carpeta de destino.")
    parser.add_argument("-f", "--filename", default=None, help="Nombre base del archivo (sin extensión).")
    parser.add_argument("--force", action="store_true", help="Fuerza re-descarga aunque ya exista el mp3.")

    args = parser.parse_args()
    download_audio(args.url, output_dir=args.output_dir, filename=args.filename, force=args.force)
