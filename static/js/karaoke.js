// ============================================================
// karaoke.js — motor de karaoke: wipe por palabra, auto-scroll,
//              RAF loop. Los DOM nodes (karaokeStage/Text) se
//              pasan como parámetros o se leen por ID para evitar
//              acoplamiento circular con player.js.
// ============================================================

// Estado del motor de karaoke — interno al módulo. Solo accesible via getters.
let _karaokeData = null;
let _karaokeActiveLine = null;
export let karaokeRAF = null;

export function getKaraokeData() { return _karaokeData; }
export function resetKaraoke() {
  _karaokeData = null;
  _karaokeActiveLine = null;
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
}

export function showKaraoke(stem, data) {
  _karaokeData = data;
  _karaokeActiveLine = null;
  _karaokeStage.hidden = false;
  _karaokeText.classList.remove("plain");

  _karaokeText.innerHTML = "";
  const scroll = document.createElement("div");
  scroll.className = "k-scroll";

  data.stanzas.forEach((stanza) => {
    const stanzaDiv = document.createElement("div");
    stanzaDiv.className = "k-stanza";
    stanza.forEach((line) => {
      const lineDiv = document.createElement("div");
      lineDiv.className = "k-line future";
      lineDiv.dataset.start = line.start;
      lineDiv.dataset.end = line.end;

      const words =
        line.words && line.words.length
          ? line.words
          : [{ text: line.text, start: line.start, end: line.end, synced: true }];
      words.forEach((w) => {
        const span = document.createElement("span");
        span.className = "k-word" + (w.synced === false ? " approx" : "");
        span.textContent = w.text + " ";
        span.dataset.start = w.start;
        span.dataset.end = w.end;
        lineDiv.appendChild(span);
      });
      stanzaDiv.appendChild(lineDiv);
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
  _karaokeStage.hidden = false;
  document.getElementById("npLyricsEmpty").style.display = "none";
  _karaokeText.classList.add("plain");
  _karaokeText.innerHTML = "";
  const scroll = document.createElement("div");
  scroll.className = "k-scroll k-plain";
  texto.split("\n").forEach((line) => {
    const div = document.createElement("div");
    div.className = "k-line-plain";
    div.textContent = line.trim() || "\u00A0";
    scroll.appendChild(div);
  });
  _karaokeText.appendChild(scroll);
}

function _setLineFill(line, percent) {
  line
    .querySelectorAll(".k-word")
    .forEach((s) => s.style.setProperty("--p", percent + "%"));
}

function _setActiveFill(line, t) {
  line.querySelectorAll(".k-word").forEach((span) => {
    const start = parseFloat(span.dataset.start);
    const end = parseFloat(span.dataset.end);
    let p;
    if (t >= end) p = 100;
    else if (t <= start) p = 0;
    else p = ((t - start) / (end - start)) * 100;
    span.style.setProperty("--p", p.toFixed(1) + "%");
  });
}

export function updateKaraoke() {
  if (!_karaokeData) return;
  const scroll = _karaokeText.querySelector(".k-scroll");
  if (!scroll) return;
  const t = _audioPlayer.currentTime;
  const lines = _karaokeText.querySelectorAll(".k-line");

  let active = null;
  lines.forEach((line) => {
    if (parseFloat(line.dataset.start) <= t) active = line;
  });
  if (!active && lines.length) active = lines[0];

  lines.forEach((line) => {
    const end = parseFloat(line.dataset.end);
    let state;
    if (line === active) state = "active";
    else if (end < t) state = "past";
    else state = "future";

    if (line.dataset.state !== state) {
      line.classList.remove("past", "active", "future");
      line.classList.add(state);
      line.dataset.state = state;
      if (state === "past") _setLineFill(line, 100);
      if (state === "future") _setLineFill(line, 0);
    }
    if (state === "active") _setActiveFill(line, t);
  });

  if (active && active !== _karaokeActiveLine) {
    _karaokeActiveLine = active;
    const offset =
      _karaokeText.clientHeight / 2 -
      (active.offsetTop + active.offsetHeight / 2);
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
