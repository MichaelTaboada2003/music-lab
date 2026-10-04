// ============================================================
// videos.js — biblioteca de videos generados
//   · cuadrícula con portada real, búsqueda, filtros y orden
//   · reproductor en ventana con navegación y acciones
//   · descargar, mostrar en carpeta, renombrar y eliminar
// ============================================================

import { formatSeconds } from "./api.js";
import { enhanceSelect } from "./dropdown.js";

const gallery = document.getElementById("videoGallery");
const summary = document.getElementById("videoLibrarySummary");
const searchInput = document.getElementById("videoSearch");
const sortSelect = document.getElementById("videoSort");
const filtersBox = document.getElementById("videoFilters");
const emptyBox = document.getElementById("videoEmpty");
const emptyTitle = document.getElementById("videoEmptyTitle");
const emptyText = document.getElementById("videoEmptyText");
const dialog = document.getElementById("videoDialog");

const state = { items: [], filter: "all", query: "", sort: "recent", current: -1, view: [] };

const KIND_ORDER = ["player", "terminal", "color", "other"];
const KIND_LABELS = { player: "Reproductor", terminal: "Terminal", color: "Color", other: "Otros" };
const SORTERS = {
  recent: (a, b) => b.mtime - a.mtime,
  oldest: (a, b) => a.mtime - b.mtime,
  name: (a, b) => a.title.localeCompare(b.title, "es", { sensitivity: "base" }),
  duration: (a, b) => b.duration - a.duration,
  size: (a, b) => b.size - a.size,
};

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

// ---- utilidades --------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(path, extra = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = path + extra;
  return svg;
}

const ICONS = {
  play: '<path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4l-12-7.5A.8.8 0 0 0 7 4.5Z" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="m14 6 4 4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  prev: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
};

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function relativeTime(epochSeconds) {
  const diff = epochSeconds - Date.now() / 1000;
  const steps = [
    ["year", 31536000], ["month", 2592000], ["week", 604800],
    ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [unit, seconds] of steps) {
    if (Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit);
  }
  return "justo ahora";
}

function fullDate(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleString("es", {
    day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const posterUrl = (item) => `/api/videos/${encodeURIComponent(item.name)}/poster?v=${Math.round(item.mtime)}`;
const videoUrl = (item) => `/videos/${encodeURIComponent(item.name)}`;
const downloadUrl = (item) => `/api/videos/${encodeURIComponent(item.name)}/download`;

async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* sin cuerpo JSON */ }
    throw new Error(detail);
  }
  return res.json();
}

/** Botón de dos pasos: el primer clic pide confirmación y el segundo ejecuta. */
function armConfirm(button, label, action) {
  let timer = null;
  const original = button.innerHTML;
  const reset = () => {
    clearTimeout(timer);
    button.classList.remove("confirming");
    button.innerHTML = original;
    button.dataset.armed = "";
  };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.dataset.armed === "1") {
      reset();
      action();
      return;
    }
    button.dataset.armed = "1";
    button.classList.add("confirming");
    button.textContent = label;
    timer = setTimeout(reset, 3200);
  });
  button.addEventListener("blur", reset);
}

// ---- filtros y vista ---------------------------------------------------------

