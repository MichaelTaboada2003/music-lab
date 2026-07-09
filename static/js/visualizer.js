// ============================================================
// visualizer.js — aurora ambiental reactiva al audio (Web Audio API)
// ============================================================

import { audioPlayer, playBtn } from "./player.js";

const bgCanvas = document.getElementById("bgCanvas");
const ctx = bgCanvas.getContext("2d");

let audioCtx, analyser, source, dataArray, bufferLength;
let visualizerRAF = null;

const _viz = { bass: 0, mid: 0, high: 0, flash: 0 };

function resizeCanvas() {
  bgCanvas.width = window.innerWidth;
  bgCanvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function initAudioVisualizer() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    return;
  }
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  bufferLength = analyser.frequencyBinCount;
  dataArray = new Uint8Array(bufferLength);
  source = audioCtx.createMediaElementSource(audioPlayer);
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  drawVisualizer();
}

function _bandAvg(data, from, to) {
  let sum = 0;
  const end = Math.min(to, data.length);
  for (let i = from; i < end; i++) sum += data[i];
  return sum / Math.max(1, end - from) / 255;
}

function drawVisualizer() {
  visualizerRAF = requestAnimationFrame(drawVisualizer);
  analyser.getByteFrequencyData(dataArray);

  const w = bgCanvas.width;
  const h = bgCanvas.height;

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(10, 10, 12, 0.16)";
  ctx.fillRect(0, 0, w, h);

  const bass = _bandAvg(dataArray, 0, 10);
  const mid = _bandAvg(dataArray, 10, 45);
  const high = _bandAvg(dataArray, 45, bufferLength);

  _viz.bass = Math.max(bass, _viz.bass * 0.86);
  _viz.mid = Math.max(mid, _viz.mid * 0.88);
  _viz.high = Math.max(high, _viz.high * 0.90);

  if (bass > 0.55 && bass > _viz.bass * 0.95) {
    _viz.flash = Math.min(1, _viz.flash + bass * 0.6);
  }
  _viz.flash *= 0.92;

  const energy = (_viz.bass + _viz.mid + _viz.high) / 3;
  const t = performance.now() / 1000;
  const speed = 0.6 + energy * 1.4;
  const short = Math.min(w, h);

  const orbs = [
    { x: w * 0.30 + Math.sin(t * 0.45 * speed) * (w * 0.10),
      y: h * 0.38 + Math.cos(t * 0.38 * speed) * (h * 0.12),
      r: short * (0.24 + _viz.bass * 0.55),
      c: [30, 215, 120], a: 0.18 + _viz.bass * 0.14 },
    { x: w * 0.70 + Math.cos(t * 0.40 * speed) * (w * 0.11),
      y: h * 0.55 + Math.sin(t * 0.32 * speed) * (h * 0.10),
      r: short * (0.22 + _viz.mid * 0.48),
      c: [40, 130, 220], a: 0.16 + _viz.mid * 0.14 },
    { x: w * 0.50 + Math.sin(t * 0.35 * speed) * (w * 0.08),
      y: h * 0.82 + Math.cos(t * 0.48 * speed) * (h * 0.08),
      r: short * (0.20 + _viz.high * 0.42),
      c: [160, 70, 230], a: 0.14 + _viz.high * 0.14 },
  ];

  ctx.globalCompositeOperation = "lighter";
  orbs.forEach((o) => {
    const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
    g.addColorStop(0.0, `rgba(${o.c[0]}, ${o.c[1]}, ${o.c[2]}, ${o.a})`);
    g.addColorStop(0.45, `rgba(${o.c[0]}, ${o.c[1]}, ${o.c[2]}, ${o.a * 0.35})`);
    g.addColorStop(1.0, `rgba(${o.c[0]}, ${o.c[1]}, ${o.c[2]}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
    ctx.fill();
  });

  if (_viz.flash > 0.02) {
    const fr = short * (0.45 + _viz.flash * 0.35);
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, fr);
    g.addColorStop(0, `rgba(255, 255, 255, ${_viz.flash * 0.08})`);
    g.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, fr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

// Inicializar en el primer clic en la página (política del navegador: AudioContext
// requiere gesto del usuario antes de poder crear nodos de audio).
document.body.addEventListener("click", initAudioVisualizer, { once: true });
audioPlayer.addEventListener("play", () => {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
});
