// ============================================================
// player.js — reproductor de audio, playlist, buscador y
//             carga de letras en el reproductor.
// ============================================================

import { apiGet, apiPost, pollJob, refreshSongSelect } from "./api.js";
import { formatClock, normalizeText } from "./format.js";
import {
  showKaraoke,
  showPlainLyrics,
  resetKaraoke,
} from "./karaoke.js";

// ---- Estado mutable (leído también por studio.js y discover.js) --------
// `canciones` es lo que suena en el reproductor: solo temas completos.
// `biblioteca` incluye además los recortes, que se gestionan en «Recortar».
export let canciones = [];
export let biblioteca = [];

function _setLibrary(all) {
  biblioteca = all || [];
  canciones = biblioteca.filter((song) => (song.kind || "song") !== "clip");
  window.dispatchEvent(new CustomEvent("music-lab:library"));
}
export let indiceActual = 0;

// ---- DOM refs ---------------------------------------------------------------
export const audioPlayer = document.getElementById("audioPlayer");
const progressBar = document.querySelector(".progress");
const progressBarContainer = document.querySelector(".progress-bar");
export const prevBtn = document.getElementById("prevBtn");
export const nextBtn = document.getElementById("nextBtn");
export const playBtn = document.getElementById("playBtn");
const currentSongTitle = document.getElementById("currentSongTitle");
const currentArtistName = document.getElementById("currentArtistName");
const volumeSlider = document.querySelector(".volume-slider");
const npArtwork = document.getElementById("npArtwork");
const npArtworkImage = document.getElementById("npArtworkImage");
const artworkMonogram = document.getElementById("artworkMonogram");
const npTrackStatus = document.getElementById("npTrackStatus");
const libraryCount = document.getElementById("libraryCount");
const lyricsMode = document.getElementById("lyricsMode");
const miniPlayer = document.getElementById("miniPlayer");

// En la vista Reproductor el mini-reproductor solo hace falta cuando los
// controles principales quedan fuera de pantalla (p. ej. al bajar por la
// biblioteca). Esta clase la activa un observador sobre el botón de play.
const mainPlayButton = document.getElementById("playBtn");
if (mainPlayButton && "IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => {
    document.body.classList.toggle("player-controls-hidden", !entry.isIntersecting);
  }).observe(mainPlayButton);
}
const miniArtworkImage = document.getElementById("miniArtworkImage");
const miniArtworkFallback = document.getElementById("miniArtworkFallback");
const miniSongTitle = document.getElementById("miniSongTitle");
const miniArtistName = document.getElementById("miniArtistName");
const miniPlayBtn = document.getElementById("miniPlayBtn");
const soundcheckPanel = document.getElementById("soundcheckPanel");
const soundcheckDetail = document.getElementById("soundcheckDetail");
const soundcheckBtn = document.getElementById("soundcheckBtn");
const playerTools = document.getElementById("playerTools");
const metadataTitle = document.getElementById("metadataTitle");
const metadataArtist = document.getElementById("metadataArtist");
const metadataSaveBtn = document.getElementById("metadataSaveBtn");
const metadataStatus = document.getElementById("metadataStatus");
const coverModalOpenBtn = document.getElementById("coverModalOpenBtn");
const coverDialog = document.getElementById("coverDialog");
const coverDialogCloseBtn = document.getElementById("coverDialogCloseBtn");
const coverDialogQuery = document.getElementById("coverDialogQuery");
const coverDialogSearchBtn = document.getElementById("coverDialogSearchBtn");
const coverDialogResults = document.getElementById("coverDialogResults");
const coverDialogFileInput = document.getElementById("coverDialogFileInput");
const coverDialogAutoBtn = document.getElementById("coverDialogAutoBtn");
const coverDialogStatus = document.getElementById("coverDialogStatus");
const karaokeModeBtn = document.getElementById("karaokeModeBtn");
const karaokeModeLabel = document.getElementById("karaokeModeLabel");
const karaokeModeDetail = document.getElementById("karaokeModeDetail");
const karaokeModeControl = document.getElementById("karaokeModeControl");

let isDragging = false;
let newTime = 0;
let libraryLoaded = false;

// ---- Preferencias persistentes ---------------------------------------------
const STORE = {
  volume: "music-lab:volume",
  shuffle: "music-lab:shuffle",
  repeat: "music-lab:repeat",
  session: "music-lab:session",
};

function _read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function _write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Almacenamiento bloqueado: las preferencias duran lo que la pestaña.
  }
}

let shuffleOn = _read(STORE.shuffle, false) === true;
// "all" repite la biblioteca (comportamiento histórico), "one" la canción.
let repeatMode = ["off", "all", "one"].includes(_read(STORE.repeat, "all")) ? _read(STORE.repeat, "all") : "all";
const shuffleHistory = [];
// Posición a restaurar cuando cargue la canción de la sesión anterior.
let pendingSeek = null;

// Versión de portada por canción: solo cambia cuando el usuario la sustituye,
// así el navegador reutiliza la imagen en vez de volver a pedirla en cada
// cambio de pista.
const coverVersions = new Map();

export function coverUrl(song) {
  const version = coverVersions.get(song.stem);
  return `/api/canciones/${encodeURIComponent(song.stem)}/cover${version ? `?v=${version}` : ""}`;
}
let soundcheckStem = null;
let playbackMode = "original";
let preparingInstrumental = false;
let karaokeModeError = "";

export const playIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" stroke-width="2"><path d="M10 18l6 -6l-6 -6v12"></path></svg>`;
export const pauseIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" stroke-width="2"><path d="M6 5m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z"></path><path d="M14 5m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z"></path></svg>`;

const karaokeStage = document.getElementById("karaokeStage");
const karaokeText = document.getElementById("karaokeText");

// ---- API pública ------------------------------------------------------------

