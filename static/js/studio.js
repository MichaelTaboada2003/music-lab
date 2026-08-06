// ============================================================
// studio.js — vista Video: sincronización + generación de video
// ============================================================

import {
  apiGet, apiPost, setStatus, pollJob,
  renderProgress, hideProgress, formatSeconds, refreshSongSelect,
} from "./api.js";
import { showKaraoke } from "./karaoke.js";
import { canciones, indiceActual } from "./player.js";

// ---- DOM refs ---------------------------------------------------------------
export const studioSongSelect = document.getElementById("studioSongSelect");
const studioSyncBtn = document.getElementById("studioSyncBtn");
const studioStatus = document.getElementById("studioStatus");
const videoGenerateBtn = document.getElementById("videoGenerateBtn");
const videoStatus = document.getElementById("videoStatus");
const videoGallery = document.getElementById("videoGallery");
const stanzaPicker = document.getElementById("stanzaPicker");
const fragStartInput = document.getElementById("fragStart");
const fragEndInput = document.getElementById("fragEnd");
const fragPreviewBtn = document.getElementById("fragPreviewBtn");
const fragPreviewAudio = document.getElementById("fragPreviewAudio");
const fragPreviewStage = document.getElementById("fragPreviewStage");
const fragPreviewLyrics = document.getElementById("fragPreviewLyrics");
const fragPreviewClose = document.getElementById("fragPreviewClose");
const fragPreviewLabel = document.getElementById("fragPreviewLabel");
const fragPreviewTitle = document.getElementById("fragPreviewTitle");
const fragPreviewArtist = document.getElementById("fragPreviewArtist");
const videoLayoutInputs = document.querySelectorAll('input[name="videoLayout"]');
const lyricStyleInputs = document.querySelectorAll('input[name="videoLyricStyle"]');
const videoThemeInputs = document.querySelectorAll('input[name="videoTheme"]');
const videoFontFamily = document.getElementById("videoFontFamily");
const videoFontSizeInputs = document.querySelectorAll('input[name="videoFontSize"]');
const videoPlayerVolume = document.getElementById("videoPlayerVolume");
const videoPlayerVolumeValue = document.getElementById("videoPlayerVolumeValue");
const studioTrackTitle = document.getElementById("studioTrackTitle");
const studioTrackArtist = document.getElementById("studioTrackArtist");
const studioArtworkImage = document.getElementById("studioArtworkImage");
const studioArtworkFallback = document.getElementById("studioArtworkFallback");
const studioPreviewEmpty = document.getElementById("studioPreviewEmpty");

const studioListenVocalsBtn = document.getElementById("studioListenVocalsBtn");
const studioVocalsAudio = document.getElementById("studioVocalsAudio");

let videoStanzas = null;
let fragPreviewRAF = null;

const LYRIC_STYLE_LABELS = {
  karaoke: "Karaoke terminal",
  typing: "Escritura progresiva",
};
const TERMINAL_TITLE = "NovaLyrics";

function selectedVideoLayout() {
  return document.querySelector('input[name="videoLayout"]:checked')?.value || "player";
}

function selectedLyricStyle() {
  return document.querySelector('input[name="videoLyricStyle"]:checked')?.value || "karaoke";
}

function selectedVideoTheme() {
  return document.querySelector('input[name="videoTheme"]:checked')?.value || "terminal";
}

function selectedFontSize() {
  return document.querySelector('input[name="videoFontSize"]:checked')?.value || "balanced";
}

function selectedPlayerVolume() {
  const percent = Number.parseFloat(videoPlayerVolume?.value ?? "50");
  return Math.max(0, Math.min(1, percent / 100));
}

function updatePlayerVolume() {
  const volume = selectedPlayerVolume();
  const percent = Math.round(volume * 100);
  if (videoPlayerVolume) {
    videoPlayerVolume.style.setProperty("--value", `${percent}%`);
  }
  if (videoPlayerVolumeValue) videoPlayerVolumeValue.textContent = `${percent}%`;
  fragPreviewAudio.volume = selectedVideoLayout() === "player" ? volume : 1;
  fragPreviewStage?.style.setProperty("--player-volume", `${percent}%`);
}

