// ============================================================
// Music Lab - lógica de la interfaz (todo lo que antes era el
// menú de terminal en music_lab.py ahora vive aquí).
// ============================================================

const API = ""; // mismo origen, FastAPI sirve tanto la API como los estáticos

// ---------- Navegación entre vistas ----------
const navItems = document.querySelectorAll(".nav-item");
const views = document.querySelectorAll(".view");

/** Activa la vista con el data-view indicado (equivalente a hacer clic en el
    botón del sidebar). Usada por el nav y por el hash de la URL (OAuth). */
function activateView(view) {
  const btn = document.querySelector(`.nav-item[data-view="${view}"]`);
  const section = document.getElementById(`view-${view}`);
  if (!btn || !section) return false;
  navItems.forEach((b) => b.classList.remove("active"));
  views.forEach((v) => v.classList.remove("active"));
  btn.classList.add("active");
  section.classList.add("active");

  if (view === "lyrics") refreshSongSelect(lyricsSongSelect, onLyricsSongChange);
  if (view === "studio") { refreshSongSelect(studioSongSelect, onStudioSongChange); loadVideoGallery(); }
  if (view === "spotify" && !discoverLoaded) { discoverLoaded = true; loadRecap(); }
  return true;
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => activateView(btn.dataset.view));
});

/** Si la URL trae #view-<nombre> (ej. tras el OAuth de Spotify), abre esa vista. */
function activateFromHash() {
  const m = /^#view-([\w-]+)$/.exec(window.location.hash || "");
  if (m) activateView(m[1]);
}
window.addEventListener("hashchange", activateFromHash);

// ---------- Utilidades ----------
async function apiGet(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  return res.json();
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status-box" + (kind ? " " + kind : "");
}

/** Sondea un job en background (sincronización / video) hasta que termina. */
function pollJob(jobId, { onDone, onError, onTick }) {
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
  }, 1500);
  return interval;
}

// ============================================================
// VISTA: Reproductor
// ============================================================
let canciones = [];
let indiceActual = 0;

const audioPlayer = document.getElementById("audioPlayer");
const progressBar = document.querySelector(".progress");
const progressBarContainer = document.querySelector(".progress-bar");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const playBtn = document.getElementById("playBtn");
const currentSongTitle = document.getElementById("currentSongTitle");
const currentArtistName = document.getElementById("currentArtistName");
const volumeSlider = document.querySelector(".volume-slider");
let isDragging = false;
let newTime = 0;

const playIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" stroke-width="2"><path d="M10 18l6 -6l-6 -6v12"></path></svg>`;
const pauseIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" stroke-width="2"><path d="M6 5m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z"></path><path d="M14 5m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z"></path></svg>`;

async function cargarListaCanciones() {
  try {
    const data = await apiGet("/api/canciones");
    canciones = data.canciones || [];
    if (canciones.length > 0) cargarCancion(indiceActual);
    renderPlaylist();
  } catch (e) {
    console.error("Error obteniendo canciones:", e);
  }
}

function cargarCancion(index) {
  const cancion = canciones[index];
  if (!cancion) {
    audioPlayer.src = "";
    currentSongTitle.textContent = "Sin canción";
    currentArtistName.textContent = "Artista";
    loadPlayerLyrics(null);
    return;
  }
  currentSongTitle.textContent = cancion.stem;
  currentArtistName.textContent = cancion.tiene_letra ? "Letra disponible" : "Sin letra guardada";
  audioPlayer.src = `/canciones/${encodeURIComponent(cancion.nombre)}`;
  loadPlayerLyrics(cancion);
}

/**
 * Carga la letra del tema en el reproductor: karaoke sincronizado si existe
 * su .sync.json, o la letra plana como respaldo si solo hay .txt.
 */
async function loadPlayerLyrics(cancion) {
  karaokeData = null;
  karaokeActiveLine = null;
  const emptyEl = document.getElementById("npLyricsEmpty");
  if (!cancion) {
    karaokeStage.hidden = true;
    emptyEl.style.display = "";
    return;
  }
  try {
    if (cancion.tiene_sync) {
      const r = await apiGet(`/api/karaoke/${encodeURIComponent(cancion.stem)}`);
      if (r.existe) {
        emptyEl.style.display = "none";
        showKaraoke(cancion.stem, r.datos);
        return;
      }
    }
    if (cancion.tiene_letra) {
      const r = await apiGet(`/api/letra/${encodeURIComponent(cancion.stem)}`);
      emptyEl.style.display = "none";
      showPlainLyrics(r.texto || "");
      return;
    }
    karaokeStage.hidden = true;
    emptyEl.style.display = "";
  } catch (e) {
    karaokeStage.hidden = true;
    emptyEl.style.display = "";
  }
}

/** Muestra la letra sin sincronizar (respaldo cuando aún no hay karaoke). */
function showPlainLyrics(texto) {
  karaokeStage.hidden = false;
  document.getElementById("npLyricsEmpty").style.display = "none";
  karaokeText.classList.add("plain");
  karaokeText.innerHTML = "";
  const scroll = document.createElement("div");
  scroll.className = "k-scroll k-plain";
  texto.split("\n").forEach((line) => {
    const div = document.createElement("div");
    div.className = "k-line-plain";
    div.textContent = line.trim() || "\u00A0";
    scroll.appendChild(div);
  });
  karaokeText.appendChild(scroll);
}

