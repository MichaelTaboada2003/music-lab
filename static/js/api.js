// ============================================================
// api.js — cliente HTTP, helpers de UI compartidos
// ============================================================

export const API = ""; // mismo origen que el servidor

export async function apiGet(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

export function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status-box" + (kind ? " " + kind : "");
}

/** Sondea un job en background hasta que termina (800 ms entre polls). */
export function pollJob(jobId, { onDone, onError, onTick }) {
  const interval = setInterval(async () => {
    try {
      const job = await apiGet(`/api/job/${jobId}`);
      if (onTick) onTick(job);
      if (job.status === "done") {
        clearInterval(interval);
        onDone(job.result);
      } else if (job.status === "error") {
        clearInterval(interval);
        onError(job.error);
      }
    } catch (e) {
      clearInterval(interval);
      onError(e.message);
    }
  }, 800);
  return interval;
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

/** Rellena un <select> de canciones y llama onChange si cambia la selección. */
export async function refreshSongSelect(selectEl, onChange) {
  try {
    const data = await apiGet("/api/canciones");
    const previous = selectEl.value;
    selectEl.innerHTML = "";
    data.canciones.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.stem;
      opt.textContent =
        [c.title || c.stem, c.artist].filter(Boolean).join(" · ") +
        (c.tiene_letra ? " · letra" : "") +
        (c.tiene_sync ? " · karaoke" : "");
      selectEl.appendChild(opt);
    });
    if (previous && data.canciones.some((c) => c.stem === previous)) {
      selectEl.value = previous;
    } else if (onChange && data.canciones.length > 0) {
      onChange();
    }
  } catch (e) {
    console.error(e);
  }
}
