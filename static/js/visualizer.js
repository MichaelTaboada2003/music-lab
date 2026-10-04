// ============================================================
// visualizer.js — fondo ambiental reactivo al audio
//
// Manchas de luz con la paleta de la portada que derivan despacio y "respiran"
// con el espectro. Todo el movimiento nace de osciladores continuos y de
// filtros suaves (ataque/liberación lentos): no hay umbrales ni golpes, así que
// nunca da saltos. El canvas se dibuja a baja resolución y el navegador lo
// escala con suavizado: degradados limpios, CPU casi nula y 0% en pausa.
// ============================================================

import { audioPlayer } from "./player.js";

const DEFAULT_SONG_KEY = "Music Lab Ambient";
const ROOT = document.documentElement;
const bgCanvas = document.getElementById("bgCanvas");
const ctx = bgCanvas?.getContext("2d", { alpha: true, desynchronized: true }) || null;
const ambientOverlay = document.querySelector(".bg-overlay");
const ambientArtwork = document.querySelector(".bg-artwork");
const artworkLayers = [...document.querySelectorAll(".bg-artwork-layer")];
const nowPlaying = document.querySelector(".now-playing");

// Detección de hardware y accesibilidad
const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const deviceMemory = Number(navigator.deviceMemory) || 8;
const cpuCores = Number(navigator.hardwareConcurrency) || 8;
const LOW_POWER_MODE = reduceMotionQuery.matches || deviceMemory <= 4 || cpuCores <= 4;

const FRAME_INTERVAL = 1000 / (reduceMotionQuery.matches ? 24 : LOW_POWER_MODE ? 30 : 60);
const CSS_UPDATE_INTERVAL = LOW_POWER_MODE ? 60 : 33;
// El canvas interno mide el viewport dividido entre este factor y se escala.
const RESOLUTION_DIVISOR = LOW_POWER_MODE ? 6 : 4;
// Tras pausar, el CSS desvanece el canvas; se limpia cuando termina el fundido.
const FADE_OUT_MS = 800;

// Estado del Web Audio API
let audioCtx = null;
let analyser = null;
let source = null;
let gainNode = null;
let pendingGain = 1;
let frequencyData = null;
let timeData = null;
let previousSpectrum = null;
const spectrumBands = new Float32Array(16);
const targetBands = new Float32Array(16);

// Estado de animación
let frameRequest = null;
let lastRenderAt = 0;
let lastCssUpdateAt = 0;
let resizeRequest = null;
let fadeOutTimer = null;
let activeArtworkIndex = 0;
let currentArtworkUrl = "";
let isAudioActive = false;

// Estado del puntero para un paralaje sutil
const pointer = {
  x: 0.5,
  y: 0.5,
  targetX: 0.5,
  targetY: 0.5,
};

// Ondas suaves que se expanden en los golpes fuertes (anillos de luz difusos).
const MAX_RINGS = 4;
const rings = [];
let ringCooldown = 0;
let previousKick = 0;

function _spawnRing(x, y, power, color) {
  if (rings.length >= MAX_RINGS) rings.shift();
  rings.push({ x, y, radius: 0.04, alpha: 0.18 + power * 0.18, color });
}

