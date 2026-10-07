"""
Administración de la biblioteca (canciones, letras y stems).
  - GET    /api/biblioteca                        → inventario por canción + totales
  - POST   /api/biblioteca/eliminar               → mueve partes a la papelera
  - POST   /api/biblioteca/huerfanos/eliminar     → mueve archivos sin canción
  - GET    /api/biblioteca/papelera               → elementos en la papelera
  - POST   /api/biblioteca/papelera/{id}/restaurar
  - DELETE /api/biblioteca/papelera/{id}          → eliminación definitiva
  - DELETE /api/biblioteca/papelera               → vaciar
"""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import library_manager

router = APIRouter(tags=["biblioteca"])

Part = Literal["audio", "lyrics", "sync", "vocals", "instrumental"]


class DeleteItem(BaseModel):
    stem: str = Field(min_length=1, max_length=400)
    parts: list[Part] = Field(min_length=1)


class DeleteRequest(BaseModel):
    items: list[DeleteItem] = Field(min_length=1, max_length=500)


class OrphanFile(BaseModel):
    dir: Literal["letras", "vocals"]
    name: str = Field(min_length=1, max_length=500)


class OrphanRequest(BaseModel):
    files: list[OrphanFile] = Field(min_length=1, max_length=500)


def _guard(call):
    try:
        return call()
    except library_manager.LibraryError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/api/biblioteca")
def api_biblioteca():
    data = library_manager.inventory()
    data["trash"] = library_manager.list_trash()
    return data


@router.post("/api/biblioteca/eliminar")
def api_biblioteca_eliminar(payload: DeleteRequest):
    def run():
        entries = []
        for item in payload.items:
            entry = library_manager.delete_parts(item.stem, list(item.parts))
            if entry:
                entries.append(entry)
        return {"entries": entries, "freed": sum(e.get("size", 0) for e in entries)}
    return _guard(run)


@router.post("/api/biblioteca/huerfanos/eliminar")
def api_biblioteca_huerfanos(payload: OrphanRequest):
    def run():
        entry = library_manager.delete_orphans([f.model_dump() for f in payload.files])
        return {"entries": [entry] if entry else [], "freed": entry.get("size", 0) if entry else 0}
    return _guard(run)


@router.get("/api/biblioteca/papelera")
def api_papelera():
    return {"entries": library_manager.list_trash()}


@router.post("/api/biblioteca/papelera/{entry_id}/restaurar")
def api_papelera_restaurar(entry_id: str):
    return _guard(lambda: library_manager.restore(entry_id))


@router.delete("/api/biblioteca/papelera/{entry_id}")
def api_papelera_purgar(entry_id: str):
    return {"freed": _guard(lambda: library_manager.purge(entry_id))}


@router.delete("/api/biblioteca/papelera")
def api_papelera_vaciar():
    return {"freed": _guard(library_manager.empty_trash)}
