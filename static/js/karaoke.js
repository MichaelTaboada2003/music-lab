// ============================================================
// karaoke.js — motor de karaoke: wipe por palabra, auto-scroll,
//              RAF loop. Los DOM nodes (karaokeStage/Text) se
//              pasan como parámetros o se leen por ID para evitar
//              acoplamiento circular con player.js.
// ============================================================

// Estado del motor de karaoke — interno al módulo. Solo accesible via getters.
let _karaokeData = null;
let _karaokeActiveLine = null;
// Líneas y palabras con sus tiempos ya convertidos a número: el bucle de 60 fps
// no vuelve a consultar el DOM ni a parsear data-attributes.
let _lines = [];
export let karaokeRAF = null;

export function getKaraokeData() { return _karaokeData; }
export function resetKaraoke() {
  _karaokeData = null;
  _karaokeActiveLine = null;
  _lines = [];
  stopKaraokeLoop();
}

// Fijamos referencias al audio del reproductor y a los nodos del DOM.
// init() debe llamarse desde main.js después de que el DOM esté listo.
let _audioPlayer = null;
let _karaokeText = null;
let _karaokeStage = null;

export function init(audioPlayer, karaokeStage, karaokeText) {
  _audioPlayer = audioPlayer;
  _karaokeStage = karaokeStage;
  _karaokeText = karaokeText;

  _audioPlayer.addEventListener("play",    () => { if (!karaokeRAF) _karaokeLoop(); });
  _audioPlayer.addEventListener("pause",   stopKaraokeLoop);
  _audioPlayer.addEventListener("ended",   stopKaraokeLoop);
  _audioPlayer.addEventListener("seeked",  updateKaraoke);
  _audioPlayer.addEventListener("timeupdate", () => { if (!karaokeRAF) updateKaraoke(); });

  // Pulsar una línea sincronizada salta a ese verso.
  _karaokeText.addEventListener("click", (event) => {
    const el = event.target.closest?.(".k-line");
    const line = el && _lines.find((item) => item.el === el);
    if (!line || !Number.isFinite(_audioPlayer.duration)) return;
    _audioPlayer.currentTime = Math.max(0, line.start - 0.05);
    if (_audioPlayer.paused) _audioPlayer.play().catch(() => {});
  });

  // El centrado depende del alto del panel: al redimensionar se recalcula.
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      _karaokeActiveLine = null;
      updateKaraoke();
    }).observe(_karaokeText);
  }
}

export function showKaraoke(stem, data) {
  _karaokeData = data;
  _karaokeActiveLine = null;
  _lines = [];
  _karaokeStage.hidden = false;
  _karaokeText.classList.remove("plain");

  _karaokeText.innerHTML = "";
  const scroll = document.createElement("div");
  scroll.className = "k-scroll";

  (data.stanzas || []).forEach((stanza) => {
    const stanzaDiv = document.createElement("div");
    stanzaDiv.className = "k-stanza";
    stanza.forEach((line) => {
      const lineDiv = document.createElement("div");
      lineDiv.className = "k-line future";
      const entry = {
        el: lineDiv, start: Number(line.start) || 0, end: Number(line.end) || 0,
        state: "future", words: [],
      };

      const words =
        line.words && line.words.length
          ? line.words
          : [{ text: line.text, start: line.start, end: line.end, synced: true }];
      words.forEach((w) => {
        const span = document.createElement("span");
        span.className = "k-word" + (w.synced === false ? " approx" : "");
        span.textContent = w.text + " ";
        lineDiv.appendChild(span);
        entry.words.push({ el: span, start: Number(w.start) || 0, end: Number(w.end) || 0, p: 0 });
      });
      stanzaDiv.appendChild(lineDiv);
      _lines.push(entry);
    });
    scroll.appendChild(stanzaDiv);
  });

  _karaokeText.appendChild(scroll);
  scroll.style.transform = "translateY(0px)";
  updateKaraoke();
}

/** Muestra la letra sin sincronizar (respaldo cuando aún no hay karaoke). */
export function showPlainLyrics(texto) {
  _karaokeData = null;
  _karaokeActiveLine = null;
  _lines = [];
  _karaokeStage.hidden = false;
  document.getElementById("npLyricsEmpty").style.display = "none";
  _karaokeText.classList.add("plain");
  _karaokeText.innerHTML = "";
  const scroll = document.createElement("div");
  scroll.className = "k-scroll k-plain";
  texto.split("\n").forEach((line) => {
    const div = document.createElement("div");
    div.className = "k-line-plain";
    div.textContent = line.trim() || " ";
    scroll.appendChild(div);
  });
  _karaokeText.appendChild(scroll);
}

function _setWordFill(word, percent) {
  // Redondear a 0,5 % evita reescribir el estilo cuando el cambio no se ve.
  const p = Math.round(percent * 2) / 2;
  if (word.p === p) return;
  word.p = p;
  word.el.style.setProperty("--p", p + "%");
}

function _setLineFill(line, percent) {
  for (const word of line.words) _setWordFill(word, percent);
}

function _setActiveFill(line, t) {
  for (const word of line.words) {
    let p;
    if (t >= word.end) p = 100;
    else if (t <= word.start) p = 0;
    else p = ((t - word.start) / (word.end - word.start)) * 100;
    _setWordFill(word, p);
  }
}

export function updateKaraoke() {
  if (!_karaokeData || !_lines.length) return;
  const t = _audioPlayer.currentTime;

  // Última línea que ya empezó (las líneas van en orden temporal).
  let activeIndex = 0;
  for (let low = 0, high = _lines.length - 1; low <= high;) {
    const mid = (low + high) >> 1;
    if (_lines[mid].start <= t) { activeIndex = mid; low = mid + 1; } else high = mid - 1;
  }
  const active = _lines[activeIndex];

  for (let i = 0; i < _lines.length; i++) {
    const line = _lines[i];
    const state = i === activeIndex ? "active" : line.end < t ? "past" : "future";
    if (line.state !== state || !line.el.dataset.state) {
      line.el.classList.remove("past", "active", "future");
      line.el.classList.add(state);
      line.el.dataset.state = state;
      line.state = state;
      if (state === "past") _setLineFill(line, 100);
      if (state === "future") _setLineFill(line, 0);
    }
  }
  _setActiveFill(active, t);

  if (active.el !== _karaokeActiveLine) {
    const scroll = _karaokeText.querySelector(".k-scroll");
    if (!scroll) return;
    _karaokeActiveLine = active.el;
    const offset =
      _karaokeText.clientHeight / 2 -
      (active.el.offsetTop + active.el.offsetHeight / 2);
    scroll.style.transform = `translateY(${offset}px)`;
  }
}

function _karaokeLoop() {
  updateKaraoke();
  karaokeRAF = requestAnimationFrame(_karaokeLoop);
}

export function stopKaraokeLoop() {
  if (karaokeRAF) {
    cancelAnimationFrame(karaokeRAF);
    karaokeRAF = null;
  }
}
