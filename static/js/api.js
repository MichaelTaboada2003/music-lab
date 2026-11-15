// ============================================================
// api.js — cliente HTTP, helpers de UI compartidos
// ============================================================

export const API = ""; // mismo origen que el servidor

/** Extrae el mensaje de error del backend aunque la respuesta no sea JSON
 *  (un 502 del proxy o un 500 en texto plano rompían `res.json()`). */
async function _errorFrom(res) {
  try {
    const data = await res.json();
    const detail = data?.detail;
    if (typeof detail === "string") return new Error(detail);
    if (Array.isArray(detail) && detail.length) {
      return new Error(detail.map((d) => d.msg || String(d)).join(" · "));
    }
  } catch {
    // Cuerpo vacío o no JSON: se usa el texto de estado.
  }
  return new Error(res.statusText || `Error ${res.status}`);
}

export async function apiGet(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw await _errorFrom(res);
  return res.json();
}

export async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw await _errorFrom(res);
  return res.json();
}

export function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status-box" + (kind ? " " + kind : "");
}

/** Escapa texto para interpolarlo en innerHTML. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** Sondea un job en background hasta que termina.
 *  Cada consulta espera a la anterior (un servidor ocupado renderizando no
 *  acumula peticiones) y un fallo de red aislado no cancela el seguimiento:
 *  solo se rinde tras varios fallos seguidos. Devuelve una función para parar. */
export function pollJob(jobId, { onDone, onError, onTick }) {
  let stopped = false;
  let failures = 0;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const job = await apiGet(`/api/job/${jobId}`);
      if (stopped) return;
      failures = 0;
      if (onTick) onTick(job);
      if (job.status === "done") return onDone(job.result);
      if (job.status === "error") return onError(job.error);
    } catch (e) {
      failures += 1;
      if (failures >= 5 || /no encontrado/i.test(e.message)) return onError(e.message);
    }
    timer = setTimeout(tick, failures ? 1500 : 700);
  };
  timer = setTimeout(tick, 350);
  return () => { stopped = true; clearTimeout(timer); };
}

export function waitForJob(jobId) {
  return new Promise((resolve, reject) => {
    pollJob(jobId, { onDone: resolve, onError: reject });
  });
}

/** Refleja el progreso de un job en la barra .job-progress de un paso.
 *  prefix: "sync" | "video" — coincide con los IDs del HTML. */
export function renderProgress(prefix, job) {
  const box = document.getElementById(prefix + "Progress");
  if (!box) return;
  const phase = document.getElementById(prefix + "ProgressPhase");
  const pctEl = document.getElementById(prefix + "ProgressPct");
  const fill = document.getElementById(prefix + "ProgressFill");
  const p = (job && job.progress) || null;
  if (!p) return;
  box.hidden = false;
  phase.textContent = p.phase || "";
  if (p.pct === null || p.pct === undefined) {
    box.classList.add("indeterminate");
    pctEl.textContent = "";
    fill.style.width = "100%";
  } else {
    box.classList.remove("indeterminate");
    pctEl.textContent = Math.round(p.pct) + "%";
    fill.style.width = Math.min(100, Math.max(0, p.pct)) + "%";
  }
}

export function hideProgress(prefix) {
  const box = document.getElementById(prefix + "Progress");
  if (box) box.hidden = true;
}

export function formatSeconds(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Rellena un <select> de canciones y llama onChange si cambia la selección.
 *  `filter` (opcional) es un predicado sobre cada canción de /api/canciones,
 *  para vistas que solo trabajan con una parte de la biblioteca. */
export async function refreshSongSelect(selectEl, onChange, filter) {
  try {
    const data = await apiGet("/api/canciones");
    const previous = selectEl.value;
    const canciones = filter ? data.canciones.filter(filter) : data.canciones;
    selectEl.innerHTML = "";
    canciones.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.stem;
      opt.textContent =
        [c.title || c.stem, c.artist].filter(Boolean).join(" · ") +
        (c.tiene_letra ? " · letra" : "") +
        (c.tiene_sync ? " · karaoke" : "");
      selectEl.appendChild(opt);
    });
    if (previous && canciones.some((c) => c.stem === previous)) {
      selectEl.value = previous;
    } else if (onChange) {
      // También cuando la lista queda vacía: la vista necesita saberlo para
      // limpiarse en vez de seguir mostrando la canción anterior.
      onChange();
    }
  } catch (e) {
    console.error(e);
  }
}
