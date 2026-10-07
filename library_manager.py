"""Administración de la biblioteca: inventario por canción, papelera y limpieza.

Cada canción puede tener estas partes en disco:

- ``audio``       canciones/<stem>.<ext>
- ``lyrics``      letras/<stem>.txt
- ``sync``        letras/<stem>.sync.json (derivada de la letra y del audio)
- ``vocals``      vocals/<stem>.vocals.<flac|mp3|wav>
- ``instrumental`` vocals/<stem>.instrumental.<flac|mp3|wav>

Nada se borra de forma definitiva al primer paso: los archivos se mueven a
``.papelera/<id>/`` junto con un manifiesto, de modo que se pueden restaurar.
Las cachés derivadas y baratas de regenerar (portada, calidad de audio) sí se
descartan directamente.
"""

import json
import os
import re
import secrets
import shutil
import tempfile
import threading
from datetime import datetime
from pathlib import Path

import library_artwork
import library_metadata

BASE_DIR = Path(__file__).resolve().parent
CANCIONES_DIR = BASE_DIR / "canciones"
LETRAS_DIR = BASE_DIR / "letras"
VOCALS_DIR = BASE_DIR / "vocals"
VIDEOS_DIR = BASE_DIR / "videos"
COVERS_DIR = BASE_DIR / ".covers"
TRASH_DIR = BASE_DIR / ".papelera"
QUALITY_PATH = BASE_DIR / ".audio_quality.json"

AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".webm", ".ogg")
STEM_EXTS = (".flac", ".mp3", ".wav")
PARTS = ("audio", "lyrics", "sync", "vocals", "instrumental")
PART_LABELS = {
    "audio": "audio", "lyrics": "letra", "sync": "sincronización",
    "vocals": "voz", "instrumental": "instrumental",
}

_LOCK = threading.RLock()
_STEM_SUFFIX_RE = re.compile(r"\.(vocals|instrumental)(\.flac|\.mp3|\.wav)$", re.IGNORECASE)