// ------------------------------------------------------------
// MANCHAS DE LUZ
// Cada una orbita sobre su propia trayectoria (osciladores lentos y
// desfasados) y reacciona a una banda del espectro con un filtro suave.
// ------------------------------------------------------------
const BLOB_SPECS = [
  // Atmósfera: grandes, tenues y casi inmóviles; dan cuerpo y color al fondo.
  { color: 0, x: 0.12, y: 0.16, ax: 0.10, ay: 0.08, fx: 0.07, fy: 0.05, size: 0.95, stretch: 0.78, alpha: 0.34, band: 1, bass: 0.9 },
  { color: 1, x: 0.90, y: 0.86, ax: 0.09, ay: 0.09, fx: 0.06, fy: 0.08, size: 1.00, stretch: 0.72, alpha: 0.32, band: 3, bass: 0.7 },
  // Cuerpo: tamaño medio, recorren la pantalla y marcan el ritmo.
  { color: 2, x: 0.62, y: 0.30, ax: 0.20, ay: 0.16, fx: 0.13, fy: 0.10, size: 0.62, stretch: 0.55, alpha: 0.42, band: 5, bass: 1.0 },
  { color: 0, x: 0.30, y: 0.72, ax: 0.22, ay: 0.14, fx: 0.11, fy: 0.15, size: 0.58, stretch: 0.50, alpha: 0.40, band: 2, bass: 1.1 },
  { color: 1, x: 0.50, y: 0.50, ax: 0.26, ay: 0.20, fx: 0.09, fy: 0.12, size: 0.50, stretch: 0.62, alpha: 0.36, band: 7, bass: 0.6 },
  // Destellos: pequeños y vivos; siguen los agudos.
  { color: 3, x: 0.72, y: 0.62, ax: 0.18, ay: 0.20, fx: 0.19, fy: 0.16, size: 0.30, stretch: 0.85, alpha: 0.38, band: 11, bass: 0.2 },
  { color: 3, x: 0.20, y: 0.40, ax: 0.16, ay: 0.18, fx: 0.17, fy: 0.21, size: 0.26, stretch: 0.80, alpha: 0.34, band: 13, bass: 0.2 },
];
const BLOB_COUNT = LOW_POWER_MODE ? 5 : BLOB_SPECS.length;
const blobs = BLOB_SPECS.slice(0, BLOB_COUNT).map((spec, index) => ({
  ...spec,
  level: 0,
  px: index * 1.618 + 0.4,
  py: index * 2.414 + 1.1,
  rotation: index * 0.9,
  spin: (index % 2 === 0 ? 1 : -1) * (0.035 + index * 0.012),
}));

// ------------------------------------------------------------
// PALETA Y ESTADO VISUAL
// ------------------------------------------------------------
const initialPalette = _buildFallbackPalette(DEFAULT_SONG_KEY);
const visual = {
  bass: 0,
  lowMid: 0,
  highMid: 0,
  air: 0,
  rms: 0,
  centroid: 0.5,
  flux: 0,
  energy: 0,
  beatFloor: 0.05,
  pulse: 0,
  kick: 0,
  seed: _hashString(DEFAULT_SONG_KEY),
  palette: _clonePalette(initialPalette),
  targetPalette: _clonePalette(initialPalette),
  fluidTime: 0,
};

// ------------------------------------------------------------
// UTILIDADES MATEMÁTICAS Y DE COLOR
// ------------------------------------------------------------
function _clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function _hashString(input) {
  let hash = 0;
  for (let index = 0; index < input.length; index++) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function _smooth(current, target, attack, release, dt) {
  const rate = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function _rgbToHsl(r, g, b) {
  const normR = r / 255;
  const normG = g / 255;
  const normB = b / 255;
  const max = Math.max(normR, normG, normB);
  const min = Math.min(normR, normG, normB);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case normR: h = ((normG - normB) / d + (normG < normB ? 6 : 0)) / 6; break;
      case normG: h = ((normB - normR) / d + 2) / 6; break;
      case normB: h = ((normR - normG) / d + 4) / 6; break;
    }
    h *= 360;
  }
  return [h, s * 100, l * 100];
}

function _hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = _clamp(s, 0, 100) / 100;
  const light = _clamp(l, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = light - chroma / 2;
  let rgb = [0, 0, 0];

  if (hue < 60) rgb = [chroma, x, 0];
  else if (hue < 120) rgb = [x, chroma, 0];
  else if (hue < 180) rgb = [0, chroma, x];
  else if (hue < 240) rgb = [0, x, chroma];
  else if (hue < 300) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];

  return rgb.map((channel) => Math.round((channel + offset) * 255));
}

function _enhanceColorVibrancy(rgb, minSat = 72, targetLight = 54) {
  const [h, s, l] = _rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const newSat = Math.max(s * 1.15, minSat);
  const newLight = _clamp(Math.max(l, targetLight), 36, 68);
  return _hslToRgb(h, newSat, newLight);
}

