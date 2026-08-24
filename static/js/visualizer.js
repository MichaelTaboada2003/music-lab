// ============================================================
// visualizer.js — Motor de Simulación Acústica Fluida & Orgánica (Web Audio API)
// Ondas de Presión Sonora • Cintas Armónicas • Nódulos Cimáticos • 60 FPS • 0% CPU en Pausa
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

// Estado del puntero para interacción acústica fluida
const pointer = {
  x: 0.5,
  y: 0.5,
  targetX: 0.5,
  targetY: 0.5,
  vx: 0,
  vy: 0,
};

// ------------------------------------------------------------
// SISTEMA DE SIMULACIÓN ACÚSTICA: MEMBRANAS Y ONDAS FLUIDAS
// ------------------------------------------------------------

// Cintas de Ondas de Presión Sonora
const NUM_WAVE_RIBBONS = LOW_POWER_MODE ? 4 : 6;
const waveRibbons = [];

function _initWaveRibbons() {
  waveRibbons.length = 0;
  for (let i = 0; i < NUM_WAVE_RIBBONS; i++) {
    waveRibbons.push({
      baseY: 0.22 + (i / Math.max(1, NUM_WAVE_RIBBONS - 1)) * 0.58,
      thickness: 0.16 + (i % 2) * 0.08,
      phase: i * 1.35,
      phase2: i * 2.1 + 0.8,
      baseSpeed: 0.45 + (i * 0.12),
      reactivity: 0.85 + (i % 3) * 0.35,
      harmonics: 2 + (i % 3),
      freqBandStart: Math.min(14, i * 2),
      colorIndex: i % 4, // 0: primary, 1: secondary, 2: tertiary, 3: accent
      flowDirection: i % 2 === 0 ? 1 : -1,
      roughness: 0.08 + (i % 3) * 0.04,
    });
  }
}

// Nódulos de Resonancia Cimática (Vórtices de Presión Sonora)
const NUM_CYMATIC_NODES = LOW_POWER_MODE ? 3 : 5;
const cymaticNodes = [];

function _initCymaticNodes() {
  cymaticNodes.length = 0;
  for (let i = 0; i < NUM_CYMATIC_NODES; i++) {
    cymaticNodes.push({
      baseX: 0.20 + (i / Math.max(1, NUM_CYMATIC_NODES - 1)) * 0.60,
      baseY: 0.30 + (i % 2 === 0 ? 0.15 : 0.48),
      currentX: 0.5,
      currentY: 0.5,
      phaseX: i * 1.618,
      phaseY: i * 2.414 + 1.2,
      orbitSpeed: 0.32 + i * 0.10,
      radiusScale: 0.32 + (i % 3) * 0.14,
      freqIndex: Math.min(15, i * 3 + 1),
      colorIndex: (i + 1) % 4,
      petals: 3 + (i % 4), // Simetría armónica cimática
    });
  }
}

// Ondas de Choque Acústicas Expansivas (Shockwaves / Solitones)
const MAX_RIPPLES = 8;
const acousticRipples = [];

function _spawnAcousticRipple(x, y, power, color) {
  if (acousticRipples.length >= MAX_RIPPLES) acousticRipples.shift();
  acousticRipples.push({
    x,
    y,
    radius: 10,
    maxRadius: Math.max(window.innerWidth, window.innerHeight) * (0.55 + power * 0.45),
    speed: 380 + power * 420,
    alpha: 0.65 + power * 0.35,
    power,
    color,
    phaseOffset: Math.random() * Math.PI * 2,
  });
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
  fluidTime: 0,
};

_initWaveRibbons();
_initCymaticNodes();

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
  const amount = 1 - Math.exp(-2.8 * dt);
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
  acousticRipples.length = 0;

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
  visual.beatFloor = _smooth(visual.beatFloor, visual.bass, 1.5, 0.9, dt);
}

