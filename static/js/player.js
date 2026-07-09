// ============================================================
// player.js — reproductor de audio, playlist, buscador y
//             carga de letras en el reproductor.
// ============================================================

import { apiGet, setStatus } from "./api.js";
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

let isDragging = false;
let newTime = 0;

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
    _loadPlayerLyrics(null);
    return;
  }
  currentSongTitle.textContent = cancion.stem;
  currentArtistName.textContent = cancion.tiene_letra
    ? "Letra disponible"
    : "Sin letra guardada";
  audioPlayer.src = `/canciones/${encodeURIComponent(cancion.nombre)}`;
  _loadPlayerLyrics(cancion);
}

async function _loadPlayerLyrics(cancion) {
  resetKaraoke();
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

export function renderPlaylist() {
  const playlistDiv = document.getElementById("playlistContainer");
  playlistDiv.innerHTML = "";

  canciones.forEach((cancion, index) => {
    const songItem = document.createElement("div");
    songItem.classList.add("song-item");
    songItem.dataset.stem = cancion.stem.toLowerCase();
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
    const stem = el.dataset.stem || "";
    el.hidden = q && !stem.includes(q);
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
