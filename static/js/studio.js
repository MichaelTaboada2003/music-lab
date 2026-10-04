// ============================================================
// studio.js — vista Video: sincronización + generación de video
// ============================================================

import {
  apiGet, apiPost, setStatus, pollJob,
  renderProgress, hideProgress, formatSeconds, refreshSongSelect,
} from "./api.js";
import { showKaraoke } from "./karaoke.js";
import { loadVideoGallery } from "./videos.js";
import { canciones, indiceActual } from "./player.js";

// ---- DOM refs ---------------------------------------------------------------
export const studioSongSelect = document.getElementById("studioSongSelect");
const studioSyncBtn = document.getElementById("studioSyncBtn");
const studioStatus = document.getElementById("studioStatus");
const videoGenerateBtn = document.getElementById("videoGenerateBtn");
const videoStatus = document.getElementById("videoStatus");
const stanzaPicker = document.getElementById("stanzaPicker");
const fragStartInput = document.getElementById("fragStart");
const fragEndInput = document.getElementById("fragEnd");
const fragPreviewBtn = document.getElementById("fragPreviewBtn");
const fragPreviewAudio = document.getElementById("fragPreviewAudio");
const fragPreviewStage = document.getElementById("fragPreviewStage");
const fragPreviewClose = document.getElementById("fragPreviewClose");
const videoLayoutInputs = document.querySelectorAll('input[name="videoLayout"]');
const lyricStyleInputs = document.querySelectorAll('input[name="videoLyricStyle"]');
const lyricFlowInputs = document.querySelectorAll('input[name="videoLyricFlow"]');
const videoThemeInputs = document.querySelectorAll('input[name="videoTheme"]');
const videoFontFamily = document.getElementById("videoFontFamily");
const videoFontSizeInputs = document.querySelectorAll('input[name="videoFontSize"]');
const fragPreviewFrame = document.getElementById("fragPreviewFrame");
const videoBgColor = document.getElementById("videoBgColor");
const videoTextColor = document.getElementById("videoTextColor");
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

function selectedVideoLayout() {
  return document.querySelector('input[name="videoLayout"]:checked')?.value || "player";
}

function selectedLyricStyle() {
  return document.querySelector('input[name="videoLyricStyle"]:checked')?.value || "karaoke";
}

function selectedLyricFlow() {
  return document.querySelector('input[name="videoLyricFlow"]:checked')?.value || "block";
}

function selectedVideoTheme() {
  return document.querySelector('input[name="videoTheme"]:checked')?.value || "terminal";
}

function selectedFontSize() {
  return document.querySelector('input[name="videoFontSize"]:checked')?.value || "balanced";
}

// Paletas curadas del formato Color: cada par se eligió por contraste y carácter.
const COLOR_PRESETS = [
  { name: "Violeta eléctrico", bg: "#5B21F5", text: "#FFE14D" },
  { name: "Negro puro", bg: "#000000", text: "#FFFFFF" },
  { name: "Crema editorial", bg: "#F4EDE1", text: "#1B1B1B" },
  { name: "Rojo pasión", bg: "#C8102E", text: "#FFF1E6" },
  { name: "Verde Music Lab", bg: "#0A1F14", text: "#1ED760" },
  { name: "Azul noche", bg: "#0E1B4D", text: "#9FD3FF" },
  { name: "Rosa chicle", bg: "#FF5FA2", text: "#2A0A1E" },
  { name: "Durazno", bg: "#FFB38A", text: "#3B1D14" },
];