function updateLayoutVisibility() {
  const playerGroup = document.getElementById("playerOptionsGroup");
  const terminalGroup = document.getElementById("terminalOptionsGroup");
  if (playerGroup) {
    playerGroup.hidden = selectedVideoLayout() !== "player";
  }
  if (terminalGroup) {
    terminalGroup.hidden = selectedVideoLayout() !== "terminal";
  }
  updatePlayerVolume();
}

function applyPreviewLyricStyle() {
  updateLayoutVisibility();
  if (!fragPreviewStage) return;
  const style = selectedLyricStyle();
  const layout = selectedVideoLayout();
  fragPreviewStage.dataset.videoLayout = layout;
  fragPreviewStage.dataset.lyricStyle = style;
  fragPreviewStage.dataset.videoTheme = selectedVideoTheme();
  fragPreviewStage.dataset.videoFont = videoFontFamily?.value || "mono";
  fragPreviewStage.dataset.videoFontSize = selectedFontSize();
  return LYRIC_STYLE_LABELS[style];
}

function _studioInitials(song) {
  return (song?.title || song?.stem || "Music Lab")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function updateStudioTrackContext() {
  const song = canciones.find((item) => item.stem === studioSongSelect.value);
  if (!song) {
    studioTrackTitle.textContent = "Elige una canción";
    studioTrackArtist.textContent = "La previsualización aparecerá aquí";
    studioArtworkFallback.textContent = "ML";
    studioArtworkImage.hidden = true;
    return;
  }

  studioTrackTitle.textContent = song.title || song.stem;
  studioTrackArtist.textContent = song.artist || "";
  studioArtworkFallback.textContent = _studioInitials(song);
  studioArtworkImage.hidden = true;
  studioArtworkImage.alt = `Carátula de ${song.title || song.stem}`;
  studioArtworkImage.onload = () => { studioArtworkImage.hidden = false; };
  studioArtworkImage.onerror = () => { studioArtworkImage.hidden = true; };
  studioArtworkImage.src = `/api/canciones/${encodeURIComponent(song.stem)}/cover`;
}

// ---- Opciones compartidas de sincronización --------------------------------

export function studioSyncOptions() {
  return {
    language: document.getElementById("studioLanguage").value.trim() || "auto",
    model: document.getElementById("studioModel").value,
    force: document.getElementById("studioForce").checked,
    separate_vocals: document.getElementById("studioSeparate").checked,
    vad: document.getElementById("studioVad").checked ? "auditok" : "none",
  };
}

export function applyStudioSync(stem, data) {
  if (data?.quality?.playable) renderStanzaPicker(data.stanzas);
  else {
    videoStanzas = null;
    stanzaPicker.innerHTML = "";
  }
}

export async function onStudioSongChange() {
  setStatus(videoStatus, "");
  if (fragPreviewStage) fragPreviewStage.hidden = true;
  if (studioPreviewEmpty) studioPreviewEmpty.hidden = false;
  updateStudioTrackContext();

  // Detener la voz si estaba reproduciéndose
  if (studioVocalsAudio) {
    studioVocalsAudio.pause();
    studioVocalsAudio.currentTime = 0;
  }
  if (studioListenVocalsBtn) {
    studioListenVocalsBtn.textContent = "Escuchar voz";
    studioListenVocalsBtn.hidden = true;
  }

  const stem = studioSongSelect.value;
  if (!stem) return;
  stanzaPicker.innerHTML = "";
  if (fragStartInput) fragStartInput.value = "";
  if (fragEndInput) fragEndInput.value = "";
  videoStanzas = null;

  try {
    const data = await apiGet(`/api/karaoke/${encodeURIComponent(stem)}`);
    if (data.tiene_vocals && studioListenVocalsBtn) {
      studioListenVocalsBtn.hidden = false;
      studioVocalsAudio.src = `/vocals/${encodeURIComponent(stem)}.vocals.wav`;
    }
    if (data.actual) {
      applyStudioSync(stem, data.datos);
      setStatus(
        studioStatus,
        data.existe
          ? "Sincronización vigente. Puedes usarla o re-sincronizar."
          : "La sincronización vigente necesita revisión antes de usarse en karaoke o video.",
        data.existe ? "ok" : "error"
      );
    } else if (data.stale) {
      setStatus(studioStatus, "La letra o el audio cambiaron. Vuelve a sincronizar.");
    } else {
      setStatus(studioStatus, "Esta canción aún no está sincronizada. Pulsa 'Sincronizar'.");
    }
  } catch (e) {
    setStatus(studioStatus, `Error: ${e.message}`, "error");
  }
}

if (studioListenVocalsBtn && studioVocalsAudio) {
  studioListenVocalsBtn.addEventListener("click", () => {
    if (studioVocalsAudio.paused) {
      studioVocalsAudio.play();
      studioListenVocalsBtn.textContent = "Pausar voz";
    } else {
      studioVocalsAudio.pause();
      studioListenVocalsBtn.textContent = "Escuchar voz";
    }
  });

  studioVocalsAudio.addEventListener("ended", () => {
    studioListenVocalsBtn.textContent = "Escuchar voz";
  });
}

studioSongSelect.addEventListener("change", onStudioSongChange);

studioSyncBtn.addEventListener("click", async () => {
  const stem = studioSongSelect.value;
  if (!stem) return;
  studioSyncBtn.disabled = true;
  setStatus(studioStatus, "");

  try {
    const { job_id } = await apiPost(
      `/api/sincronizar/${encodeURIComponent(stem)}`,
      studioSyncOptions()
    );
    pollJob(job_id, {
      onTick: (job) => renderProgress("sync", job),
      onDone: (result) => {
        hideProgress("sync");
        const playable = result.quality?.playable;
        const qualityLabels = {
          alta: "Sincronía alta.",
          buena: "Sincronía buena.",
          revisar: "Sincronía a revisar.",
          baja: "Sincronía insuficiente.",
        };
        const qualityStatus = qualityLabels[result.quality?.label] || qualityLabels.baja;
        const unresolved = Number(result.quality?.unresolved_words || 0);
        const diagnostic = unresolved
          ? ` ${unresolved} palabras quedaron sin ancla directa.`
          : "";
        setStatus(
          studioStatus,
          playable
            ? `Sincronización automática lista. ${qualityStatus}`
            : `La sincronización automática terminó. ${qualityStatus}${diagnostic} Prueba modelo medium, idioma Automático y alterna VAD; la letra no necesariamente está mal.`,
          playable ? "ok" : "error"
        );
        applyStudioSync(stem, result);
        studioSyncBtn.disabled = false;
        refreshSongSelect(studioSongSelect);
        // Si el tema sincronizado es el que suena, refrescar su karaoke.
        const actual = canciones[indiceActual];
        if (actual && actual.stem === stem) {
          actual.tiene_sync = playable;
          if (playable) showKaraoke(stem, result);
        }
      },
      onError: (err) => {
        hideProgress("sync");
        setStatus(studioStatus, `Error: ${err}`, "error");
        studioSyncBtn.disabled = false;
      },
    });
  } catch (e) {
    setStatus(studioStatus, `Error: ${e.message}`, "error");
    studioSyncBtn.disabled = false;
  }
});

// ---- Selector de fragmento --------------------------------------------------

function renderStanzaPicker(stanzas) {
  videoStanzas = stanzas;
  stanzaPicker.innerHTML = "";

  stanzas.forEach((stanza) => {
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
      document
        .querySelectorAll(".stanza-option")
        .forEach((el) => el.classList.remove("selected"));
      option.classList.add("selected");
      fragStartInput.value = start.toFixed(1);
      fragEndInput.value = end.toFixed(1);
      fragPreviewAudio.hidden = true;
    });
    stanzaPicker.appendChild(option);
  });
}

