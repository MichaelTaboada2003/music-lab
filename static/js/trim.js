// ============================================================
// trim.js — vista "Recortar": elegir un tramo de una canción y
//   guardarlo como una canción nueva. El original nunca se toca.
// ============================================================

import {
  apiPost, formatSeconds, hideProgress, pollJob, refreshSongSelect,
  renderProgress, setStatus,
} from "./api.js";
import { canciones, cargarListaCanciones, pauseIcon, playIcon } from "./player.js";

export const trimSongSelect = document.getElementById("trimSongSelect");
const audio = document.getElementById("trimAudio");
const track = document.getElementById("trimTrack");
const selection = document.getElementById("trimSelection");
const playhead = document.getElementById("trimPlayhead");
const handleStart = document.getElementById("trimHandleStart");
const handleEnd = document.getElementById("trimHandleEnd");
const playBtn = document.getElementById("trimPlayBtn");
const currentTimeEl = document.getElementById("trimCurrentTime");
const totalTimeEl = document.getElementById("trimTotalTime");
const selectionLabel = document.getElementById("trimSelectionLabel");
const startInput = document.getElementById("trimStart");
const endInput = document.getElementById("trimEnd");
const nameInput = document.getElementById("trimName");
const fadeInput = document.getElementById("trimFade");
const markStartBtn = document.getElementById("trimMarkStart");
const markEndBtn = document.getElementById("trimMarkEnd");
const previewBtn = document.getElementById("trimPreviewBtn");
const saveBtn = document.getElementById("trimSaveBtn");
const statusEl = document.getElementById("trimStatus");

// Coincide con MIN_DURATION en audio_trim.py: por debajo el backend rechaza.
const MIN_DURATION = 0.5;
const FADE_SECONDS = 0.5;
const KEY_STEP = 0.5;

let duracion = 0;
let inicio = 0;
let fin = 0;
let escuchandoSeleccion = false;
let guardando = false;

// ---- Estado y pintado --------------------------------------------------------

function _pct(segundos) {
  return duracion > 0 ? (segundos / duracion) * 100 : 0;
}

function _clamp(valor, min, max) {
  return Math.min(max, Math.max(min, valor));
}

