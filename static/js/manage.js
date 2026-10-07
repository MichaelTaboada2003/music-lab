// ============================================================
// manage.js — administración de la biblioteca
//   · resumen de espacio y limpieza rápida
//   · lista por canción con borrado por parte (audio, letra, sync, voz…)
//   · selección en lote, archivos sin canción y papelera con "Deshacer"
// ============================================================

import { formatBytes, relativeTime } from "./format.js";
import { enhanceSelect } from "./dropdown.js";
import { refreshLibrary } from "./player.js";

const $ = (id) => document.getElementById(id);
const els = {
  total: $("mgTotal"), totalLabel: $("mgTotalLabel"), bar: $("mgBar"), legend: $("mgLegend"),
  quick: $("mgQuick"), search: $("mgSearch"), sort: $("mgSort"), filters: $("mgFilters"),
  list: $("mgList"), empty: $("mgEmpty"), emptyTitle: $("mgEmptyTitle"), emptyText: $("mgEmptyText"),
  orphansPanel: $("mgOrphansPanel"), orphansMeta: $("mgOrphansMeta"), orphans: $("mgOrphans"),
  trashPanel: $("mgTrashPanel"), trashMeta: $("mgTrashMeta"), trash: $("mgTrash"),
  bulk: $("mgBulk"), bulkCount: $("mgBulkCount"), bulkActions: $("mgBulkActions"), bulkClear: $("mgBulkClear"),
  confirm: $("mgConfirm"), confirmTitle: $("mgConfirmTitle"), confirmText: $("mgConfirmText"),
  confirmList: $("mgConfirmList"), confirmOk: $("mgConfirmOk"), confirmCancel: $("mgConfirmCancel"),
  toast: $("mgToast"), toastText: $("mgToastText"), toastUndo: $("mgToastUndo"),
};

const COLUMNS = ["audio", "lyrics", "sync", "vocals", "instrumental"];
const PART_LABEL = {
  audio: "Audio", lyrics: "Letra", sync: "Sincronización", vocals: "Voz", instrumental: "Instrumental",
};
// Etiquetas cortas para la cabecera de la tabla (las largas no caben en la columna).
const HEAD_LABEL = { audio: "Audio", lyrics: "Letra", sync: "Sync", vocals: "Voz", instrumental: "Instrumental" };
const PART_ACTION = {
  audio: "la canción completa", lyrics: "la letra (y su sincronización)", sync: "la sincronización",
  vocals: "la voz", instrumental: "el instrumental",
};
const SEGMENTS = [
  ["stems", "Voz e instrumental", "#a78bfa"],
  ["audio", "Audio", "#1ed760"],
  ["sync", "Sincronización", "#62d6ee"],
  ["lyrics", "Letras", "#ffbd2e"],
  ["covers", "Portadas", "#f472b6"],
  ["videos", "Videos", "#7c8aa5"],
  ["orphans", "Sin canción", "#f15e6c"],
];
const FILTERS = [
  ["all", "Todas", () => true],
  ["nolyrics", "Sin letra", (s) => !s.parts.lyrics],
  ["stems", "Con stems", (s) => s.parts.vocals || s.parts.instrumental],
  ["clips", "Recortes", (s) => s.is_clip],
];
const SORTERS = {
  name: (a, b) => a.title.localeCompare(b.title, "es", { sensitivity: "base" }),
  size: (a, b) => b.total_size - a.total_size,
  stems: (a, b) => stemSize(b) - stemSize(a),
  recent: (a, b) => b.mtime - a.mtime,
};

const state = {
  data: null, filter: "all", query: "", sort: "name", selected: new Set(), loaded: false,
};

const stemSize = (song) => (song.parts.vocals?.size || 0) + (song.parts.instrumental?.size || 0);

// ---- utilidades --------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>';

async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* sin JSON */ }
    throw new Error(detail);
  }
  return res.json();
}

const post = (path, body) => request(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
});

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

// ---- toast con "Deshacer" ---------------------------------------------------

let toastTimer = null;
let toastUndo = null;

function showToast(text, undo) {
  clearTimeout(toastTimer);
  els.toastText.textContent = text;
  toastUndo = undo || null;
  els.toastUndo.hidden = !undo;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add("show"));
  toastTimer = setTimeout(hideToast, undo ? 10000 : 4500);
}