export async function cargarListaCanciones() {
  // Tras la primera carga, refrescar no debe reiniciar la canción que suena
  // (pasaba al terminar una descarga o guardar un recorte).
  if (libraryLoaded) {
    try {
      await refreshLibrary();
    } catch (e) {
      console.error("Error actualizando canciones:", e);
    }
    return;
  }
  try {
    const data = await apiGet("/api/canciones");
    _setLibrary(data.canciones);
    libraryLoaded = true;
    const session = _read(STORE.session, null);
    const restored = session ? canciones.findIndex((song) => song.stem === session.stem) : -1;
    if (restored >= 0) {
      indiceActual = restored;
      if (Number.isFinite(session.time) && session.time > 3) pendingSeek = session.time;
    }
    if (canciones.length > 0) cargarCancion(indiceActual);
    renderPlaylist();
  } catch (e) {
    console.error("Error obteniendo canciones:", e);
    _renderLibraryError();
  }
}

/** Vuelve a leer la biblioteca sin interrumpir la canción en curso, salvo que
 *  haya sido eliminada (en ese caso se detiene y se carga la primera). */
export async function refreshLibrary() {
  const currentStem = canciones[indiceActual]?.stem;
  const data = await apiGet("/api/canciones");
  _setLibrary(data.canciones);
  libraryLoaded = true;
  shuffleHistory.length = 0;
  const index = canciones.findIndex((song) => song.stem === currentStem);
  if (index >= 0) {
    indiceActual = index;
    _renderKaraokeMode();
  } else {
    audioPlayer.pause();
    indiceActual = 0;
    cargarCancion(0);
  }
  renderPlaylist();
}

/** Carga la canción `index` y, salvo que se pida lo contrario, la reproduce. */
export function playIndex(index, { autoplay = true } = {}) {
  if (!canciones.length) return;
  indiceActual = ((index % canciones.length) + canciones.length) % canciones.length;
  pendingSeek = null;
  cargarCancion(indiceActual);
  _markActiveSong();
  if (autoplay) _play();
}

export function playStem(stem) {
  const index = canciones.findIndex((song) => song.stem === stem);
  if (index >= 0) playIndex(index);
}

function _play() {
  // play() rechaza si el navegador exige un gesto o si se cambia de pista
  // antes de que cargue; no es un error que deba llegar a la consola.
  audioPlayer.play()?.catch(() => {});
}

export function togglePlay() {
  if (!audioPlayer.getAttribute("src")) return;
  if (audioPlayer.paused) _play();
  else audioPlayer.pause();
}

export function playNext() {
  if (!canciones.length) return;
  if (shuffleOn && canciones.length > 1) {
    let next = indiceActual;
    while (next === indiceActual) next = Math.floor(Math.random() * canciones.length);
    shuffleHistory.push(indiceActual);
    if (shuffleHistory.length > 200) shuffleHistory.shift();
    playIndex(next);
  } else {
    playIndex(indiceActual + 1);
  }
}

export function playPrevious() {
  if (!canciones.length) return;
  // Como en cualquier reproductor: pasado el arranque, "anterior" reinicia.
  if (audioPlayer.currentTime > 4) {
    audioPlayer.currentTime = 0;
    return;
  }
  if (shuffleOn && shuffleHistory.length) playIndex(shuffleHistory.pop());
  else playIndex(indiceActual - 1);
}

export function seekBy(seconds) {
  if (!Number.isFinite(audioPlayer.duration)) return;
  audioPlayer.currentTime = Math.min(
    Math.max(0, audioPlayer.currentTime + seconds), Math.max(0, audioPlayer.duration - 0.2));
}

export function cargarCancion(index) {
  const cancion = canciones[index];
  if (!cancion) {
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
    _renderTime();
    currentSongTitle.textContent = "Sin canción";
    currentArtistName.textContent = "Artista";
    _setArtwork(null);
    _syncMiniPlayer(null);
    soundcheckStem = null;
    window.dispatchEvent(
      new CustomEvent("music-lab:songchange", {
        detail: { title: "Music Lab Ambient" },
      })
    );
    _setTrackGain(0);
    _renderSoundcheck(null);
    _renderMetadata(null);
    _resetKaraokeMode();
    _loadPlayerLyrics(null);
    return;
  }
  currentSongTitle.textContent = cancion.title || cancion.stem;
  currentArtistName.textContent = cancion.artist || "";
  _setArtwork(cancion);
  _syncMiniPlayer(cancion);
  _resetKaraokeMode();
  audioPlayer.src = `/canciones/${encodeURIComponent(cancion.nombre)}`;
  _renderTime();
  _updateMediaSession(cancion);
  _saveSession(0);
  window.dispatchEvent(
    new CustomEvent("music-lab:songchange", {
      detail: {
        title: cancion.title || cancion.stem,
        artist: cancion.artist || "",
        filename: cancion.nombre,
        stem: cancion.stem,
        coverUrl: coverUrl(cancion),
      },
    })
  );
  _setTrackGain(0);
  _loadSoundcheck(cancion);
  _renderMetadata(cancion);
  _loadPlayerLyrics(cancion);
}

function _instrumentalSource(song) {
  if (song && song.pista_url) {
    return song.pista_url;
  }
  return `/vocals/${encodeURIComponent(song.stem)}.instrumental.flac`;
}

function _resetKaraokeMode() {
  playbackMode = "original";
  preparingInstrumental = false;
  karaokeModeError = "";
  _renderKaraokeMode();
}

