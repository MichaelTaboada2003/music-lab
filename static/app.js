// ============================================================
// Music Lab - lógica de la interfaz (todo lo que antes era el
// menú de terminal en music_lab.py ahora vive aquí).
// ============================================================

const API = ""; // mismo origen, FastAPI sirve tanto la API como los estáticos

// ---------- Navegación entre vistas ----------
const navItems = document.querySelectorAll(".nav-item");
const views = document.querySelectorAll(".view");

navItems.forEach((btn) => {
  btn.addEventListener("click", () => {
    navItems.forEach((b) => b.classList.remove("active"));
    views.forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`view-${btn.dataset.view}`).classList.add("active");

    if (btn.dataset.view === "lyrics") refreshSongSelect(lyricsSongSelect, onLyricsSongChange);
    if (btn.dataset.view === "karaoke") refreshSongSelect(karaokeSongSelect, onKaraokeSongChange);
    if (btn.dataset.view === "video") { refreshSongSelect(videoSongSelect); loadVideoGallery(); }
  });
});

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
    return;
  }
  currentSongTitle.textContent = cancion.stem;
  currentArtistName.textContent = cancion.tiene_letra ? "Letra disponible" : "Sin letra guardada";
  audioPlayer.src = `/canciones/${encodeURIComponent(cancion.nombre)}`;
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
  } else {
    audioPlayer.pause();
    playBtn.innerHTML = playIcon;
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
// VISTA: Descargar
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
const karaokeSongSelect = document.getElementById("karaokeSongSelect");
const videoSongSelect = document.getElementById("videoSongSelect");

async function refreshSongSelect(selectEl, onChange) {
  try {
    const data = await apiGet("/api/canciones");
    const previous = selectEl.value;
    selectEl.innerHTML = "";
    data.canciones.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.stem;
      opt.textContent = c.stem + (c.tiene_letra ? " ✓ letra" : "") + (c.tiene_sync ? " ✓ karaoke" : "");
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
    refreshSongSelect(karaokeSongSelect);
    refreshSongSelect(videoSongSelect);
  } catch (e) {
    setStatus(lyricsStatus, `Error: ${e.message}`, "error");
  } finally {
    lyricsSaveBtn.disabled = false;
  }
});

// ============================================================
// VISTA: Karaoke
// ============================================================
const karaokeSyncBtn = document.getElementById("karaokeSyncBtn");
const karaokeStatus = document.getElementById("karaokeStatus");
const karaokeStage = document.getElementById("karaokeStage");
const karaokeAudio = document.getElementById("karaokeAudio");
const karaokeText = document.getElementById("karaokeText");
let karaokeData = null;

async function onKaraokeSongChange() {
  const stem = karaokeSongSelect.value;
  if (!stem) return;
  karaokeStage.hidden = true;
  try {
    const data = await apiGet(`/api/karaoke/${encodeURIComponent(stem)}`);
    if (data.existe) {
      setStatus(karaokeStatus, "Ya existe una sincronización guardada. Puedes reproducirla o forzar una nueva.");
      showKaraoke(stem, data.datos);
    } else {
      setStatus(karaokeStatus, "Esta canción aún no está sincronizada. Pulsa 'Sincronizar'.");
    }
  } catch (e) {
    setStatus(karaokeStatus, `Error: ${e.message}`, "error");
  }
}

karaokeSongSelect.addEventListener("change", onKaraokeSongChange);

karaokeSyncBtn.addEventListener("click", async () => {
  const stem = karaokeSongSelect.value;
  if (!stem) return;
  const language = document.getElementById("karaokeLanguage").value.trim() || "es";
  const model = document.getElementById("karaokeModel").value;
  const force = document.getElementById("karaokeForce").checked;
  const separate_vocals = document.getElementById("karaokeSeparate").checked;
  const vad = document.getElementById("karaokeVad").checked ? "auditok" : "none";

  karaokeSyncBtn.disabled = true;
  setStatus(karaokeStatus, "Sincronizando... si aíslas la voz, la primera vez puede tardar un par de minutos.");

  try {
    const { job_id } = await apiPost(`/api/sincronizar/${encodeURIComponent(stem)}`, { language, model, force, separate_vocals, vad });
    pollJob(job_id, {
      onDone: (result) => {
        setStatus(karaokeStatus, "Sincronización lista.", "ok");
        showKaraoke(stem, result);
        karaokeSyncBtn.disabled = false;
        refreshSongSelect(karaokeSongSelect);
        refreshSongSelect(videoSongSelect);
      },
      onError: (err) => {
        setStatus(karaokeStatus, `Error: ${err}`, "error");
        karaokeSyncBtn.disabled = false;
      },
    });
  } catch (e) {
    setStatus(karaokeStatus, `Error: ${e.message}`, "error");
    karaokeSyncBtn.disabled = false;
  }
});

let karaokeActiveLine = null;
let karaokeRAF = null;

