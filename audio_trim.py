"""
audio_trim.py
================
Recorta un fragmento de una canción y lo guarda como un archivo nuevo con
ffmpeg. El recorte es no destructivo: el original nunca se toca. La
escritura pasa antes por un archivo oculto en la propia carpeta destino y
solo se renombra al terminar, para que la biblioteca jamás liste un
recorte a medio escribir.

Uso como script:
    python audio_trim.py "canciones/tema.mp3" --start 45 --end 75 --fade-out 1

Uso como librería:
    from audio_trim import trim_audio
    ruta = trim_audio("canciones/tema.mp3", start=45, end=75)
"""

import argparse
import re
import subprocess
from pathlib import Path
from typing import Callable, Optional, Union

# Por debajo de medio segundo el recorte deja de ser audio útil y algunos
# reproductores ni siquiera abren el archivo resultante.
MIN_DURATION = 0.5
MAX_FADE = 10.0

# Códec y contenedor por extensión de salida. El contenedor va explícito
# porque escribimos sobre un temporal ".part" del que ffmpeg no puede
# deducir el formato. Cualquier otra extensión (webm, etc.) se exporta como
# mp3, el formato común de la biblioteca.
_CODECS = {
    ".mp3": ["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"],
    ".m4a": ["-c:a", "aac", "-b:a", "192k", "-f", "ipod"],
    ".ogg": ["-c:a", "libvorbis", "-q:a", "5", "-f", "ogg"],
    ".wav": ["-c:a", "pcm_s16le", "-f", "wav"],
}
_DEFAULT_EXT = ".mp3"
# Contenedores que admiten una imagen incrustada (attached_pic).
_COVER_FORMATS = {".mp3": "mp3", ".m4a": "ipod"}
_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

ProgressCb = Optional[Callable[[str, Optional[float]], None]]


def probe_duration(audio_path: Union[str, Path]) -> float:
    """Duración total del audio en segundos (float) vía ffprobe."""
    comando = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(audio_path),
    ]
    try:
        resultado = subprocess.run(
            comando, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, check=False,
        )
        return float(resultado.stdout.strip())
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            f"No se pudo leer la duración de '{Path(audio_path).name}'. "
            "Comprueba que ffprobe esté instalado y el archivo no esté dañado."
        ) from exc


def sanitize_name(name: str) -> str:
    """Deja un nombre de archivo seguro: sin separadores de ruta ni caracteres
    prohibidos, sin espacios repetidos y acotado en longitud."""
    limpio = _INVALID_CHARS.sub(" ", name or "")
    return re.sub(r"\s+", " ", limpio).strip(" .")[:120]