// ---- Vista previa del fragmento: replica el look de terminal del video ----
// El botón "Previsualizar" reproduce el fragmento con la letra revelada
// palabra a palabra dentro de una "ventana de terminal" (misma estética
// que tiktok_generator.py). No hace falta un botón "Escuchar" aparte
// porque la vista previa ya trae audio.

let fragStopHandler = null;

fragPreviewBtn.addEventListener("click", async () => {
  const stem = studioSongSelect.value;
  if (!stem) return;
  const song = canciones.find((c) => c.stem === stem);
  if (!song) return;

  // Necesitamos la sincronización para saber cuándo revelar cada palabra.
  let stanzas = videoStanzas;
  if (!stanzas) {
    try {
      const cached = await apiGet(`/api/karaoke/${encodeURIComponent(stem)}`);
      if (cached.existe) {
        stanzas = cached.datos.stanzas;
        videoStanzas = stanzas;
      }
    } catch {}
  }
  if (!stanzas) {
    setStatus(
      videoStatus,
      "Necesitas sincronizar la canción antes de ver la vista previa.",
      "error"
    );
    fragPreviewStage.hidden = true;
    return;
  }

  setStatus(videoStatus, "");

  const start = parseFloat(fragStartInput.value) || 0;
  const end = fragEndInput.value ? parseFloat(fragEndInput.value) : null;

  // Rellenar metadatos en cabecera terminal y reproductor.
  const titulo = document.getElementById("videoTitulo").value.trim() || song.title || stem;
  const artista = document.getElementById("videoArtista").value.trim() || song.artist || "";
  fragPreviewTitle.textContent = titulo;
  fragPreviewArtist.textContent = artista;

  const playerPreviewTitle = document.getElementById("playerPreviewTitle");
  const playerPreviewArtist = document.getElementById("playerPreviewArtist");
  const playerPreviewArtworkImage = document.getElementById("playerPreviewArtworkImage");
  const playerPreviewArtworkFallback = document.getElementById("playerPreviewArtworkFallback");

  if (playerPreviewTitle) playerPreviewTitle.textContent = titulo;
  if (playerPreviewArtist) playerPreviewArtist.textContent = artista;
  if (playerPreviewArtworkFallback) playerPreviewArtworkFallback.textContent = _studioInitials(song);
  fragPreviewStage.style.setProperty(
    "--player-preview-cover",
    `url("/api/canciones/${encodeURIComponent(song.stem)}/cover")`
  );
  if (playerPreviewArtworkImage) {
    playerPreviewArtworkImage.hidden = true;
    playerPreviewArtworkImage.onload = () => { playerPreviewArtworkImage.hidden = false; };
    playerPreviewArtworkImage.onerror = () => { playerPreviewArtworkImage.hidden = true; };
    playerPreviewArtworkImage.src = `/api/canciones/${encodeURIComponent(song.stem)}/cover`;
  }

  applyPreviewLyricStyle();
  fragPreviewLabel.textContent = TERMINAL_TITLE;

  _renderTerminalLyrics(stanzas);
  fragPreviewStage.hidden = false;
  if (studioPreviewEmpty) studioPreviewEmpty.hidden = true;

  // Audio: recargamos, buscamos al start y reproducimos.
  fragPreviewAudio.src = `/canciones/${encodeURIComponent(song.nombre)}`;
  if (fragStopHandler)
    fragPreviewAudio.removeEventListener("timeupdate", fragStopHandler);
  fragStopHandler = () => {
    if (end !== null && fragPreviewAudio.currentTime >= end)
      fragPreviewAudio.pause();
  };
  fragPreviewAudio.addEventListener("timeupdate", fragStopHandler);

  fragPreviewAudio.addEventListener("play",  _startFragLoop);
  fragPreviewAudio.addEventListener("pause", _stopFragLoop);
  fragPreviewAudio.addEventListener("ended", _stopFragLoop);

  const seekAndPlay = () => {
    fragPreviewAudio.currentTime = start;
    fragPreviewAudio.play().catch(() => {});
  };
  if (fragPreviewAudio.readyState >= 1) seekAndPlay();
  else fragPreviewAudio.addEventListener("loadedmetadata", seekAndPlay, { once: true });
});

