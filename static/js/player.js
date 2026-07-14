// ============================================================
// player.js — reproductor de audio, playlist, buscador y
//             carga de letras en el reproductor.
// ============================================================

import { apiGet, apiPost, pollJob, refreshSongSelect } from "./api.js";
import {
  showKaraoke,
  showPlainLyrics,
  resetKaraoke,
} from "./karaoke.js";

// ---- Estado mutable (leído también por studio.js y discover.js) --------
export let canciones = [];
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
const karaokeModeBtn = document.getElementById("karaokeModeBtn");
const karaokeModeLabel = document.getElementById("karaokeModeLabel");
const karaokeModeDetail = document.getElementById("karaokeModeDetail");
const karaokeModeControl = document.getElementById("karaokeModeControl");

let isDragging = false;
let newTime = 0;
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
  try {
    const data = await apiGet("/api/canciones");
    canciones = data.canciones || [];
    if (canciones.length > 0) cargarCancion(indiceActual);
    renderPlaylist();
  } catch (e) {
    console.error("Error obteniendo canciones:", e);
  }
}

export function cargarCancion(index) {
  const cancion = canciones[index];
  if (!cancion) {
    audioPlayer.src = "";
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
  currentArtistName.textContent = cancion.artist || "Biblioteca local";
  _setArtwork(cancion);
  _syncMiniPlayer(cancion);
  _resetKaraokeMode();
  audioPlayer.src = `/canciones/${encodeURIComponent(cancion.nombre)}`;
  window.dispatchEvent(
    new CustomEvent("music-lab:songchange", {
      detail: {
        title: cancion.title || cancion.stem,
        artist: cancion.artist || "",
        filename: cancion.nombre,
      },
    })
  );
  _setTrackGain(0);
  _loadSoundcheck(cancion);
  _renderMetadata(cancion);
  _loadPlayerLyrics(cancion);
}

function _instrumentalSource(song) {
  return `/vocals/${encodeURIComponent(song.stem)}.instrumental.wav`;
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

function _sampleArtworkPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 20;
  canvas.height = 20;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  try {
    context.drawImage(image, 0, 0, 20, 20);
    const pixels = context.getImageData(0, 0, 20, 20).data;
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
      if (max < 42 || max - min < 28) continue;
      red += pixels[i];
      green += pixels[i + 1];
      blue += pixels[i + 2];
      count += 1;
    }
    if (count) _setTrackPalette(Math.round(red / count), Math.round(green / count), Math.round(blue / count));
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
  npArtworkImage.src = `/api/canciones/${encodeURIComponent(song.stem)}/cover?v=${Date.now()}`;
}

function _syncMiniPlayer(song) {
  if (!miniPlayer) return;
  miniPlayer.hidden = !song;
  if (!song) return;
  miniSongTitle.textContent = song.title || song.stem;
  miniArtistName.textContent = song.artist || "Biblioteca local";
  miniArtworkImage.hidden = true;
  miniArtworkImage.alt = `Carátula de ${song.title || song.stem}`;
  miniArtworkImage.onload = () => { miniArtworkImage.hidden = false; };
  miniArtworkImage.onerror = () => { miniArtworkImage.hidden = true; };
  miniArtworkImage.src = `/api/canciones/${encodeURIComponent(song.stem)}/cover?v=${Date.now()}`;
  _updatePlaybackChrome();
}

function _updatePlaybackChrome() {
  const playing = !audioPlayer.paused && Boolean(audioPlayer.src);
  npArtwork?.classList.toggle("playing", playing);
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
    currentArtistName.textContent = song.artist || "Biblioteca local";
    metadataStatus.textContent = "Ficha guardada.";
    renderPlaylist();
    const [{ studioSongSelect }, { lyricsSongSelect }] = await Promise.all([
      import("./studio.js"),
      import("./lyrics.js"),
    ]);
    refreshSongSelect(studioSongSelect);
    refreshSongSelect(lyricsSongSelect);
  } catch (error) {
    metadataStatus.textContent = `No se pudo guardar: ${error.message}`;
  } finally {
    metadataSaveBtn.disabled = false;
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
  try {
    if (cancion.tiene_sync) {
      const r = await apiGet(`/api/karaoke/${encodeURIComponent(cancion.stem)}`);
      if (r.existe) {
        emptyEl.style.display = "none";
        if (lyricsMode) lyricsMode.textContent = "Sincronizada";
        showKaraoke(cancion.stem, r.datos);
        return;
      }
    }
    if (cancion.tiene_letra) {
      const r = await apiGet(`/api/letra/${encodeURIComponent(cancion.stem)}`);
      emptyEl.style.display = "none";
      if (lyricsMode) lyricsMode.textContent = "Lectura";
      showPlainLyrics(r.texto || "");
      return;
    }
    karaokeStage.hidden = true;
    emptyEl.style.display = "";
    if (lyricsMode) lyricsMode.textContent = "Sin letra";
  } catch (e) {
    karaokeStage.hidden = true;
    emptyEl.style.display = "";
    if (lyricsMode) lyricsMode.textContent = "Sin letra";
  }
}

export function renderPlaylist() {
  const playlistDiv = document.getElementById("playlistContainer");
  playlistDiv.innerHTML = "";
  if (libraryCount) {
    libraryCount.textContent = `${canciones.length} ${canciones.length === 1 ? "canción" : "canciones"}`;
  }

  canciones.forEach((cancion, index) => {
    const songItem = document.createElement("div");
    songItem.classList.add("song-item");
    songItem.dataset.search = [cancion.title, cancion.artist, cancion.stem]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (index === indiceActual) songItem.classList.add("active");

    const songDetails = document.createElement("div");
    songDetails.classList.add("song-details");

    const titleRow = document.createElement("div");
    titleRow.classList.add("song-title-row");

    const eq = document.createElement("span");
    eq.classList.add("eq");
    eq.innerHTML = "<i></i><i></i><i></i>";

    const songTitle = document.createElement("span");
    songTitle.classList.add("song-title");
    songTitle.textContent = cancion.title || cancion.stem;

    titleRow.appendChild(eq);
    titleRow.appendChild(songTitle);

    const badges = document.createElement("div");
    badges.classList.add("badges");
    badges.innerHTML = `
      <span class="badge ${cancion.tiene_letra ? "on" : ""}">Letra</span>
      <span class="badge ${cancion.tiene_sync ? "on" : ""}">Karaoke</span>
    `;

    songDetails.appendChild(titleRow);
    if (cancion.artist) {
      const songArtist = document.createElement("span");
      songArtist.className = "song-artist";
      songArtist.textContent = cancion.artist;
      songDetails.appendChild(songArtist);
    }

    const songDuration = document.createElement("span");
    songDuration.classList.add("song-duration");
    songDuration.textContent = cancion.duracion || "Desconocida";

    const songMeta = document.createElement("div");
    songMeta.classList.add("song-meta");
    songMeta.appendChild(badges);
    songMeta.appendChild(songDuration);

    const songArtwork = document.createElement("div");
    songArtwork.className = "song-artwork";
    songArtwork.textContent = _initials(cancion);
    const songArtworkImage = document.createElement("img");
    songArtworkImage.alt = "";
    songArtworkImage.loading = "lazy";
    songArtworkImage.onload = () => songArtwork.classList.add("has-image");
    songArtworkImage.onerror = () => songArtworkImage.remove();
    songArtworkImage.src = `/api/canciones/${encodeURIComponent(cancion.stem)}/cover`;
    songArtwork.appendChild(songArtworkImage);

    songItem.appendChild(songArtwork);
    songItem.appendChild(songDetails);
    songItem.appendChild(songMeta);
    playlistDiv.appendChild(songItem);

    songItem.addEventListener("click", () => {
      indiceActual = index;
      cargarCancion(indiceActual);
      audioPlayer.play();
      playBtn.innerHTML = pauseIcon;
      Array.from(playlistDiv.getElementsByClassName("song-item")).forEach((el) =>
        el.classList.remove("active")
      );
      songItem.classList.add("active");
    });
  });
  applyPlaylistFilter();
}

export function applyPlaylistFilter() {
  const inp = document.getElementById("playlistSearch");
  const q = inp ? inp.value.trim().toLowerCase() : "";
  document.querySelectorAll("#playlistContainer .song-item").forEach((el) => {
    const search = el.dataset.search || "";
    el.hidden = q && !search.includes(q);
  });
}

// ---- Event listeners --------------------------------------------------------

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

miniPlayBtn?.addEventListener("click", () => playBtn.click());
karaokeModeBtn?.addEventListener("click", _toggleKaraokeMode);

audioPlayer.addEventListener("play", _updatePlaybackChrome);
audioPlayer.addEventListener("pause", _updatePlaybackChrome);

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
  const progressPercent =
    (audioPlayer.currentTime / audioPlayer.duration) * 100 || 0;
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
  _updateVisualProgress(event);
});
document.addEventListener("mousemove", (event) => {
  if (isDragging) _updateVisualProgress(event);
});
document.addEventListener("mouseup", () => {
  if (isDragging) {
    isDragging = false;
    audioPlayer.currentTime = newTime;
  }
});

function _updateVisualProgress(event) {
  const rect = progressBarContainer.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const width = rect.width;
  const progressPercent = Math.min(Math.max(offsetX / width, 0), 1);
  progressBar.style.width = `${progressPercent * 100}%`;
  newTime = progressPercent * audioPlayer.duration;
}

document
  .getElementById("playlistSearch")
  .addEventListener("input", applyPlaylistFilter);
