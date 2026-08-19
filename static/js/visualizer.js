// ============================================================
// visualizer.js — Motor Visual de Iluminación Acústica Inmersiva (Web Audio API)
// 100% Reactivo al Audio • Sin Estrellas ni Rayas • Apagado en Pausa • 60 FPS
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

const NORMAL_FPS = reduceMotionQuery.matches ? 30 : LOW_POWER_MODE ? 45 : 60;
const DEGRADED_FPS = 30;
const CSS_UPDATE_INTERVAL = LOW_POWER_MODE ? 60 : 33;
const BASE_PIXEL_BUDGET = LOW_POWER_MODE ? 800_000 : 1_800_000;
const MOBILE_PIXEL_BUDGET = LOW_POWER_MODE ? 450_000 : 950_000;

// ------------------------------------------------------------
// MODOS DE ILUMINACIÓN ESCÉNICA (Asignados por Canción)
// ------------------------------------------------------------
const STAGE_LIGHT_MODES = [
  { id: "fluid_aura", name: "Aura Líquida de Escenario", focusX: 0.38, focusY: 0.42, spread: 1.5, drift: 1.0 },
  { id: "volumetric_beams", name: "Haces de Luz Volumétricos", focusX: 0.50, focusY: 0.38, spread: 2.0, drift: 1.4 },
  { id: "chromatic_caustics", name: "Cáusticas de Luz Armónica", focusX: 0.44, focusY: 0.52, spread: 1.6, drift: 0.9 },
  { id: "resonant_chamber", name: "Cámara de Luz Resonante", focusX: 0.55, focusY: 0.40, spread: 1.8, drift: 1.2 },
  { id: "kinetic_waves", name: "Ondas Cinéticas de Escenario", focusX: 0.48, focusY: 0.46, spread: 1.7, drift: 1.5 },
];

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

// Estado de animación y profiling
let frameRequest = null;
let lastRenderAt = 0;
let lastCssUpdateAt = 0;
let resizeRequest = null;
let beatCooldown = 0;
let activeArtworkIndex = 0;
let currentArtworkUrl = "";
let frameInterval = 1000 / NORMAL_FPS;
let averageRenderCost = 0;
let quality = 1;
let qualityCheckAt = 0;
let isAudioActive = false;

// Estado del puntero para paralaje
const pointer = {
  x: 0.5,
  y: 0.5,
  targetX: 0.5,
  targetY: 0.5,
};

// ------------------------------------------------------------
// NODOS DE LUZ ACÚSTICA MULTICAPA (Proyecciones de Espectro)
// ------------------------------------------------------------
const NUM_LIGHT_NODES = LOW_POWER_MODE ? 4 : 6;
const lightNodes = [];

function _initLightNodes() {
  lightNodes.length = 0;
  for (let i = 0; i < NUM_LIGHT_NODES; i++) {
    lightNodes.push({
      baseX: 0.2 + (i / Math.max(1, NUM_LIGHT_NODES - 1)) * 0.60,
      baseY: 0.25 + (i % 2) * 0.40,
      currentX: 0.5,
      currentY: 0.5,
      baseRadiusScale: 0.45 + (i % 3) * 0.18,
      speed: 0.45 + i * 0.18,
      phaseX: i * 1.5,
      phaseY: i * 2.2 + 1.0,
      colorIndex: i % 4, // 0: primary, 1: secondary, 2: tertiary, 3: accent
      driftAmpX: 0.18 + (i % 2) * 0.08,
      driftAmpY: 0.14 + (i % 3) * 0.06,
    });
  }
}

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
  seed: _hashString(DEFAULT_SONG_KEY),
  palette: _clonePalette(initialPalette),
  targetPalette: _clonePalette(initialPalette),
  mode: STAGE_LIGHT_MODES[0],
};

_initLightNodes();

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
  const shiftA = 45 + (seed % 40);
  const shiftB = 120 + (seed % 60);

  return {
    primary: _hslToRgb(hue, 90, 60),
    secondary: _hslToRgb(hue + shiftA, 88, 62),
    tertiary: _hslToRgb(hue + shiftB, 82, 58),
    accent: _hslToRgb(hue + 180, 92, 70),
    shadow: _hslToRgb(hue + 15, 45, 6),
  };
}

function _paletteFromArtwork(colors) {
  const [primary, secondary, tertiary] = colors;
  return {
    primary: _mixColor(primary, [255, 255, 255], 0.12),
    secondary: _mixColor(secondary, [255, 255, 255], 0.10),
    tertiary: _mixColor(tertiary, [255, 255, 255], 0.14),
    accent: _mixColor(secondary, tertiary, 0.5),
    shadow: _mixColor(primary, [3, 5, 9], 0.90),
  };
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

  // ASIGNAR MODO DE ILUMINACIÓN DE ESCENARIO ÚNICO POR CANCIÓN
  const modeIndex = visual.seed % STAGE_LIGHT_MODES.length;
  visual.mode = STAGE_LIGHT_MODES[modeIndex];

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
  const amount = 1 - Math.exp(-3.0 * dt);
  for (const key of Object.keys(visual.palette)) {
    visual.palette[key] = _mixColor(visual.palette[key], visual.targetPalette[key], amount);
  }
}