fragPreviewClose.addEventListener("click", () => {
  fragPreviewStage.hidden = true;
  if (studioPreviewEmpty) studioPreviewEmpty.hidden = false;
  fragPreviewAudio.pause();
  _stopFragLoop();
});

videoLayoutInputs.forEach((input) => {
  input.addEventListener("change", () => {
    updateLayoutVisibility();
    if (!fragPreviewStage.hidden) {
      applyPreviewLyricStyle();
      if (_fragState.stanzas) _renderTerminalLyrics(_fragState.stanzas);
      _updateFragTerminal();
    }
  });
});
updateLayoutVisibility();

lyricStyleInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (fragPreviewStage.hidden) return;
    applyPreviewLyricStyle();
    fragPreviewLabel.textContent = TERMINAL_TITLE;
  });
});

videoThemeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (fragPreviewStage.hidden) return;
    applyPreviewLyricStyle();
  });
});

videoFontFamily?.addEventListener("change", () => {
  if (!fragPreviewStage.hidden) applyPreviewLyricStyle();
});

videoFontSizeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (!fragPreviewStage.hidden) applyPreviewLyricStyle();
  });
});

videoPlayerVolume?.addEventListener("input", updatePlayerVolume);
updatePlayerVolume();

// ---- Renderizado de previsualización (Terminal / Reproductor 1:1) ------------