function hideToast() {
  els.toast.classList.remove("show");
  setTimeout(() => { if (!els.toast.classList.contains("show")) els.toast.hidden = true; }, 220);
}

els.toastUndo.addEventListener("click", async () => {
  const undo = toastUndo;
  hideToast();
  if (undo) await undo();
});

// ---- diálogo de confirmación -------------------------------------------------

function confirmAction({ title, text, items = [], okLabel = "Mover a la papelera" }) {
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.confirmOk.textContent = okLabel;
  els.confirmList.innerHTML = "";
  items.slice(0, 6).forEach((item) => els.confirmList.appendChild(el("li", "", item)));
  if (items.length > 6) els.confirmList.appendChild(el("li", "mg-confirm-more", `y ${items.length - 6} más…`));
  els.confirmList.hidden = items.length === 0;
  return new Promise((resolve) => {
    const done = (value) => {
      els.confirm.removeEventListener("close", onClose);
      resolve(value);
    };
    const onClose = () => done(els.confirm.returnValue === "ok");
    els.confirm.addEventListener("close", onClose);
    els.confirm.returnValue = "";
    els.confirm.showModal();
  });
}

els.confirmOk.addEventListener("click", () => { els.confirm.returnValue = "ok"; });
els.confirmCancel.addEventListener("click", () => { els.confirm.returnValue = ""; els.confirm.close(); });
els.confirm.addEventListener("click", (event) => { if (event.target === els.confirm) els.confirm.close(); });

// ---- carga y refresco --------------------------------------------------------

export async function loadManage() {
  if (!state.loaded) els.list.setAttribute("aria-busy", "true");
  try {
    state.data = await request("/api/biblioteca");
    state.loaded = true;
    const known = new Set(state.data.songs.map((s) => s.stem));
    state.selected = new Set([...state.selected].filter((stem) => known.has(stem)));
    render();
  } catch (e) {
    els.list.setAttribute("aria-busy", "false");
    els.list.innerHTML = "";
    els.empty.hidden = false;
    els.emptyTitle.textContent = "No se pudo cargar la biblioteca";
    els.emptyText.textContent = e.message;
  }
}

async function afterChange() {
  await loadManage();
  refreshLibrary().catch(() => { /* el reproductor se actualizará al volver a él */ });
}

// ---- acciones ------------------------------------------------------------------

function describeEntry(entry) {
  const names = (entry.parts || []).map((p) => PART_LABEL[p]?.toLowerCase() || p);
  return `${entry.label}: ${names.join(", ")}`;
}

async function trashItems(items, successText) {
  try {
    const result = await post("/api/biblioteca/eliminar", { items });
    if (!result.entries.length) {
      showToast("No había nada que eliminar.");
      return;
    }
    await afterChange();
    const text = successText || (result.entries.length === 1
      ? `${describeEntry(result.entries[0])} · ${formatBytes(result.freed)} a la papelera`
      : `${result.entries.length} elementos · ${formatBytes(result.freed)} a la papelera`);
    showToast(text, () => restoreEntries(result.entries.map((e) => e.id)));
  } catch (e) {
    showToast(`No se pudo eliminar: ${e.message}`);
  }
}

async function restoreEntries(ids) {
  try {
    for (const id of ids) await post(`/api/biblioteca/papelera/${encodeURIComponent(id)}/restaurar`);
    await afterChange();
    showToast(ids.length === 1 ? "Restaurado." : `${ids.length} elementos restaurados.`);
  } catch (e) {
    showToast(`No se pudo restaurar: ${e.message}`);
    await afterChange();
  }
}

async function trashOrphans(files) {
  try {
    const result = await post("/api/biblioteca/huerfanos/eliminar", { files });
    if (!result.entries.length) return;
    await afterChange();
    showToast(`${files.length} ${files.length === 1 ? "archivo" : "archivos"} · ${formatBytes(result.freed)} a la papelera`,
      () => restoreEntries(result.entries.map((e) => e.id)));
  } catch (e) {
    showToast(`No se pudo eliminar: ${e.message}`);
  }
}