/** Duración de respaldo mientras el navegador no ha leído los metadatos. */
function _duracionBiblioteca(stem) {
  const partes = (canciones.find((c) => c.stem === stem)?.duracion || "").split(":");
  if (partes.length !== 2) return 0;
  const total = Number(partes[0]) * 60 + Number(partes[1]);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function _renderInputs() {
  startInput.value = inicio.toFixed(1);
  endInput.value = fin.toFixed(1);
}

function _render() {
  const listo = duracion > 0;
  selection.style.left = `${_pct(inicio)}%`;
  selection.style.width = `${Math.max(0, _pct(fin - inicio))}%`;
  handleStart.style.left = `${_pct(inicio)}%`;
  handleEnd.style.left = `${_pct(fin)}%`;
  playhead.style.left = `${_pct(audio.currentTime)}%`;
  playhead.hidden = !listo;

  currentTimeEl.textContent = formatSeconds(audio.currentTime || 0);
  totalTimeEl.textContent = formatSeconds(duracion);
  selectionLabel.textContent = listo
    ? `${formatSeconds(inicio)} – ${formatSeconds(fin)} · ${formatSeconds(fin - inicio)}`
    : (trimSongSelect.value ? "Cargando canción..." : "Elige una canción");

  const valido = listo && fin - inicio >= MIN_DURATION;
  saveBtn.disabled = !valido || guardando;
  previewBtn.disabled = !valido;
  playBtn.disabled = !listo;
  markStartBtn.disabled = !listo;
  markEndBtn.disabled = !listo;
  playBtn.innerHTML = audio.paused ? playIcon : pauseIcon;
}

function _setInicio(valor) {
  inicio = _clamp(valor, 0, Math.max(0, fin - MIN_DURATION));
  _renderInputs();
  _render();
}

function _setFin(valor) {
  fin = _clamp(valor, Math.min(duracion, inicio + MIN_DURATION), duracion);
  _renderInputs();
  _render();
}

// ---- Carga de la canción seleccionada ---------------------------------------

export function onTrimSongChange() {
  const stem = trimSongSelect.value;
  _pararSeleccion();
  audio.pause();
  setStatus(statusEl, "");
  hideProgress("trim");
  nameInput.value = "";
  duracion = 0;
  inicio = 0;
  fin = 0;
  _renderInputs();

  const cancion = canciones.find((c) => c.stem === stem);
  if (!stem) {
    audio.removeAttribute("src");
    _render();
    return;
  }
  audio.src = `/canciones/${encodeURIComponent(cancion?.nombre || `${stem}.mp3`)}`;
  audio.load();
  // El respaldo evita una vista muerta si el navegador tarda en leer los
  // metadatos; el evento loadedmetadata lo corrige con el valor exacto.
  _aplicarDuracion(_duracionBiblioteca(stem));
}

function _aplicarDuracion(valor) {
  if (!(valor > 0) || duracion > 0) {
    _render();
    return;
  }
  duracion = valor;
  inicio = 0;
  fin = valor;
  _renderInputs();
  _render();
}

audio.addEventListener("loadedmetadata", () => {
  if (!Number.isFinite(audio.duration)) return;
  const completo = fin >= duracion - 0.05;
  duracion = audio.duration;
  if (completo) fin = duracion;
  fin = _clamp(fin, MIN_DURATION, duracion);
  inicio = _clamp(inicio, 0, fin - MIN_DURATION);
  _renderInputs();
  _render();
});

audio.addEventListener("timeupdate", () => {
  if (escuchandoSeleccion && audio.currentTime >= fin) {
    audio.pause();
    _pararSeleccion();
  }
  _render();
});

audio.addEventListener("play", _render);
audio.addEventListener("pause", _render);
audio.addEventListener("ended", () => {
  _pararSeleccion();
  _render();
});

// ---- Línea de tiempo ---------------------------------------------------------

function _tiempoEn(clientX) {
  const rect = track.getBoundingClientRect();
  if (!rect.width) return 0;
  return _clamp((clientX - rect.left) / rect.width, 0, 1) * duracion;
}

function _arrastrar(extremo) {
  return (event) => {
    if (duracion <= 0) return;
    event.preventDefault();
    track.classList.add("is-dragging");
    const mover = (e) => {
      if (extremo === "inicio") _setInicio(_tiempoEn(e.clientX));
      else _setFin(_tiempoEn(e.clientX));
    };
    const soltar = () => {
      track.classList.remove("is-dragging");
      document.removeEventListener("pointermove", mover);
      document.removeEventListener("pointerup", soltar);
    };
    document.addEventListener("pointermove", mover);
    document.addEventListener("pointerup", soltar);
    mover(event);
  };
}

handleStart.addEventListener("pointerdown", _arrastrar("inicio"));
handleEnd.addEventListener("pointerdown", _arrastrar("fin"));

// Los tiradores son botones: con el teclado se mueven de medio en medio segundo.
function _teclas(extremo) {
  return (event) => {
    const paso = event.key === "ArrowLeft" ? -KEY_STEP : event.key === "ArrowRight" ? KEY_STEP : 0;
    if (!paso) return;
    event.preventDefault();
    if (extremo === "inicio") _setInicio(inicio + paso);
    else _setFin(fin + paso);
  };
}

handleStart.addEventListener("keydown", _teclas("inicio"));
handleEnd.addEventListener("keydown", _teclas("fin"));

track.addEventListener("pointerdown", (event) => {
  if (event.target.classList.contains("trim-handle") || duracion <= 0) return;
  _pararSeleccion();
  audio.currentTime = _tiempoEn(event.clientX);
  _render();
});

// ---- Controles ---------------------------------------------------------------

function _pararSeleccion() {
  escuchandoSeleccion = false;
  previewBtn.textContent = "Escuchar selección";
}

async function _reproducir() {
  try {
    await audio.play();
  } catch {
    _pararSeleccion();
  }
}

playBtn.addEventListener("click", () => {
  if (duracion <= 0) return;
  if (audio.paused) {
    _reproducir();
  } else {
    audio.pause();
    _pararSeleccion();
  }
});

previewBtn.addEventListener("click", () => {
  if (escuchandoSeleccion) {
    audio.pause();
    _pararSeleccion();
    return;
  }
  audio.currentTime = inicio;
  escuchandoSeleccion = true;
  previewBtn.textContent = "Detener";
  _reproducir();
});

markStartBtn.addEventListener("click", () => _setInicio(audio.currentTime));
markEndBtn.addEventListener("click", () => _setFin(audio.currentTime));

startInput.addEventListener("change", () => _setInicio(parseFloat(startInput.value) || 0));
endInput.addEventListener("change", () => _setFin(parseFloat(endInput.value) || duracion));

trimSongSelect.addEventListener("change", onTrimSongChange);

// ---- Guardado ----------------------------------------------------------------

saveBtn.addEventListener("click", async () => {
  const stem = trimSongSelect.value;
  if (!stem || guardando || fin - inicio < MIN_DURATION) return;

  audio.pause();
  _pararSeleccion();
  guardando = true;
  setStatus(statusEl, "Recortando...");
  _render();

  const terminar = (mensaje, kind) => {
    guardando = false;
    hideProgress("trim");
    setStatus(statusEl, mensaje, kind);
    _render();
  };

  try {
    const { job_id } = await apiPost(
      `/api/canciones/${encodeURIComponent(stem)}/recortar`,
      {
        start: inicio,
        end: fin,
        nombre_salida: nameInput.value.trim() || null,
        fade_in: fadeInput.checked ? FADE_SECONDS : 0,
        fade_out: fadeInput.checked ? FADE_SECONDS : 0,
      }
    );
    pollJob(job_id, {
      onTick: (job) => renderProgress("trim", job),
      onDone: async (result) => {
        terminar(`Recorte guardado: ${result.archivo}`, "ok");
        nameInput.value = "";
        // El recorte es una canción más: refrescamos biblioteca y selectores.
        await cargarListaCanciones();
        refreshSongSelect(trimSongSelect);
        const [{ studioSongSelect }, { refreshLyricsSongs }] = await Promise.all([
          import("./studio.js"),
          import("./lyrics.js"),
        ]);
        refreshSongSelect(studioSongSelect);
        refreshLyricsSongs();
      },
      onError: (error) => terminar(`No se pudo recortar: ${error}`, "error"),
    });
  } catch (error) {
    terminar(`No se pudo recortar: ${error.message}`, "error");
  }
});

_render();