const _fragState = {
  stanzas: null,
  activeStanza: null,
  activePlayerLine: null,
};

function _renderTerminalLyrics(stanzas) {
  _fragState.stanzas = stanzas;
  _fragState.activeStanza = null;
  _fragState.activePlayerLine = null;
  const playerPreviewLyrics = document.getElementById("playerPreviewLyrics");
  if (playerPreviewLyrics) {
    playerPreviewLyrics.innerHTML = "";
    playerPreviewLyrics.style.transform = "translateY(0px)";
  }
  if (fragPreviewLyrics) fragPreviewLyrics.innerHTML = "";
  if (selectedVideoLayout() === "player") _buildStanzaDomPlayer(stanzas);
}

function _buildStanzaDomPlayer(stanzas) {
  const playerPreviewLyrics = document.getElementById("playerPreviewLyrics");
  if (!playerPreviewLyrics) return;
  playerPreviewLyrics.innerHTML = "";
  stanzas.flat().forEach((line) => {
    const l = document.createElement("div");
    l.className = "player-line";
    l.dataset.start = line.start;
    l.dataset.end = line.end;
    const words = line.words && line.words.length
      ? line.words
      : [{ text: line.text, start: line.start, end: line.end }];
    words.forEach((w, i) => {
      const sp = document.createElement("span");
      sp.className = "player-word";
      sp.textContent = w.text;
      sp.dataset.start = w.start;
      sp.dataset.end = w.end;
      sp.style.setProperty("--p", "0%");
      l.appendChild(sp);
      if (i < words.length - 1) l.appendChild(document.createTextNode(" "));
    });
    playerPreviewLyrics.appendChild(l);
  });
}

function _setPlayerLineFill(line, t, state) {
  line.querySelectorAll(".player-word").forEach((word) => {
    const start = Number.parseFloat(word.dataset.start);
    const end = Number.parseFloat(word.dataset.end);
    let progress = state === "past" ? 1 : 0;
    if (state === "active") {
      const duration = Math.max(0.001, end - start);
      progress = Math.max(0, Math.min(1, (t - start) / duration));
    }
    word.style.setProperty("--p", `${(progress * 100).toFixed(2)}%`);
  });
}