/** Elimina una parte en varias canciones tras confirmar (lotes y limpieza rápida). */
async function bulkDelete(songs, parts, { title, text }) {
  const targets = songs.filter((s) => parts.some((p) => s.parts[p]));
  if (!targets.length) {
    showToast("No hay nada que eliminar con esa selección.");
    return;
  }
  const freed = targets.reduce(
    (sum, s) => sum + parts.reduce((acc, p) => acc + (s.parts[p]?.size || 0), 0), 0);
  const ok = await confirmAction({
    title,
    text: `${text} Se liberarán ${formatBytes(freed)} y podrás deshacerlo desde la papelera.`,
    items: targets.map((s) => s.title),
  });
  if (!ok) return;
  await trashItems(targets.map((s) => ({ stem: s.stem, parts })));
  state.selected.clear();
  renderBulk();
}

// ---- vistas --------------------------------------------------------------------

function visibleSongs() {
  const filter = FILTERS.find(([key]) => key === state.filter) || FILTERS[0];
  const q = state.query.trim().toLowerCase();
  return state.data.songs
    .filter(filter[2])
    .filter((s) => !q || `${s.title} ${s.artist} ${s.stem}`.toLowerCase().includes(q))
    .sort(SORTERS[state.sort]);
}

function renderOverview() {
  const { totals, songs, trash } = state.data;
  const keys = SEGMENTS.map(([key]) => key);
  const sum = keys.reduce((acc, key) => acc + (totals[key] || 0), 0);
  els.total.textContent = formatBytes(sum);
  els.totalLabel.textContent =
    `${songs.length} ${songs.length === 1 ? "canción" : "canciones"} en disco` +
    (trash.length ? ` · ${formatBytes(totals.trash)} en la papelera` : "");

  els.bar.innerHTML = "";
  els.legend.innerHTML = "";
  SEGMENTS.forEach(([key, label, color]) => {
    const size = totals[key] || 0;
    if (!size) return;
    const segment = el("span", "mg-bar-seg");
    segment.style.flexGrow = String(size);
    segment.style.background = color;
    segment.title = `${label}: ${formatBytes(size)}`;
    els.bar.appendChild(segment);
    const item = el("li", "mg-legend-item");
    const dot = el("i");
    dot.style.background = color;
    item.append(dot, el("span", "mg-legend-label", label), el("b", "", formatBytes(size)));
    els.legend.appendChild(item);
  });
}

function quickCard({ title, value, text, actionLabel, onAction, tone }) {
  const card = el("div", "mg-quick-card");
  if (tone) card.dataset.tone = tone;
  card.append(el("span", "mg-quick-title", title), el("strong", "mg-quick-value", value), el("p", "mg-quick-text", text));
  if (actionLabel) {
    const button = el("button", "btn-ghost mg-quick-action", actionLabel);
    button.type = "button";
    button.addEventListener("click", onAction);
    card.appendChild(button);
  }
  return card;
}

function renderQuick() {
  const { songs, totals, orphans, trash } = state.data;
  els.quick.innerHTML = "";
  const withStems = songs.filter((s) => s.parts.vocals || s.parts.instrumental);
  els.quick.appendChild(quickCard({
    title: "Voz e instrumental",
    value: formatBytes(totals.stems),
    text: withStems.length
      ? `${withStems.length} canciones. Se regeneran solos al sincronizar o usar karaoke.`
      : "No hay stems guardados.",
    actionLabel: withStems.length ? "Eliminar todos" : "",
    tone: "accent",
    onAction: () => bulkDelete(songs, ["vocals", "instrumental"], {
      title: "Eliminar todos los stems",
      text: "Se borrarán la voz y el instrumental de todas las canciones. Se volverán a generar cuando los necesites.",
    }),
  }));
  const noLyrics = songs.filter((s) => !s.parts.lyrics).length;
  els.quick.appendChild(quickCard({
    title: "Sin letra",
    value: String(noLyrics),
    text: noLyrics ? "Canciones que aún no tienen letra guardada." : "Todas tus canciones tienen letra.",
    actionLabel: noLyrics ? "Ver canciones" : "",
    onAction: () => { state.filter = "nolyrics"; render(); els.list.scrollIntoView({ behavior: "smooth", block: "start" }); },
  }));
  if (orphans.length) {
    els.quick.appendChild(quickCard({
      title: "Archivos sin canción",
      value: String(orphans.length),
      text: `${formatBytes(totals.orphans)} que ya no pertenecen a ninguna canción.`,
      actionLabel: "Revisar",
      tone: "warn",
      onAction: () => { els.orphansPanel.open = true; els.orphansPanel.scrollIntoView({ behavior: "smooth", block: "center" }); },
    }));
  }
  if (trash.length) {
    els.quick.appendChild(quickCard({
      title: "Papelera",
      value: formatBytes(totals.trash),
      text: `${trash.length} ${trash.length === 1 ? "elemento" : "elementos"} que puedes restaurar o vaciar.`,
      actionLabel: "Abrir",
      onAction: () => { els.trashPanel.open = true; els.trashPanel.scrollIntoView({ behavior: "smooth", block: "center" }); },
    }));
  }
}

