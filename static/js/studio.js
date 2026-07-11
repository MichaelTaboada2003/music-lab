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

const studioListenVocalsBtn = document.getElementById("studioListenVocalsBtn");
const studioVocalsAudio = document.getElementById("studioVocalsAudio");
const syncQuality = document.getElementById("syncQuality");
const syncQualityLabel = document.getElementById("syncQualityLabel");
const syncQualityDetail = document.getElementById("syncQualityDetail");
const syncReview = document.getElementById("syncReview");
const syncReviewSummary = document.getElementById("syncReviewSummary");
const syncReviewList = document.getElementById("syncReviewList");
const syncReviewAudio = document.getElementById("syncReviewAudio");
const syncReviewSaveBtn = document.getElementById("syncReviewSaveBtn");

let videoStanzas = null;
let fragPreviewRAF = null;
let syncReviewData = null;

// ---- Opciones compartidas de sincronización --------------------------------

export function studioSyncOptions() {
  return {
    language: document.getElementById("studioLanguage").value.trim() || "es",
    model: document.getElementById("studioModel").value,
    force: document.getElementById("studioForce").checked,
    separate_vocals: document.getElementById("studioSeparate").checked,
    vad: document.getElementById("studioVad").checked ? "auditok" : "none",
  };
}

export function applyStudioSync(stem, data) {
  renderSyncQuality(data?.quality);
  renderSyncReview(stem, data);
  if (data?.quality?.playable) renderStanzaPicker(data.stanzas);
  else {
    videoStanzas = null;
    stanzaPicker.innerHTML = "";
  }
}

function renderSyncQuality(quality) {
  if (!syncQuality || !syncQualityLabel || !syncQualityDetail) return;
  if (!quality) {
    syncQuality.hidden = true;
    return;
  }

  const labels = {
    alta: "Sincronía alta",
    buena: "Sincronía buena",
    revisar: "Sincronía a revisar",
    baja: "Sincronía insuficiente",
  };
  const coverage = Math.round((quality.coverage || 0) * 100);
  const repairs = quality.timing_repairs || 0;
  const unresolved = quality.unresolved_words || 0;
  const manual = quality.manual_words || 0;
  syncQuality.hidden = false;
  syncQuality.className = `sync-quality ${quality.label || "baja"}`;
  syncQualityLabel.textContent = labels[quality.label] || labels.baja;
  syncQualityDetail.textContent =
    `${coverage}% de palabras ancladas al audio` +
    (unresolved
      ? ` · ${unresolved} por ajustar`
      : repairs
        ? ` · ${repairs} tiempos normalizados`
        : " · tiempos consistentes") +
    (manual ? ` · ${manual} ajustes manuales` : "");
}

function renderSyncReview(stem, data) {
  syncReviewData = null;
  syncReview.hidden = true;
  syncReviewList.innerHTML = "";
  if (!data?.stanzas) return;

  const pending = [];
  data.stanzas.forEach((stanza, stanzaIndex) => {
    stanza.forEach((line, lineIndex) => {
      (line.words || []).forEach((word, wordIndex) => {
        if (!word.synced) pending.push({ stanzaIndex, lineIndex, wordIndex, word });
      });
    });
  });
  if (!pending.length) return;

  syncReviewData = data;
  syncReview.hidden = false;
  syncReviewSummary.textContent = `Ajustar ${pending.length} palabra${pending.length === 1 ? "" : "s"} aproximada${pending.length === 1 ? "" : "s"}`;
  const song = canciones.find((item) => item.stem === stem);
  if (song) syncReviewAudio.src = `/canciones/${encodeURIComponent(song.nombre)}`;

  pending.forEach(({ stanzaIndex, lineIndex, wordIndex, word }) => {
    const row = document.createElement("div");
    row.className = "sync-review-row";
    row.dataset.stanza = stanzaIndex;
    row.dataset.line = lineIndex;
    row.dataset.word = wordIndex;
    row.innerHTML = `
      <strong>${word.text}</strong>
      <label>Inicio <input class="sync-time-start" type="number" min="0" step="0.1" value="${Number(word.start).toFixed(1)}"></label>
      <label>Fin <input class="sync-time-end" type="number" min="0" step="0.1" value="${Number(word.end).toFixed(1)}"></label>
      <button type="button" class="sync-locate">Escuchar</button>
    `;
    const locate = row.querySelector(".sync-locate");
    locate.addEventListener("click", () => {
      syncReviewAudio.currentTime = Number(row.querySelector(".sync-time-start").value) || 0;
      syncReviewAudio.play();
    });
    syncReviewList.appendChild(row);
  });
}