function _updatePlayerPreview(t, stanzas) {
  const playerPreviewLyrics = document.getElementById("playerPreviewLyrics");
  if (!playerPreviewLyrics) return;
  const lines = [...playerPreviewLyrics.querySelectorAll(".player-line")];
  if (!lines.length) return;

  let activeIndex = 0;
  lines.forEach((line, index) => {
    if (Number.parseFloat(line.dataset.start) <= t) activeIndex = index;
  });

  lines.forEach((line, index) => {
    const state = index < activeIndex ? "past" : index === activeIndex ? "active" : "future";
    line.classList.toggle("past", state === "past");
    line.classList.toggle("active", state === "active");
    line.classList.toggle("future", state === "future");
    _setPlayerLineFill(line, t, state);
  });

  const activeLine = lines[activeIndex];
  if (activeLine !== _fragState.activePlayerLine) {
    _fragState.activePlayerLine = activeLine;
    const viewport = playerPreviewLyrics.closest(".player-preview-lyrics-viewport");
    if (viewport) {
      const activeCenter = activeLine.offsetTop + activeLine.offsetHeight / 2;
      const scrollAnchor = viewport.clientHeight * 0.58;
      const targetCenter = Math.min(activeCenter, scrollAnchor);
      playerPreviewLyrics.style.transform = `translateY(${targetCenter - activeCenter}px)`;
    }
  }

  const lyricEnd = stanzas.flat().reduce(
    (maxEnd, line) => Math.max(maxEnd, Number.parseFloat(line.end) || 0),
    0
  );
  const duration = Number.isFinite(fragPreviewAudio.duration)
    ? fragPreviewAudio.duration
    : lyricEnd;
  const currentLabel = document.getElementById("playerPreviewCurrentTime");
  const durationLabel = document.getElementById("playerPreviewDuration");
  const progressFill = document.getElementById("playerPreviewFill");
  if (currentLabel) currentLabel.textContent = formatSeconds(Math.max(0, t));
  if (durationLabel) durationLabel.textContent = formatSeconds(Math.max(0, duration));
  if (progressFill) {
    const progress = duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0;
    progressFill.style.width = `${(progress * 100).toFixed(2)}%`;
  }
}

function _buildStanzaDom(stanza) {
  fragPreviewLyrics.innerHTML = "";
  const totalChars = stanza.reduce((sum, line) => sum + (line.text || "").length, 0);
  const estimatedWrappedLines = stanza.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil((line.text || "").length / 24)),
    0
  );
  fragPreviewLyrics.dataset.density =
    totalChars > 170 || estimatedWrappedLines > 8
      ? "very-dense"
      : totalChars > 105 || estimatedWrappedLines > 5
        ? "dense"
        : "normal";
  stanza.forEach((line) => {
    const l = document.createElement("div");
    l.className = "term-line";
    const words = line.words && line.words.length
      ? line.words
      : [{ text: line.text, start: line.start, end: line.end }];
    words.forEach((w, i) => {
      const sp = document.createElement("span");
      sp.className = "term-word";
      sp.textContent = w.text;
      sp.dataset.start = w.start;
      sp.dataset.end = w.end;
      l.appendChild(sp);
      if (i < words.length - 1) l.appendChild(document.createTextNode(" "));
    });
    fragPreviewLyrics.appendChild(l);
  });
  const cursor = document.createElement("span");
  cursor.className = "term-cursor";
  cursor.textContent = "█";
  fragPreviewLyrics.appendChild(cursor);
}

