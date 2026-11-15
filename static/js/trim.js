// ============================================================
// trim.js — vista "Recortar": elegir un tramo de una canción y
//   guardarlo como una canción nueva. El original nunca se toca.
// ============================================================

import {
  apiPost, formatSeconds, hideProgress, pollJob, refreshSongSelect,
  renderProgress, setStatus,
} from "./api.js";
import { biblioteca, cargarListaCanciones, coverUrl, pauseIcon, playIcon } from "./player.js";
import { showToast } from "./commands.js";
import { activateView } from "./nav.js";

/** Solo se recortan canciones completas: un recorte de un recorte es ruido. */
export const soloCanciones = (cancion) => (cancion.kind || "song") !== "clip";

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
  const partes = (biblioteca.find((c) => c.stem === stem)?.duracion || "").split(":");
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

  const cancion = biblioteca.find((c) => c.stem === stem);
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
        const letra = result.karaoke
          ? ` Nace con su letra (${result.versos} versos) y su karaoke: ya puedes crear el video.`
          : result.versos
            ? ` Nace con su letra (${result.versos} versos); falta sincronizarla en «Video».`
            : " La canción no tiene letra con tiempos, así que el recorte queda sin letra.";
        terminar(`Recorte guardado.${letra}`, "ok");
        nameInput.value = "";
        ultimoRecorte = result.stem;
        await cargarListaCanciones();
        refreshSongSelect(trimSongSelect, null, soloCanciones);
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

// ---- Tus recortes --------------------------------------------------------------
// Los recortes son material de trabajo: viven aquí (no en el reproductor) y se
// limpian en cuanto su video está exportado.

const clipsList = document.getElementById("clipsList");
const clipsSummary = document.getElementById("clipsSummary");
const clipsCleanBtn = document.getElementById("clipsCleanBtn");
const clipAudio = document.getElementById("clipAudio");
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 14h10l1-14"></path></svg>';

let ultimoRecorte = null;
let clipSonando = null;
let limpiezaArmada = false;
let limpiezaTimer = null;

function _clips() {
  return biblioteca.filter((cancion) => cancion.kind === "clip");
}

function _chip(texto, activo) {
  const chip = document.createElement("span");
  chip.className = "badge" + (activo ? " on" : "");
  chip.textContent = texto;
  return chip;
}

function _boton(texto, titulo, onClick, clase = "btn-ghost") {
  const boton = document.createElement("button");
  boton.type = "button";
  boton.className = `clip-action ${clase}`;
  boton.title = titulo;
  if (texto.startsWith("<svg")) {
    boton.innerHTML = texto;
    boton.setAttribute("aria-label", titulo);
  } else {
    boton.textContent = texto;
  }
  boton.addEventListener("click", onClick);
  return boton;
}

async function _eliminarClips(stems) {
  if (!stems.length) return;
  if (stems.includes(clipSonando)) clipAudio.pause();
  await apiPost("/api/biblioteca/eliminar", {
    items: stems.map((stem) => ({ stem, parts: ["audio"] })),
  });
  await cargarListaCanciones();
  showToast(
    stems.length === 1
      ? "Recorte movido a la papelera"
      : `${stems.length} recortes movidos a la papelera`
  );
}