export async function onStudioSongChange() {
  setStatus(videoStatus, "");
  if (fragPreviewStage) fragPreviewStage.hidden = true;
  
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
  renderSyncQuality(null);
  renderSyncReview(null, null);

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
        setStatus(
          studioStatus,
          playable
            ? "Sincronización lista. Revisa el indicador de calidad antes de exportar."
            : "La sincronización se guardó, pero necesita revisión antes de karaoke o video.",
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

syncReviewSaveBtn.addEventListener("click", async () => {
  const stem = studioSongSelect.value;
  if (!stem || !syncReviewData) return;
  const adjustments = [...syncReviewList.querySelectorAll(".sync-review-row")].map((row) => ({
    stanza: Number(row.dataset.stanza),
    line: Number(row.dataset.line),
    word: Number(row.dataset.word),
    start: Number(row.querySelector(".sync-time-start").value),
    end: Number(row.querySelector(".sync-time-end").value),
  }));
  syncReviewSaveBtn.disabled = true;
  try {
    const result = await apiPost(`/api/karaoke/${encodeURIComponent(stem)}/ajustes`, { adjustments });
    applyStudioSync(stem, result.datos);
    refreshSongSelect(studioSongSelect);
    const actual = canciones[indiceActual];
    if (actual?.stem === stem) {
      actual.tiene_sync = Boolean(result.calidad?.playable);
      if (actual.tiene_sync) showKaraoke(stem, result.datos);
    }
    setStatus(studioStatus, "Ajustes guardados. La calidad se recalculó con tus tiempos.", "ok");
  } catch (error) {
    setStatus(studioStatus, `No se pudieron guardar los ajustes: ${error.message}`, "error");
  } finally {
    syncReviewSaveBtn.disabled = false;
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

  // Rellenar cabecera de la terminal con título/artista del formulario.
  const titulo = document.getElementById("videoTitulo").value.trim() || song.title || stem;
  const artista = document.getElementById("videoArtista").value.trim() || song.artist || "";
  fragPreviewTitle.textContent = titulo;
  fragPreviewArtist.textContent = artista ? `por ${artista}` : "";
  fragPreviewLabel.textContent =
    `music-lab — vista previa (${formatSeconds(start)} — ${end !== null ? formatSeconds(end) : "fin"})`;

  _renderTerminalLyrics(stanzas);
  fragPreviewStage.hidden = false;

  // Audio: recargamos, buscamos al start y reproducimos. Sin controles
  // visibles porque el foco está en la terminal.
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
    fragPreviewAudio.play();
  };
  if (fragPreviewAudio.readyState >= 1) seekAndPlay();
  else fragPreviewAudio.addEventListener("loadedmetadata", seekAndPlay, { once: true });
});

fragPreviewClose.addEventListener("click", () => {
  fragPreviewStage.hidden = true;
  fragPreviewAudio.pause();
  _stopFragLoop();
});

// ---- Renderizado tipo terminal ----------------------------------------------
// Cada palabra empieza como .term-word (invisible). En cada frame marcamos
// como .revealed las que ya empezaron, y movemos el cursor tras la última.
// Solo mostramos la estrofa activa en cada momento — igual que el generador
// de video, que solo dibuja la estrofa cuya primera palabra ya sonó.

const _fragState = { stanzas: null, activeStanza: null };

function _renderTerminalLyrics(stanzas) {
  _fragState.stanzas = stanzas;
  _fragState.activeStanza = null;
  fragPreviewLyrics.innerHTML = "";
}

function _buildStanzaDom(stanza) {
  fragPreviewLyrics.innerHTML = "";
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
      l.appendChild(sp);
      if (i < words.length - 1) l.appendChild(document.createTextNode(" "));
    });
    fragPreviewLyrics.appendChild(l);
  });
  // Cursor único (se mueve tras la última palabra revelada en cada tick).
  const cursor = document.createElement("span");
  cursor.className = "term-cursor";
  cursor.textContent = "█";
  fragPreviewLyrics.appendChild(cursor);
}

function _updateFragTerminal() {
  const stanzas = _fragState.stanzas;
  if (!stanzas) return;
  const t = fragPreviewAudio.currentTime;

  // Encontrar la estrofa activa: la última cuya primera palabra ya empezó.
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