function _mixColor(from, to, amount) {
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount));
}

function _rgba(color, alpha) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

function _clonePalette(palette) {
  return Object.fromEntries(Object.entries(palette).map(([key, color]) => [key, [...color]]));
}

function _buildFallbackPalette(songKey) {
  const seed = _hashString(songKey);
  const hue = seed % 360;
  const shiftA = 40 + (seed % 35);
  const shiftB = 110 + (seed % 50);

  return {
    primary: _hslToRgb(hue, 92, 58),
    secondary: _hslToRgb(hue + shiftA, 88, 60),
    tertiary: _hslToRgb(hue + shiftB, 84, 56),
    accent: _hslToRgb(hue + 180, 94, 68),
    shadow: _hslToRgb(hue + 20, 50, 7),
  };
}

function _paletteFromArtwork(colors) {
  const [c0, c1, c2] = colors;
  const primary = _enhanceColorVibrancy(c0, 78, 56);
  const secondary = _enhanceColorVibrancy(c1 || c0, 75, 58);
  const tertiary = _enhanceColorVibrancy(c2 || c1 || c0, 70, 52);
  const [h] = _rgbToHsl(primary[0], primary[1], primary[2]);
  const accent = _hslToRgb(h + 160, 90, 66);
  const shadow = _mixColor(primary, [4, 6, 10], 0.92);

  return { primary, secondary, tertiary, accent, shadow };
}

function _songKeyFromDetail(detail) {
  return [detail?.title || DEFAULT_SONG_KEY, detail?.artist, detail?.filename]
    .filter(Boolean)
    .join("::");
}

function _applyPaletteVariables(palette) {
  ROOT.style.setProperty("--ambient-primary", palette.primary.join(", "));
  ROOT.style.setProperty("--ambient-secondary", palette.secondary.join(", "));
  ROOT.style.setProperty("--ambient-tertiary", palette.tertiary.join(", "));
  ROOT.style.setProperty("--ambient-accent", palette.accent.join(", "));
  ROOT.style.setProperty("--ambient-shadow", palette.shadow.join(", "));
}

function _setSong(detail) {
  const songKey = _songKeyFromDetail(detail);
  const palette = _buildFallbackPalette(songKey);
  visual.targetPalette = palette;
  visual.seed = _hashString(songKey);

  _applyPaletteVariables(palette);
  if (detail?.coverUrl) _setArtwork(detail.coverUrl);
}

function _setArtworkPalette(detail) {
  if (!Array.isArray(detail?.colors) || detail.colors.length < 3) return;
  const palette = _paletteFromArtwork(detail.colors);
  visual.targetPalette = palette;
  _applyPaletteVariables(palette);
}

function _setArtwork(url) {
  if (!artworkLayers.length || !url || url === currentArtworkUrl) return;
  currentArtworkUrl = url;
  const nextIndex = artworkLayers.length > 1 ? (activeArtworkIndex + 1) % artworkLayers.length : 0;
  const nextLayer = artworkLayers[nextIndex];
  const expectedUrl = url;

  nextLayer.onload = () => {
    if (currentArtworkUrl !== expectedUrl) return;
    artworkLayers.forEach((layer, index) => layer.classList.toggle("is-active", index === nextIndex));
    ambientArtwork?.classList.add("has-artwork");
    activeArtworkIndex = nextIndex;
  };
  nextLayer.onerror = () => {
    if (currentArtworkUrl === expectedUrl) ambientArtwork?.classList.remove("has-artwork");
  };
  nextLayer.src = url;
}

function _lerpPalette(dt) {
  const amount = 1 - Math.exp(-1.6 * dt);
  for (const key of Object.keys(visual.palette)) {
    visual.palette[key] = _mixColor(visual.palette[key], visual.targetPalette[key], amount);
  }
}

function _getColorByIndex(index) {
  switch (index % 4) {
    case 0: return visual.palette.primary;
    case 1: return visual.palette.secondary;
    case 2: return visual.palette.tertiary;
    case 3: default: return visual.palette.accent;
  }
}

