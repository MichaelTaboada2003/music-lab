// ============================================================
// lyrics.js — vista "Letras": ver y editar la letra de una canción
//   o de un recorte guardado desde la vista "Recortar".
// ============================================================

import { apiGet, apiPost, setStatus, refreshSongSelect } from "./api.js";

export const lyricsSongSelect = document.getElementById("lyricsSongSelect");
const lyricsTextarea = document.getElementById("lyricsTextarea");
const lyricsSaveBtn = document.getElementById("lyricsSaveBtn");
const lyricsStatus = document.getElementById("lyricsStatus");
const kindInputs = document.querySelectorAll('input[name="lyricsSongKind"]');
const lyricsSongLabel = document.getElementById("lyricsSongLabel");

/** "song" (canciones completas) o "clip" (recortes). */
function selectedKind() {
  return document.querySelector('input[name="lyricsSongKind"]:checked')?.value || "song";
}

/** Rellena el selector con la mitad de la biblioteca que toca. El backend
 *  marca cada canción con kind: "song" | "clip" (ver library_metadata). */
export function refreshLyricsSongs() {
  const kind = selectedKind();
  lyricsSongLabel.textContent = kind === "clip" ? "Recorte" : "Canción";
  return refreshSongSelect(
    lyricsSongSelect,
    onLyricsSongChange,
    (cancion) => (cancion.kind || "song") === kind
  );
}

export async function onLyricsSongChange() {
  const stem = lyricsSongSelect.value;
  if (!stem) {
    lyricsTextarea.value = "";
    lyricsSaveBtn.disabled = true;
    setStatus(
      lyricsStatus,
      selectedKind() === "clip"
        ? "Todavía no tienes recortes. Crea uno en la sección «Recortar»."
        : "No hay canciones en tu biblioteca."
    );
    return;
  }
  lyricsSaveBtn.disabled = false;
  try {
    const data = await apiGet(`/api/letra/${encodeURIComponent(stem)}`);
    lyricsTextarea.value = data.texto || "";
    setStatus(
      lyricsStatus,
      data.existe
        ? "Letra cargada."
        : "Esta canción todavía no tiene letra guardada."
    );
  } catch (e) {
    setStatus(lyricsStatus, `Error: ${e.message}`, "error");
  }
}

kindInputs.forEach((input) => input.addEventListener("change", refreshLyricsSongs));
lyricsSongSelect.addEventListener("change", onLyricsSongChange);

lyricsSaveBtn.addEventListener("click", async () => {
  const stem = lyricsSongSelect.value;
  if (!stem) return;
  lyricsSaveBtn.disabled = true;
  try {
    await apiPost(`/api/letra/${encodeURIComponent(stem)}`, {
      texto: lyricsTextarea.value,
    });
    setStatus(lyricsStatus, "Letra guardada.", "ok");
    // Refrescar el select del estudio para que aparezca la marca · letra
    const { studioSongSelect } = await import("./studio.js");
    refreshSongSelect(studioSongSelect);
  } catch (e) {
    setStatus(lyricsStatus, `Error: ${e.message}`, "error");
  } finally {
    lyricsSaveBtn.disabled = false;
  }
});