function _renderKaraokeMode() {
  if (!karaokeModeBtn || !karaokeModeLabel || !karaokeModeDetail) return;
  const song = canciones[indiceActual];
  const hasSong = Boolean(song);
  const hasInstrumental = Boolean(song?.tiene_pista);
  const active = playbackMode === "instrumental";

  karaokeModeControl?.classList.toggle("is-active", active);
  karaokeModeControl?.classList.toggle("is-preparing", preparingInstrumental);
  karaokeModeBtn.disabled = !hasSong || preparingInstrumental;
  karaokeModeBtn.setAttribute("aria-pressed", String(active));

  if (!hasSong) {
    karaokeModeLabel.textContent = "Sin canción";
    karaokeModeDetail.textContent = "Elige una canción";
  } else if (preparingInstrumental) {
    karaokeModeLabel.textContent = "Preparando";
    karaokeModeDetail.textContent = "Separando voz e instrumental...";
  } else if (active) {
    karaokeModeLabel.textContent = "Desactivar";
    karaokeModeDetail.textContent = "Instrumental sin voz";
  } else if (karaokeModeError) {
    karaokeModeLabel.textContent = "Reintentar";
    karaokeModeDetail.textContent = karaokeModeError;
  } else {
    karaokeModeLabel.textContent = hasInstrumental ? "Activar" : "Preparar";
    karaokeModeDetail.textContent = hasInstrumental ? "Pista original" : "Se prepara una sola vez";
  }
}

function _swapPlaybackSource(song, mode) {
  const currentTime = audioPlayer.currentTime || 0;
  const wasPlaying = !audioPlayer.paused;
  const source = mode === "instrumental"
    ? _instrumentalSource(song)
    : `/canciones/${encodeURIComponent(song.nombre)}`;

  return new Promise((resolve) => {
    const restorePlayback = async () => {
      audioPlayer.removeEventListener("loadedmetadata", restorePlayback);
      if (Number.isFinite(audioPlayer.duration)) {
        audioPlayer.currentTime = Math.min(currentTime, Math.max(0, audioPlayer.duration - 0.05));
      }
      if (wasPlaying) {
        try {
          await audioPlayer.play();
        } catch {
          // La interfaz conserva el estado; el navegador puede requerir un nuevo gesto.
        }
      }
      resolve();
    };
    audioPlayer.addEventListener("loadedmetadata", restorePlayback, { once: true });
    audioPlayer.src = source;
    audioPlayer.load();
  });
}

async function _toggleKaraokeMode() {
  const song = canciones[indiceActual];
  if (!song || preparingInstrumental) return;

  if (playbackMode === "instrumental") {
    playbackMode = "original";
    _renderKaraokeMode();
    await _swapPlaybackSource(song, playbackMode);
    return;
  }

  if (!song.tiene_pista) {
    karaokeModeError = "";
    preparingInstrumental = true;
    _renderKaraokeMode();
    try {
      const result = await apiPost(`/api/karaoke/${encodeURIComponent(song.stem)}/pista`);
      if (!result.lista) {
        await new Promise((resolve, reject) => {
          pollJob(result.job_id, {
            onDone: resolve,
            onError: reject,
            onTick: (job) => {
              if (canciones[indiceActual]?.stem === song.stem) {
                karaokeModeDetail.textContent = job.progress?.phase || "Separando voz e instrumental...";
              }
            },
          });
        });
      }
      if (canciones[indiceActual]?.stem !== song.stem) return;
      song.tiene_pista = true;
    } catch (error) {
      if (canciones[indiceActual]?.stem === song.stem) {
        karaokeModeError = `No se pudo preparar: ${error.message || error}`;
      }
      return;
    } finally {
      preparingInstrumental = false;
      _renderKaraokeMode();
    }
  }

  if (canciones[indiceActual]?.stem !== song.stem) return;
  playbackMode = "instrumental";
  _renderKaraokeMode();
  await _swapPlaybackSource(song, playbackMode);
}

function _renderMetadata(cancion) {
  if (!playerTools || !metadataTitle || !metadataArtist || !metadataSaveBtn) return;
  playerTools.open = false;
  metadataStatus.textContent = "";
  metadataTitle.value = cancion?.title || "";
  metadataArtist.value = cancion?.artist || "";
  metadataSaveBtn.disabled = !cancion;
}

function _hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function _initials(song) {
  const source = song?.title || song?.stem || "Music Lab";
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function _setTrackPalette(red, green, blue) {
  const root = document.documentElement.style;
  root.setProperty("--track-primary-rgb", `${red}, ${green}, ${blue}`);
  root.setProperty("--track-primary", `rgb(${red}, ${green}, ${blue})`);
  root.setProperty("--track-primary-soft", `rgba(${red}, ${green}, ${blue}, 0.16)`);
  root.setProperty("--track-primary-glow", `rgba(${red}, ${green}, ${blue}, 0.30)`);
}

function _setFallbackPalette(song) {
  const hue = _hashString(`${song?.title || "Music Lab"}:${song?.artist || ""}`) % 360;
  const color = `hsl(${hue} 82% 58%)`;
  document.documentElement.style.setProperty("--art-hue", hue);
  document.documentElement.style.setProperty("--track-primary", color);
  document.documentElement.style.setProperty("--track-primary-soft", `hsl(${hue} 82% 58% / 0.16)`);
  document.documentElement.style.setProperty("--track-primary-glow", `hsl(${hue} 82% 58% / 0.30)`);
}

function _colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function _sampleArtworkPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 28;
  canvas.height = 28;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  try {
    context.drawImage(image, 0, 0, 28, 28);
    const pixels = context.getImageData(0, 0, 28, 28).data;
    const buckets = new Map();

    for (let i = 0; i < pixels.length; i += 4) {
      const color = [pixels[i], pixels[i + 1], pixels[i + 2]];
      const max = Math.max(...color);
      const min = Math.min(...color);
      const chroma = max - min;
      const luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
      if (pixels[i + 3] < 220 || luminance < 28 || luminance > 238 || chroma < 22) continue;

      // Cuantizar evita que un degradado produzca decenas de tonos casi iguales.
      const key = color.map((channel) => Math.round(channel / 40) * 40).join(":");
      const bucket = buckets.get(key) || { sum: [0, 0, 0], weight: 0 };
      const weight = 1 + chroma / 80;
      bucket.sum[0] += color[0] * weight;
      bucket.sum[1] += color[1] * weight;
      bucket.sum[2] += color[2] * weight;
      bucket.weight += weight;
      buckets.set(key, bucket);
    }

    const candidates = [...buckets.values()]
      .sort((a, b) => b.weight - a.weight)
      .map((bucket) => bucket.sum.map((channel) => Math.round(channel / bucket.weight)));
    if (!candidates.length) return;

    const colors = [candidates[0]];
    for (const candidate of candidates.slice(1)) {
      if (colors.every((color) => _colorDistance(color, candidate) > 78)) colors.push(candidate);
      if (colors.length === 3) break;
    }
    while (colors.length < 3) {
      const base = colors[0];
      const offset = colors.length === 1 ? [36, -24, 58] : [-28, 48, 20];
      colors.push(base.map((channel, index) => Math.max(24, Math.min(238, channel + offset[index]))));
    }

    _setTrackPalette(...colors[0]);
    window.dispatchEvent(
      new CustomEvent("music-lab:artworkpalette", {
        detail: { colors, imageSrc: image.currentSrc || image.src },
      })
    );
  } catch {
    // El fallback determinista ya mantiene la identidad si el canvas no puede leer la imagen.
  }
}