// ------------------------------------------------------------
// CONFIGURACIÓN DE CANVAS Y RESIZE
// ------------------------------------------------------------
function resizeCanvas() {
  if (!ctx || !bgCanvas) return;
  // Resolución baja a propósito: el escalado suaviza los degradados.
  bgCanvas.width = Math.max(2, Math.ceil(window.innerWidth / RESOLUTION_DIVISOR));
  bgCanvas.height = Math.max(2, Math.ceil(window.innerHeight / RESOLUTION_DIVISOR));
  bgCanvas.style.width = "100%";
  bgCanvas.style.height = "100%";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function scheduleCanvasResize() {
  if (resizeRequest) return;
  resizeRequest = requestAnimationFrame(() => {
    resizeRequest = null;
    resizeCanvas();
    if (!isAudioActive) _clearCanvas();
  });
}

function _clearCanvas() {
  if (!ctx || !bgCanvas) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  ctx.restore();
}

// ------------------------------------------------------------
// CONTROL DE WEB AUDIO API
// ------------------------------------------------------------
function initAudioVisualizer() {
  if (!ctx) return;
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    return;
  }

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.76;
    frequencyData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.frequencyBinCount);
    previousSpectrum = new Float32Array(analyser.frequencyBinCount);

    source = audioCtx.createMediaElementSource(audioPlayer);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = pendingGain;
    source.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch {
    // Si la captura falla por políticas de navegador, continúa en modo fluido autónomo
  }
}

function setTrackGain(gainDb) {
  pendingGain = _clamp(Math.pow(10, (Number(gainDb) || 0) / 20), 0.25, 4);
  if (!gainNode || !audioCtx) return;
  gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  gainNode.gain.setTargetAtTime(pendingGain, audioCtx.currentTime, 0.12);
}

function _startVisualizer() {
  if (!ctx) return;
  clearTimeout(fadeOutTimer);
  isAudioActive = true;
  document.body.classList.add("ambient-playing");
  lastRenderAt = 0;
  if (!frameRequest) drawVisualizer();
}

function _stopVisualizer() {
  isAudioActive = false;
  document.body.classList.remove("ambient-playing");
  if (frameRequest) cancelAnimationFrame(frameRequest);
  frameRequest = null;

  // El último cuadro se queda mientras el CSS desvanece el canvas; después se
  // limpia para no gastar memoria ni dejar restos al volver a reproducir.
  clearTimeout(fadeOutTimer);
  fadeOutTimer = setTimeout(() => {
    if (isAudioActive) return;
    visual.bass = visual.lowMid = visual.highMid = visual.air = 0;
    visual.rms = visual.energy = visual.flux = visual.pulse = 0;
    visual.kick = 0;
    rings.length = 0;
    blobs.forEach((blob) => { blob.level = 0; });
    _clearCanvas();
  }, FADE_OUT_MS);
}

// ------------------------------------------------------------
// ANÁLISIS DEL ESPECTRO ACÚSTICO
// ------------------------------------------------------------
function _bandAverage(data, from, to) {
  let sum = 0;
  const end = Math.min(to, data.length);
  for (let index = from; index < end; index++) sum += data[index];
  return sum / Math.max(1, end - from) / 255;
}

function _computeRms(data) {
  let sum = 0;
  for (const sample of data) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / Math.max(1, data.length));
}

function _computeCentroid(data) {
  let weighted = 0;
  let total = 0;
  for (let index = 0; index < data.length; index++) {
    const value = data[index] / 255;
    weighted += value * index;
    total += value;
  }
  return total ? weighted / total / Math.max(1, data.length - 1) : 0.5;
}

function _computeFlux(data) {
  let flux = 0;
  for (let index = 0; index < data.length; index++) {
    const normalized = data[index] / 255;
    flux += Math.max(0, normalized - previousSpectrum[index]);
    previousSpectrum[index] = normalized;
  }
  return _clamp(flux / Math.max(1, data.length * 0.15), 0, 1);
}