function _getColorByIndex(index) {
  switch (index) {
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
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pixelBudget = (width <= 768 ? MOBILE_PIXEL_BUDGET : BASE_PIXEL_BUDGET) * quality;
  const budgetScale = Math.sqrt(pixelBudget / Math.max(1, width * height));
  const renderScale = Math.min(window.devicePixelRatio || 1, LOW_POWER_MODE ? 0.85 : 1, budgetScale);

  bgCanvas.width = Math.max(1, Math.round(width * renderScale));
  bgCanvas.height = Math.max(1, Math.round(height * renderScale));
  bgCanvas.style.width = `${width}px`;
  bgCanvas.style.height = `${height}px`;
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
}

function scheduleCanvasResize() {
  if (resizeRequest) return;
  resizeRequest = requestAnimationFrame(() => {
    resizeRequest = null;
    resizeCanvas();
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
    analyser.smoothingTimeConstant = 0.75;
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
    // Si la captura falla por políticas de navegador, continúa de forma autónoma
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

  visual.bass = 0;
  visual.lowMid = 0;
  visual.highMid = 0;
  visual.air = 0;
  visual.rms = 0;
  visual.energy = 0;
  visual.pulse = 0;

  _clearCanvas();
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
    spectrumBands[i] = _smooth(spectrumBands[i], targetBands[i], 22, 7.0, dt);
  }

  visual.bass = _smooth(visual.bass, bass, 20, 5.0, dt);
  visual.lowMid = _smooth(visual.lowMid, lowMid, 16, 4.0, dt);
  visual.highMid = _smooth(visual.highMid, highMid, 14, 3.5, dt);
  visual.air = _smooth(visual.air, air, 12, 3.0, dt);
  visual.rms = _smooth(visual.rms, rms, 18, 4.2, dt);
  visual.centroid = _smooth(visual.centroid, centroid, 8, 5, dt);
  visual.flux = _smooth(visual.flux, flux, 22, 10, dt);

  const energy = _clamp(
    (visual.bass * 1.8 + visual.lowMid * 1.2 + visual.highMid * 1.0 + visual.air * 0.8 + visual.rms * 1.5) / 5.8,
    0,
    1
  );
  visual.energy = _smooth(visual.energy, energy, 14, 3.5, dt);
  visual.beatFloor = _smooth(visual.beatFloor, visual.bass, 1.5, 0.9, dt);
}

// ------------------------------------------------------------
// CAPA 1: FONDO CÓSMICO PROFUNDO BASE
// ------------------------------------------------------------
function _drawAtmosphericBase(width, height) {
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, _rgba(visual.palette.shadow, 0.72));
  grad.addColorStop(0.5, _rgba([6, 8, 12], 0.84));
  grad.addColorStop(1, _rgba(visual.palette.shadow, 0.78));
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

// ------------------------------------------------------------
// CAPA 2: NÚCLEO Y VELOS DE LUZ ACÚSTICA (100% Reactivo a la Música)
// ------------------------------------------------------------
function _drawAcousticLightAtmosphere(width, height, short, time, motionScale) {
  ctx.globalCompositeOperation = "screen";

  const mode = visual.mode;
  const energy = visual.energy;
  const bass = visual.bass;
  const lowMid = visual.lowMid;
  const highMid = visual.highMid;
  const air = visual.air;

  const focusX = width * mode.focusX + (pointer.x - 0.5) * width * 0.12 * motionScale;
  const focusY = height * mode.focusY + (pointer.y - 0.5) * height * 0.10 * motionScale;

  // 1. Nodos de Luz Fluida en Movimiento Armónico (Mapeados a las frecuencias)
  lightNodes.forEach((node, idx) => {
    const t = time * node.speed * mode.drift * (0.6 + energy * 0.9) * motionScale;
    const wanderX = Math.sin(t + node.phaseX) * node.driftAmpX * width;
    const wanderY = Math.cos(t * 0.85 + node.phaseY) * node.driftAmpY * height;

    node.currentX = width * node.baseX + wanderX + (pointer.x - 0.5) * 40;
    node.currentY = height * node.baseY + wanderY + (pointer.y - 0.5) * 30;

    // Modulación del radio por frecuencias:
    // Nodos 0-1: Graves / Sub-bass
    // Nodos 2-3: Medios / Vocales
    // Nodos 4-5: Agudos / Aire
    const freqBoost = idx < 2 ? bass * 0.45 : idx < 4 ? lowMid * 0.38 : highMid * 0.32;
    const baseRad = short * node.baseRadiusScale;
    const radius = baseRad * (1.0 + energy * 1.2 + freqBoost + visual.pulse * 0.6);

    const color = _getColorByIndex(node.colorIndex);
    const alphaBase = 0.16 + (idx < 2 ? bass * 0.28 : lowMid * 0.22) + visual.pulse * 0.14;
    const alpha = _clamp(alphaBase * (0.5 + energy * 0.9), 0.05, 0.65);

    // Ondulación elíptica armónica que respira con la música
    const morphX = 1 + Math.sin(time * 2.2 + node.phaseX) * (0.10 + bass * 0.20);
    const morphY = 1 - Math.sin(time * 1.8 + node.phaseY) * (0.08 + lowMid * 0.15);

    ctx.save();
    ctx.translate(node.currentX, node.currentY);
    ctx.rotate(time * 0.15 * (idx % 2 === 0 ? 1 : -1) + node.phaseX);
    ctx.scale(morphX, morphY);

    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    grad.addColorStop(0, _rgba(color, alpha));
    grad.addColorStop(0.35, _rgba(color, alpha * 0.60));
    grad.addColorStop(0.70, _rgba(color, alpha * 0.15));
    grad.addColorStop(1, _rgba(color, 0));

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // 2. Haces de Luz Volumétrica (Se abren y giran al subir la potencia del audio)
  if (!LOW_POWER_MODE && mode.id === "volumetric_beams") {
    const beamCount = 8;
    const beamLength = Math.max(width, height) * (0.65 + energy * 0.45);
    for (let b = 0; b < beamCount; b++) {
      const angle = (b / beamCount) * Math.PI * 2 + time * 0.12 * motionScale;
      const beamGrad = ctx.createLinearGradient(focusX, focusY, focusX + Math.cos(angle) * beamLength, focusY + Math.sin(angle) * beamLength);
      const bColor = _getColorByIndex(b % 4);
      const bAlpha = _clamp((0.10 + bass * 0.18 + visual.pulse * 0.16) * (0.5 + energy * 0.8), 0.02, 0.42);

      beamGrad.addColorStop(0, _rgba(bColor, bAlpha));
      beamGrad.addColorStop(0.50, _rgba(bColor, bAlpha * 0.40));
      beamGrad.addColorStop(1, _rgba(bColor, 0));

      ctx.save();
      ctx.translate(focusX, focusY);
      ctx.rotate(angle);
      ctx.fillStyle = beamGrad;
      ctx.beginPath();
      ctx.moveTo(0, -short * 0.04);
      ctx.lineTo(beamLength, -short * (0.08 + bass * 0.08));
      ctx.lineTo(beamLength, short * (0.08 + bass * 0.08));
      ctx.lineTo(0, short * 0.04);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // 3. Resplandor de Agudos & Brillo Espectral
  if (air > 0.15) {
    const airRadius = short * (0.45 + air * 0.40);
    const airColor = _mixColor(visual.palette.accent, [255, 255, 255], 0.35);
    const airGrad = ctx.createRadialGradient(focusX, focusY, 0, focusX, focusY, airRadius);
    const airAlpha = _clamp(air * 0.22, 0.02, 0.25);

    airGrad.addColorStop(0, _rgba(airColor, airAlpha));
    airGrad.addColorStop(0.50, _rgba(visual.palette.tertiary, airAlpha * 0.40));
    airGrad.addColorStop(1, _rgba(visual.palette.tertiary, 0));

    ctx.fillStyle = airGrad;
    ctx.beginPath();
    ctx.arc(focusX, focusY, airRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------
// CAPA 3: RÁFAGA DE LUZ EN GOLPES DE RITMO (BEAT FLASH BLOOM)
// Explosión de luz expansiva en bombos y drops (100% lumínico, 0 rayas)
// ------------------------------------------------------------
function _drawAcousticBeatBloom(width, height, short) {
  if (visual.pulse < 0.02) return;
  const cx = width * pointer.x;
  const cy = height * pointer.y;
  const radius = short * (0.42 + visual.pulse * 0.60);
  const color = _mixColor(visual.palette.accent, [255, 255, 255], 0.45);

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0, _rgba(color, visual.pulse * 0.30));
  grad.addColorStop(0.35, _rgba(visual.palette.primary, visual.pulse * 0.15));
  grad.addColorStop(0.70, _rgba(visual.palette.secondary, visual.pulse * 0.05));
  grad.addColorStop(1, _rgba(visual.palette.secondary, 0));

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------
// CAPA 4: VIÑETA DE CONTRASTE & LEGIBILIDAD UI
// ------------------------------------------------------------
function _drawCenterVignette(width, height) {
  const maxDim = Math.max(width, height);
  const grad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    height * 0.16,
    width * 0.5,
    height * 0.5,
    maxDim * 0.72
  );
  grad.addColorStop(0, "rgba(6, 8, 12, 0.10)");
  grad.addColorStop(0.50, "rgba(6, 8, 12, 0.38)");
  grad.addColorStop(1, "rgba(6, 8, 12, 0.85)");

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

// ------------------------------------------------------------
// ACTUALIZACIÓN DE VARIABLES CSS & PARALAJE
// ------------------------------------------------------------
function _updateCss(time, motionScale) {
  pointer.x += (pointer.targetX - pointer.x) * 0.08;
  pointer.y += (pointer.targetY - pointer.y) * 0.08;

  const energy = visual.energy;
  const driftX = Math.sin(time * 0.22) * (18 + energy * 36) * motionScale + (pointer.x - 0.5) * 50;
  const driftY = Math.cos(time * 0.18) * (15 + energy * 28) * motionScale + (pointer.y - 0.5) * 40;
  const intensity = _clamp(0.25 + energy * 0.60 + visual.flux * 0.15, 0.20, 0.90);
  const beatScale = _clamp(visual.pulse * 0.038, 0, 0.06);
  const rotation = Math.sin(time * 0.10) * 4 + (pointer.x - 0.5) * 5;

  const targets = [ambientOverlay, ambientArtwork, nowPlaying].filter(Boolean);
  targets.forEach((target) => {
    target.style.setProperty("--ambient-intensity", intensity.toFixed(3));
    target.style.setProperty("--ambient-beat-scale", beatScale.toFixed(3));
    target.style.setProperty("--ambient-shift-x", `${driftX.toFixed(1)}px`);
    target.style.setProperty("--ambient-shift-y", `${driftY.toFixed(1)}px`);
    target.style.setProperty("--ambient-local-x", `${(driftX * 0.20).toFixed(1)}px`);
    target.style.setProperty("--ambient-local-y", `${(driftY * 0.15).toFixed(1)}px`);
    target.style.setProperty("--ambient-rotate", `${rotation.toFixed(2)}deg`);
    target.style.setProperty("--ambient-pointer-x", pointer.x.toFixed(3));
    target.style.setProperty("--ambient-pointer-y", pointer.y.toFixed(3));
  });
}

// ------------------------------------------------------------
// PROFILER ADAPTATIVO (60 FPS FIJOS)
// ------------------------------------------------------------
function _adaptQuality(renderCost, now) {
  averageRenderCost = averageRenderCost ? averageRenderCost * 0.94 + renderCost * 0.06 : renderCost;
  if (now - qualityCheckAt < 2000 || LOW_POWER_MODE || reduceMotionQuery.matches) return;
  qualityCheckAt = now;

  if (averageRenderCost > 13.5 && quality > 0.70) {
    quality = 0.70;
    frameInterval = 1000 / DEGRADED_FPS;
    scheduleCanvasResize();
  } else if (averageRenderCost < 6.0 && quality < 1) {
    quality = 1;
    frameInterval = 1000 / NORMAL_FPS;
    scheduleCanvasResize();
  }
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
  if (elapsed < frameInterval) return;
  lastRenderAt = frameAt - (elapsed % frameInterval);

  const renderStartedAt = performance.now();
  const dt = Math.min(elapsed / 1000, 0.10);
  const width = window.innerWidth;
  const height = window.innerHeight;
  const short = Math.min(width, height);
  const time = frameAt / 1000;
  const motionScale = reduceMotionQuery.matches ? 0.15 : 1;

  beatCooldown = Math.max(0, beatCooldown - dt);
  _readAudio(dt);
  _lerpPalette(dt);

  // Detección de golpes de bombo / transitorios
  const transient = visual.bass - visual.beatFloor;
  if (
    !reduceMotionQuery.matches &&
    beatCooldown === 0 &&
    visual.bass > 0.28 &&
    transient > 0.025 &&
    visual.flux > 0.05
  ) {
    visual.pulse = _clamp(visual.pulse + 0.45 + visual.flux * 0.35, 0, 1);
    beatCooldown = 0.16;
  }
  visual.pulse *= Math.exp(-4.2 * dt);

  ctx.clearRect(0, 0, width, height);

  // Renderizado 100% de luz acústica envolvente
  _drawAtmosphericBase(width, height);
  _drawAcousticLightAtmosphere(width, height, short, time, motionScale);
  _drawAcousticBeatBloom(width, height, short);
  _drawCenterVignette(width, height);

  ctx.globalCompositeOperation = "source-over";

  if (frameAt - lastCssUpdateAt >= CSS_UPDATE_INTERVAL) {
    _updateCss(time, motionScale);
    lastCssUpdateAt = frameAt;
  }
  _adaptQuality(performance.now() - renderStartedAt, frameAt);
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