function _setArtwork(song) {
  const initials = _initials(song);
  npArtwork?.classList.remove("track-change");
  requestAnimationFrame(() => npArtwork?.classList.add("track-change"));
  if (artworkMonogram) artworkMonogram.textContent = initials;
  if (miniArtworkFallback) miniArtworkFallback.textContent = initials;
  _setFallbackPalette(song);
  if (!npArtworkImage || !song) {
    npArtwork?.classList.remove("has-image");
    if (npArtworkImage) npArtworkImage.hidden = true;
    return;
  }
  npArtwork?.classList.remove("has-image");
  npArtworkImage.hidden = true;
  npArtworkImage.alt = `Carátula de ${song.title || song.stem}`;
  npArtworkImage.onload = () => {
    npArtworkImage.hidden = false;
    npArtwork?.classList.add("has-image");
    _sampleArtworkPalette(npArtworkImage);
  };
  npArtworkImage.onerror = () => {
    npArtworkImage.hidden = true;
    npArtwork?.classList.remove("has-image");
  };
  npArtworkImage.src = coverUrl(song);
}

/** La portada de `song` cambió en el servidor: se vuelve a pedir en el
 *  reproductor, el fondo ambiental y la lista. */
function _renderArtwork(song) {
  coverVersions.set(song.stem, Date.now());
  if (canciones[indiceActual]?.stem !== song.stem) return;
  _setArtwork(song);
  _updateMediaSession(song);
  window.dispatchEvent(
    new CustomEvent("music-lab:songchange", {
      detail: {
        title: song.title || song.stem,
        artist: song.artist || "",
        filename: song.nombre,
        stem: song.stem,
        coverUrl: coverUrl(song),
      },
    })
  );
}

function _syncMiniPlayer(song) {
  if (!miniPlayer) return;
  miniPlayer.hidden = !song;
  if (!song) return;
  miniSongTitle.textContent = song.title || song.stem;
  miniArtistName.textContent = song.artist || "";
  miniArtworkImage.hidden = true;
  miniArtworkImage.alt = `Carátula de ${song.title || song.stem}`;
  miniArtworkImage.onload = () => { miniArtworkImage.hidden = false; };
  miniArtworkImage.onerror = () => { miniArtworkImage.hidden = true; };
  miniArtworkImage.src = coverUrl(song);
  _updatePlaybackChrome();
}

function _updatePlaybackChrome() {
  const playing = !audioPlayer.paused && Boolean(audioPlayer.getAttribute("src"));
  npArtwork?.classList.toggle("playing", playing);
  document.body.classList.toggle("is-playing", playing);
  // El icono sale siempre del estado real del audio: antes se cambiaba a mano
  // en cada botón y quedaba en "pausa" si play() era rechazado.
  playBtn.innerHTML = playing ? pauseIcon : playIcon;
  playBtn.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
  if (npTrackStatus) {
    npTrackStatus.textContent = playbackMode === "instrumental"
      ? (playing ? "Karaoke activo" : "Karaoke listo")
      : (playing ? "Reproduciendo" : "En pausa");
  }
  if (miniPlayBtn) {
    miniPlayBtn.innerHTML = playing ? pauseIcon : playIcon;
    miniPlayBtn.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
  }
}

function _setTrackGain(gainDb) {
  window.dispatchEvent(
    new CustomEvent("music-lab:trackgain", { detail: { gainDb } })
  );
}

function _formatGain(gainDb) {
  const gain = Number(gainDb) || 0;
  return `${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB`;
}

function _renderSoundcheck(analysis) {
  if (!soundcheckPanel || !soundcheckDetail || !soundcheckBtn) return;
  if (!analysis) {
    soundcheckDetail.textContent = "Sin calibrar";
    soundcheckBtn.textContent = "Analizar";
    soundcheckBtn.disabled = !soundcheckStem;
    return;
  }
  soundcheckDetail.textContent = `${_formatGain(analysis.gain_db)} · ${analysis.integrated_lufs.toFixed(1)} LUFS`;
  soundcheckBtn.textContent = "Reanalizar";
  soundcheckBtn.disabled = false;
}

async function _loadSoundcheck(cancion) {
  soundcheckStem = cancion.stem;
  _renderSoundcheck(null);
  try {
    const data = await apiGet(`/api/audio-calidad/${encodeURIComponent(cancion.stem)}`);
    if (soundcheckStem !== cancion.stem || !data.existe) return;
    _setTrackGain(data.datos.gain_db);
    _renderSoundcheck(data.datos);
  } catch {
    // Soundcheck es opcional: el reproductor sigue funcionando sin análisis.
  }
}

