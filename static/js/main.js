// ============================================================
// main.js — punto de entrada de la SPA.
//
// Los imports de ES modules son siempre hoisted; el código de
// inicialización que viene después se ejecuta una vez que todos
// los módulos han sido evaluados y sus efectos laterales
// (event listeners, DOM queries) completados.
// ============================================================

// --- Imports -------------------------------------------------------
import { init as initKaraoke } from "./karaoke.js";
import { audioPlayer, cargarListaCanciones } from "./player.js";
import { activateFromHash } from "./nav.js";
import { apiPost, setStatus, pollJob, renderProgress, hideProgress } from "./api.js";
import { enhanceSelect } from "./dropdown.js";

// Módulos con efectos laterales: registran listeners al ser evaluados.
import "./lyrics.js";
import "./studio.js";
import "./discover.js";
import "./visualizer.js";

// --- Inicialización ------------------------------------------------

// Conectar el motor de karaoke con los nodos del reproductor.
const karaokeStage = document.getElementById("karaokeStage");
const karaokeText  = document.getElementById("karaokeText");
initKaraoke(audioPlayer, karaokeStage, karaokeText);

// Mejorar los <select> del sistema para que coincidan con el diseño.
[
  document.getElementById("lyricsSongSelect"),
  document.getElementById("studioSongSelect"),
  document.getElementById("studioLanguage"),
  document.getElementById("studioModel"),
].forEach(enhanceSelect);

// Cargar biblioteca de canciones y renderizar la playlist.
cargarListaCanciones();

// Activar la vista indicada por el hash (ej. /#view-spotify tras OAuth).
activateFromHash();

// --- Download form -------------------------------------------------
// No justifica un módulo propio por su bajo volumen.

const downloadForm   = document.getElementById("downloadForm");
const downloadStatus = document.getElementById("downloadStatus");
const downloadSubmit = document.getElementById("downloadSubmit");

downloadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url    = document.getElementById("downloadUrl").value.trim();
  const nombre = document.getElementById("downloadName").value.trim();
  if (!url) return;
  downloadSubmit.disabled = true;
  setStatus(downloadStatus, "Descargando... esto puede tardar un momento.");
  try {
    const { job_id } = await apiPost("/api/descargar", {
      url,
      nombre: nombre || null,
    });
    pollJob(job_id, {
      onTick: (job) => renderProgress("download", job),
      onDone: (data) => {
        hideProgress("download");
        setStatus(downloadStatus, `Descargado con éxito: ${data.archivo}`, "ok");
        downloadForm.reset();
        downloadSubmit.disabled = false;
        cargarListaCanciones();
      },
      onError: (error) => {
        hideProgress("download");
        setStatus(downloadStatus, `Error: ${error}`, "error");
        downloadSubmit.disabled = false;
      },
    });
  } catch (err) {
    setStatus(downloadStatus, `Error: ${err.message}`, "error");
    downloadSubmit.disabled = false;
  }
});
