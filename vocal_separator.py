"""
vocal_separator.py
=====================
Aísla la pista de voz de una canción usando Demucs. Transcribir solo la voz
(en vez de la mezcla completa) reduce drásticamente las "alucinaciones" de
Whisper sobre secciones instrumentales y mejora mucho la precisión de los
tiempos, que es la clave para una sincronía casi perfecta del karaoke.

El resultado se cachea en vocals/<nombre>.vocals.wav y
vocals/<nombre>.instrumental.wav para no volver a separar la misma canción
(Demucs es costoso en CPU).

Uso como librería:
    from vocal_separator import separate_vocals
    vocals_path = separate_vocals("canciones/cancion.mp3")
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
VOCALS_DIR = BASE_DIR / "vocals"

DEFAULT_MODEL = "htdemucs"


def _cached_vocals_path(audio_path: Path) -> Path:
    return VOCALS_DIR / f"{audio_path.stem}.vocals.wav"


def _cached_instrumental_path(audio_path: Path) -> Path:
    return VOCALS_DIR / f"{audio_path.stem}.instrumental.wav"


def _is_current(cache_path: Path, audio_path: Path) -> bool:
    try:
        return cache_path.is_file() and cache_path.stat().st_mtime >= audio_path.stat().st_mtime
    except OSError:
        return False


def separate_stems(audio_path: str, model: str = DEFAULT_MODEL, force: bool = False) -> tuple[Path, Path]:
    """
    Separa voz e instrumental y devuelve ambas rutas .wav.
    La caché se considera válida solo si los dos stems corresponden al audio
    actual: así una instalación previa que guardó solo la voz se actualiza al
    primer uso del modo karaoke.
    """
    audio_path = Path(audio_path)
    if not audio_path.is_file():
        raise FileNotFoundError(f"No existe el audio: {audio_path}")

    VOCALS_DIR.mkdir(parents=True, exist_ok=True)
    cached_vocals = _cached_vocals_path(audio_path)
    cached_instrumental = _cached_instrumental_path(audio_path)

    if not force and _is_current(cached_vocals, audio_path) and _is_current(cached_instrumental, audio_path):
        print(f"Usando stems cacheados: {cached_vocals}")
        return cached_vocals, cached_instrumental

    print(f"Separando la voz con Demucs ('{model}'), esto puede tardar un poco...")
    with tempfile.TemporaryDirectory() as tmpdir:
        # --two-stems=vocals genera vocals.wav (voz) y no_vocals.wav (pista).
        cmd = [
            sys.executable, "-m", "demucs",
            "--two-stems=vocals",
            "-n", model,
            "-o", tmpdir,
            str(audio_path),
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                "Demucs falló al separar la voz.\n" + (result.stdout or "")[-1500:]
            )

        produced_vocals = Path(tmpdir) / model / audio_path.stem / "vocals.wav"
        produced_instrumental = Path(tmpdir) / model / audio_path.stem / "no_vocals.wav"
        if not produced_vocals.is_file() or not produced_instrumental.is_file():
            # Buscar por si el nombre de la subcarpeta difiere
            vocal_matches = list(Path(tmpdir).glob(f"{model}/*/vocals.wav"))
            instrumental_matches = list(Path(tmpdir).glob(f"{model}/*/no_vocals.wav"))
            if not vocal_matches or not instrumental_matches:
                raise RuntimeError("Demucs terminó pero no se encontraron los stems de voz e instrumental.")
            produced_vocals = vocal_matches[0]
            produced_instrumental = instrumental_matches[0]

        shutil.move(str(produced_vocals), str(cached_vocals))
        shutil.move(str(produced_instrumental), str(cached_instrumental))

    print(f"Stems guardados en: {cached_vocals} y {cached_instrumental}")
    return cached_vocals, cached_instrumental


def separate_vocals(audio_path: str, model: str = DEFAULT_MODEL, force: bool = False) -> Path:
    """Compatibilidad con la sincronización: devuelve solo el stem vocal."""
    vocals, _ = separate_stems(audio_path, model=model, force=force)
    return vocals


def separate_instrumental(audio_path: str, model: str = DEFAULT_MODEL, force: bool = False) -> Path:
    """Devuelve la instrumental sin voz, preparándola con Demucs si hace falta."""
    _, instrumental = separate_stems(audio_path, model=model, force=force)
    return instrumental


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Aísla la voz de una canción con Demucs.")
    parser.add_argument("audio", help="Ruta al audio (mp3, wav, etc.)")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help="Modelo Demucs (htdemucs, htdemucs_ft, mdx_extra...)")
    parser.add_argument("--force", action="store_true", help="Fuerza re-separación aunque exista cache.")
    args = parser.parse_args()

    path = separate_vocals(args.audio, model=args.model, force=args.force)
    print(path)
