"""
app.jobs
============
Gestor simple de tareas largas en background (sincronización, generación
de video). Cada job vive en un dict en memoria protegido por un Lock. Es
suficiente mientras la app corre en un solo proceso; si se escala a
múltiples workers habría que mover esto a Redis o similar.

Uso:
    from app.jobs import start_job, router as jobs_router

    def tarea(progress_cb):
        progress_cb("Preparando", 0)
        ...
        return {"resultado": ...}

    job_id = start_job(tarea)
"""

import threading
import time
import uuid

from fastapi import APIRouter, HTTPException

_jobs: dict = {}
_jobs_lock = threading.Lock()
_active_keys: dict[str, str] = {}
JOB_RETENTION_SECONDS = 4 * 60 * 60


def _cleanup_locked(now: float) -> None:
    """Evita que el historial de tareas crezca durante sesiones largas."""
    expired = [
        job_id
        for job_id, job in _jobs.items()
        if job["status"] != "running"
        and job.get("finished_at")
        and now - job["finished_at"] > JOB_RETENTION_SECONDS
    ]
    for job_id in expired:
        _jobs.pop(job_id, None)


def start_job(fn, key: str | None = None) -> str:
    """Lanza `fn(progress_cb)` en un hilo. `progress_cb(phase: str, pct: float | None)`
    permite a la tarea reportar en qué fase está y (si se conoce) qué porcentaje
    lleva. Cuando pct es None, el frontend muestra una barra indeterminada.
    """
    now = time.time()
    with _jobs_lock:
        _cleanup_locked(now)
        if key and (active_id := _active_keys.get(key)):
            active = _jobs.get(active_id)
            if active and active["status"] == "running":
                return active_id
            _active_keys.pop(key, None)

        job_id = uuid.uuid4().hex
        _jobs[job_id] = {
            "status": "running", "result": None, "error": None,
            "progress": {"phase": "En cola", "pct": None},
            "created_at": now, "finished_at": None, "key": key,
        }
        if key:
            _active_keys[key] = job_id

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
                job = _jobs[job_id]
                job["status"] = "done"
                job["result"] = result
                job["progress"] = {"phase": "Listo", "pct": 100}
                job["finished_at"] = time.time()
        except Exception as e:
            with _jobs_lock:
                job = _jobs[job_id]
                job["status"] = "error"
                job["error"] = str(e).strip() or e.__class__.__name__
                job["finished_at"] = time.time()
        finally:
            if key:
                with _jobs_lock:
                    if _active_keys.get(key) == job_id:
                        _active_keys.pop(key, None)

    threading.Thread(target=target, daemon=True).start()
    return job_id


router = APIRouter(tags=["jobs"])


@router.get("/api/job/{job_id}")
def api_job_status(job_id: str):
    with _jobs_lock:
        _cleanup_locked(time.time())
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job no encontrado")
    return {name: value for name, value in job.items() if name != "key"}