soundcheckBtn?.addEventListener("click", async () => {
  const stem = soundcheckStem;
  if (!stem) return;
  soundcheckBtn.disabled = true;
  soundcheckDetail.textContent = "Midiendo volumen...";
  try {
    const { job_id } = await apiPost(`/api/audio-calidad/${encodeURIComponent(stem)}`);
    pollJob(job_id, {
      onTick: (job) => {
        if (soundcheckStem === stem) soundcheckDetail.textContent = job.progress?.phase || "Midiendo volumen...";
      },
      onDone: (analysis) => {
        if (soundcheckStem === stem) {
          _setTrackGain(analysis.gain_db);
          _renderSoundcheck(analysis);
        }
      },
      onError: (error) => {
        if (soundcheckStem === stem) {
          soundcheckDetail.textContent = `No se pudo medir: ${error}`;
          soundcheckBtn.disabled = false;
        }
      },
    });
  } catch (error) {
    soundcheckDetail.textContent = `No se pudo medir: ${error.message}`;
    soundcheckBtn.disabled = false;
  }
});

metadataSaveBtn?.addEventListener("click", async () => {
  const song = canciones[indiceActual];
  if (!song) return;
  metadataSaveBtn.disabled = true;
  metadataStatus.textContent = "Guardando ficha...";
  try {
    const result = await apiPost(
      `/api/canciones/${encodeURIComponent(song.stem)}/metadata`,
      { title: metadataTitle.value, artist: metadataArtist.value }
    );
    Object.assign(song, result.metadata);
    currentSongTitle.textContent = song.title;
    currentArtistName.textContent = song.artist || "";
    metadataStatus.textContent = "Ficha guardada.";
    _renderArtwork(song);
    _syncMiniPlayer(song);
    renderPlaylist();
    const [{ studioSongSelect }, { refreshLyricsSongs }] = await Promise.all([
      import("./studio.js"),
      import("./lyrics.js"),
    ]);
    refreshSongSelect(studioSongSelect);
    refreshLyricsSongs();
  } catch (error) {
    metadataStatus.textContent = `No se pudo guardar: ${error.message}`;
  } finally {
    metadataSaveBtn.disabled = false;
  }
});

let coverSearchId = 0;

async function _searchAndRenderCoverCandidates(song, query) {
  if (!coverDialogResults) return;
  coverDialogResults.innerHTML = '<div class="cover-dialog-empty">Buscando carátulas disponibles…</div>';
  if (coverDialogStatus) coverDialogStatus.textContent = "";

  const searchId = ++coverSearchId;
  try {
    const qParam = query ? `?q=${encodeURIComponent(query)}` : "";
    const res = await apiGet(`/api/canciones/${encodeURIComponent(song.stem)}/cover/search${qParam}`);
    // Una búsqueda anterior más lenta no debe pisar los resultados de la nueva.
    if (searchId !== coverSearchId) return;
    const candidates = res.candidates || [];
    if (!candidates.length) {
      coverDialogResults.innerHTML = '<div class="cover-dialog-empty">No se encontraron carátulas relevantes para esta búsqueda. Prueba con otro término o sube un archivo local.</div>';
      return;
    }

    coverDialogResults.innerHTML = "";
    candidates.forEach((cand) => {
      const card = document.createElement("div");
      card.className = "cover-candidate-card";
      card.title = `Aplicar carátula de "${cand.title}" por ${cand.artist}`;
      // Los textos vienen de catálogos externos: nunca como HTML.
      const img = document.createElement("img");
      img.className = "cover-candidate-img";
      img.loading = "lazy";
      img.alt = cand.title || "";
      img.src = cand.preview_url || cand.cover_url;
      const info = document.createElement("div");
      info.className = "cover-candidate-info";
      [["cover-candidate-title", cand.title], ["cover-candidate-artist", cand.artist],
        ["cover-candidate-source", cand.source]].forEach(([className, text]) => {
        const span = document.createElement("span");
        span.className = className;
        span.textContent = text || "";
        info.appendChild(span);
      });
      card.append(img, info);
      card.addEventListener("click", async () => {
        if (coverDialogStatus) coverDialogStatus.textContent = "Aplicando portada...";
        try {
          await apiPost(`/api/canciones/${encodeURIComponent(song.stem)}/cover/apply`, {
            image_url: cand.cover_url,
          });
          _renderArtwork(song);
          _syncMiniPlayer(song);
          renderPlaylist();
          if (coverDialogStatus) coverDialogStatus.textContent = "Portada actualizada.";
          setTimeout(() => coverDialog?.close(), 400);
        } catch (err) {
          if (coverDialogStatus) coverDialogStatus.textContent = `Error: ${err.message}`;
        }
      });
      coverDialogResults.appendChild(card);
    });
  } catch (err) {
    const failure = document.createElement("div");
    failure.className = "cover-dialog-empty";
    failure.textContent = `Error al buscar: ${err.message}`;
    coverDialogResults.replaceChildren(failure);
  }
}

coverModalOpenBtn?.addEventListener("click", () => {
  const song = canciones[indiceActual];
  if (!song || !coverDialog) return;
  const initialQuery = `${song.title || song.stem} ${song.artist || ""}`.trim();
  if (coverDialogQuery) coverDialogQuery.value = initialQuery;
  coverDialog.showModal();
  _searchAndRenderCoverCandidates(song, initialQuery);
});

coverDialogCloseBtn?.addEventListener("click", () => coverDialog?.close());
coverDialog?.addEventListener("click", (e) => {
  if (e.target === coverDialog) coverDialog.close();
});

coverDialogSearchBtn?.addEventListener("click", () => {
  const song = canciones[indiceActual];
  if (!song) return;
  const query = coverDialogQuery?.value.trim() || "";
  _searchAndRenderCoverCandidates(song, query);
});

coverDialogQuery?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    coverDialogSearchBtn?.click();
  }
});

coverDialogAutoBtn?.addEventListener("click", async () => {
  const song = canciones[indiceActual];
  if (!song) return;
  if (coverDialogStatus) coverDialogStatus.textContent = "Rebuscando en catálogos...";
  try {
    await apiPost(`/api/canciones/${encodeURIComponent(song.stem)}/cover/refresh`, {});
    _renderArtwork(song);
    _syncMiniPlayer(song);
    renderPlaylist();
    if (coverDialogStatus) coverDialogStatus.textContent = "Portada re-evaluada.";
    setTimeout(() => coverDialog?.close(), 400);
  } catch (err) {
    if (coverDialogStatus) coverDialogStatus.textContent = `Error: ${err.message}`;
  }
});

coverDialogFileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  const song = canciones[indiceActual];
  if (!file || !song) return;
  if (coverDialogStatus) coverDialogStatus.textContent = "Subiendo imagen...";
  try {
    const res = await fetch(`/api/canciones/${encodeURIComponent(song.stem)}/cover/upload`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Fallo en subida");
    }
    _renderArtwork(song);
    _syncMiniPlayer(song);
    renderPlaylist();
    if (coverDialogStatus) coverDialogStatus.textContent = "Portada asignada con éxito.";
    setTimeout(() => coverDialog?.close(), 400);
  } catch (err) {
    if (coverDialogStatus) coverDialogStatus.textContent = `Error: ${err.message}`;
  } finally {
    coverDialogFileInput.value = "";
  }
});


async function _loadPlayerLyrics(cancion) {
  resetKaraoke();
  const emptyEl = document.getElementById("npLyricsEmpty");
  if (!cancion) {
    karaokeStage.hidden = true;
    emptyEl.style.display = "";
    if (lyricsMode) lyricsMode.textContent = "Sin letra";
    return;
  }
  const stillCurrent = () => canciones[indiceActual]?.stem === cancion.stem;
  try {
    if (cancion.tiene_sync) {
      const r = await apiGet(`/api/karaoke/${encodeURIComponent(cancion.stem)}`);
      // Al saltar rápido entre canciones, la respuesta lenta de la anterior
      // pintaba su letra sobre la canción nueva.
      if (!stillCurrent()) return;
      if (r.existe) {
        emptyEl.style.display = "none";
        if (lyricsMode) lyricsMode.textContent = "Sincronizada";
        showKaraoke(cancion.stem, r.datos);
        return;
      }
    }
    if (cancion.tiene_letra) {
      const r = await apiGet(`/api/letra/${encodeURIComponent(cancion.stem)}`);
      if (!stillCurrent()) return;
      emptyEl.style.display = "none";
      if (lyricsMode) lyricsMode.textContent = "Lectura";
      showPlainLyrics(r.texto || "");
      return;
    }
    karaokeStage.hidden = true;
    emptyEl.style.display = "";
    if (lyricsMode) lyricsMode.textContent = "Sin letra";
  } catch (e) {
    if (!stillCurrent()) return;
    karaokeStage.hidden = true;
    emptyEl.style.display = "";
    if (lyricsMode) lyricsMode.textContent = "Sin letra";
  }
}

const playlistDiv = document.getElementById("playlistContainer");
const playlistSearch = document.getElementById("playlistSearch");

function _playlistNote(text) {
  const note = document.createElement("div");
  note.className = "playlist-note";
  note.textContent = text;
  return note;
}

function _renderLibraryError() {
  playlistDiv.replaceChildren(
    _playlistNote("No se pudo cargar la biblioteca. Comprueba que el servidor sigue en marcha y recarga.")
  );
}

export function renderPlaylist() {
  if (libraryCount) {
    libraryCount.textContent = `${canciones.length} ${canciones.length === 1 ? "canción" : "canciones"}`;
  }

  const fragment = document.createDocumentFragment();
  canciones.forEach((cancion, index) => {
    const songItem = document.createElement("div");
    songItem.className = "song-item";
    songItem.dataset.index = index;
    songItem.tabIndex = 0;
    songItem.setAttribute("role", "button");
    songItem.dataset.search = normalizeText(
      [cancion.title, cancion.artist, cancion.stem].filter(Boolean).join(" ")
    );
    if (index === indiceActual) songItem.classList.add("active");

    const songDetails = document.createElement("div");
    songDetails.className = "song-details";

    const titleRow = document.createElement("div");
    titleRow.className = "song-title-row";
    const eq = document.createElement("span");
    eq.className = "eq";
    eq.innerHTML = "<i></i><i></i><i></i>";
    const songTitle = document.createElement("span");
    songTitle.className = "song-title";
    songTitle.textContent = cancion.title || cancion.stem;
    titleRow.append(eq, songTitle);
    songDetails.appendChild(titleRow);

    if (cancion.artist) {
      const songArtist = document.createElement("span");
      songArtist.className = "song-artist";
      songArtist.textContent = cancion.artist;
      songDetails.appendChild(songArtist);
    }

    const badges = document.createElement("div");
    badges.className = "badges";
    badges.innerHTML = `
      <span class="badge ${cancion.tiene_letra ? "on" : ""}">Letra</span>
      <span class="badge ${cancion.tiene_sync ? "on" : ""}">Karaoke</span>
    `;
    const songDuration = document.createElement("span");
    songDuration.className = "song-duration";
    songDuration.textContent = cancion.duracion || "Desconocida";
    const songMeta = document.createElement("div");
    songMeta.className = "song-meta";
    songMeta.append(badges, songDuration);

    const songArtwork = document.createElement("div");
    songArtwork.className = "song-artwork";
    songArtwork.textContent = _initials(cancion);
    const songArtworkImage = document.createElement("img");
    songArtworkImage.alt = "";
    songArtworkImage.loading = "lazy";
    songArtworkImage.decoding = "async";
    songArtworkImage.onload = () => songArtwork.classList.add("has-image");
    songArtworkImage.onerror = () => songArtworkImage.remove();
    songArtworkImage.src = coverUrl(cancion);
    songArtwork.appendChild(songArtworkImage);

    songItem.append(songArtwork, songDetails, songMeta);
    fragment.appendChild(songItem);
  });

  if (!canciones.length) {
    fragment.appendChild(_playlistNote("Tu biblioteca está vacía. Añade una canción desde «Video» o «Descubrir»."));
  }
  playlistDiv.replaceChildren(fragment);
  applyPlaylistFilter();
}