function _renderClips() {
  if (!clipsList) return;
  const clips = _clips();
  const exportados = clips.filter((clip) => clip.videos > 0);
  clipsSummary.textContent = !clips.length
    ? "Aquí aparecerán los fragmentos que guardes. No se mezclan con las canciones del reproductor."
    : `${clips.length} ${clips.length === 1 ? "recorte" : "recortes"}` +
      (exportados.length ? `, ${exportados.length} con video ya exportado.` : ". Ninguno tiene video todavía.");

  clipsCleanBtn.hidden = !exportados.length;
  if (!limpiezaArmada) {
    clipsCleanBtn.textContent = `Limpiar los ${exportados.length} ya exportados`;
    clipsCleanBtn.classList.remove("is-armed");
  }

  const fragment = document.createDocumentFragment();
  clips.forEach((clip) => {
    const origen = biblioteca.find((cancion) => cancion.stem === clip.clip_of);
    const fila = document.createElement("div");
    fila.className = "clip-row" + (clip.stem === ultimoRecorte ? " is-new" : "");

    const portada = document.createElement("div");
    portada.className = "clip-cover";
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => img.remove();
    img.src = coverUrl(clip);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "clip-play";
    const sonando = clipSonando === clip.stem && !clipAudio.paused;
    play.innerHTML = sonando ? pauseIcon : playIcon;
    play.setAttribute("aria-label", sonando ? "Pausar recorte" : "Escuchar recorte");
    play.addEventListener("click", () => {
      if (clipSonando === clip.stem && !clipAudio.paused) {
        clipAudio.pause();
        return;
      }
      audio.pause();
      if (clipSonando !== clip.stem) {
        clipSonando = clip.stem;
        clipAudio.src = `/canciones/${encodeURIComponent(clip.nombre)}`;
      }
      clipAudio.play().catch(() => {});
    });
    portada.append(img, play);

    const texto = document.createElement("div");
    texto.className = "clip-copy";
    const titulo = document.createElement("span");
    titulo.className = "clip-title";
    titulo.textContent = clip.title || clip.stem;
    const detalle = document.createElement("span");
    detalle.className = "clip-detail";
    const desde = Number.isFinite(clip.clip_start) ? `desde ${formatSeconds(clip.clip_start)}` : "";
    detalle.textContent = [
      clip.duracion && clip.duracion !== "Desconocida" ? clip.duracion : "",
      desde,
      origen ? `de «${origen.title || origen.stem}»` : (clip.artist || ""),
    ].filter(Boolean).join(", ");
    const chips = document.createElement("div");
    chips.className = "clip-chips";
    chips.append(
      _chip("Letra", clip.tiene_letra),
      _chip("Karaoke", clip.tiene_sync),
      _chip(clip.videos ? `${clip.videos} ${clip.videos === 1 ? "video" : "videos"}` : "Sin video", clip.videos > 0)
    );
    texto.append(titulo, detalle, chips);

    const acciones = document.createElement("div");
    acciones.className = "clip-actions";
    acciones.append(
      _boton("Letra", "Ver o corregir la letra del recorte", async () => {
        activateView("lyrics");
        const { openLyricsFor } = await import("./lyrics.js");
        openLyricsFor(clip.stem, "clip");
      }),
      _boton("Crear video", "Abrir el recorte en el generador de video", async () => {
        activateView("studio");
        const { openStudioFor } = await import("./studio.js");
        openStudioFor(clip.stem);
      }, clip.videos ? "btn-ghost" : "clip-primary"),
      _boton(TRASH_SVG, "Mover a la papelera (se puede restaurar en «Administrar»)", (event) => {
        event.currentTarget.disabled = true;
        _eliminarClips([clip.stem]).catch((error) => showToast(`No se pudo eliminar: ${error.message}`));
      }, "clip-delete")
    );

    fila.append(portada, texto, acciones);
    fragment.appendChild(fila);
  });
  clipsList.replaceChildren(fragment);
}

// Dos pasos en vez de un diálogo: el primer clic arma, el segundo confirma.
clipsCleanBtn?.addEventListener("click", async () => {
  const exportados = _clips().filter((clip) => clip.videos > 0).map((clip) => clip.stem);
  if (!exportados.length) return;
  if (!limpiezaArmada) {
    limpiezaArmada = true;
    clipsCleanBtn.classList.add("is-armed");
    clipsCleanBtn.textContent = `¿Mover ${exportados.length} a la papelera? Pulsa otra vez`;
    clearTimeout(limpiezaTimer);
    limpiezaTimer = setTimeout(() => { limpiezaArmada = false; _renderClips(); }, 4000);
    return;
  }
  clearTimeout(limpiezaTimer);
  limpiezaArmada = false;
  clipsCleanBtn.disabled = true;
  try {
    await _eliminarClips(exportados);
  } catch (error) {
    showToast(`No se pudo limpiar: ${error.message}`);
  } finally {
    clipsCleanBtn.disabled = false;
  }
});

clipAudio?.addEventListener("play", _renderClips);
clipAudio?.addEventListener("pause", _renderClips);
clipAudio?.addEventListener("ended", _renderClips);
audio.addEventListener("play", () => clipAudio?.pause());
window.addEventListener("music-lab:library", _renderClips);

_render();
_renderClips();