function _luminance(hex) {
  const channels = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function _contrastRatio(a, b) {
  const [hi, lo] = [_luminance(a), _luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function renderColorPresets() {
  const host = document.getElementById("videoColorPresets");
  if (!host) return;
  host.innerHTML = "";
  COLOR_PRESETS.forEach((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-preset";
    button.dataset.bg = preset.bg;
    button.dataset.text = preset.text;
    button.innerHTML =
      `<span class="color-preset-swatch" style="--bg:${preset.bg};--fg:${preset.text}" aria-hidden="true">Aa</span>` +
      `<span class="color-preset-name">${preset.name}</span>`;
    button.addEventListener("click", () => setVideoColors(preset.bg, preset.text));
    host.appendChild(button);
  });
}

function setVideoColors(bg, text) {
  videoBgColor.value = bg.toLowerCase();
  videoTextColor.value = text.toLowerCase();
  updateColorControls();
}

function updateColorControls() {
  const bg = selectedBgColor();
  const text = selectedTextColor();
  document.getElementById("videoBgColorValue").textContent = bg;
  document.getElementById("videoTextColorValue").textContent = text;
  document.querySelectorAll(".color-preset").forEach((button) => {
    const active = button.dataset.bg === bg && button.dataset.text === text;
    button.setAttribute("aria-pressed", String(active));
  });
  const hint = document.getElementById("videoColorContrast");
  if (hint) {
    const ratio = _contrastRatio(bg, text);
    hint.dataset.level = ratio >= 3 ? "ok" : "warn";
    hint.textContent = ratio >= 4.5
      ? `Contraste excelente (${ratio.toFixed(1)}:1): la letra se lee sin esfuerzo.`
      : ratio >= 3
        ? `Contraste suficiente (${ratio.toFixed(1)}:1): se lee bien en letra grande.`
        : `Contraste bajo (${ratio.toFixed(1)}:1): la letra costará leerse. Prueba una paleta más marcada.`;
  }
  requestPreviewFrame(true);
}

function selectedBgColor() {
  return (videoBgColor?.value || COLOR_PRESETS[0].bg).toUpperCase();
}

function selectedTextColor() {
  return (videoTextColor?.value || COLOR_PRESETS[0].text).toUpperCase();
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
  const colorGroup = document.getElementById("colorOptionsGroup");
  const layout = selectedVideoLayout();
  if (terminalGroup) {
    // Color reutiliza tipografía y formato de letra de Terminal, pero no su tema.
    terminalGroup.hidden = layout === "player";
  }
  const themePicker = terminalGroup?.querySelector(".video-theme-picker");
  if (themePicker) themePicker.hidden = layout === "color";
  if (colorGroup) colorGroup.hidden = layout !== "color";
  updatePlayerVolume();
}

function applyPreviewLyricStyle() {
  updateLayoutVisibility();
  if (!fragPreviewStage) return;
  const style = selectedLyricStyle();
  const lyricFlow = selectedLyricFlow();
  const layout = selectedVideoLayout();
  fragPreviewStage.dataset.videoLayout = layout;
  fragPreviewStage.dataset.lyricStyle = style;
  fragPreviewStage.dataset.lyricFlow = lyricFlow;
  fragPreviewStage.dataset.videoTheme = selectedVideoTheme();
  fragPreviewStage.dataset.videoFont = videoFontFamily?.value || "mono";
  fragPreviewStage.dataset.videoFontSize = selectedFontSize();
  requestPreviewFrame(true);
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
      studioVocalsAudio.src = data.vocals_url || `/vocals/${encodeURIComponent(stem)}.vocals.flac`;
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
  const availableStanzas = stanzas.filter((stanza) => stanza.length);

  availableStanzas.forEach((stanza, stanzaIndex) => {
    const start = stanza[0].start;
    const end = stanza[stanza.length - 1].end;

    const option = document.createElement("div");
    option.className = "stanza-option";
    option.dataset.stanzaIndex = stanzaIndex;
    option.innerHTML = `
      <span class="stanza-time">${formatSeconds(start)} — ${formatSeconds(end)}</span>
      <span class="stanza-lines">${stanza.map((l) => l.text).join("\n")}</span>
    `;
    option.addEventListener("click", () => {
      option.classList.toggle("selected");
      const options = [...stanzaPicker.querySelectorAll(".stanza-option")];
      let selected = options.filter((item) => item.classList.contains("selected"));

      // La exportación es continua: al escoger dos extremos también se
      // seleccionan las estrofas que están entre ellos.
      if (selected.length > 1) {
        const indexes = selected.map((item) => Number(item.dataset.stanzaIndex));
        const first = Math.min(...indexes);
        const last = Math.max(...indexes);
        options.forEach((item) => {
          const index = Number(item.dataset.stanzaIndex);
          item.classList.toggle("selected", index >= first && index <= last);
        });
        selected = options.filter((item) => item.classList.contains("selected"));
      }

      if (!selected.length) {
        fragStartInput.value = "";
        fragEndInput.value = "";
      } else {
        const indexes = selected.map((item) => Number(item.dataset.stanzaIndex));
        const first = Math.min(...indexes);
        const last = Math.max(...indexes);
        const firstStanza = availableStanzas[first];
        const lastStanza = availableStanzas[last];
        fragStartInput.value = Number(firstStanza[0].start).toFixed(1);
        fragEndInput.value = Number(lastStanza[lastStanza.length - 1].end).toFixed(1);
      }
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
  _fragState.fragmentStart = start;
  _fragState.fragmentEnd = end;

  // Rellenar metadatos en cabecera terminal y reproductor.
  const titulo = document.getElementById("videoTitulo").value.trim() || song.title || stem;
  const artista = document.getElementById("videoArtista").value.trim() || song.artist || "";

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

  _renderTerminalLyrics(stanzas);
  fragPreviewStage.hidden = false;
  if (studioPreviewEmpty) studioPreviewEmpty.hidden = true;
  _frameLastT = -1;
  requestPreviewFrame(true);

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

// Cada formato recuerda su tipografía: Color nace con una moderna y Terminal con mono.
const _fontByLayout = { player: "modern", terminal: "mono", color: "modern" };
let _fontLayout = selectedVideoLayout();

videoLayoutInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (videoFontFamily) {
      _fontByLayout[_fontLayout] = videoFontFamily.value;
      _fontLayout = selectedVideoLayout();
      videoFontFamily.value = _fontByLayout[_fontLayout];
    }
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
  });
});

lyricFlowInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (fragPreviewStage.hidden) return;
    applyPreviewLyricStyle();
    if (_fragState.stanzas) _renderTerminalLyrics(_fragState.stanzas);
    _updateFragTerminal();
  });
});

videoThemeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (fragPreviewStage.hidden) return;
    applyPreviewLyricStyle();
  });
});

videoFontFamily?.addEventListener("change", () => {
  _fontByLayout[_fontLayout] = videoFontFamily.value;
  if (!fragPreviewStage.hidden) applyPreviewLyricStyle();
});

videoFontSizeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (!fragPreviewStage.hidden) applyPreviewLyricStyle();
  });
});

videoBgColor?.addEventListener("input", updateColorControls);
videoTextColor?.addEventListener("input", updateColorControls);
document.getElementById("videoColorSwap")?.addEventListener("click", () => {
  setVideoColors(selectedTextColor(), selectedBgColor());
});
renderColorPresets();
updateColorControls();

videoPlayerVolume?.addEventListener("input", updatePlayerVolume);
updatePlayerVolume();

// ---- Renderizado de previsualización (Terminal / Reproductor 1:1) ------------

const _fragState = {
  stanzas: null,
  activePlayerPage: null,
  activePlayerLine: null,
  fragmentStart: 0,
  fragmentEnd: null,
};

const PLAYER_PAGE_LINE_CAPACITY = 8;

function _selectedPlayerLines(stanzas) {
  const start = Number.isFinite(_fragState.fragmentStart) ? _fragState.fragmentStart : null;
  const end = Number.isFinite(_fragState.fragmentEnd) ? _fragState.fragmentEnd : null;
  return stanzas.flat().filter((line) => {
    const lineStart = Number.parseFloat(line.start);
    const lineEnd = Number.parseFloat(line.end);
    if (start !== null && lineEnd <= start) return false;
    if (end !== null && lineStart >= end) return false;
    return true;
  });
}

function _renderTerminalLyrics(stanzas) {
  _fragState.stanzas = stanzas;
  _fragState.activePlayerPage = null;
  _fragState.activePlayerLine = null;
  const playerPreviewLyrics = document.getElementById("playerPreviewLyrics");
  if (playerPreviewLyrics) {
    playerPreviewLyrics.innerHTML = "";
    playerPreviewLyrics.style.transform = "translateY(0px)";
  }
  if (selectedVideoLayout() === "player") {
    const selectedLines = _selectedPlayerLines(stanzas);
    const isLineFlow = selectedLyricFlow() === "line";
    const firstPage = isLineFlow
      ? selectedLines.slice(0, 1)
      : selectedLines.slice(0, PLAYER_PAGE_LINE_CAPACITY);
    _fragState.activePlayerPage = isLineFlow ? "line:0" : 0;
    _buildStanzaDomPlayer(firstPage);
  }
}