/** Marca la fila activa sin reconstruir la lista (antes cada "siguiente"
 *  recreaba todas las filas y volvía a pedir todas las portadas). */
function _markActiveSong() {
  playlistDiv.querySelectorAll(".song-item.active").forEach((el) => el.classList.remove("active"));
  const active = playlistDiv.querySelector(`.song-item[data-index="${indiceActual}"]`);
  if (!active) return;
  active.classList.add("active");
  if (active.hidden) return;
  // Solo se desplaza la lista: scrollIntoView movía también la página y
  // dejaba la portada fuera de pantalla.
  const top = active.offsetTop - playlistDiv.offsetTop;
  if (top < playlistDiv.scrollTop) playlistDiv.scrollTop = top;
  else if (top + active.offsetHeight > playlistDiv.scrollTop + playlistDiv.clientHeight) {
    playlistDiv.scrollTop = top + active.offsetHeight - playlistDiv.clientHeight;
  }
}

export function applyPlaylistFilter() {
  const q = normalizeText(playlistSearch?.value || "");
  let visible = 0;
  playlistDiv.querySelectorAll(".song-item").forEach((el) => {
    const match = !q || (el.dataset.search || "").includes(q);
    el.hidden = !match;
    if (match) visible += 1;
  });
  playlistDiv.querySelector(".playlist-note.is-filter")?.remove();
  if (q && !visible && canciones.length) {
    const note = _playlistNote(`Nada coincide con «${playlistSearch.value.trim()}».`);
    note.classList.add("is-filter");
    playlistDiv.appendChild(note);
  }
}

// Un único listener para toda la lista en vez de uno por fila.
playlistDiv.addEventListener("click", (event) => {
  const item = event.target.closest(".song-item");
  if (item) playIndex(Number(item.dataset.index));
});
playlistDiv.addEventListener("keydown", (event) => {
  const item = event.target.closest(".song-item");
  if (!item) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    playIndex(Number(item.dataset.index));
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    let sibling = item;
    do {
      sibling = event.key === "ArrowDown" ? sibling.nextElementSibling : sibling.previousElementSibling;
    } while (sibling && (sibling.hidden || !sibling.classList.contains("song-item")));
    sibling?.focus();
  }
});
playlistSearch?.addEventListener("input", applyPlaylistFilter);
playlistSearch?.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && playlistSearch.value) {
    playlistSearch.value = "";
    applyPlaylistFilter();
  }
});

// ---- Transporte --------------------------------------------------------------

prevBtn.addEventListener("click", playPrevious);
nextBtn.addEventListener("click", playNext);
playBtn.addEventListener("click", togglePlay);
miniPlayBtn?.addEventListener("click", togglePlay);

const shuffleBtn = document.getElementById("shuffleBtn");
const repeatBtn = document.getElementById("repeatBtn");
const REPEAT_LABELS = { off: "Repetición desactivada", all: "Repetir biblioteca", one: "Repetir esta canción" };

function _renderModes() {
  if (shuffleBtn) {
    shuffleBtn.classList.toggle("is-on", shuffleOn);
    shuffleBtn.setAttribute("aria-pressed", String(shuffleOn));
    shuffleBtn.title = shuffleOn ? "Aleatorio activado (S)" : "Aleatorio (S)";
  }
  if (repeatBtn) {
    repeatBtn.classList.toggle("is-on", repeatMode !== "off");
    repeatBtn.dataset.mode = repeatMode;
    repeatBtn.title = `${REPEAT_LABELS[repeatMode]} (R)`;
    repeatBtn.setAttribute("aria-label", REPEAT_LABELS[repeatMode]);
  }
}

export function toggleShuffle() {
  shuffleOn = !shuffleOn;
  shuffleHistory.length = 0;
  _write(STORE.shuffle, shuffleOn);
  _renderModes();
  return shuffleOn;
}

export function cycleRepeat() {
  repeatMode = { off: "all", all: "one", one: "off" }[repeatMode];
  _write(STORE.repeat, repeatMode);
  _renderModes();
  return REPEAT_LABELS[repeatMode];
}

shuffleBtn?.addEventListener("click", toggleShuffle);
repeatBtn?.addEventListener("click", cycleRepeat);
_renderModes();

// Pulsar la portada o el título del mini-reproductor vuelve a la vista Reproductor.
const miniOpen = document.getElementById("miniOpen");
const _goToPlayer = () => document.querySelector('.nav-item[data-view="player"]')?.click();
miniOpen?.addEventListener("click", _goToPlayer);
miniOpen?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    _goToPlayer();
  }
});
karaokeModeBtn?.addEventListener("click", _toggleKaraokeMode);

audioPlayer.addEventListener("play", _updatePlaybackChrome);
audioPlayer.addEventListener("pause", _updatePlaybackChrome);
audioPlayer.addEventListener("emptied", _updatePlaybackChrome);

audioPlayer.addEventListener("ended", () => {
  if (!canciones.length) return;
  if (repeatMode === "one") {
    audioPlayer.currentTime = 0;
    _play();
  } else if (repeatMode === "off" && !shuffleOn && indiceActual >= canciones.length - 1) {
    _updatePlaybackChrome(); // fin de la biblioteca: se queda en pausa
  } else {
    playNext();
  }
});

audioPlayer.addEventListener("error", () => {
  if (!audioPlayer.getAttribute("src")) return;
  if (npTrackStatus) npTrackStatus.textContent = "No se pudo reproducir";
});

// ---- Volumen -----------------------------------------------------------------

let lastAudibleVolume = 0.5;

export function setVolume(value) {
  const volume = Math.min(1, Math.max(0, Number(value) || 0));
  audioPlayer.volume = volume;
  audioPlayer.muted = false;
  if (volume > 0) lastAudibleVolume = volume;
  volumeSlider.value = volume;
  volumeSlider.style.setProperty("--value", `${volume * 100}%`);
  document.body.classList.toggle("is-muted", volume === 0);
  _write(STORE.volume, volume);
  return volume;
}

