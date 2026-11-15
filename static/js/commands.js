// ============================================================
// commands.js — paleta de comandos (⌘K / Ctrl+K) y atajos de teclado.
//
// La paleta busca en la biblioteca (sin distinguir tildes), salta entre
// secciones y ejecuta acciones del reproductor sin tocar el ratón.
// ============================================================

import {
  audioPlayer, canciones, coverUrl, cycleRepeat, playNext, playPrevious,
  playStem, seekBy, setVolume, toggleMute, togglePlay, toggleShuffle,
} from "./player.js";
import { activateView } from "./nav.js";
import { normalizeText } from "./format.js";

const dialog = document.getElementById("commandPalette");
const input = document.getElementById("commandInput");
const list = document.getElementById("commandList");
const toast = document.getElementById("appToast");

const ICONS = {
  view: '<path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path>',
  action: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"></path>',
};

let results = [];
let selected = 0;
let toastTimer = null;

/** Aviso breve y no bloqueante (confirma atajos que no tienen otro reflejo visible). */
export function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1600);
}

function _actions() {
  const views = [...document.querySelectorAll(".nav-item[data-view]")].map((btn) => ({
    kind: "view",
    title: `Ir a ${btn.textContent.trim()}`,
    keywords: btn.textContent,
    run: () => activateView(btn.dataset.view),
  }));
  return [
    { kind: "action", title: audioPlayer.paused ? "Reproducir" : "Pausar", hint: "Espacio", keywords: "play pause reproducir pausar", run: togglePlay },
    { kind: "action", title: "Siguiente canción", hint: "⇧ →", keywords: "next siguiente", run: playNext },
    { kind: "action", title: "Canción anterior", hint: "⇧ ←", keywords: "previous anterior", run: playPrevious },
    { kind: "action", title: "Alternar aleatorio", hint: "S", keywords: "shuffle aleatorio mezclar", run: () => showToast(toggleShuffle() ? "Aleatorio activado" : "Aleatorio desactivado") },
    { kind: "action", title: "Cambiar modo de repetición", hint: "R", keywords: "repeat repetir bucle", run: () => showToast(cycleRepeat()) },
    { kind: "action", title: "Silenciar o restaurar volumen", hint: "M", keywords: "mute silencio volumen", run: toggleMute },
    { kind: "action", title: "Modo karaoke (instrumental sin voz)", keywords: "karaoke instrumental voz", run: () => { activateView("player"); document.getElementById("karaokeModeBtn")?.click(); } },
    {
      kind: "action", title: "Añadir canción por URL", keywords: "descargar download youtube añadir agregar",
      run: () => {
        activateView("studio");
        const details = document.querySelector("details.add-song");
        if (details) details.open = true;
        document.getElementById("downloadUrl")?.focus();
      },
    },
    ...views,
  ];
}

function _score(haystack, title, tokens) {
  let score = 0;
  for (const token of tokens) {
    const at = haystack.indexOf(token);
    if (at < 0) return -1;
    if (title.startsWith(token)) score += 6;
    else if (title.includes(` ${token}`)) score += 4;
    else if (title.includes(token)) score += 3;
    else score += 1;
  }
  return score;
}