function _readAudio(dt) {
  if (!analyser || !isAudioActive) {
    visual.bass = _smooth(visual.bass, 0, 8, 8, dt);
    visual.lowMid = _smooth(visual.lowMid, 0, 8, 8, dt);
    visual.highMid = _smooth(visual.highMid, 0, 8, 8, dt);
    visual.air = _smooth(visual.air, 0, 8, 8, dt);
    visual.rms = _smooth(visual.rms, 0, 8, 8, dt);
    visual.flux = _smooth(visual.flux, 0, 8, 8, dt);
    visual.energy = _smooth(visual.energy, 0, 8, 8, dt);
    return;
  }

  analyser.getByteFrequencyData(frequencyData);
  analyser.getByteTimeDomainData(timeData);

  const bass = _bandAverage(frequencyData, 0, 14);
  const lowMid = _bandAverage(frequencyData, 14, 52);
  const highMid = _bandAverage(frequencyData, 52, 118);
  const air = _bandAverage(frequencyData, 118, frequencyData.length);
  const rms = _computeRms(timeData);
  const centroid = _computeCentroid(frequencyData);
  const flux = _computeFlux(frequencyData);

  const binStep = Math.floor(frequencyData.length / 16);
  for (let i = 0; i < 16; i++) {
    const bandVal = _bandAverage(frequencyData, i * binStep, (i + 1) * binStep);
    targetBands[i] = bandVal;
    spectrumBands[i] = _smooth(spectrumBands[i], targetBands[i], 22, 6.5, dt);
  }

  visual.bass = _smooth(visual.bass, bass, 20, 5.0, dt);
  visual.lowMid = _smooth(visual.lowMid, lowMid, 16, 4.0, dt);
  visual.highMid = _smooth(visual.highMid, highMid, 14, 3.5, dt);
  visual.air = _smooth(visual.air, air, 12, 3.0, dt);
  visual.rms = _smooth(visual.rms, rms, 18, 4.2, dt);
  visual.centroid = _smooth(visual.centroid, centroid, 8, 5, dt);
  visual.flux = _smooth(visual.flux, flux, 22, 10, dt);

  const energy = _clamp(
    (visual.bass * 1.9 + visual.lowMid * 1.3 + visual.highMid * 1.1 + visual.air * 0.8 + visual.rms * 1.5) / 6.0,
    0,
    1
  );
  visual.energy = _smooth(visual.energy, energy, 14, 3.5, dt);
  // "Kick": envolvente rápida de los transitorios (graves por encima de su línea
  // base más el cambio espectral). Ataque casi instantáneo y caída corta: da el
  // pulso de la música sin umbrales ni saltos bruscos.
  const punch = _clamp((bass - visual.beatFloor) * 5 + flux * 1.2, 0, 1.2);
  visual.kick = _smooth(visual.kick, punch, 38, 6.5, dt);
  visual.beatFloor = _smooth(visual.beatFloor, visual.bass, 1.5, 0.9, dt);
}