function renderPlaylist() {
  const playlistDiv = document.getElementById("playlistContainer");
  playlistDiv.innerHTML = "";

  canciones.forEach((cancion, index) => {
    const songItem = document.createElement("div");
    songItem.classList.add("song-item");
    if (index === indiceActual) songItem.classList.add("active");

    const songDetails = document.createElement("div");
    songDetails.classList.add("song-details");

    // Fila del título con un ecualizador animado (solo visible, vía CSS,
    // cuando la canción está activa: sustituye al highlight verde intenso).
    const titleRow = document.createElement("div");
    titleRow.classList.add("song-title-row");

    const eq = document.createElement("span");
    eq.classList.add("eq");
    eq.innerHTML = "<i></i><i></i><i></i>";

    const songTitle = document.createElement("span");
    songTitle.classList.add("song-title");
    songTitle.textContent = cancion.stem;

    titleRow.appendChild(eq);
    titleRow.appendChild(songTitle);

    const badges = document.createElement("div");
    badges.classList.add("badges");
    badges.innerHTML = `
      <span class="badge ${cancion.tiene_letra ? "on" : ""}">Letra</span>
      <span class="badge ${cancion.tiene_sync ? "on" : ""}">Karaoke</span>
    `;

    songDetails.appendChild(titleRow);
    songDetails.appendChild(badges);

    const songDuration = document.createElement("span");
    songDuration.classList.add("song-duration");
    songDuration.textContent = cancion.duracion || "Desconocida";

    songItem.appendChild(songDetails);
    songItem.appendChild(songDuration);
    playlistDiv.appendChild(songItem);

    songItem.addEventListener("click", () => {
      indiceActual = index;
      cargarCancion(indiceActual);
      audioPlayer.play();
      playBtn.innerHTML = pauseIcon;
      Array.from(playlistDiv.getElementsByClassName("song-item")).forEach((el) => el.classList.remove("active"));
      songItem.classList.add("active");
    });
  });
}

prevBtn.addEventListener("click", () => {
  if (canciones.length === 0) return;
  indiceActual = indiceActual > 0 ? indiceActual - 1 : canciones.length - 1;
  cargarCancion(indiceActual);
  audioPlayer.play();
  playBtn.innerHTML = pauseIcon;
  renderPlaylist();
});

nextBtn.addEventListener("click", () => {
  if (canciones.length === 0) return;
  indiceActual = indiceActual < canciones.length - 1 ? indiceActual + 1 : 0;
  cargarCancion(indiceActual);
  audioPlayer.play();
  playBtn.innerHTML = pauseIcon;
  renderPlaylist();
});

playBtn.addEventListener("click", () => {
  if (!audioPlayer.src) return;
  if (audioPlayer.paused) {
    audioPlayer.play();
    playBtn.innerHTML = pauseIcon;
    document.getElementById("npArtwork").classList.add("playing");
  } else {
    audioPlayer.pause();
    playBtn.innerHTML = playIcon;
    document.getElementById("npArtwork").classList.remove("playing");
  }
});

window.addEventListener("load", () => {
  const initialVolume = 0.5;
  volumeSlider.value = initialVolume;
  audioPlayer.volume = initialVolume;
  volumeSlider.style.setProperty("--value", `${initialVolume * 100}%`);
});

volumeSlider.addEventListener("input", (e) => {
  const value = parseFloat(e.target.value);
  audioPlayer.volume = value;
  volumeSlider.style.setProperty("--value", `${value * 100}%`);
});

audioPlayer.addEventListener("timeupdate", () => {
  const currentTimeElem = document.getElementById("currentTime");
  const durationElem = document.getElementById("duration");
  const formatTime = (time) => {
    if (isNaN(time) || !isFinite(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };
  currentTimeElem.textContent = formatTime(audioPlayer.currentTime);
  durationElem.textContent = formatTime(audioPlayer.duration);
  const progressPercent = (audioPlayer.currentTime / audioPlayer.duration) * 100 || 0;
  progressBar.style.width = `${progressPercent}%`;
});

audioPlayer.addEventListener("ended", () => {
  indiceActual = indiceActual < canciones.length - 1 ? indiceActual + 1 : 0;
  cargarCancion(indiceActual);
  audioPlayer.play();
  playBtn.innerHTML = pauseIcon;
  renderPlaylist();
});

progressBarContainer.addEventListener("mousedown", (event) => {
  isDragging = true;
  updateVisualProgress(event);
});
document.addEventListener("mousemove", (event) => {
  if (isDragging) updateVisualProgress(event);
});
document.addEventListener("mouseup", () => {
  if (isDragging) {
    isDragging = false;
    audioPlayer.currentTime = newTime;
  }
});
function updateVisualProgress(event) {
  const rect = progressBarContainer.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const width = rect.width;
  const progressPercent = Math.min(Math.max(offsetX / width, 0), 1);
  progressBar.style.width = `${progressPercent * 100}%`;
  newTime = progressPercent * audioPlayer.duration;
}

// ============================================================
// Añadir canción por URL (bloque plegable dentro del Reproductor)
// ============================================================
const downloadForm = document.getElementById("downloadForm");
const downloadStatus = document.getElementById("downloadStatus");
const downloadSubmit = document.getElementById("downloadSubmit");

downloadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = document.getElementById("downloadUrl").value.trim();
  const nombre = document.getElementById("downloadName").value.trim();
  if (!url) return;

  downloadSubmit.disabled = true;
  setStatus(downloadStatus, "Descargando... esto puede tardar un momento.");

  try {
    const data = await apiPost("/api/descargar", { url, nombre: nombre || null });
    setStatus(downloadStatus, `Descargado con éxito: ${data.archivo}`, "ok");
    downloadForm.reset();
    cargarListaCanciones();
  } catch (e) {
    setStatus(downloadStatus, `Error: ${e.message}`, "error");
  } finally {
    downloadSubmit.disabled = false;
  }
});

