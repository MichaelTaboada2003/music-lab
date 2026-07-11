// ============================================================
// nav.js — sistema de navegación SPA + activación desde hash
// ============================================================

// Importaciones diferidas para evitar ciclos: lyrics y studio necesitan
// nav (a través de discover) y nav necesita refrescar sus selectores.
import { refreshSongSelect } from "./api.js";
import { lyricsSongSelect, onLyricsSongChange } from "./lyrics.js";
import {
  studioSongSelect, onStudioSongChange, loadVideoGallery,
} from "./studio.js";
import {
  discoverLoaded, setDiscoverLoaded, loadRecap,
} from "./discover.js";

const navItems = document.querySelectorAll(".nav-item");
const views = document.querySelectorAll(".view");

export function activateView(view) {
  const btn = document.querySelector(`.nav-item[data-view="${view}"]`);
  const section = document.getElementById(`view-${view}`);
  if (!btn || !section) return false;

  navItems.forEach((b) => b.classList.remove("active"));
  views.forEach((v) => v.classList.remove("active"));
  btn.classList.add("active");
  section.classList.add("active");
  document.body.dataset.activeView = view;

  if (view === "lyrics") refreshSongSelect(lyricsSongSelect, onLyricsSongChange);
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
  if (m) activateView(m[1]);
}

window.addEventListener("hashchange", activateFromHash);