// ------------------------------------------------------------
// CAPA 1: MAR DE FONDO FLUIDO Y RESONANTE
// ------------------------------------------------------------
function _drawAtmosphericFluidBase(width, height, time) {
  const grad = ctx.createLinearGradient(0, 0, width, height);
  const waveShift = Math.sin(time * 0.25) * 0.08;
  
  grad.addColorStop(0, _rgba(visual.palette.shadow, 0.85));
  grad.addColorStop(0.45 + waveShift, _rgba([7, 9, 14], 0.90));
  grad.addColorStop(1, _rgba(visual.palette.shadow, 0.88));

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
}

// ------------------------------------------------------------
// CAPA 2: CINTAS DE ONDAS ACÚSTICAS FLUIDAS (Harmonic Wave Ribbons)
// ------------------------------------------------------------
function _drawHarmonicWaveRibbons(width, height, time, dt, motionScale) {
  const steps = LOW_POWER_MODE ? 40 : 64;
  const dx = width / steps;
  const energy = visual.energy;
  const bass = visual.bass;
  const pulse = visual.pulse;

  ctx.globalCompositeOperation = "screen";

  waveRibbons.forEach((ribbon, idx) => {
    // Acumulación continua de fase fluida (física de ondas sin saltos)
    ribbon.phase += dt * (ribbon.baseSpeed + energy * ribbon.reactivity * 1.4) * ribbon.flowDirection * motionScale;
    ribbon.phase2 += dt * (ribbon.baseSpeed * 0.65 + bass * 0.8) * motionScale;

    const bandVal = spectrumBands[ribbon.freqBandStart] || energy;
    const color = _getColorByIndex(ribbon.colorIndex);
    const alphaBase = 0.12 + (idx < 2 ? bass * 0.22 : visual.lowMid * 0.18) + pulse * 0.10;
    const alpha = _clamp(alphaBase * (0.45 + energy * 0.85), 0.04, 0.55);

    const centerY = height * ribbon.baseY + (pointer.y - 0.5) * height * 0.08 * motionScale;
    const amp1 = height * (0.04 + (idx < 2 ? bass * 0.14 : visual.highMid * 0.10) + pulse * 0.05);
    const amp2 = height * (0.02 + bandVal * 0.08);
    const thickness = height * ribbon.thickness * (0.85 + energy * 0.65 + pulse * 0.35);

    // Trazar curva superior
    ctx.beginPath();
    let prevX = 0;
    let prevY = centerY;

    for (let s = 0; s <= steps; s++) {
      const x = s * dx;
      const nx = x / width;
      
      // Armónicos compuestos de Fourier modulados por sonido
      const w1 = Math.sin(nx * Math.PI * ribbon.harmonics + ribbon.phase);
      const w2 = Math.cos(nx * Math.PI * (ribbon.harmonics * 1.6) + ribbon.phase2 + (pointer.x - 0.5) * 2);
      const w3 = Math.sin(nx * Math.PI * 4.2 - time * 0.8) * ribbon.roughness;
      
      const waveOffset = (w1 * 0.65 + w2 * 0.35 + w3) * (amp1 + amp2);
      const y = centerY + waveOffset;

      if (s === 0) {
        ctx.moveTo(x, y);
      } else {
        const cx = (prevX + x) / 2;
        const cy = (prevY + y) / 2;
        ctx.quadraticCurveTo(prevX, prevY, cx, cy);
      }
      prevX = x;
      prevY = y;
    }
    ctx.lineTo(width, prevY);

    // Trazar curva inferior para cerrar el volumen fluido de la cinta
    for (let s = steps; s >= 0; s--) {
      const x = s * dx;
      const nx = x / width;
      
      const w1 = Math.sin(nx * Math.PI * ribbon.harmonics + ribbon.phase + 0.4);
      const w2 = Math.cos(nx * Math.PI * (ribbon.harmonics * 1.6) + ribbon.phase2 - 0.3);
      const waveOffset = (w1 * 0.60 + w2 * 0.40) * (amp1 + amp2 * 0.8);
      const y = centerY + waveOffset + thickness;

      if (s === steps) {
        ctx.lineTo(x, y);
      } else {
        const cx = (prevX + x) / 2;
        const cy = (prevY + y) / 2;
        ctx.quadraticCurveTo(prevX, prevY, cx, cy);
      }
      prevX = x;
      prevY = y;
    }
    ctx.closePath();

    // Gradiente lumínico vertical del fluido
    const grad = ctx.createLinearGradient(0, centerY - amp1, 0, centerY + thickness + amp1);
    grad.addColorStop(0, _rgba(color, 0));
    grad.addColorStop(0.35, _rgba(color, alpha));
    grad.addColorStop(0.70, _rgba(_mixColor(color, visual.palette.accent, 0.4), alpha * 0.7));
    grad.addColorStop(1, _rgba(color, 0));

    ctx.fillStyle = grad;
    ctx.fill();
  });
}

