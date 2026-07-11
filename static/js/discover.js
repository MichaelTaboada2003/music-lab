// ============================================================
// discover.js — vista Descubrir: Recap del mes, Mis playlists,
//               Mis favoritas (Spotify Web API)
// ============================================================

import { apiGet, apiPost, setStatus, refreshSongSelect, waitForJob } from "./api.js";
import { canciones, cargarListaCanciones } from "./player.js";
import { studioSongSelect } from "./studio.js";

// Re-export para que nav.js pueda llamar a loadRecap la primera vez.
export let discoverLoaded = false;
export function setDiscoverLoaded(v) { discoverLoaded = v; }

// ---- DOM refs ---------------------------------------------------------------
const spotifyGrid = document.getElementById("spotifyGrid");
const spotifyStatus = document.getElementById("spotifyStatus");
const discoverTabs = document.querySelectorAll(".discover-tab");
const recapPanel = document.getElementById("recapPanel");
const recapArtists = document.getElementById("recapArtists");
const recapTracks = document.getElementById("recapTracks");
const playlistCrumb = document.getElementById("playlistCrumb");
const playlistBackBtn = document.getElementById("playlistBackBtn");
const playlistCrumbTitle = document.getElementById("playlistCrumbTitle");

let currentAudioPreview = null;
let currentPreviewBtn = null;

// ---- Helpers ----------------------------------------------------------------

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
  currentAudioPreview.play().catch((e) => console.error("Error preview", e));
  currentAudioPreview.onended = () => {
    if (currentPreviewBtn) currentPreviewBtn.classList.remove("playing");
    currentPreviewBtn = null;
    currentAudioPreview = null;
  };
}

export function isInLibrary(title) {
  const t = (title || "").trim().toLowerCase();
  if (!t) return false;
  return canciones.some((c) => {
    const terms = [c.title, c.artist, c.stem]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return terms.includes(t) || t.includes(terms);
  });
}

export async function downloadFromSpotify(btn, title, artists) {
  btn.disabled = true;
  btn.textContent = "Descargando…";
  btn.title = "";
  let requestErr = null;
  try {
    const { job_id } = await apiPost("/api/descargar", {
      url: `ytsearch:${title} ${artists} audio`,
    });
    await waitForJob(job_id);
  } catch (e) {
    requestErr = e;
  }

  // Verificación real: aunque haya habido error, ¿aparece la canción?
  await cargarListaCanciones();
  refreshSongSelect(studioSongSelect);
  if (isInLibrary(title)) {
    btn.textContent = "En tu biblioteca";
    btn.classList.add("in-lib");
    btn.title = "";
    return;
  }

  const msg = ((requestErr && requestErr.message) || "").toLowerCase();
  if (msg.includes("drm") || msg.includes("protegido")) {
    btn.textContent = "Sin fuente disponible";
    btn.title =
      "El primer resultado de YouTube está protegido con DRM. Prueba buscando manualmente otra versión y pegando la URL en 'Añadir canción por URL'.";
  } else {
    btn.textContent = "Error, reintentar";
    btn.title =
      (requestErr && requestErr.message) ||
      "No se pudo descargar la canción.";
  }
  btn.disabled = false;
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

function _resetDiscoverPanels() {
  recapPanel.hidden = true;
  playlistCrumb.hidden = true;
  spotifyGrid.innerHTML = "";
  recapArtists.innerHTML = "";
  recapTracks.innerHTML = "";
  spotifyStatus.className = "status-box";
  spotifyStatus.textContent = "";
}

async function _withSpotifyAuth(fn) {
  try {
    await fn();
  } catch (err) {
    if (/401|iniciado sesión|expirada/i.test(err.message)) {
      showSpotifyLogin();
    } else if (/403/i.test(err.message)) {
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

// ---- Recap del mes ----------------------------------------------------------

export async function loadRecap() {
  _resetDiscoverPanels();
  recapPanel.hidden = false;
  setStatus(spotifyStatus, "Preparando tu recap del mes…");
  await _withSpotifyAuth(async () => {
    const [artistsRes, tracksRes] = await Promise.all([
      apiGet("/api/spotify/top-artists?time_range=short_term&limit=5"),
      apiGet("/api/spotify/top?time_range=short_term&limit=5"),
    ]);
    _renderRecapArtists(artistsRes.items || []);
    _renderRecapTracks(tracksRes.items || []);
    spotifyStatus.textContent = "";
  });
}

function _renderRecapArtists(artists) {
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

function _renderRecapTracks(tracks) {
  recapTracks.innerHTML = "";
  if (!tracks.length) {
    recapTracks.innerHTML = `<p class="hint">Sin canciones destacadas este mes todavía.</p>`;
    return;
  }
  renderCardsInto(recapTracks, tracks);
}

// ---- Mis playlists ----------------------------------------------------------

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
    items.forEach((pl) => spotifyGrid.appendChild(_renderPlaylistCard(pl)));
  });
}

function _renderPlaylistCard(pl) {
  const img = pl.images?.[0]?.url || "";
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
  card.addEventListener("click", () => _openPlaylist(pl));
  return card;
}

async function _openPlaylist(pl) {
  _resetDiscoverPanels();
  document.querySelector(".discover-tabs").style.display = "none";
  playlistCrumb.hidden = false;
  playlistCrumbTitle.textContent = pl.name;
  const meta = document.getElementById("playlistCrumbMeta");
  meta.textContent = pl.owner?.display_name ? `por ${pl.owner.display_name}` : "";

  setStatus(spotifyStatus, "Cargando canciones…");
  await _withSpotifyAuth(async () => {
    const res = await apiGet(`/api/spotify/playlist/${pl.id}/tracks`);
    const tracks = (res.items || [])
      .map((it) => it.track)
      .filter((t) => t && t.id);
    const total = res.total ?? tracks.length;
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

// ---- Mis favoritas ----------------------------------------------------------

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

// ---- Cards de tracks --------------------------------------------------------

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
    if (previewBtn)
      previewBtn.addEventListener("click", () =>
        playPreview(previewUrl, previewBtn)
      );

    const btn = card.querySelector(".btn-download-spotify");
    if (inLib) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () =>
        downloadFromSpotify(btn, title, artists)
      );
    }
    container.appendChild(card);
  });
}

// ---- Cableado de pestañas ---------------------------------------------------

discoverTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelector(".discover-tabs").style.display = "";
    discoverTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const src = tab.dataset.src;
    if (src === "recap") loadRecap();
    else if (src === "playlists") loadPlaylists();
    else if (src === "top") loadFavorites();
  });
});