function matches(item) {
  if (state.filter !== "all" && item.kind !== state.filter) return false;
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [item.title, item.artist, item.kind_label, item.name, ...item.tags].join(" ").toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

function computeView() {
  state.view = state.items.filter(matches).sort(SORTERS[state.sort]);
}

function renderFilters() {
  filtersBox.innerHTML = "";
  const counts = { all: state.items.length };
  state.items.forEach((item) => { counts[item.kind] = (counts[item.kind] || 0) + 1; });
  const chips = [["all", "Todos"], ...KIND_ORDER.filter((k) => counts[k]).map((k) => [k, KIND_LABELS[k]])];
  chips.forEach(([key, label]) => {
    const chip = el("button", "vl-chip");
    chip.type = "button";
    chip.dataset.kind = key;
    chip.setAttribute("aria-pressed", String(state.filter === key));
    chip.append(el("span", "", label), el("span", "vl-chip-count", String(counts[key] || 0)));
    chip.addEventListener("click", () => {
      state.filter = key;
      render();
    });
    filtersBox.appendChild(chip);
  });
  filtersBox.hidden = state.items.length === 0;
}

function renderSummary() {
  const total = state.items.reduce((sum, item) => sum + item.size, 0);
  const n = state.items.length;
  summary.textContent = n
    ? `${n} ${n === 1 ? "video" : "videos"} · ${formatBytes(total)} en disco`
    : "Aún no has exportado ningún video";
  const filtered = state.view.length !== n;
  if (n && filtered) summary.textContent += ` · mostrando ${state.view.length}`;
}

function buildCard(item, index) {
  const card = el("article", "vcard");
  card.dataset.name = item.name;
  card.dataset.kind = item.kind;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Reproducir ${item.title}`);
  card.style.setProperty("--i", String(Math.min(index, 14)));

  const media = el("div", "vcard-media loading");
  media.dataset.orientation = item.orientation;
  const bg = el("img", "vcard-bg");
  bg.alt = "";
  bg.loading = "lazy";
  bg.src = posterUrl(item);
  const poster = el("img", "vcard-poster");
  poster.alt = `Vista previa de ${item.title}`;
  poster.loading = "lazy";
  poster.src = posterUrl(item);
  poster.addEventListener("load", () => media.classList.remove("loading"));
  poster.addEventListener("error", () => {
    media.classList.remove("loading");
    media.classList.add("no-poster");
  });
  if (poster.complete && poster.naturalWidth) media.classList.remove("loading");
  const badge = el("span", `vcard-badge kind-${item.kind}`, item.kind_label);
  const duration = el("span", "vcard-duration", formatSeconds(item.duration));
  const play = el("span", "vcard-play");
  play.appendChild(icon(ICONS.play));
  const actions = el("div", "vcard-actions");
  const dl = el("a", "vcard-action");
  dl.href = downloadUrl(item);
  dl.title = "Descargar";
  dl.setAttribute("aria-label", "Descargar");
  dl.appendChild(icon(ICONS.download));
  dl.addEventListener("click", (event) => event.stopPropagation());
  const del = el("button", "vcard-action danger");
  del.type = "button";
  del.title = "Eliminar";
  del.setAttribute("aria-label", "Eliminar");
  del.appendChild(icon(ICONS.trash));
  armConfirm(del, "¿Eliminar?", () => deleteItem(item));
  actions.append(dl, del);
  media.append(bg, poster, badge, duration, play, actions);

  const body = el("div", "vcard-body");
  const title = el("h3", "vcard-title", item.title);
  title.title = item.title;
  body.appendChild(title);
  if (item.artist) body.appendChild(el("p", "vcard-artist", item.artist));
  if (item.tags.length) {
    const tags = el("div", "vcard-tags");
    item.tags.slice(0, 3).forEach((tag) => tags.appendChild(el("span", "vtag", tag)));
    body.appendChild(tags);
  }
  const meta = el("p", "vcard-meta");
  const when = el("span", "", relativeTime(item.mtime));
  when.title = fullDate(item.mtime);
  meta.append(when, el("span", "vcard-dot", "·"), el("span", "", formatBytes(item.size)));
  body.appendChild(meta);
  card.append(media, body);

  card.addEventListener("click", () => openDialog(index));
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDialog(index);
    }
  });
  attachHoverPreview(card, media, item);
  return card;
}

/** Tras una breve pausa sobre la tarjeta, reproduce el video en silencio. */
function attachHoverPreview(card, media, item) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!window.matchMedia("(hover: hover)").matches) return;
  let timer = null;
  let preview = null;
  const stop = () => {
    clearTimeout(timer);
    if (preview) {
      preview.remove();
      preview = null;
    }
    media.classList.remove("previewing");
  };
  card.addEventListener("mouseenter", () => {
    timer = setTimeout(() => {
      preview = el("video", "vcard-preview");
      preview.muted = true;
      preview.loop = true;
      preview.playsInline = true;
      preview.preload = "auto";
      preview.src = videoUrl(item);
      preview.addEventListener("playing", () => media.classList.add("previewing"), { once: true });
      media.insertBefore(preview, media.querySelector(".vcard-badge"));
      preview.play().catch(stop);
    }, 450);
  });
  card.addEventListener("mouseleave", stop);
  card.addEventListener("blur", stop, true);
}

function renderGrid(highlight) {
  gallery.innerHTML = "";
  gallery.setAttribute("aria-busy", "false");
  state.view.forEach((item, index) => gallery.appendChild(buildCard(item, index)));
  const hasItems = state.items.length > 0;
  gallery.hidden = state.view.length === 0;
  emptyBox.hidden = state.view.length > 0;
  if (state.view.length === 0) {
    emptyBox.dataset.mode = hasItems ? "filtered" : "empty";
    emptyTitle.textContent = hasItems ? "Nada coincide con tu búsqueda" : "Tu galería está esperando";
    emptyText.textContent = hasItems
      ? "Prueba con otra palabra o quita el filtro de formato."
      : "Sincroniza una canción, elige un formato y genera tu primer video: aparecerá aquí.";
  }
  if (highlight) {
    const card = gallery.querySelector(`.vcard[data-name="${CSS.escape(highlight)}"]`);
    if (card) {
      card.classList.add("is-new");
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setTimeout(() => card.classList.remove("is-new"), 4200);
    }
  }
}

function render(highlight) {
  computeView();
  renderFilters();
  renderSummary();
  renderGrid(highlight);
}

function renderSkeleton() {
  gallery.hidden = false;
  emptyBox.hidden = true;
  gallery.setAttribute("aria-busy", "true");
  gallery.innerHTML = "";
  for (let i = 0; i < 6; i += 1) {
    const card = el("div", "vcard skeleton");
    card.append(el("div", "vcard-media"), el("div", "vskel-line"), el("div", "vskel-line short"));
    gallery.appendChild(card);
  }
}

// ---- acciones ----------------------------------------------------------------

async function deleteItem(item) {
  try {
    await request(`/api/videos/${encodeURIComponent(item.name)}`, { method: "DELETE" });
    state.items = state.items.filter((it) => it.name !== item.name);
    if (dialog.open) dialog.close();
    render();
  } catch (e) {
    summary.textContent = `No se pudo eliminar: ${e.message}`;
  }
}

// ---- ventana del reproductor -------------------------------------------------

const dlg = {
  video: dialog.querySelector(".vdialog-video"),
  badge: dialog.querySelector(".vdialog-badge"),
  title: dialog.querySelector(".vdialog-title"),
  artist: dialog.querySelector(".vdialog-artist"),
  tags: dialog.querySelector(".vdialog-tags"),
  meta: dialog.querySelector(".vdialog-meta"),
  counter: dialog.querySelector(".vdialog-counter"),
  prev: dialog.querySelector(".vdialog-prev"),
  next: dialog.querySelector(".vdialog-next"),
  stage: dialog.querySelector(".vdialog-stage"),
  download: dialog.querySelector(".vdialog-download"),
  reveal: dialog.querySelector(".vdialog-reveal"),
  renameBtn: dialog.querySelector(".vdialog-rename"),
  deleteBtn: dialog.querySelector(".vdialog-delete"),
  renameForm: dialog.querySelector(".vdialog-rename-form"),
  renameInput: dialog.querySelector(".vdialog-rename-input"),
  message: dialog.querySelector(".vdialog-message"),
  close: dialog.querySelector(".vdialog-close"),
};

function setMessage(text, kind = "") {
  dlg.message.textContent = text;
  dlg.message.dataset.kind = kind;
}

function fillDialog() {
  const item = state.view[state.current];
  if (!item) return;
  dlg.stage.dataset.orientation = item.orientation;
  dlg.video.poster = posterUrl(item);
  dlg.video.src = videoUrl(item);
  dlg.video.play().catch(() => {});
  dlg.badge.className = `vdialog-badge kind-${item.kind}`;
  dlg.badge.textContent = item.kind_label;
  dlg.title.textContent = item.title;
  dlg.artist.textContent = item.artist;
  dlg.artist.hidden = !item.artist;
  dlg.tags.innerHTML = "";
  item.tags.forEach((tag) => dlg.tags.appendChild(el("span", "vtag", tag)));
  dlg.meta.innerHTML = "";
  [
    ["Duración", formatSeconds(item.duration)],
    ["Resolución", item.width ? `${item.width}×${item.height}` : "—"],
    ["Tamaño", formatBytes(item.size)],
    ["Creado", fullDate(item.mtime)],
    ["Archivo", item.name],
  ].forEach(([key, value]) => {
    const row = el("div", "vmeta-row");
    row.append(el("dt", "", key), el("dd", "", value));
    dlg.meta.appendChild(row);
  });
  dlg.counter.textContent = `${state.current + 1} de ${state.view.length}`;
  dlg.prev.disabled = state.current <= 0;
  dlg.next.disabled = state.current >= state.view.length - 1;
  dlg.download.href = downloadUrl(item);
  dlg.renameForm.hidden = true;
  setMessage("");
}

function openDialog(index) {
  state.current = index;
  fillDialog();
  if (!dialog.open) dialog.showModal();
}

function step(delta) {
  const next = state.current + delta;
  if (next < 0 || next >= state.view.length) return;
  state.current = next;
  fillDialog();
}

dlg.prev.addEventListener("click", () => step(-1));
dlg.next.addEventListener("click", () => step(1));
dlg.close.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => {
  dlg.video.pause();
  dlg.video.removeAttribute("src");
  dlg.video.load();
});
dialog.addEventListener("keydown", (event) => {
  if (event.target.tagName === "INPUT") return;
  if (event.key === "ArrowLeft") step(-1);
  if (event.key === "ArrowRight") step(1);
});

dlg.reveal.addEventListener("click", async () => {
  const item = state.view[state.current];
  try {
    await request(`/api/videos/${encodeURIComponent(item.name)}/reveal`, { method: "POST" });
    setMessage("Abierto en el Finder.", "ok");
  } catch (e) {
    setMessage(e.message, "error");
  }
});

dlg.renameBtn.addEventListener("click", () => {
  const item = state.view[state.current];
  dlg.renameForm.hidden = !dlg.renameForm.hidden;
  if (!dlg.renameForm.hidden) {
    dlg.renameInput.value = item.name.replace(/\.mp4$/i, "");
    dlg.renameInput.focus();
    dlg.renameInput.select();
  }
});

dlg.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = state.view[state.current];
  const nuevo = dlg.renameInput.value.trim();
  if (!nuevo) return;
  try {
    const updated = await request(`/api/videos/${encodeURIComponent(item.name)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nuevo_nombre: nuevo }),
    });
    const at = state.items.findIndex((it) => it.name === item.name);
    if (at >= 0) state.items[at] = updated;
    computeView();
    state.current = Math.max(0, state.view.findIndex((it) => it.name === updated.name));
    render();
    fillDialog();
    setMessage("Nombre actualizado.", "ok");
  } catch (e) {
    setMessage(e.message, "error");
  }
});
dlg.renameInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    dlg.renameForm.hidden = true;
  }
});

armConfirm(dlg.deleteBtn, "¿Seguro? Eliminar", () => deleteItem(state.view[state.current]));

// ---- carga -------------------------------------------------------------------

let loaded = false;

export async function loadVideoGallery({ highlight } = {}) {
  if (!loaded) renderSkeleton();
  try {
    const data = await request("/api/videos");
    state.items = data.items || [];
    loaded = true;
    render(highlight);
  } catch (e) {
    gallery.setAttribute("aria-busy", "false");
    gallery.hidden = true;
    emptyBox.hidden = false;
    emptyBox.dataset.mode = "error";
    emptyTitle.textContent = "No se pudo cargar la galería";
    emptyText.textContent = e.message;
  }
}

searchInput.addEventListener("input", () => {
  state.query = searchInput.value;
  render();
});
sortSelect.addEventListener("change", () => {
  state.sort = sortSelect.value;
  render();
});
enhanceSelect(sortSelect);
