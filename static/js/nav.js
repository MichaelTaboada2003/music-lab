// ============================================================
// nav.js — sistema de navegación SPA + activación desde hash
// ============================================================

// Importaciones diferidas para evitar ciclos: lyrics y studio necesitan
// nav (a través de discover) y nav necesita refrescar sus selectores.
import { refreshSongSelect } from "./api.js";
import { refreshLyricsSongs } from "./lyrics.js";
import { studioSongSelect, onStudioSongChange } from "./studio.js";
import { loadVideoGallery } from "./videos.js";
import { trimSongSelect, onTrimSongChange } from "./trim.js";
import {
  discoverLoaded, setDiscoverLoaded, loadRecap,
} from "./discover.js";

const navItems = document.querySelectorAll(".nav-item");
const views = document.querySelectorAll(".view");

// La pestaña activa vive en la URL (#view-…) para que al recargar la página
// el usuario se quede donde estaba; replaceState evita llenar el historial.
// localStorage cubre el caso de abrir la dirección sin hash.
const VIEW_KEY = "music-lab:view";

function rememberView(view) {
  const hash = `#view-${view}`;
  if (window.location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Almacenamiento bloqueado: la URL sigue siendo suficiente.
  }
}

function storedView() {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

export function activateView(view) {
  const btn = document.querySelector(`.nav-item[data-view="${view}"]`);
  const section = document.getElementById(`view-${view}`);
  if (!btn || !section) return false;

  navItems.forEach((b) => b.classList.remove("active"));
  views.forEach((v) => v.classList.remove("active"));
  btn.classList.add("active");
  section.classList.add("active");
  document.body.dataset.activeView = view;
  rememberView(view);

  if (view === "lyrics") refreshLyricsSongs();
  if (view === "trim") refreshSongSelect(trimSongSelect, onTrimSongChange);
  if (view === "studio") {
    refreshSongSelect(studioSongSelect, onStudioSongChange);
    loadVideoGallery();
  }
  if (view === "spotify" && !discoverLoaded) {
    setDiscoverLoaded(true);
    loadRecap();
  }
  return true;
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => activateView(btn.dataset.view));
});

export function activateFromHash() {
  const m = /^#view-([\w-]+)$/.exec(window.location.hash || "");
  if (m && activateView(m[1])) return;
  // Sin hash válido (p. ej. la URL base): vuelve a la última pestaña usada.
  const last = storedView();
  if (!m && last) activateView(last);
}

window.addEventListener("hashchange", activateFromHash);
