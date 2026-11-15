// ============================================================
// lyrics.js — vista "Letras": ver y editar la letra de una canción
//   o de un recorte guardado desde la vista "Recortar".
// ============================================================

import { apiGet, apiPost, setStatus, refreshSongSelect } from "./api.js";
import { cargarListaCanciones } from "./player.js";

export const lyricsSongSelect = document.getElementById("lyricsSongSelect");
const lyricsTextarea = document.getElementById("lyricsTextarea");
const lyricsSaveBtn = document.getElementById("lyricsSaveBtn");
const lyricsFindBtn = document.getElementById("lyricsFindBtn");
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
    lyricsFindBtn.disabled = true;
    setStatus(
      lyricsStatus,
      selectedKind() === "clip"
        ? "Todavía no tienes recortes. Crea uno en la sección «Recortar»."
        : "No hay canciones en tu biblioteca."
    );
    return;
  }
  lyricsSaveBtn.disabled = false;
  lyricsFindBtn.disabled = false;
  try {
    const data = await apiGet(`/api/letra/${encodeURIComponent(stem)}`);
    // Si se cambió de canción mientras llegaba, esta respuesta ya no aplica.
    if (lyricsSongSelect.value !== stem) return;
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

/** Abre la vista con una canción o recorte ya elegido (desde «Recortar»). */
export async function openLyricsFor(stem, kind = "song") {
  const input = [...kindInputs].find((item) => item.value === kind);
  if (input) input.checked = true;
  await refreshLyricsSongs();
  if (![...lyricsSongSelect.options].some((option) => option.value === stem)) return;
  lyricsSongSelect.value = stem;
  lyricsSongSelect.dispatchEvent(new Event("change", { bubbles: true }));
}

async function _saveLyrics(stem, message = "Letra guardada.") {
  lyricsSaveBtn.disabled = true;
  try {
    await apiPost(`/api/letra/${encodeURIComponent(stem)}`, {
      texto: lyricsTextarea.value,
    });
    setStatus(lyricsStatus, message, "ok");
    cargarListaCanciones();
    // Refrescar el select del estudio para que aparezca la marca · letra
    const { studioSongSelect } = await import("./studio.js");
    refreshSongSelect(studioSongSelect);
  } catch (e) {
    setStatus(lyricsStatus, `Error: ${e.message}`, "error");
  } finally {
    lyricsSaveBtn.disabled = false;
  }
}

lyricsSaveBtn.addEventListener("click", () => {
  const stem = lyricsSongSelect.value;
  if (stem) _saveLyrics(stem);
});

lyricsFindBtn.addEventListener("click", async () => {
  const stem = lyricsSongSelect.value;
  if (!stem) return;
  const teniaTexto = Boolean(lyricsTextarea.value.trim());
  lyricsFindBtn.disabled = true;
  setStatus(lyricsStatus, "Buscando la letra en el catálogo…");
  try {
    const found = await apiPost(`/api/letra/${encodeURIComponent(stem)}/buscar`);
    if (lyricsSongSelect.value !== stem) return;
    if (!found.encontrada) {
      setStatus(lyricsStatus, "El catálogo no tiene esta letra. Revisa el título y el artista en la ficha de la canción, o escríbela a mano.", "error");
      return;
    }
    const origen = [found.titulo, found.artista].filter(Boolean).join(" — ");
    lyricsTextarea.value = found.texto;
    if (teniaTexto) {
      // Había una letra escrita: no se pisa en disco sin que la revises.
      setStatus(lyricsStatus, `Letra encontrada (${origen}). Sustituye a la que había: revísala y pulsa «Guardar letra».`);
    } else {
      await _saveLyrics(stem, `Letra encontrada y guardada (${origen}).`);
    }
  } catch (e) {
    setStatus(lyricsStatus, `Error: ${e.message}`, "error");
  } finally {
    lyricsFindBtn.disabled = !lyricsSongSelect.value;
  }
});