function renderFilters() {
  els.filters.innerHTML = "";
  FILTERS.forEach(([key, label, test]) => {
    const count = state.data.songs.filter(test).length;
    const chip = el("button", "vl-chip");
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(state.filter === key));
    chip.append(el("span", "", label), el("span", "vl-chip-count", String(count)));
    chip.addEventListener("click", () => { state.filter = key; render(); });
    els.filters.appendChild(chip);
  });
}

function buildHeaderRow(songs) {
  const row = el("div", "mg-row mg-head");
  const check = el("label", "mg-check");
  const input = el("input");
  input.type = "checkbox";
  input.setAttribute("aria-label", "Seleccionar todas");
  input.checked = songs.length > 0 && songs.every((s) => state.selected.has(s.stem));
  input.indeterminate = !input.checked && songs.some((s) => state.selected.has(s.stem));
  input.addEventListener("change", () => {
    songs.forEach((s) => (input.checked ? state.selected.add(s.stem) : state.selected.delete(s.stem)));
    renderList();
    renderBulk();
  });
  check.appendChild(input);
  row.appendChild(check);
  row.appendChild(el("span", "mg-col mg-col-song", "Canción"));
  COLUMNS.forEach((part) => row.appendChild(el("span", "mg-col", HEAD_LABEL[part])));
  row.append(el("span", "mg-col mg-col-total", "Total"), el("span", "mg-col"));
  return row;
}

function buildCell(song, part) {
  const info = song.parts[part];
  const cell = el("div", "mg-cell");
  cell.dataset.label = PART_LABEL[part];
  if (!info) {
    cell.appendChild(el("span", "mg-none", "—"));
    return cell;
  }
  const chip = el("button", "mg-chip");
  chip.type = "button";
  chip.title = `Eliminar ${PART_ACTION[part]}`;
  chip.setAttribute("aria-label", `Eliminar ${PART_ACTION[part]} de ${song.title}`);
  const label = el("span", "mg-chip-size", formatBytes(info.size));
  const ext = el("span", "mg-chip-ext", info.ext);
  const icon = el("span", "mg-chip-icon");
  icon.innerHTML = TRASH_ICON;
  chip.append(label, ext, icon);
  if (part === "audio") {
    // Quitar el audio elimina la canción entera: pide un segundo clic.
    armConfirm(chip, "¿Eliminar todo?", () => trashItems([{ stem: song.stem, parts: ["audio"] }]));
  } else {
    chip.addEventListener("click", () => trashItems([{ stem: song.stem, parts: [part] }]));
  }
  cell.appendChild(chip);
  return cell;
}