// ============================================================
// Helper compartido: llenar selects de canciones
// ============================================================
const lyricsSongSelect = document.getElementById("lyricsSongSelect");
const studioSongSelect = document.getElementById("studioSongSelect");

async function refreshSongSelect(selectEl, onChange) {
  try {
    const data = await apiGet("/api/canciones");
    const previous = selectEl.value;
    selectEl.innerHTML = "";
    data.canciones.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.stem;
      opt.textContent = c.stem + (c.tiene_letra ? " · letra" : "") + (c.tiene_sync ? " · karaoke" : "");
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

// ============================================================
// VISTA: Letras
// ============================================================
const lyricsTextarea = document.getElementById("lyricsTextarea");
const lyricsSaveBtn = document.getElementById("lyricsSaveBtn");
const lyricsStatus = document.getElementById("lyricsStatus");

async function onLyricsSongChange() {
  const stem = lyricsSongSelect.value;
  if (!stem) return;
  try {
    const data = await apiGet(`/api/letra/${encodeURIComponent(stem)}`);
    lyricsTextarea.value = data.texto || "";
    setStatus(lyricsStatus, data.existe ? "Letra cargada." : "Esta canción todavía no tiene letra guardada.");
  } catch (e) {
    setStatus(lyricsStatus, `Error: ${e.message}`, "error");
  }
}

lyricsSongSelect.addEventListener("change", onLyricsSongChange);

lyricsSaveBtn.addEventListener("click", async () => {
  const stem = lyricsSongSelect.value;
  if (!stem) return;
  lyricsSaveBtn.disabled = true;
  try {
    await apiPost(`/api/letra/${encodeURIComponent(stem)}`, { texto: lyricsTextarea.value });
    setStatus(lyricsStatus, "Letra guardada.", "ok");
    refreshSongSelect(studioSongSelect);
  } catch (e) {
    setStatus(lyricsStatus, `Error: ${e.message}`, "error");
  } finally {
    lyricsSaveBtn.disabled = false;
  }
});

// ============================================================
// VISTA: Estudio (Karaoke + Video con sincronización compartida)
// ============================================================
const studioSyncBtn = document.getElementById("studioSyncBtn");
const studioStatus = document.getElementById("studioStatus");
// El escenario de karaoke vive ahora en el Reproductor; estos nodos se
// rellenan desde loadPlayerLyrics(), no desde el Estudio.
const karaokeStage = document.getElementById("karaokeStage");
const karaokeText = document.getElementById("karaokeText");
let karaokeData = null;

/** Opciones de sincronización para el video (quedan cacheadas y sirven
    también para el karaoke del reproductor). */
function studioSyncOptions() {
  return {
    language: document.getElementById("studioLanguage").value.trim() || "es",
    model: document.getElementById("studioModel").value,
    force: document.getElementById("studioForce").checked,
    separate_vocals: document.getElementById("studioSeparate").checked,
    vad: document.getElementById("studioVad").checked ? "auditok" : "none",
  };
}

/** Tras sincronizar solo actualizamos el selector de fragmento del video;
    el karaoke del reproductor se refresca al reproducir la canción. */
function applyStudioSync(stem, data) {
  renderStanzaPicker(data.stanzas);
}

async function onStudioSongChange() {
  const stem = studioSongSelect.value;
  if (!stem) return;
  // Reset del selector de fragmento al cambiar de canción.
  stanzaPicker.innerHTML = "";
  fragStartInput.value = "";
  fragEndInput.value = "";
  fragPreviewAudio.hidden = true;
  videoStanzas = null;

  try {
    const data = await apiGet(`/api/karaoke/${encodeURIComponent(stem)}`);
    if (data.existe) {
      setStatus(studioStatus, "Ya existe una sincronización. Puedes usarla o re-sincronizar.");
      applyStudioSync(stem, data.datos);
    } else {
      setStatus(studioStatus, "Esta canción aún no está sincronizada. Pulsa 'Sincronizar'.");
    }
  } catch (e) {
    setStatus(studioStatus, `Error: ${e.message}`, "error");
  }
}

studioSongSelect.addEventListener("change", onStudioSongChange);

studioSyncBtn.addEventListener("click", async () => {
  const stem = studioSongSelect.value;
  if (!stem) return;
  studioSyncBtn.disabled = true;
  setStatus(studioStatus, "Sincronizando... si aíslas la voz, la primera vez puede tardar un par de minutos.");

  try {
    const { job_id } = await apiPost(`/api/sincronizar/${encodeURIComponent(stem)}`, studioSyncOptions());
    pollJob(job_id, {
      onDone: (result) => {
        setStatus(studioStatus, "Sincronización lista.", "ok");
        applyStudioSync(stem, result);
        studioSyncBtn.disabled = false;
        refreshSongSelect(studioSongSelect);
        // Si el tema sincronizado es el que suena, refrescar su karaoke.
        const actual = canciones[indiceActual];
        if (actual && actual.stem === stem) {
          actual.tiene_sync = true;
          showKaraoke(stem, result);
        }
      },
      onError: (err) => {
        setStatus(studioStatus, `Error: ${err}`, "error");
        studioSyncBtn.disabled = false;
      },
    });
  } catch (e) {
    setStatus(studioStatus, `Error: ${e.message}`, "error");
    studioSyncBtn.disabled = false;
  }
});

let karaokeActiveLine = null;
let karaokeRAF = null;

function showKaraoke(stem, data) {
  karaokeData = data;
  karaokeActiveLine = null;
  karaokeStage.hidden = false;
  karaokeText.classList.remove("plain");

  // Estructura: karaokeText (ventana con máscara) > .k-scroll (se desplaza)
  // > .k-stanza > .k-line > .k-word. Cada palabra guarda sus tiempos para
  // el relleno progresivo (wipe) y la línea guarda los suyos para el scroll.
  karaokeText.innerHTML = "";
  const scroll = document.createElement("div");
  scroll.className = "k-scroll";

  data.stanzas.forEach((stanza) => {
    const stanzaDiv = document.createElement("div");
    stanzaDiv.className = "k-stanza";
    stanza.forEach((line) => {
      const lineDiv = document.createElement("div");
      lineDiv.className = "k-line future";
      lineDiv.dataset.start = line.start;
      lineDiv.dataset.end = line.end;

      const words = line.words && line.words.length
        ? line.words
        : [{ text: line.text, start: line.start, end: line.end, synced: true }];
      words.forEach((w) => {
        const span = document.createElement("span");
        // synced === false => Whisper no reconoció la palabra (tiempo
        // interpolado): se marca como "aproximada" para el usuario.
        span.className = "k-word" + (w.synced === false ? " approx" : "");
        span.textContent = w.text + " ";
        span.dataset.start = w.start;
        span.dataset.end = w.end;
        lineDiv.appendChild(span);
      });
      stanzaDiv.appendChild(lineDiv);
    });
    scroll.appendChild(stanzaDiv);
  });

  karaokeText.appendChild(scroll);
  scroll.style.transform = "translateY(0px)";
  updateKaraoke();
}

/** Rellena todas las palabras de una línea a un porcentaje fijo (0 o 100). */
function _setLineFill(line, percent) {
  line.querySelectorAll(".k-word").forEach((s) => s.style.setProperty("--p", percent + "%"));
}

/** Rellena la línea activa palabra por palabra según el tiempo actual. */
function _setActiveFill(line, t) {
  line.querySelectorAll(".k-word").forEach((span) => {
    const start = parseFloat(span.dataset.start);
    const end = parseFloat(span.dataset.end);
    let p;
    if (t >= end) p = 100;
    else if (t <= start) p = 0;
    else p = ((t - start) / (end - start)) * 100;
    span.style.setProperty("--p", p.toFixed(1) + "%");
  });
}

/** Actualiza estados de línea, relleno de palabras y auto-scroll. */
function updateKaraoke() {
  if (!karaokeData) return;
  const scroll = karaokeText.querySelector(".k-scroll");
  if (!scroll) return;
  const t = audioPlayer.currentTime;
  const lines = karaokeText.querySelectorAll(".k-line");

  // La línea activa es la última cuya primera palabra ya empezó a sonar
  // (mismo criterio que lyrics.py: se mantiene durante los instrumentales).
  let active = null;
  lines.forEach((line) => {
    if (parseFloat(line.dataset.start) <= t) active = line;
  });
  // Antes de que empiece la primera línea (o en pausa con t=0) resaltamos la
  // primera para que la letra sea visible desde el inicio, no toda borrosa.
  if (!active && lines.length) active = lines[0];

  lines.forEach((line) => {
    const end = parseFloat(line.dataset.end);
    let state;
    if (line === active) state = "active";
    else if (end < t) state = "past";
    else state = "future";

    if (line.dataset.state !== state) {
      line.classList.remove("past", "active", "future");
      line.classList.add(state);
      line.dataset.state = state;
      if (state === "past") _setLineFill(line, 100);
      if (state === "future") _setLineFill(line, 0);
    }
    // Solo la línea activa se actualiza cada frame (el resto ya quedó fijo).
    if (state === "active") _setActiveFill(line, t);
  });

  // Centrar la línea activa dentro de la ventana con una transición suave.
  if (active && active !== karaokeActiveLine) {
    karaokeActiveLine = active;
    const offset = karaokeText.clientHeight / 2 - (active.offsetTop + active.offsetHeight / 2);
    scroll.style.transform = `translateY(${offset}px)`;
  }
}

// Para que el "wipe" de cada palabra sea fluido usamos requestAnimationFrame
// mientras suena (timeupdate solo dispara ~4 veces/seg). Al pausar o mover
// la barra, updateKaraoke se llama puntualmente para reflejar el salto.
function _karaokeLoop() {
  updateKaraoke();
  karaokeRAF = requestAnimationFrame(_karaokeLoop);
}
function _stopKaraokeLoop() {
  if (karaokeRAF) {
    cancelAnimationFrame(karaokeRAF);
    karaokeRAF = null;
  }
}
audioPlayer.addEventListener("play", () => { if (!karaokeRAF) _karaokeLoop(); });
audioPlayer.addEventListener("pause", _stopKaraokeLoop);
audioPlayer.addEventListener("ended", _stopKaraokeLoop);
audioPlayer.addEventListener("seeked", updateKaraoke);
audioPlayer.addEventListener("timeupdate", () => { if (!karaokeRAF) updateKaraoke(); });

// ============================================================
// Panel Video: selector de fragmento + generación
// (la sincronización la comparte el Estudio, ver arriba)
// ============================================================
const videoGenerateBtn = document.getElementById("videoGenerateBtn");
const videoStatus = document.getElementById("videoStatus");
const videoGallery = document.getElementById("videoGallery");
const stanzaPicker = document.getElementById("stanzaPicker");
const fragStartInput = document.getElementById("fragStart");
const fragEndInput = document.getElementById("fragEnd");
const fragPreviewBtn = document.getElementById("fragPreviewBtn");
const fragPreviewAudio = document.getElementById("fragPreviewAudio");

let videoStanzas = null; // estrofas de la última sincronización cargada

function renderStanzaPicker(stanzas) {
  videoStanzas = stanzas;
  stanzaPicker.innerHTML = "";

  stanzas.forEach((stanza, idx) => {
    if (!stanza.length) return;
    const start = stanza[0].start;
    const end = stanza[stanza.length - 1].end;

    const option = document.createElement("div");
    option.className = "stanza-option";
    option.innerHTML = `
      <span class="stanza-time">${formatSeconds(start)} — ${formatSeconds(end)}</span>
      <span class="stanza-lines">${stanza.map((l) => l.text).join("\n")}</span>
    `;
    option.addEventListener("click", () => {
      document.querySelectorAll(".stanza-option").forEach((el) => el.classList.remove("selected"));
      option.classList.add("selected");
      fragStartInput.value = start.toFixed(1);
      fragEndInput.value = end.toFixed(1);
      fragPreviewAudio.hidden = true;
    });
    stanzaPicker.appendChild(option);
  });
}

function formatSeconds(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ---- Previsualizar el fragmento elegido antes de generar el video ----
let fragStopHandler = null;

fragPreviewBtn.addEventListener("click", () => {
  const stem = studioSongSelect.value;
  if (!stem) return;
  const song = canciones.find((c) => c.stem === stem);
  if (!song) return;

  const start = parseFloat(fragStartInput.value) || 0;
  const end = fragEndInput.value ? parseFloat(fragEndInput.value) : null;

  fragPreviewAudio.hidden = false;
  fragPreviewAudio.src = `/canciones/${encodeURIComponent(song.nombre)}`;

  if (fragStopHandler) fragPreviewAudio.removeEventListener("timeupdate", fragStopHandler);
  fragStopHandler = () => {
    if (end !== null && fragPreviewAudio.currentTime >= end) {
      fragPreviewAudio.pause();
    }
  };
  fragPreviewAudio.addEventListener("timeupdate", fragStopHandler);

  fragPreviewAudio.addEventListener("loadedmetadata", () => {
    fragPreviewAudio.currentTime = start;
    fragPreviewAudio.play();
  }, { once: true });

  if (fragPreviewAudio.readyState >= 1) {
    fragPreviewAudio.currentTime = start;
    fragPreviewAudio.play();
  }
});

// ---- Generar el video con el fragmento (o la canción completa) elegido ----
videoGenerateBtn.addEventListener("click", async () => {
  const stem = studioSongSelect.value;
  if (!stem) return;
  const opts = studioSyncOptions();
  const nombre_salida = document.getElementById("videoOutputName").value.trim() || null;
  const titulo = document.getElementById("videoTitulo").value.trim() || null;
  const artista = document.getElementById("videoArtista").value.trim() || null;
  const start_time = fragStartInput.value !== "" ? parseFloat(fragStartInput.value) : null;
  const end_time = fragEndInput.value !== "" ? parseFloat(fragEndInput.value) : null;

  videoGenerateBtn.disabled = true;
  setStatus(videoStatus, "Generando video... esto puede tardar varios minutos.");

  try {
    const { job_id } = await apiPost(`/api/video/${encodeURIComponent(stem)}`, {
      language: opts.language, model: opts.model, force_sync: opts.force,
      nombre_salida, titulo, artista, start_time, end_time,
      separate_vocals: opts.separate_vocals, vad: opts.vad,
    });
    pollJob(job_id, {
      onDone: (result) => {
        setStatus(videoStatus, `Video generado: ${result.video}`, "ok");
        videoGenerateBtn.disabled = false;
        loadVideoGallery();
      },
      onError: (err) => {
        setStatus(videoStatus, `Error: ${err}`, "error");
        videoGenerateBtn.disabled = false;
      },
    });
  } catch (e) {
    setStatus(videoStatus, `Error: ${e.message}`, "error");
    videoGenerateBtn.disabled = false;
  }
});

async function loadVideoGallery() {
  try {
    const data = await apiGet("/api/videos");
    videoGallery.innerHTML = "";
    data.videos.forEach((name) => {
      const card = document.createElement("div");
      card.className = "video-card";
      card.innerHTML = `
        <video controls src="/videos/${encodeURIComponent(name)}"></video>
        <div class="video-name">${name}</div>
      `;
      videoGallery.appendChild(card);
    });
  } catch (e) {
    console.error(e);
  }
}

// ============================================================
// Arranque
// ============================================================
cargarListaCanciones();

// ============================================================
// VISTA: Descubrir (Spotify → Recap, Playlists, Favoritas)
// ============================================================
const spotifyGrid = document.getElementById("spotifyGrid");
const spotifyStatus = document.getElementById("spotifyStatus");
const discoverTabs = document.querySelectorAll(".discover-tab");
const recapPanel = document.getElementById("recapPanel");
const recapArtists = document.getElementById("recapArtists");
const recapTracks = document.getElementById("recapTracks");
const playlistCrumb = document.getElementById("playlistCrumb");
const playlistBackBtn = document.getElementById("playlistBackBtn");
const playlistCrumbTitle = document.getElementById("playlistCrumbTitle");
let discoverLoaded = false;

let currentAudioPreview = null;
let currentPreviewBtn = null;

function playPreview(url, btnElement) {
  if (currentAudioPreview) {
    currentAudioPreview.pause();
    if (currentPreviewBtn) currentPreviewBtn.classList.remove("playing");
  }
  if (!url) return;
  
  if (currentPreviewBtn === btnElement) {
    currentPreviewBtn = null;
    currentAudioPreview = null;
    return;
  }
  
  currentAudioPreview = new Audio(url);
  currentAudioPreview.volume = 0.5;
  currentPreviewBtn = btnElement;
  currentPreviewBtn.classList.add("playing");
  
  currentAudioPreview.play().catch(e => console.error("Error preview", e));
  
  currentAudioPreview.onended = () => {
    if (currentPreviewBtn) currentPreviewBtn.classList.remove("playing");
    currentPreviewBtn = null;
    currentAudioPreview = null;
  };
}

/** Coincidencia laxa: ¿ya hay una canción parecida en la biblioteca local? */
function isInLibrary(title) {
  const t = (title || "").trim().toLowerCase();
  if (!t) return false;
  return canciones.some((c) => {
    const s = c.stem.toLowerCase();
    return s.includes(t) || t.includes(s);
  });
}

/** Descarga la canción al Lab vía búsqueda en YouTube. */
async function downloadFromSpotify(btn, title, artists) {
  btn.disabled = true;
  btn.textContent = "Descargando…";
  try {
    await apiPost("/api/descargar", { url: `ytsearch:${title} ${artists} audio` });
    btn.textContent = "En tu biblioteca";
    btn.classList.add("in-lib");
    cargarListaCanciones();
    refreshSongSelect(studioSongSelect);
  } catch (e) {
    btn.textContent = "Error, reintentar";
    btn.disabled = false;
  }
}



function showSpotifyLogin() {
  spotifyGrid.innerHTML = "";
  spotifyStatus.className = "status-box";
  spotifyStatus.innerHTML = `
    <div class="spotify-login-box">
      <p>Conecta tu cuenta de Spotify para ver tus favoritas y novedades.</p>
      <button class="btn-spotify-login" onclick="window.location.href='/api/spotify/login'">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="vertical-align:middle; margin-right:8px; margin-top:-2px"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424c-.18.295-.563.387-.857.207-2.35-1.434-5.305-1.76-8.786-.963-.335.077-.67-.133-.746-.468-.077-.334.132-.67.467-.746 3.816-.874 7.058-.496 9.715 1.122.295.18.388.563.207.848zm1.22-3.237c-.226.368-.706.485-1.072.26-2.687-1.65-6.785-2.13-9.965-1.166-.413.125-.845-.108-.97-.52-.125-.413.108-.844.52-.97 3.66-1.11 8.24-.57 11.226 1.264.367.225.485.705.26 1.072zm.106-3.41c-3.21-1.905-8.5-2.08-11.562-1.15-.49.148-.99-.126-1.138-.616-.148-.49.125-.99.615-1.137 3.51-.97 9.38-.767 13.06 1.417.44.26.582.846.32 1.286-.26.44-.847.582-1.295.32z"></path></svg>
        Iniciar sesión con Spotify
      </button>
    </div>`;
}

/** Oculta todos los paneles de Descubrir para dejar el escenario limpio. */
function _resetDiscoverPanels() {
  recapPanel.hidden = true;
  playlistCrumb.hidden = true;
  spotifyGrid.innerHTML = "";
  recapArtists.innerHTML = "";
  recapTracks.innerHTML = "";
  spotifyStatus.className = "status-box";
  spotifyStatus.textContent = "";
}

/** Envuelve una promesa que llama a Spotify y muestra el prompt de login
    o el error correspondiente cuando la sesión falta o expira. */
async function _withSpotifyAuth(fn) {
  try {
    await fn();
  } catch (err) {
    if (/401|iniciado sesión|expirada/i.test(err.message)) {
      showSpotifyLogin();
    } else if (/403/i.test(err.message)) {
      // 403 típicamente = scope insuficiente (playlists añadidas después).
      spotifyStatus.innerHTML = `
        <div class="spotify-login-box">
          <p>Necesitamos permisos adicionales para leer tus playlists. Vuelve a conectar tu cuenta.</p>
          <button class="btn-spotify-login" onclick="window.location.href='/api/spotify/login'">
            Reconectar Spotify
          </button>
        </div>`;
    } else {
      setStatus(spotifyStatus, `Error: ${err.message}`, "error");
    }
  }
}

// ---- Recap del mes ----
async function loadRecap() {
  _resetDiscoverPanels();
  recapPanel.hidden = false;
  setStatus(spotifyStatus, "Preparando tu recap del mes…");
  await _withSpotifyAuth(async () => {
    const [artistsRes, tracksRes] = await Promise.all([
      apiGet("/api/spotify/top-artists?time_range=short_term&limit=5"),
      apiGet("/api/spotify/top?time_range=short_term&limit=5"),
    ]);
    renderRecapArtists(artistsRes.items || []);
    renderRecapTracks(tracksRes.items || []);
    spotifyStatus.textContent = "";
  });
}

function renderRecapArtists(artists) {
  recapArtists.innerHTML = "";
  if (!artists.length) {
    recapArtists.innerHTML = `<p class="hint">Aún no hay suficiente historial en Spotify para un recap del mes.</p>`;
    return;
  }
  artists.forEach((a, i) => {
    const img = a.images?.[0]?.url || "";
    const card = document.createElement("div");
    card.className = "recap-artist";
    card.innerHTML = `
      <div class="recap-rank">#${i + 1}</div>
      <div class="recap-artist-avatar">${img ? `<img src="${img}" alt="">` : ""}</div>
      <div class="recap-artist-name">${a.name}</div>
    `;
    recapArtists.appendChild(card);
  });
}

function renderRecapTracks(tracks) {
  recapTracks.innerHTML = "";
  if (!tracks.length) {
    recapTracks.innerHTML = `<p class="hint">Sin canciones destacadas este mes todavía.</p>`;
    return;
  }
  renderCardsInto(recapTracks, tracks);
}

// ---- Mis playlists ----
async function loadPlaylists() {
  _resetDiscoverPanels();
  setStatus(spotifyStatus, "Cargando tus playlists…");
  await _withSpotifyAuth(async () => {
    const res = await apiGet("/api/spotify/playlists?limit=50");
    const items = res.items || [];
    if (!items.length) {
      setStatus(spotifyStatus, "Aún no tienes playlists en Spotify.");
      return;
    }
    spotifyStatus.textContent = "";
    spotifyGrid.innerHTML = "";
    items.forEach((pl) => spotifyGrid.appendChild(renderPlaylistCard(pl)));
  });
}

function renderPlaylistCard(pl) {
  const img = pl.images?.[0]?.url || "";
  // /me/playlists devuelve tracks:null, así que en la lista no mostramos
  // conteo (sería siempre 0); mostramos al dueño y el conteo real aparece
  // en el header al entrar en la playlist.
  const owner = pl.owner?.display_name || "";
  const card = document.createElement("div");
  card.className = "spotify-card playlist-card";
  card.innerHTML = `
    <div class="spotify-img-container">
      ${img ? `<img src="${img}" class="spotify-img" alt="">` : `<div class="playlist-cover-fallback"></div>`}
    </div>
    <div class="spotify-title" title="${pl.name}">${pl.name}</div>
    <div class="spotify-artist">${owner ? "por " + owner : ""}</div>
  `;
  card.addEventListener("click", () => openPlaylist(pl));
  return card;
}

async function openPlaylist(pl) {
  _resetDiscoverPanels();
  // Ocultar tabs para reforzar que estamos en una sub-vista.
  document.querySelector(".discover-tabs").style.display = "none";
  playlistCrumb.hidden = false;
  playlistCrumbTitle.textContent = pl.name;
  const meta = document.getElementById("playlistCrumbMeta");
  // El conteo real llega solo al pedir la playlist (más abajo). Mostramos
  // "…" mientras carga para no mentir con "0 canciones".
  meta.textContent = pl.owner?.display_name ? `por ${pl.owner.display_name}` : "";

  setStatus(spotifyStatus, "Cargando canciones…");
  await _withSpotifyAuth(async () => {
    const res = await apiGet(`/api/spotify/playlist/${pl.id}/tracks`);
    // El backend ya aplana al shape uniforme {items: [{track: ...}], total}.
    const tracks = (res.items || [])
      .map((it) => it.track)
      .filter((t) => t && t.id);
    const total = res.total ?? tracks.length;
    // Actualizamos el header con el conteo real.
    meta.textContent =
      `${total} ${total === 1 ? "canción" : "canciones"}` +
      (pl.owner?.display_name ? ` · por ${pl.owner.display_name}` : "");
    if (!tracks.length) {
      setStatus(spotifyStatus, "Esta playlist está vacía.");
      return;
    }
    spotifyStatus.textContent = "";
    renderCardsInto(spotifyGrid, tracks);
  });
}

playlistBackBtn.addEventListener("click", () => {
  document.querySelector(".discover-tabs").style.display = "";
  loadPlaylists();
});

// ---- Mis favoritas (top de siempre) ----
async function loadFavorites() {
  _resetDiscoverPanels();
  setStatus(spotifyStatus, "Trayendo tus favoritas de siempre…");
  await _withSpotifyAuth(async () => {
    const res = await apiGet("/api/spotify/top?time_range=long_term&limit=20");
    const tracks = res.items || [];
    if (!tracks.length) {
      setStatus(spotifyStatus, "Aún no tienes suficientes escuchas.");
      return;
    }
    spotifyStatus.textContent = "";
    renderCardsInto(spotifyGrid, tracks);
  });
}

/** Pinta tarjetas de tracks en el contenedor indicado. */
function renderCardsInto(container, tracks) {
  container.innerHTML = "";
  const playSvg = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>`;
  tracks.forEach((track) => {
    const imgUrl = track.album?.images?.[0]?.url || "";
    const artists = (track.artists || []).map((a) => a.name).join(", ");
    const title = track.name || "";
    const previewUrl = track.preview_url;
    const inLib = isInLibrary(title);

    const card = document.createElement("div");
    card.className = "spotify-card";
    card.innerHTML = `
      <div class="spotify-img-container">
        ${imgUrl ? `<img src="${imgUrl}" class="spotify-img" alt="">` : ""}
        ${previewUrl ? `<div class="spotify-preview-overlay"><button class="spotify-preview-btn" title="Adelanto">${playSvg}</button></div>` : ""}
      </div>
      <div class="spotify-title" title="${title}">${title}</div>
      <div class="spotify-artist" title="${artists}">${artists}</div>
      <button class="btn-download-spotify${inLib ? " in-lib" : ""}">${inLib ? "En tu biblioteca" : "Descargar al Lab"}</button>
    `;

    const previewBtn = card.querySelector(".spotify-preview-btn");
    if (previewBtn) previewBtn.addEventListener("click", () => playPreview(previewUrl, previewBtn));

    const btn = card.querySelector(".btn-download-spotify");
    if (inLib) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => downloadFromSpotify(btn, title, artists));
    }
    container.appendChild(card);
  });
}

// Cableado de pestañas
discoverTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    // Si veníamos de abrir una playlist, restauramos la barra de pestañas.
    document.querySelector(".discover-tabs").style.display = "";
    discoverTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const src = tab.dataset.src;
    if (src === "recap") loadRecap();
    else if (src === "playlists") loadPlaylists();
    else if (src === "top") loadFavorites();
  });
});


// ============================================================
// Web Audio API & Ambient Mode (Canvas Visualizer)
// ============================================================
const bgCanvas = document.getElementById("bgCanvas");
const ctx = bgCanvas.getContext("2d");
let audioCtx, analyser, source, dataArray, bufferLength;
let visualizerRAF = null;

function resizeCanvas() {
  bgCanvas.width = window.innerWidth;
  bgCanvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function initAudioVisualizer() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    return;
  }
  
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  bufferLength = analyser.frequencyBinCount;
  dataArray = new Uint8Array(bufferLength);

  source = audioCtx.createMediaElementSource(audioPlayer);
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  
  drawVisualizer();
}

function drawVisualizer() {
  visualizerRAF = requestAnimationFrame(drawVisualizer);
  
  analyser.getByteFrequencyData(dataArray);
  
  const width = bgCanvas.width;
  const height = bgCanvas.height;
  
  // Limpiar con negro semi-transparente para un efecto trail
  ctx.fillStyle = "rgba(5, 5, 5, 0.2)";
  ctx.fillRect(0, 0, width, height);

  // Calcular el "bass" (frecuencias bajas) para el pulso central
  let bassAvg = 0;
  for(let i=0; i<10; i++) {
    bassAvg += dataArray[i];
  }
  bassAvg = bassAvg / 10;
  
  // Dibujar un orbe central difuminado que pulsa con el bajo (Ambient Mode)
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = (bassAvg / 255) * (Math.min(width, height) / 2) + 100;
  
  const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
  gradient.addColorStop(0, "rgba(30, 215, 96, 0.15)");
  gradient.addColorStop(1, "rgba(30, 215, 96, 0)");
  
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  ctx.fillStyle = gradient;
  ctx.fill();

  // Dibujar barras espectrales en la parte inferior
  const barWidth = (width / bufferLength) * 2.5;
  let barHeight;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    barHeight = dataArray[i] * 1.5;

    // Color gradient para las barras
    const r = barHeight + (25 * (i / bufferLength));
    const g = 250 * (i / bufferLength);
    const b = 50;

    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, height - barHeight, barWidth, barHeight);

    x += barWidth + 1;
  }
}

// Inicializar el visualizador en el primer clic a Play para cumplir las políticas del navegador
playBtn.addEventListener("click", () => {
  initAudioVisualizer();
}, { once: true });
audioPlayer.addEventListener("play", () => {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
});

// ============================================================
// Activación inicial por hash (tras el OAuth de Spotify, la URL termina en
// #view-spotify y queremos abrir directamente esa vista).
// ============================================================
activateFromHash();