class LibraryError(Exception):
    """Error de validación con código HTTP sugerido."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- utilidades --

def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(_size(p) for p in path.rglob("*") if p.is_file())


def _relative(path: Path) -> str:
    return path.resolve().relative_to(BASE_DIR.resolve()).as_posix()


def _safe_stem(stem: str) -> str:
    if not stem or Path(stem).name != stem or stem.startswith("."):
        raise LibraryError("Nombre de canción no válido.")
    return stem


def _write_json(path: Path, data) -> None:
    fd, temp = tempfile.mkstemp(prefix=".manager.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


# ----------------------------------------------------------------- inventario --

def _audio_file(stem: str) -> Path | None:
    for ext in AUDIO_EXTS:
        candidate = CANCIONES_DIR / f"{stem}{ext}"
        if candidate.is_file():
            return candidate
    return None


def _stem_files(stem: str, kind: str) -> list[Path]:
    return [
        VOCALS_DIR / f"{stem}.{kind}{ext}"
        for ext in STEM_EXTS
        if (VOCALS_DIR / f"{stem}.{kind}{ext}").is_file()
    ]


def song_parts(stem: str) -> dict[str, list[Path]]:
    """Archivos existentes de cada parte de una canción."""
    audio = _audio_file(stem)
    parts = {
        "audio": [audio] if audio else [],
        "lyrics": [p for p in (LETRAS_DIR / f"{stem}.txt",) if p.is_file()],
        "sync": [p for p in (LETRAS_DIR / f"{stem}.sync.json",) if p.is_file()],
        "vocals": _stem_files(stem, "vocals"),
        "instrumental": _stem_files(stem, "instrumental"),
    }
    return parts


def _part_info(files: list[Path]):
    if not files:
        return None
    return {
        "name": files[0].name,
        "ext": files[0].suffix.lower().lstrip("."),
        "size": sum(_size(p) for p in files),
    }


def _known_files(songs: list[Path]) -> set[str]:
    known = set()
    for song in songs:
        for files in song_parts(song.stem).values():
            known.update(p.name for p in files)
    return known


def inventory() -> dict:
    """Canciones con el tamaño de cada parte, archivos huérfanos y totales."""
    songs = sorted(
        (p for p in CANCIONES_DIR.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS),
        key=lambda p: p.stem.lower(),
    ) if CANCIONES_DIR.is_dir() else []

    items, totals = [], {key: 0 for key in PARTS}
    for song in songs:
        parts = song_parts(song.stem)
        info = {key: _part_info(files) for key, files in parts.items()}
        sizes = {key: (value["size"] if value else 0) for key, value in info.items()}
        for key, size in sizes.items():
            totals[key] += size
        display = library_metadata.display_info(song.stem)
        es_recorte, _ = library_metadata.clip_info(song)
        items.append({
            "stem": song.stem,
            "title": display["title"],
            "artist": display["artist"],
            "is_clip": es_recorte,
            "parts": info,
            "total_size": sum(sizes.values()),
            "mtime": song.stat().st_mtime,
        })

    known = _known_files(songs)
    orphans = []
    for directory, label in ((LETRAS_DIR, "letras"), (VOCALS_DIR, "vocals")):
        if not directory.is_dir():
            continue
        for path in sorted(directory.iterdir()):
            if path.is_file() and not path.name.startswith(".") and path.name not in known:
                orphans.append({
                    "dir": label,
                    "name": path.name,
                    "size": _size(path),
                    "reason": _orphan_reason(path),
                })

    stems_total = totals["vocals"] + totals["instrumental"]
    return {
        "songs": items,
        "orphans": orphans,
        "totals": {
            "audio": totals["audio"],
            "lyrics": totals["lyrics"],
            "sync": totals["sync"],
            "stems": stems_total,
            "covers": _dir_size(COVERS_DIR),
            "videos": _dir_size(VIDEOS_DIR),
            "trash": _dir_size(TRASH_DIR),
            "orphans": sum(o["size"] for o in orphans),
        },
    }


def _orphan_reason(path: Path) -> str:
    name = path.name.lower()
    if _STEM_SUFFIX_RE.search(name):
        return "Stem sin canción"
    if name.endswith(".sync.json"):
        return "Sincronización sin canción"
    if "before-correction" in name or name.endswith((".bak", ".old")):
        return "Copia de seguridad"
    if name.endswith(".txt"):
        return "Letra sin canción"
    return "Archivo sin canción"


# ----------------------------------------------------------------- papelera --

def _plan(stem: str, parts: list[str]) -> tuple[list[Path], list[str]]:
    """Archivos a mover y partes efectivas, aplicando las dependencias."""
    wanted = set(parts)
    unknown = wanted - set(PARTS)
    if unknown:
        raise LibraryError(f"Parte desconocida: {', '.join(sorted(unknown))}.")
    if "audio" in wanted:
        wanted = set(PARTS)          # sin audio, el resto pierde sentido
    if "lyrics" in wanted:
        wanted.add("sync")           # la sincronización depende de la letra
    found = song_parts(stem)
    files = [p for key in PARTS if key in wanted for p in found[key]]
    return files, [key for key in PARTS if key in wanted and found[key]]


def _drop_derived_caches(stem: str, audio: Path | None) -> None:
    """Descarta portada y medición de calidad: se regeneran cuando hagan falta."""
    if audio is not None:
        library_artwork.drop_cover(audio)
    if QUALITY_PATH.is_file():
        try:
            data = json.loads(QUALITY_PATH.read_text(encoding="utf-8"))
            tracks = data.get("tracks", {})
            stale = [k for k in tracks if Path(k).stem == stem]
            if stale:
                for key in stale:
                    tracks.pop(key, None)
                _write_json(QUALITY_PATH, data)
        except (OSError, ValueError):
            pass


def _new_trash_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"


def _move_to_trash(label: str, files: list[Path], parts: list[str], state: dict | None = None) -> dict:
    entry_id = _new_trash_id()
    root = TRASH_DIR / entry_id
    manifest = {
        "id": entry_id,
        "label": label,
        "parts": parts,
        "deleted_at": datetime.now().isoformat(timespec="seconds"),
        "files": [],
        "state": state or {},
    }
    try:
        for path in files:
            rel = _relative(path)
            target = root / "files" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            size = _size(path)
            shutil.move(str(path), str(target))
            manifest["files"].append({"rel": rel, "size": size})
        manifest["size"] = sum(f["size"] for f in manifest["files"])
        root.mkdir(parents=True, exist_ok=True)
        _write_json(root / "manifest.json", manifest)
    except OSError as exc:
        # Deshace lo ya movido para no dejar la biblioteca a medias.
        for moved in manifest["files"]:
            source = root / "files" / moved["rel"]
            if source.exists():
                (BASE_DIR / moved["rel"]).parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(source), str(BASE_DIR / moved["rel"]))
        shutil.rmtree(root, ignore_errors=True)
        raise LibraryError(f"No se pudo mover a la papelera: {exc}", 500) from exc
    return manifest


def delete_parts(stem: str, parts: list[str]) -> dict | None:
    """Mueve a la papelera las partes pedidas de una canción (con sus dependencias)."""
    _safe_stem(stem)
    with _LOCK:
        files, effective = _plan(stem, parts)
        if not files:
            return None
        audio = _audio_file(stem)
        full_song = "audio" in effective
        state = {}
        if full_song:
            # Los datos editados por el usuario se guardan para poder restaurarlos.
            state["metadata"] = library_metadata.pop_override(stem)
        manifest = _move_to_trash(
            library_metadata.display_info(stem)["title"] or stem, files, effective, state)
        manifest["stem"] = stem
        _write_json(TRASH_DIR / manifest["id"] / "manifest.json", manifest)
        if full_song:
            _drop_derived_caches(stem, audio)
        return manifest


def delete_orphans(files: list[dict]) -> dict | None:
    """Mueve a la papelera archivos sin canción (carpeta + nombre)."""
    folders = {"letras": LETRAS_DIR, "vocals": VOCALS_DIR}
    paths = []
    with _LOCK:
        for item in files:
            folder = folders.get(item.get("dir"))
            name = item.get("name", "")
            if folder is None or Path(name).name != name or name.startswith("."):
                raise LibraryError("Archivo no válido.")
            path = folder / name
            if path.is_file():
                paths.append(path)
        if not paths:
            return None
        return _move_to_trash("Archivos sin canción", paths, ["orphans"], {})


def list_trash() -> list[dict]:
    entries = []
    if TRASH_DIR.is_dir():
        for folder in sorted(TRASH_DIR.iterdir(), reverse=True):
            manifest = folder / "manifest.json"
            if manifest.is_file():
                try:
                    entries.append(json.loads(manifest.read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    continue
    return entries


def _trash_folder(entry_id: str) -> Path:
    if Path(entry_id).name != entry_id or not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{4}", entry_id):
        raise LibraryError("Identificador de papelera no válido.")
    folder = TRASH_DIR / entry_id
    if not folder.is_dir():
        raise LibraryError("Ese elemento ya no está en la papelera.", 404)
    return folder


def restore(entry_id: str) -> dict:
    with _LOCK:
        folder = _trash_folder(entry_id)
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        clashes = [f["rel"] for f in manifest["files"] if (BASE_DIR / f["rel"]).exists()]
        if clashes:
            raise LibraryError(
                "No se puede restaurar: ya existe "
                + ", ".join(Path(c).name for c in clashes[:3]) + ".", 409)
        for item in manifest["files"]:
            destination = BASE_DIR / item["rel"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(folder / "files" / item["rel"]), str(destination))
        metadata = (manifest.get("state") or {}).get("metadata")
        if metadata and manifest.get("stem"):
            library_metadata.set_override(manifest["stem"], metadata)
        shutil.rmtree(folder, ignore_errors=True)
        return manifest


def purge(entry_id: str) -> int:
    """Elimina definitivamente un elemento de la papelera; devuelve bytes liberados."""
    with _LOCK:
        folder = _trash_folder(entry_id)
        try:
            freed = int(json.loads((folder / "manifest.json").read_text(encoding="utf-8")).get("size", 0))
        except (OSError, ValueError):
            freed = _dir_size(folder)
        shutil.rmtree(folder, ignore_errors=True)
        return freed


def empty_trash() -> int:
    freed = 0
    with _LOCK:
        for entry in list_trash():
            freed += purge(entry["id"])
    return freed