// ------------------------------------------------------------
// DIBUJO DE LAS MANCHAS DE LUZ
// ------------------------------------------------------------
function _drawBlobs(width, height, dt, motionScale) {
  const short = Math.min(width, height);
  const energy = visual.energy;
  const kick = visual.kick;
  const intensity = _clamp(0.30 + energy * 0.70 + kick * 0.15, 0.30, 1);
  const reach = 1.35 + energy * 0.65;       // las órbitas se abren con la música
  const t = visual.fluidTime * motionScale;

  ctx.globalCompositeOperation = "screen";

  blobs.forEach((blob) => {
    // Nivel por banda: sube rápido y baja con soltura (vibra con el espectro).
    const target = _clamp(spectrumBands[blob.band] * 1.15 + visual.bass * blob.bass * 0.8, 0, 1.3);
    blob.level = _smooth(blob.level, target, 16, 3.8, dt);
    blob.rotation += blob.spin * dt * (0.8 + energy * 1.6 + kick) * motionScale;

    // Temblor fino proporcional al nivel: la mancha "vibra" con su banda.
    const shakeX = Math.sin(t * 38 + blob.px * 5) * blob.level * 0.016 * motionScale;
    const shakeY = Math.cos(t * 33 + blob.py * 5) * blob.level * 0.020 * motionScale;
    const x = (blob.x + blob.ax * reach * Math.sin(t * blob.fx * 6.28 + blob.px) + shakeX
      + (pointer.x - 0.5) * 0.06 * motionScale) * width;
    const y = (blob.y + blob.ay * reach * Math.cos(t * blob.fy * 6.28 + blob.py) + shakeY
      + (pointer.y - 0.5) * 0.05 * motionScale) * height;
    const radius = short * blob.size * (0.86 + blob.level * 0.55 + kick * 0.16 * blob.bass);
    const alpha = _clamp(
      blob.alpha * (0.42 + intensity * 0.72) * (0.78 + blob.level * 0.50 + kick * 0.20), 0.02, 0.80);
    const color = _getColorByIndex(blob.color);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(blob.rotation);
    ctx.scale(1, blob.stretch);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    gradient.addColorStop(0.00, _rgba(color, alpha));
    gradient.addColorStop(0.25, _rgba(color, alpha * 0.72));
    gradient.addColorStop(0.50, _rgba(color, alpha * 0.34));
    gradient.addColorStop(0.75, _rgba(color, alpha * 0.10));
    gradient.addColorStop(1.00, _rgba(color, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  _drawRings(width, height, dt, short);
}

function _drawRings(width, height, dt, short) {
  if (!rings.length) return;
  ctx.globalCompositeOperation = "screen";
  const band = short * 0.10;
  for (let i = rings.length - 1; i >= 0; i--) {
    const ring = rings[i];
    ring.radius += short * 1.05 * dt;
    ring.alpha *= Math.exp(-2.3 * dt);
    if (ring.alpha < 0.012 || ring.radius > Math.max(width, height)) {
      rings.splice(i, 1);
      continue;
    }
    // Anillo difuso: transparente → color → transparente (sin borde duro).
    const gradient = ctx.createRadialGradient(
      ring.x, ring.y, Math.max(0, ring.radius - band), ring.x, ring.y, ring.radius + band);
    gradient.addColorStop(0.00, _rgba(ring.color, 0));
    gradient.addColorStop(0.50, _rgba(ring.color, ring.alpha));
    gradient.addColorStop(1.00, _rgba(ring.color, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.radius + band, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------
// ACTUALIZACIÓN DE VARIABLES CSS & PARALAJE
// ------------------------------------------------------------
function _updateCss(time, motionScale) {
  const energy = visual.energy;
  const driftX = Math.sin(time * 0.20) * (16 + energy * 38 + visual.kick * 14) * motionScale + (pointer.x - 0.5) * 40;
  const driftY = Math.cos(time * 0.16) * (14 + energy * 30 + visual.kick * 10) * motionScale + (pointer.y - 0.5) * 32;
  const intensity = _clamp(0.28 + energy * 0.62 + visual.flux * 0.14 + visual.kick * 0.22, 0.20, 1);
  const beatScale = _clamp(visual.kick * 0.05, 0, 0.08);
  const rotation = Math.sin(time * 0.08) * 3 + (pointer.x - 0.5) * 4;

  const targets = [ambientOverlay, ambientArtwork, nowPlaying].filter(Boolean);
  targets.forEach((target) => {
    target.style.setProperty("--ambient-intensity", intensity.toFixed(3));
    target.style.setProperty("--ambient-beat-scale", beatScale.toFixed(3));
    target.style.setProperty("--ambient-shift-x", `${driftX.toFixed(1)}px`);
    target.style.setProperty("--ambient-shift-y", `${driftY.toFixed(1)}px`);
    target.style.setProperty("--ambient-local-x", `${(driftX * 0.18).toFixed(1)}px`);
    target.style.setProperty("--ambient-local-y", `${(driftY * 0.14).toFixed(1)}px`);
    target.style.setProperty("--ambient-rotate", `${rotation.toFixed(2)}deg`);
    target.style.setProperty("--ambient-pointer-x", pointer.x.toFixed(3));
    target.style.setProperty("--ambient-pointer-y", pointer.y.toFixed(3));
  });
}

// ------------------------------------------------------------
// BUCLE PRINCIPAL DE RENDERIZADO
// ------------------------------------------------------------
function drawVisualizer(frameAt = performance.now()) {
  if (!ctx || document.hidden || !isAudioActive) {
    frameRequest = null;
    return;
  }

  frameRequest = requestAnimationFrame(drawVisualizer);
  const elapsed = frameAt - lastRenderAt;
  if (elapsed < FRAME_INTERVAL - 1) return;
  lastRenderAt = frameAt;

  const dt = Math.min(elapsed / 1000, 0.10);
  const motionScale = reduceMotionQuery.matches ? 0.15 : 1;

  _readAudio(dt);
  _lerpPalette(dt);

  // El tiempo del fluido avanza más rápido con la energía y con cada golpe;
  // ambas señales están suavizadas, así que la aceleración es continua.
  visual.fluidTime += dt * (0.90 + visual.energy * 1.70 + visual.kick * 1.40);
  visual.pulse = visual.kick;

  // Onda suave en los golpes fuertes (flanco de subida + enfriamiento corto).
  ringCooldown = Math.max(0, ringCooldown - dt);
  if (!reduceMotionQuery.matches && ringCooldown === 0 && visual.kick > 0.55 && visual.kick > previousKick) {
    const lead = blobs[2 + Math.floor(Math.random() * Math.max(1, blobs.length - 3))] || blobs[0];
    _spawnRing(lead.x * bgCanvas.width, lead.y * bgCanvas.height, _clamp(visual.kick, 0, 1), visual.palette.accent);
    ringCooldown = 0.20;
  }
  previousKick = visual.kick;

  pointer.x += (pointer.targetX - pointer.x) * (1 - Math.exp(-3 * dt));
  pointer.y += (pointer.targetY - pointer.y) * (1 - Math.exp(-3 * dt));

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  _drawBlobs(bgCanvas.width, bgCanvas.height, dt, motionScale);

  if (frameAt - lastCssUpdateAt >= CSS_UPDATE_INTERVAL) {
    _updateCss(frameAt / 1000, motionScale);
    lastCssUpdateAt = frameAt;
  }
}

// ------------------------------------------------------------
// LISTENERS & EVENTOS
// ------------------------------------------------------------
window.addEventListener("pointermove", (e) => {
  pointer.targetX = _clamp(e.clientX / Math.max(1, window.innerWidth), 0.1, 0.9);
  pointer.targetY = _clamp(e.clientY / Math.max(1, window.innerHeight), 0.1, 0.9);
}, { passive: true });

window.addEventListener("resize", scheduleCanvasResize, { passive: true });

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (frameRequest) cancelAnimationFrame(frameRequest);
    frameRequest = null;
  } else if (isAudioActive) {
    lastRenderAt = performance.now();
    if (!frameRequest) drawVisualizer();
  }
});

window.addEventListener("music-lab:songchange", (event) => _setSong(event.detail));
window.addEventListener("music-lab:artworkpalette", (event) => _setArtworkPalette(event.detail));
window.addEventListener("music-lab:trackgain", (event) => setTrackGain(event.detail?.gainDb));

document.body.addEventListener("click", initAudioVisualizer, { once: true });
audioPlayer.addEventListener("play", () => {
  initAudioVisualizer();
  if (audioCtx?.state === "suspended") audioCtx.resume();
  _startVisualizer();
});
audioPlayer.addEventListener("pause", _stopVisualizer);
audioPlayer.addEventListener("ended", _stopVisualizer);

// Inicialización de arranque (apagado y limpio al inicio)
resizeCanvas();
_setSong({ title: DEFAULT_SONG_KEY });
document.body.classList.toggle("ambient-low-power", LOW_POWER_MODE);
_clearCanvas();