function buildRow(song) {
  const row = el("div", "mg-row");
  row.dataset.stem = song.stem;
  if (state.selected.has(song.stem)) row.classList.add("selected");

  const check = el("label", "mg-check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = state.selected.has(song.stem);
  input.setAttribute("aria-label", `Seleccionar ${song.title}`);
  input.addEventListener("change", () => {
    if (input.checked) state.selected.add(song.stem); else state.selected.delete(song.stem);
    row.classList.toggle("selected", input.checked);
    renderBulk();
    renderHeaderCheckbox();
  });
  check.appendChild(input);

  const info = el("div", "mg-song");
  const cover = el("div", "mg-cover");
  const img = el("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = `/api/canciones/${encodeURIComponent(song.stem)}/cover`;
  img.addEventListener("error", () => img.remove());
  cover.append(el("span", "", (song.title || "?").trim().slice(0, 1).toUpperCase()), img);
  const copy = el("div", "mg-song-copy");
  const title = el("span", "mg-title", song.title);
  title.title = song.title;
  copy.appendChild(title);
  const sub = el("span", "mg-sub");
  if (song.artist) sub.appendChild(el("span", "", song.artist));
  if (song.is_clip) sub.appendChild(el("span", "vtag", "Recorte"));
  if (sub.childNodes.length) copy.appendChild(sub);
  info.append(cover, copy);

  row.append(check, info);
  COLUMNS.forEach((part) => row.appendChild(buildCell(song, part)));

  const total = el("div", "mg-total-cell", formatBytes(song.total_size));
  total.dataset.label = "Total";
  const actions = el("div", "mg-actions");
  const del = el("button", "mg-del");
  del.type = "button";
  del.title = "Eliminar la canción y todo lo asociado";
  del.setAttribute("aria-label", `Eliminar ${song.title} completa`);
  del.innerHTML = TRASH_ICON;
  armConfirm(del, "¿Eliminar?", () => trashItems([{ stem: song.stem, parts: ["audio"] }]));
  actions.appendChild(del);
  row.append(total, actions);
  return row;
}

function renderHeaderCheckbox() {
  const input = els.list.querySelector(".mg-head input");
  if (!input) return;
  const songs = visibleSongs();
  input.checked = songs.length > 0 && songs.every((s) => state.selected.has(s.stem));
  input.indeterminate = !input.checked && songs.some((s) => state.selected.has(s.stem));
}

function renderList() {
  const songs = visibleSongs();
  els.list.setAttribute("aria-busy", "false");
  els.list.innerHTML = "";
  const hasSongs = state.data.songs.length > 0;
  els.list.hidden = songs.length === 0;
  els.empty.hidden = songs.length > 0;
  if (!songs.length) {
    els.emptyTitle.textContent = hasSongs ? "Nada coincide con tu búsqueda" : "Tu biblioteca está vacía";
    els.emptyText.textContent = hasSongs
      ? "Prueba con otra palabra o cambia el filtro."
      : "Añade canciones desde Descubrir o pegando una URL en Video.";
    return;
  }
  els.list.appendChild(buildHeaderRow(songs));
  songs.forEach((song) => els.list.appendChild(buildRow(song)));
}

function renderBulk() {
  const chosen = state.data.songs.filter((s) => state.selected.has(s.stem));
  els.bulk.hidden = chosen.length === 0;
  document.body.classList.toggle("mg-selecting", chosen.length > 0);
  if (!chosen.length) return;
  els.bulkCount.textContent = `${chosen.length} ${chosen.length === 1 ? "seleccionada" : "seleccionadas"}`;
  els.bulkActions.innerHTML = "";
  const groups = [
    ["Voz e instrumental", ["vocals", "instrumental"], "Eliminar voz e instrumental"],
    ["Letras", ["lyrics"], "Eliminar letras"],
    ["Sincronización", ["sync"], "Eliminar sincronizaciones"],
    ["Canciones completas", ["audio"], "Eliminar canciones completas"],
  ];
  groups.forEach(([label, parts, title]) => {
    const count = chosen.filter((s) => parts.some((p) => s.parts[p])).length;
    if (!count) return;
    const button = el("button", `mg-bulk-btn${parts[0] === "audio" ? " danger" : ""}`, `${label} (${count})`);
    button.type = "button";
    button.addEventListener("click", () => bulkDelete(chosen, parts, {
      title,
      text: parts[0] === "audio"
        ? "Se eliminará cada canción con su letra, sincronización y stems."
        : `Se eliminará solo «${label.toLowerCase()}»; el resto se conserva.`,
    }));
    els.bulkActions.appendChild(button);
  });
}

function renderOrphans() {
  const { orphans, totals } = state.data;
  els.orphansPanel.hidden = orphans.length === 0;
  els.orphansMeta.textContent = orphans.length
    ? `${orphans.length} ${orphans.length === 1 ? "archivo" : "archivos"} · ${formatBytes(totals.orphans)}` : "";
  els.orphans.innerHTML = "";
  if (!orphans.length) return;
  const head = el("div", "mg-panel-actions");
  const all = el("button", "btn-ghost", "Eliminar todos");
  all.type = "button";
  all.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "Eliminar archivos sin canción",
      text: `Se moverán ${orphans.length} archivos (${formatBytes(totals.orphans)}) a la papelera.`,
      items: orphans.map((o) => o.name),
    });
    if (ok) trashOrphans(orphans.map(({ dir, name }) => ({ dir, name })));
  });
  head.appendChild(all);
  els.orphans.appendChild(head);
  orphans.forEach((file) => {
    const row = el("div", "mg-file-row");
    const copy = el("div", "mg-file-copy");
    const name = el("span", "mg-file-name", file.name);
    name.title = file.name;
    copy.append(name, el("span", "mg-file-meta", `${file.reason} · ${formatBytes(file.size)}`));
    const del = el("button", "mg-del");
    del.type = "button";
    del.title = "Eliminar archivo";
    del.setAttribute("aria-label", `Eliminar ${file.name}`);
    del.innerHTML = TRASH_ICON;
    del.addEventListener("click", () => trashOrphans([{ dir: file.dir, name: file.name }]));
    row.append(copy, del);
    els.orphans.appendChild(row);
  });
}