function _updateFragTerminal() {
  const stanzas = _fragState.stanzas;
  if (!stanzas) return;
  const t = fragPreviewAudio.currentTime;

  if (selectedVideoLayout() === "player") {
    _updatePlayerPreview(t, stanzas);
    return;
  }

  let active = null;
  for (const stanza of stanzas) {
    if (!stanza.length) continue;
    if (stanza[0].start <= t) active = stanza;
    else break;
  }
  if (!active) active = stanzas.find((s) => s.length) || null;
  if (!active) return;

  if (active !== _fragState.activeStanza) {
    _fragState.activeStanza = active;
    _buildStanzaDom(active);
  }

  // Marcar palabras reveladas y mover el cursor.
  const words = fragPreviewLyrics.querySelectorAll(".term-word");
  let lastRevealed = null;
  words.forEach((w) => {
    const start = parseFloat(w.dataset.start);
    const end = parseFloat(w.dataset.end);
    if (t >= start) {
      w.classList.add("revealed");
      w.classList.toggle("current", t < end);
      lastRevealed = w;
    } else {
      w.classList.remove("revealed");
      w.classList.remove("current");
    }
  });

  const cursor = fragPreviewLyrics.querySelector(".term-cursor");
  if (cursor) {
    if (lastRevealed) {
      lastRevealed.after(cursor);
    } else {
      // Ninguna palabra aún: cursor al inicio de la primera línea.
      const first = fragPreviewLyrics.querySelector(".term-line");
      if (first) first.insertBefore(cursor, first.firstChild);
    }
  }
}

function _startFragLoop() {
  if (fragPreviewRAF) return;
  const step = () => {
    _updateFragTerminal();
    fragPreviewRAF = requestAnimationFrame(step);
  };
  step();
}

function _stopFragLoop() {
  if (fragPreviewRAF) {
    cancelAnimationFrame(fragPreviewRAF);
    fragPreviewRAF = null;
  }
}

// ---- Generación de video ----------------------------------------------------

videoGenerateBtn.addEventListener("click", async () => {
  const stem = studioSongSelect.value;
  if (!stem) return;
  const opts = studioSyncOptions();
  const nombre_salida =
    document.getElementById("videoOutputName").value.trim() || null;
  const selectedSong = canciones.find((song) => song.stem === stem);
  const titulo = document.getElementById("videoTitulo").value.trim() || selectedSong?.title || stem;
  const artista = document.getElementById("videoArtista").value.trim() || selectedSong?.artist || null;
  const start_time =
    fragStartInput.value !== "" ? parseFloat(fragStartInput.value) : null;
  const end_time =
    fragEndInput.value !== "" ? parseFloat(fragEndInput.value) : null;
  const layout_style = selectedVideoLayout();
  const lyric_style = selectedLyricStyle();
  const theme = selectedVideoTheme();
  const font_family = videoFontFamily?.value || "mono";
  const font_size = selectedFontSize();
  const audio_volume = layout_style === "player" ? selectedPlayerVolume() : 1;

  videoGenerateBtn.disabled = true;
  setStatus(videoStatus, "");

  try {
    const { job_id } = await apiPost(
      `/api/video/${encodeURIComponent(stem)}`,
      {
        language: opts.language,
        model: opts.model,
        force_sync: opts.force,
        nombre_salida,
        titulo,
        artista,
        start_time,
        end_time,
        layout_style,
        audio_volume,
        lyric_style,
        theme,
        font_family,
        font_size,
        separate_vocals: opts.separate_vocals,
        vad: opts.vad,
      }
    );
    pollJob(job_id, {
      onTick: (job) => renderProgress("video", job),
      onDone: (result) => {
        hideProgress("video");
        setStatus(videoStatus, `Video generado: ${result.video}`, "ok");
        videoGenerateBtn.disabled = false;
        loadVideoGallery();
      },
      onError: (err) => {
        hideProgress("video");
        setStatus(videoStatus, `Error: ${err}`, "error");
        videoGenerateBtn.disabled = false;
      },
    });
  } catch (e) {
    setStatus(videoStatus, `Error: ${e.message}`, "error");
    videoGenerateBtn.disabled = false;
  }
});

export async function loadVideoGallery() {
  try {
    const data = await apiGet("/api/videos");
    videoGallery.innerHTML = "";
    videoGallery.classList.toggle("has-overflow", data.videos.length > 4);
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