function _search(query) {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  const songs = canciones.map((song) => ({
    kind: "song",
    song,
    title: song.title || song.stem,
    subtitle: song.artist || "",
    hint: song.duracion && song.duracion !== "Desconocida" ? song.duracion : "",
    keywords: `${song.artist || ""} ${song.stem}`,
    run: () => playStem(song.stem),
  }));
  const actions = _actions();
  if (!tokens.length) {
    // Sin texto: lo más útil primero (acciones) y luego la biblioteca entera.
    return [...actions.slice(0, 6), ...songs.slice(0, 40), ...actions.slice(6)];
  }
  return [...songs, ...actions]
    .map((item, order) => {
      const title = normalizeText(item.title);
      const score = _score(`${title} ${normalizeText(item.keywords)}`, title, tokens);
      return { item, score, order };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 50)
    .map((entry) => entry.item);
}

function _render() {
  results = _search(input.value);
  selected = Math.min(selected, Math.max(0, results.length - 1));
  const fragment = document.createDocumentFragment();

  results.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "cmd-item" + (index === selected ? " is-selected" : "");
    row.dataset.index = index;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selected));

    const icon = document.createElement("span");
    icon.className = "cmd-icon";
    if (item.kind === "song") {
      icon.classList.add("is-cover");
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.onerror = () => img.remove();
      img.src = coverUrl(item.song);
      icon.appendChild(img);
    } else {
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[item.kind]}</svg>`;
    }

    const copy = document.createElement("span");
    copy.className = "cmd-copy";
    const title = document.createElement("span");
    title.className = "cmd-title";
    title.textContent = item.title;
    copy.appendChild(title);
    if (item.subtitle) {
      const subtitle = document.createElement("span");
      subtitle.className = "cmd-subtitle";
      subtitle.textContent = item.subtitle;
      copy.appendChild(subtitle);
    }

    row.append(icon, copy);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "cmd-hint";
      hint.textContent = item.hint;
      row.appendChild(hint);
    }
    fragment.appendChild(row);
  });

  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "cmd-empty";
    empty.textContent = `Nada coincide con «${input.value.trim()}».`;
    fragment.appendChild(empty);
  }
  list.replaceChildren(fragment);
}

function _select(index) {
  if (!results.length) return;
  selected = (index + results.length) % results.length;
  list.querySelectorAll(".cmd-item").forEach((row, i) => {
    row.classList.toggle("is-selected", i === selected);
    row.setAttribute("aria-selected", String(i === selected));
    if (i === selected) row.scrollIntoView({ block: "nearest" });
  });
}

function _run(index) {
  const item = results[index];
  if (!item) return;
  dialog.close();
  item.run();
}

export function openPalette() {
  if (!dialog || dialog.open) return;
  input.value = "";
  selected = 0;
  _render();
  dialog.showModal();
  list.scrollTop = 0;
  input.focus();
}

if (dialog) {
  input.addEventListener("input", () => {
    selected = 0;
    _render();
    list.scrollTop = 0;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); _select(selected + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); _select(selected - 1); }
    else if (event.key === "Enter") { event.preventDefault(); _run(selected); }
  });
  list.addEventListener("click", (event) => {
    const row = event.target.closest(".cmd-item");
    if (row) _run(Number(row.dataset.index));
  });
  list.addEventListener("pointermove", (event) => {
    const row = event.target.closest(".cmd-item");
    if (row && Number(row.dataset.index) !== selected) _select(Number(row.dataset.index));
  });
  // Clic en el fondo (fuera de la tarjeta) cierra.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.getElementById("commandOpenBtn")?.addEventListener("click", openPalette);
}

// ---- Atajos globales ---------------------------------------------------------

function _isTyping(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return true;
  return false;
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (dialog?.open) dialog.close();
    else openPalette();
    return;
  }
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  // Con un diálogo abierto o escribiendo, las teclas pertenecen a ese control.
  if (document.querySelector("dialog[open]") || _isTyping(event.target)) return;
  // Los botones y controles propios ya responden a Espacio/flechas.
  const onControl = event.target instanceof Element
    && event.target.closest("button, a, summary, [role='button'], [role='slider'], .select-custom.open");

  switch (event.key) {
    case " ":
      if (onControl) return;
      event.preventDefault();
      togglePlay();
      break;
    case "ArrowRight":
      if (onControl && !event.shiftKey) return;
      event.preventDefault();
      if (event.shiftKey) playNext(); else seekBy(5);
      break;
    case "ArrowLeft":
      if (onControl && !event.shiftKey) return;
      event.preventDefault();
      if (event.shiftKey) playPrevious(); else seekBy(-5);
      break;
    case "ArrowUp":
    case "ArrowDown": {
      if (onControl || document.querySelector(".select-custom.open")) return;
      event.preventDefault();
      const volume = setVolume(audioPlayer.volume + (event.key === "ArrowUp" ? 0.05 : -0.05));
      showToast(`Volumen ${Math.round(volume * 100)}%`);
      break;
    }
    case "m": case "M":
      showToast(toggleMute() === 0 ? "Silenciado" : "Sonido activado");
      break;
    case "s": case "S":
      showToast(toggleShuffle() ? "Aleatorio activado" : "Aleatorio desactivado");
      break;
    case "r": case "R":
      showToast(cycleRepeat());
      break;
    case "/":
      event.preventDefault();
      openPalette();
      break;
    default:
  }
});