function renderTrash() {
  const { trash, totals } = state.data;
  els.trashMeta.textContent = trash.length
    ? `${trash.length} ${trash.length === 1 ? "elemento" : "elementos"} · ${formatBytes(totals.trash)}` : "Vacía";
  els.trash.innerHTML = "";
  if (!trash.length) {
    els.trash.appendChild(el("p", "mg-panel-empty", "La papelera está vacía."));
    return;
  }
  const head = el("div", "mg-panel-actions");
  const empty = el("button", "btn-ghost mg-danger-ghost", "Vaciar papelera");
  empty.type = "button";
  armConfirm(empty, "¿Vaciar para siempre?", async () => {
    try {
      const result = await request("/api/biblioteca/papelera", { method: "DELETE" });
      await loadManage();
      showToast(`Papelera vaciada · ${formatBytes(result.freed)} liberados`);
    } catch (e) {
      showToast(`No se pudo vaciar: ${e.message}`);
    }
  });
  head.appendChild(empty);
  els.trash.appendChild(head);
  trash.forEach((entry) => {
    const row = el("div", "mg-file-row");
    const copy = el("div", "mg-file-copy");
    const names = (entry.parts || []).map((p) => (PART_LABEL[p] || "Archivos").toLowerCase()).join(", ");
    copy.append(
      el("span", "mg-file-name", entry.label),
      el("span", "mg-file-meta", `${names} · ${formatBytes(entry.size || 0)} · ${relativeTime(entry.deleted_at)}`),
    );
    const actions = el("div", "mg-file-actions");
    const restore = el("button", "btn-ghost", "Restaurar");
    restore.type = "button";
    restore.addEventListener("click", () => restoreEntries([entry.id]));
    const purge = el("button", "mg-del");
    purge.type = "button";
    purge.title = "Eliminar definitivamente";
    purge.setAttribute("aria-label", `Eliminar definitivamente ${entry.label}`);
    purge.innerHTML = TRASH_ICON;
    armConfirm(purge, "¿Para siempre?", async () => {
      try {
        await request(`/api/biblioteca/papelera/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
        await loadManage();
      } catch (e) {
        showToast(`No se pudo eliminar: ${e.message}`);
      }
    });
    actions.append(restore, purge);
    row.append(copy, actions);
    els.trash.appendChild(row);
  });
}

function render() {
  if (!state.data) return;
  renderOverview();
  renderQuick();
  renderFilters();
  renderList();
  renderBulk();
  renderOrphans();
  renderTrash();
}

// ---- eventos --------------------------------------------------------------------

els.search.addEventListener("input", () => { state.query = els.search.value; renderList(); });
els.sort.addEventListener("change", () => { state.sort = els.sort.value; renderList(); });
els.bulkClear.addEventListener("click", () => { state.selected.clear(); renderList(); renderBulk(); });
enhanceSelect(els.sort);