export function toggleMute() {
  return setVolume(audioPlayer.volume > 0 ? 0 : lastAudibleVolume);
}

volumeSlider.step = "0.01";
{
  const stored = Number(_read(STORE.volume, 0.5));
  setVolume(Number.isFinite(stored) ? stored : 0.5);
}
volumeSlider.addEventListener("input", (e) => setVolume(parseFloat(e.target.value)));
document.getElementById("volumeMuteBtn")?.addEventListener("click", toggleMute);

// ---- Tiempo y barra de progreso ---------------------------------------------

const currentTimeElem = document.getElementById("currentTime");
const durationElem = document.getElementById("duration");

function _renderTime() {
  const duration = audioPlayer.duration;
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const current = isDragging ? newTime : audioPlayer.currentTime || 0;
  currentTimeElem.textContent = formatClock(current);
  durationElem.textContent = formatClock(hasDuration ? duration : 0);
  const percent = hasDuration ? Math.min(100, (current / duration) * 100) : 0;
  progressBar.style.width = `${percent}%`;
  miniPlayer?.style.setProperty("--mini-progress", `${percent.toFixed(2)}%`);
  progressBarContainer.setAttribute("aria-valuenow", String(Math.round(percent)));
  progressBarContainer.setAttribute("aria-valuetext", `${formatClock(current)} de ${formatClock(hasDuration ? duration : 0)}`);
}

audioPlayer.addEventListener("timeupdate", () => {
  if (!isDragging) _renderTime();
  _saveSession();
});
audioPlayer.addEventListener("durationchange", _renderTime);
audioPlayer.addEventListener("loadedmetadata", () => {
  // Retoma donde se quedó la sesión anterior (solo la primera canción cargada).
  if (pendingSeek !== null && Number.isFinite(audioPlayer.duration)) {
    if (pendingSeek < audioPlayer.duration - 5) audioPlayer.currentTime = pendingSeek;
    pendingSeek = null;
  }
  _renderTime();
});

progressBarContainer.setAttribute("role", "slider");
progressBarContainer.setAttribute("tabindex", "0");
progressBarContainer.setAttribute("aria-label", "Posición de la canción");
progressBarContainer.setAttribute("aria-valuemin", "0");
progressBarContainer.setAttribute("aria-valuemax", "100");

const progressTip = document.createElement("span");
progressTip.className = "progress-tip";
progressTip.setAttribute("aria-hidden", "true");
progressBarContainer.appendChild(progressTip);

function _pointerRatio(event) {
  const rect = progressBarContainer.getBoundingClientRect();
  return rect.width ? Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) : 0;
}

function _showTip(event) {
  const duration = audioPlayer.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const ratio = _pointerRatio(event);
  progressTip.textContent = formatClock(ratio * duration);
  progressTip.style.left = `${ratio * 100}%`;
}

// Pointer events: el arrastre funciona igual con ratón, táctil y lápiz (antes
// solo ratón), y sin duración cargada ya no se asigna NaN a currentTime.
progressBarContainer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !Number.isFinite(audioPlayer.duration)) return;
  isDragging = true;
  progressBarContainer.classList.add("is-dragging");
  progressBarContainer.setPointerCapture?.(event.pointerId);
  newTime = _pointerRatio(event) * audioPlayer.duration;
  _showTip(event);
  _renderTime();
});
progressBarContainer.addEventListener("pointermove", (event) => {
  _showTip(event);
  if (!isDragging) return;
  newTime = _pointerRatio(event) * audioPlayer.duration;
  _renderTime();
});
const _endDrag = (commit) => () => {
  if (!isDragging) return;
  isDragging = false;
  progressBarContainer.classList.remove("is-dragging");
  if (commit && Number.isFinite(newTime)) audioPlayer.currentTime = newTime;
  _renderTime();
};
progressBarContainer.addEventListener("pointerup", _endDrag(true));
progressBarContainer.addEventListener("pointercancel", _endDrag(false));
progressBarContainer.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    event.stopPropagation();
    seekBy(event.key === "ArrowRight" ? 5 : -5);
  }
});

// ---- Sesión ------------------------------------------------------------------

let lastSessionSave = 0;

function _saveSession(forcedTime) {
  const song = canciones[indiceActual];
  if (!song) return;
  const now = performance.now();
  if (forcedTime === undefined && now - lastSessionSave < 2000) return;
  // Mientras hay una posición pendiente de restaurar no se pisa con 0.
  if (pendingSeek !== null) return;
  lastSessionSave = now;
  _write(STORE.session, { stem: song.stem, time: forcedTime ?? audioPlayer.currentTime ?? 0 });
}

window.addEventListener("pagehide", () => {
  if (!audioPlayer.getAttribute("src")) return;
  _saveSession(audioPlayer.currentTime || 0);
});

// ---- Media Session: teclas multimedia, auriculares y control del sistema -----

function _updateMediaSession(song) {
  if (!("mediaSession" in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || song.stem,
      artist: song.artist || "",
      album: "Music Lab",
      artwork: [{ src: new URL(coverUrl(song), location.href).href, sizes: "512x512", type: "image/jpeg" }],
    });
  } catch {
    // Metadatos opcionales: sin ellos las teclas multimedia siguen funcionando.
  }
}

if ("mediaSession" in navigator) {
  const handlers = {
    play: _play,
    pause: () => audioPlayer.pause(),
    previoustrack: playPrevious,
    nexttrack: playNext,
    seekbackward: (details) => seekBy(-(details?.seekOffset || 10)),
    seekforward: (details) => seekBy(details?.seekOffset || 10),
    seekto: (details) => {
      if (Number.isFinite(details?.seekTime)) audioPlayer.currentTime = details.seekTime;
    },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Acción no soportada por este navegador.
    }
  }
}

_updatePlaybackChrome();