function _buildStanzaDomPlayer(lines) {
  const playerPreviewLyrics = document.getElementById("playerPreviewLyrics");
  if (!playerPreviewLyrics) return;
  playerPreviewLyrics.innerHTML = "";
  playerPreviewLyrics.style.transform = "translateY(0px)";
  lines.forEach((line) => {
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

  const selectedLines = _selectedPlayerLines(stanzas);
  if (!selectedLines.length) return;
  let selectedActiveIndex = 0;
  selectedLines.forEach((line, index) => {
    if (Number.parseFloat(line.start) <= t) selectedActiveIndex = index;
  });
  const isLineFlow = selectedLyricFlow() === "line";
  const activePage = isLineFlow
    ? `line:${selectedActiveIndex}`
    : Math.floor(selectedActiveIndex / PLAYER_PAGE_LINE_CAPACITY);

  if (activePage !== _fragState.activePlayerPage) {
    _fragState.activePlayerPage = activePage;
    _fragState.activePlayerLine = null;
    if (isLineFlow) {
      _buildStanzaDomPlayer([selectedLines[selectedActiveIndex]]);
    } else {
      const pageStart = activePage * PLAYER_PAGE_LINE_CAPACITY;
      _buildStanzaDomPlayer(
        selectedLines.slice(pageStart, pageStart + PLAYER_PAGE_LINE_CAPACITY)
      );
    }
  }

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
    // La página permanece fija mientras se rellena hacia abajo. Al llegar a
    // la novena línea se reconstruye desde arriba con la página siguiente.
    playerPreviewLyrics.style.transform = "translateY(0px)";
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

// ---- Previsualización de Color y Terminal: frames reales del renderizador ----
// El servidor usa el mismo código que la exportación, así que la vista previa
// es idéntica al video. Se pide un frame a la vez para no saturar el render.
let _frameInFlight = false;
let _framePending = null;
let _frameLastT = -1;
let _frameUrl = null;
const FRAME_MIN_STEP = 1 / 30;

function _previewMeta() {
  const song = canciones.find((c) => c.stem === studioSongSelect.value);
  return {
    titulo: document.getElementById("videoTitulo").value.trim() || song?.title || studioSongSelect.value,
    artista: document.getElementById("videoArtista").value.trim() || song?.artist || "",
  };
}

async function requestPreviewFrame(force = false) {
  const layout = selectedVideoLayout();
  if (layout === "player" || fragPreviewStage.hidden || !fragPreviewFrame || !studioSongSelect.value) return;
  const t = fragPreviewAudio.currentTime || 0;
  if (!force && Math.abs(t - _frameLastT) < FRAME_MIN_STEP) return;
  if (_frameInFlight) {
    _framePending = { force: force || Boolean(_framePending?.force) };
    return;
  }
  _frameInFlight = true;
  _frameLastT = t;
  const { titulo, artista } = _previewMeta();
  const params = new URLSearchParams({
    t: t.toFixed(3),
    layout_style: layout,
    theme: selectedVideoTheme(),
    font_family: videoFontFamily?.value || "mono",
    font_size: selectedFontSize(),
    lyric_style: selectedLyricStyle(),
    lyric_flow: selectedLyricFlow(),
    bg_color: selectedBgColor(),
    text_color: selectedTextColor(),
    titulo,
    artista,
  });
  if (Number.isFinite(_fragState.fragmentStart)) params.set("start", _fragState.fragmentStart);
  if (Number.isFinite(_fragState.fragmentEnd)) params.set("end", _fragState.fragmentEnd);
  try {
    const res = await fetch(`/api/video/${encodeURIComponent(studioSongSelect.value)}/frame?${params}`);
    if (res.ok) {
      const url = URL.createObjectURL(await res.blob());
      const previous = _frameUrl;
      _frameUrl = url;
      fragPreviewFrame.src = url;
      if (previous) URL.revokeObjectURL(previous);
    }
  } catch {
    // Un frame perdido no debe romper la reproducción de la vista previa.
  } finally {
    _frameInFlight = false;
    if (_framePending) {
      const { force: pendingForce } = _framePending;
      _framePending = null;
      requestPreviewFrame(pendingForce);
    }
  }
}

function _updateFragTerminal() {
  const stanzas = _fragState.stanzas;
  if (!stanzas) return;
  const t = fragPreviewAudio.currentTime;

  if (selectedVideoLayout() === "player") {
    _updatePlayerPreview(t, stanzas);
    return;
  }
  requestPreviewFrame(false);
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
  const lyric_flow = selectedLyricFlow();
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
        lyric_flow,
        theme,
        font_family,
        font_size,
        bg_color: selectedBgColor(),
        text_color: selectedTextColor(),
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
        loadVideoGallery({ highlight: result.video });
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