function showKaraoke(stem, data) {
  karaokeData = data;
  karaokeActiveLine = null;
  karaokeStage.hidden = false;
  const song = canciones.find((c) => c.stem === stem);
  karaokeAudio.src = `/canciones/${encodeURIComponent(song ? song.nombre : stem + ".mp3")}`;

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
  const t = karaokeAudio.currentTime;
  const lines = karaokeText.querySelectorAll(".k-line");

  // La línea activa es la última cuya primera palabra ya empezó a sonar
  // (mismo criterio que lyrics.py: se mantiene durante los instrumentales).
  let active = null;
  lines.forEach((line) => {
    if (parseFloat(line.dataset.start) <= t) active = line;
  });

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
karaokeAudio.addEventListener("play", () => { if (!karaokeRAF) _karaokeLoop(); });
karaokeAudio.addEventListener("pause", _stopKaraokeLoop);
karaokeAudio.addEventListener("ended", _stopKaraokeLoop);
karaokeAudio.addEventListener("seeked", updateKaraoke);
karaokeAudio.addEventListener("timeupdate", () => { if (!karaokeRAF) updateKaraoke(); });

// ============================================================
// VISTA: Video TikTok
// ============================================================
const videoGenerateBtn = document.getElementById("videoGenerateBtn");
const videoStatus = document.getElementById("videoStatus");
const videoGallery = document.getElementById("videoGallery");
const videoLoadStanzasBtn = document.getElementById("videoLoadStanzasBtn");
const stanzaPicker = document.getElementById("stanzaPicker");
const fragStartInput = document.getElementById("fragStart");
const fragEndInput = document.getElementById("fragEnd");
const fragPreviewBtn = document.getElementById("fragPreviewBtn");
const fragPreviewAudio = document.getElementById("fragPreviewAudio");

let videoStanzas = null; // estrofas de la última sincronización cargada

videoSongSelect.addEventListener("change", () => {
  videoStanzas = null;
  stanzaPicker.innerHTML = "";
  fragStartInput.value = "";
  fragEndInput.value = "";
  fragPreviewAudio.hidden = true;
});

// ---- Cargar / sincronizar estrofas para elegir el fragmento (ej. coro) ----
videoLoadStanzasBtn.addEventListener("click", async () => {
  const stem = videoSongSelect.value;
  if (!stem) return;
  const language = document.getElementById("videoLanguage").value.trim() || "es";
  const model = document.getElementById("videoModel").value;
  const force = document.getElementById("videoForce").checked;
  const separate_vocals = document.getElementById("videoSeparate").checked;
  const vad = document.getElementById("videoVad").checked ? "auditok" : "none";

  videoLoadStanzasBtn.disabled = true;

  try {
    // Si ya existe una sincronización y no se pide forzar, la reutilizamos
    // directamente sin lanzar un job en background.
    if (!force) {
      const cached = await apiGet(`/api/karaoke/${encodeURIComponent(stem)}`);
      if (cached.existe) {
        renderStanzaPicker(cached.datos.stanzas);
        videoLoadStanzasBtn.disabled = false;
        return;
      }
    }

    setStatus(videoStatus, "Sincronizando para detectar las estrofas... la primera vez puede tardar un par de minutos.");
    const { job_id } = await apiPost(`/api/sincronizar/${encodeURIComponent(stem)}`, { language, model, force, separate_vocals, vad });
    pollJob(job_id, {
      onDone: (result) => {
        setStatus(videoStatus, "Estrofas cargadas.", "ok");
        renderStanzaPicker(result.stanzas);
        videoLoadStanzasBtn.disabled = false;
      },
      onError: (err) => {
        setStatus(videoStatus, `Error: ${err}`, "error");
        videoLoadStanzasBtn.disabled = false;
      },
    });
  } catch (e) {
    setStatus(videoStatus, `Error: ${e.message}`, "error");
    videoLoadStanzasBtn.disabled = false;
  }
});

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
  const stem = videoSongSelect.value;
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
  const stem = videoSongSelect.value;
  if (!stem) return;
  const language = document.getElementById("videoLanguage").value.trim() || "es";
  const model = document.getElementById("videoModel").value;
  const force_sync = document.getElementById("videoForce").checked;
  const nombre_salida = document.getElementById("videoOutputName").value.trim() || null;
  const titulo = document.getElementById("videoTitulo").value.trim() || null;
  const artista = document.getElementById("videoArtista").value.trim() || null;
  const start_time = fragStartInput.value !== "" ? parseFloat(fragStartInput.value) : null;
  const end_time = fragEndInput.value !== "" ? parseFloat(fragEndInput.value) : null;
  const separate_vocals = document.getElementById("videoSeparate").checked;
  const vad = document.getElementById("videoVad").checked ? "auditok" : "none";

  videoGenerateBtn.disabled = true;
  setStatus(videoStatus, "Generando video... esto puede tardar varios minutos.");

  try {
    const { job_id } = await apiPost(`/api/video/${encodeURIComponent(stem)}`, {
      language, model, force_sync, nombre_salida, titulo, artista, start_time, end_time,
      separate_vocals, vad,
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
karaokeAudio.addEventListener("play", () => {
  if(audioCtx && audioCtx.state === "suspended") audioCtx.resume();
});