def _embed_cover(audio_path: Path, cover: Path) -> bool:
    """Incrusta `cover` como carátula del archivo. El corte se hace sin pistas
    de video (la portada es una de ellas), así que se vuelve a añadir en una
    pasada aparte que copia el audio sin recodificar. Es un extra: si falla, el
    recorte se queda igual de válido, solo sin foto."""
    formato = _COVER_FORMATS.get(audio_path.suffix.lower())
    if not formato or not cover.is_file():
        return False

    temporal = audio_path.with_name(f".{audio_path.name}.cover.part")
    comando = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(audio_path), "-i", str(cover),
        "-map", "0:a", "-map", "1:v", "-c:a", "copy", "-c:v", "mjpeg",
        "-disposition:v:0", "attached_pic",
    ]
    if formato == "mp3":
        comando += ["-id3v2_version", "3", "-metadata:s:v", "title=Album cover"]
    comando += ["-f", formato, str(temporal)]

    try:
        resultado = subprocess.run(
            comando, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        temporal.unlink(missing_ok=True)
        return False

    if resultado.returncode != 0 or not temporal.is_file():
        temporal.unlink(missing_ok=True)
        return False
    temporal.replace(audio_path)
    return True


def _unique_path(directory: Path, stem: str, suffix: str) -> Path:
    """Evita pisar recortes anteriores: 'tema (recorte)', '... (2)', '... (3)'."""
    candidato = directory / f"{stem}{suffix}"
    indice = 2
    while candidato.exists():
        candidato = directory / f"{stem} ({indice}){suffix}"
        indice += 1
    return candidato


def trim_audio(
    source: Union[str, Path],
    start: float = 0.0,
    end: Optional[float] = None,
    output_dir: Union[str, Path, None] = None,
    filename: Optional[str] = None,
    fade_in: float = 0.0,
    fade_out: float = 0.0,
    cover: Union[str, Path, None] = None,
    progress_cb: ProgressCb = None,
) -> Path:
    """
    Extrae el tramo [start, end] de `source` y lo guarda como archivo nuevo.

    start / end   segundos; `end=None` recorta hasta el final de la canción.
    output_dir    carpeta destino (por defecto, la del original).
    filename      nombre base del recorte; si ya existe se numera solo.
    fade_in/out   fundidos en segundos; se recortan si no caben en el tramo.
    cover         imagen a incrustar como carátula (la del tema original).
    progress_cb   callback (fase, porcentaje) compatible con app.jobs.

    Devuelve la ruta (Path) del recorte generado.
    """
    source = Path(source)
    if not source.is_file():
        raise FileNotFoundError(f"El archivo de audio '{source}' no existe.")

    duracion = probe_duration(source)
    start = max(0.0, float(start))
    end = duracion if end is None else min(float(end), duracion)
    largo = end - start
    if largo < MIN_DURATION:
        raise ValueError(
            f"El fragmento debe durar al menos {MIN_DURATION:g} s "
            f"(inicio {start:.1f} s, fin {end:.1f} s)."
        )

    # Dos fundidos no pueden solaparse ni comerse el fragmento entero.
    fade_max = min(MAX_FADE, largo / 2)
    fade_in = min(max(0.0, float(fade_in)), fade_max)
    fade_out = min(max(0.0, float(fade_out)), fade_max)

    destino_dir = Path(output_dir) if output_dir else source.parent
    destino_dir.mkdir(parents=True, exist_ok=True)
    extension = source.suffix.lower() if source.suffix.lower() in _CODECS else _DEFAULT_EXT
    base = sanitize_name(Path(filename).stem if filename else f"{source.stem} (recorte)")
    if not base:
        raise ValueError("El nombre del recorte no es válido.")

    destino = _unique_path(destino_dir, base, extension)
    # El punto inicial lo mantiene fuera del listado de la biblioteca mientras
    # ffmpeg escribe.
    temporal = destino.with_name(f".{destino.name}.part")

    filtros = []
    if fade_in:
        filtros.append(f"afade=t=in:st=0:d={fade_in:.3f}")
    if fade_out:
        filtros.append(f"afade=t=out:st={largo - fade_out:.3f}:d={fade_out:.3f}")

    comando = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", f"{start:.3f}", "-t", f"{largo:.3f}", "-i", str(source),
        "-vn", "-map_metadata", "0",
    ]
    if filtros:
        comando += ["-af", ",".join(filtros)]
    comando += _CODECS[extension] + ["-progress", "pipe:1", str(temporal)]

    if progress_cb:
        progress_cb("Recortando audio", 0)

    try:
        proceso = subprocess.Popen(
            comando, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
    except OSError as exc:
        raise RuntimeError(
            "ffmpeg no está instalado o no está en el PATH; sin él no se puede recortar."
        ) from exc

    try:
        for linea in proceso.stdout:
            if progress_cb and linea.startswith("out_time_us="):
                try:
                    avanzado = int(linea.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                progress_cb("Recortando audio", min(99.0, avanzado / largo * 100))
        _, errores = proceso.communicate()
    except BaseException:
        proceso.kill()
        proceso.wait()
        temporal.unlink(missing_ok=True)
        raise

    if proceso.returncode != 0 or not temporal.is_file():
        detalle = (errores or "").strip().splitlines()
        temporal.unlink(missing_ok=True)
        raise RuntimeError(
            "ffmpeg no pudo generar el recorte."
            + (f" Detalle: {detalle[-1]}" if detalle else "")
        )

    temporal.replace(destino)
    if cover:
        _embed_cover(destino, Path(cover))
    if progress_cb:
        progress_cb("Recorte listo", 100)
    return destino


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Recorta un fragmento de una canción y lo guarda como archivo nuevo."
    )
    parser.add_argument("source", help="Archivo de audio a recortar.")
    parser.add_argument("-s", "--start", type=float, default=0.0, help="Segundo inicial.")
    parser.add_argument("-e", "--end", type=float, default=None, help="Segundo final (por defecto, el final).")
    parser.add_argument("-o", "--output-dir", default=None, help="Carpeta destino.")
    parser.add_argument("-f", "--filename", default=None, help="Nombre base del recorte.")
    parser.add_argument("--fade-in", type=float, default=0.0, help="Fundido de entrada en segundos.")
    parser.add_argument("--fade-out", type=float, default=0.0, help="Fundido de salida en segundos.")
    parser.add_argument("--cover", default=None, help="Imagen a incrustar como carátula del recorte.")

    args = parser.parse_args()
    ruta = trim_audio(
        args.source, start=args.start, end=args.end,
        output_dir=args.output_dir, filename=args.filename,
        fade_in=args.fade_in, fade_out=args.fade_out, cover=args.cover,
        progress_cb=lambda fase, pct: print(f"{fase}{'' if pct is None else f' {pct:.0f}%'}", end="\r"),
    )
    print(f"\nRecorte listo: {ruta}")