// ------------------------------------------------------------
// CAPA 3: NÓDULOS DE RESONANCIA CIMÁTICA (Cymatic Pressure Vortices)
// ------------------------------------------------------------
function _drawCymaticPressureNodes(width, height, short, time, dt, motionScale) {
  ctx.globalCompositeOperation = "screen";
  const energy = visual.energy;
  const bass = visual.bass;

  cymaticNodes.forEach((node, idx) => {
    // Órbita fluida con inercia elíptica
    const orbitT = time * node.orbitSpeed * (0.7 + energy * 0.6) * motionScale;
    const wanderX = Math.sin(orbitT + node.phaseX) * width * 0.16;
    const wanderY = Math.cos(orbitT * 0.85 + node.phaseY) * height * 0.14;

    node.currentX = width * node.baseX + wanderX + (pointer.x - 0.5) * 60;
    node.currentY = height * node.baseY + wanderY + (pointer.y - 0.5) * 50;

    const bandEnergy = spectrumBands[node.freqIndex] || energy;
    const baseRadius = short * node.radiusScale * (0.85 + bandEnergy * 0.75 + visual.pulse * 0.45);
    const color = _getColorByIndex(node.colorIndex);
    const nodeAlpha = _clamp((0.14 + bandEnergy * 0.26 + visual.pulse * 0.12) * (0.5 + energy * 0.8), 0.03, 0.52);

    // Dibujar patrón de interferencia acústica con forma de flor cimática
    ctx.save();
    ctx.translate(node.currentX, node.currentY);
    ctx.rotate(time * 0.18 * (idx % 2 === 0 ? 1 : -1) + node.phaseX);

    const petals = node.petals;
    const points = LOW_POWER_MODE ? 32 : 48;
    ctx.beginPath();

    for (let p = 0; p <= points; p++) {
      const angle = (p / points) * Math.PI * 2;
      const mod = 1 + Math.sin(angle * petals + time * 1.5) * (0.12 + bass * 0.18);
      const r = baseRadius * mod;
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r;

      if (p === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();

    const radGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, baseRadius * 1.2);
    radGrad.addColorStop(0, _rgba(color, nodeAlpha));
    radGrad.addColorStop(0.40, _rgba(color, nodeAlpha * 0.55));
    radGrad.addColorStop(0.80, _rgba(color, nodeAlpha * 0.12));
    radGrad.addColorStop(1, _rgba(color, 0));

    ctx.fillStyle = radGrad;
    ctx.fill();
    ctx.restore();
  });
}

// ------------------------------------------------------------
// CAPA 4: ONDAS DE CHOQUE ACÚSTICAS EN TRANSITORIOS (Acoustic Ripples)
// ------------------------------------------------------------
function _updateAndDrawAcousticRipples(width, height, dt) {
  if (!acousticRipples.length) return;
  ctx.globalCompositeOperation = "screen";

  for (let i = acousticRipples.length - 1; i >= 0; i--) {
    const ripple = acousticRipples[i];
    ripple.radius += ripple.speed * dt;
    ripple.alpha *= Math.exp(-2.2 * dt);

    if (ripple.radius >= ripple.maxRadius || ripple.alpha < 0.01) {
      acousticRipples.splice(i, 1);
      continue;
    }

    const grad = ctx.createRadialGradient(
      ripple.x,
      ripple.y,
      Math.max(0, ripple.radius - 60),
      ripple.x,
      ripple.y,
      ripple.radius
    );
    
    grad.addColorStop(0, _rgba(ripple.color, 0));
    grad.addColorStop(0.65, _rgba(ripple.color, ripple.alpha * 0.45));
    grad.addColorStop(0.85, _rgba([255, 255, 255], ripple.alpha * 0.65));
    grad.addColorStop(1, _rgba(ripple.color, 0));

    ctx.save();
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ------------------------------------------------------------
// CAPA 5: FILAMENTOS DE LUZ Y AGUDOS ARMÓNICOS (Caustics)
// ------------------------------------------------------------
function _drawHarmonicCaustics(width, height, short, time, motionScale) {
  if (visual.air < 0.14 && visual.highMid < 0.16) return;
  ctx.globalCompositeOperation = "screen";

  const airPower = Math.max(visual.air, visual.highMid);
  const fx = width * 0.5 + (pointer.x - 0.5) * width * 0.2 * motionScale;
  const fy = height * 0.42 + (pointer.y - 0.5) * height * 0.15 * motionScale;
  const radius = short * (0.38 + airPower * 0.42);
  const color = _mixColor(visual.palette.accent, [255, 255, 255], 0.40);
  const alpha = _clamp(airPower * 0.24, 0.02, 0.30);

  const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, radius);
  grad.addColorStop(0, _rgba(color, alpha));
  grad.addColorStop(0.45, _rgba(visual.palette.tertiary, alpha * 0.40));
  grad.addColorStop(1, _rgba(visual.palette.tertiary, 0));

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(fx, fy, radius, 0, Math.PI * 2);
  ctx.fill();
}

// ------------------------------------------------------------
// CAPA 6: VIÑETA CINEMÁTICA Y CONTRASTE DE INTERFAZ
// ------------------------------------------------------------
function _drawCinematicVignette(width, height) {
  const maxDim = Math.max(width, height);
  const grad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    height * 0.18,
    width * 0.5,
    height * 0.5,
    maxDim * 0.70
  );
  grad.addColorStop(0, "rgba(7, 9, 14, 0.02)");
  grad.addColorStop(0.50, "rgba(7, 9, 14, 0.32)");
  grad.addColorStop(1, "rgba(7, 9, 14, 0.84)");

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
  const driftX = Math.sin(time * 0.20) * (14 + energy * 26) * motionScale + (pointer.x - 0.5) * 40;
  const driftY = Math.cos(time * 0.16) * (12 + energy * 20) * motionScale + (pointer.y - 0.5) * 32;
  const intensity = _clamp(0.28 + energy * 0.62 + visual.flux * 0.14, 0.20, 0.95);
  const beatScale = _clamp(visual.pulse * 0.032, 0, 0.05);
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

  visual.fluidTime += dt * (0.8 + visual.energy * 0.8);
  beatCooldown = Math.max(0, beatCooldown - dt);
  _readAudio(dt);
  _lerpPalette(dt);

  // Detección de golpes rítmicos / Transitorios para Ondas de Choque Acústicas
  const transient = visual.bass - visual.beatFloor;
  if (
    !reduceMotionQuery.matches &&
    beatCooldown === 0 &&
    visual.bass > 0.26 &&
    transient > 0.022 &&
    visual.flux > 0.045
  ) {
    visual.pulse = _clamp(visual.pulse + 0.50 + visual.flux * 0.35, 0, 1);
    beatCooldown = 0.15;
    
    // Disparar onda de choque acústica
    const spawnX = width * pointer.x;
    const spawnY = height * pointer.y;
    _spawnAcousticRipple(spawnX, spawnY, visual.bass, visual.palette.accent);
  }
  visual.pulse *= Math.exp(-4.2 * dt);

  ctx.clearRect(0, 0, width, height);

  // Pipeline de Renderizado de Simulación Acústica Fluida
  _drawAtmosphericFluidBase(width, height, time);
  _drawHarmonicWaveRibbons(width, height, time, dt, motionScale);
  _drawCymaticPressureNodes(width, height, short, time, dt, motionScale);
  _updateAndDrawAcousticRipples(width, height, dt);
  _drawHarmonicCaustics(width, height, short, time, motionScale);
  _drawCinematicVignette(width, height);

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
