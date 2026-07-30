// ============================================================
// visualizer.js — Motor Visual Inmersivo HD Reactivo al Audio (Web Audio API)
// 6 Escenas Procedurales 3D • Malla Fluida • Espectro Armónico • Turbulencia Vectorial
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
const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const deviceMemory = Number(navigator.deviceMemory) || 8;
const cpuCores = Number(navigator.hardwareConcurrency) || 8;
const LOW_POWER_MODE = reduceMotionQuery.matches || deviceMemory <= 4 || cpuCores <= 4;

const NORMAL_FPS = reduceMotionQuery.matches ? 24 : LOW_POWER_MODE ? 30 : 60;
const DEGRADED_FPS = reduceMotionQuery.matches ? 18 : 30;
const CSS_UPDATE_INTERVAL = LOW_POWER_MODE ? 80 : 40;
const AMBIENT_FADE_DURATION = 560;
const BASE_PIXEL_BUDGET = LOW_POWER_MODE ? 800_000 : 1_600_000;
const MOBILE_PIXEL_BUDGET = LOW_POWER_MODE ? 450_000 : 900_000;

// 6 Escenas procedurales hiper-dinámicas únicas asignadas por semilla de la canción
const SCENES = [
  { id: "aurora", name: "Quantum Fluid Aurora", focusX: 0.35, focusY: 0.40, rotation: -0.22, drift: 1.2, turbulence: 1.4, rayDensity: 0.8 },
  { id: "supernova", name: "Cosmic Supernova", focusX: 0.50, focusY: 0.45, rotation: 0.05, drift: 0.9, turbulence: 1.8, rayDensity: 1.4 },
  { id: "cybergrid", name: "Cyber Waveform Grid", focusX: 0.50, focusY: 0.65, rotation: 0.00, drift: 1.5, turbulence: 1.0, rayDensity: 0.6 },
  { id: "vortex", name: "Bioluminescent Vortex", focusX: 0.60, focusY: 0.40, rotation: 0.45, drift: 1.1, turbulence: 2.2, rayDensity: 1.2 },
  { id: "hyperdrive", name: "Hyperdrive Light Rays", focusX: 0.50, focusY: 0.35, rotation: -0.15, drift: 1.4, turbulence: 1.6, rayDensity: 2.0 },
  { id: "galaxy", name: "Starlight Galaxy Field", focusX: 0.42, focusY: 0.55, rotation: 0.25, drift: 0.8, turbulence: 2.5, rayDensity: 1.0 },
];

let audioCtx;
let analyser;
let source;
let gainNode;
let pendingGain = 1;
let frequencyData;
let timeData;
let previousSpectrum;
let spectrumBands = new Float32Array(16);
let targetBands = new Float32Array(16);

let frameRequest = null;
let lastRenderAt = 0;
let lastCssUpdateAt = 0;
let clearCanvasTimer = null;
let resizeRequest = null;
let beatCooldown = 0;
let activeArtworkIndex = 0;
let currentArtworkUrl = "";
let frameInterval = 1000 / NORMAL_FPS;
let averageRenderCost = 0;
let quality = 1;
let qualityCheckAt = 0;

// Pool de partículas con físicas vectoriales avanzadas
const MAX_PARTICLES = LOW_POWER_MODE ? 24 : 54;
const particles = [];

function _initParticles() {
  particles.length = 0;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    particles.push({
      x: Math.random(),
      y: Math.random(),
      z: 0.2 + Math.random() * 0.8,
      size: 1.2 + Math.random() * 2.8,
      alpha: 0.15 + Math.random() * 0.45,
      vx: (Math.random() - 0.5) * 0.08,
      vy: (Math.random() - 0.5) * 0.08,
      phase: Math.random() * Math.PI * 2,
      orbitRadius: 0.1 + Math.random() * 0.35,
      orbitAngle: Math.random() * Math.PI * 2,
    });
  }
}

const initialPalette = _buildFallbackPalette(DEFAULT_SONG_KEY);
const visual = {
  bass: 0,
  lowMid: 0,
  highMid: 0,
  air: 0,
  rms: 0,
  centroid: 0.5,
  flux: 0,
  energy: 0.08,
  beatFloor: 0.08,
  pulse: 0,
  seed: _hashString(DEFAULT_SONG_KEY),
  palette: _clonePalette(initialPalette),
  targetPalette: _clonePalette(initialPalette),
  scene: _sceneFromKey(DEFAULT_SONG_KEY),
  ripples: [],
  flowAngle: 0,
  flowFreq: 1.2,
  rotation3D: { x: 0, y: 0, z: 0 },
};

_initParticles();

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
  const shiftA = 40 + (seed % 50);
  const shiftB = 110 + (seed % 80);

  return {
    primary: _hslToRgb(hue, 88, 62),
    secondary: _hslToRgb(hue + shiftA, 82, 64),
    tertiary: _hslToRgb(hue + shiftB, 78, 62),
    accent: _hslToRgb(hue + 180, 90, 72),
    shadow: _hslToRgb(hue + 15, 35, 8),
  };
}

function _paletteFromArtwork(colors) {
  const [primary, secondary, tertiary] = colors;
  return {
    primary: _mixColor(primary, [255, 255, 255], 0.12),
    secondary: _mixColor(secondary, [255, 255, 255], 0.08),
    tertiary: _mixColor(tertiary, [255, 255, 255], 0.14),
    accent: _mixColor(secondary, tertiary, 0.5),
    shadow: _mixColor(primary, [4, 6, 10], 0.88),
  };
}

function _sceneFromKey(songKey) {
  const index = _hashString(songKey) % SCENES.length;
  return SCENES[index];
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
}

function _setSong(detail) {
  const songKey = _songKeyFromDetail(detail);
  const palette = _buildFallbackPalette(songKey);
  visual.targetPalette = palette;
  visual.seed = _hashString(songKey);
  visual.scene = _sceneFromKey(songKey);

  // Parámetros procedimentales únicos por canción
  visual.flowAngle = (visual.seed % 360) * (Math.PI / 180);
  visual.flowFreq = 0.7 + ((visual.seed % 100) / 100) * 1.4;

  document.body.dataset.ambientScene = visual.scene.id;
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

function resizeCanvas() {
  if (!ctx || !bgCanvas) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pixelBudget = (width <= 768 ? MOBILE_PIXEL_BUDGET : BASE_PIXEL_BUDGET) * quality;
  const budgetScale = Math.sqrt(pixelBudget / Math.max(1, width * height));
  const renderScale = Math.min(window.devicePixelRatio || 1, LOW_POWER_MODE ? 0.82 : 1, budgetScale);

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

function initAudioVisualizer() {
  if (!ctx) return;
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    return;
  }

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.72;
  frequencyData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.frequencyBinCount);
  previousSpectrum = new Float32Array(analyser.frequencyBinCount);

  source = audioCtx.createMediaElementSource(audioPlayer);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = pendingGain;
  source.connect(gainNode);
  gainNode.connect(analyser);
  analyser.connect(audioCtx.destination);
}

function setTrackGain(gainDb) {
  pendingGain = _clamp(Math.pow(10, (Number(gainDb) || 0) / 20), 0.25, 4);
  if (!gainNode || !audioCtx) return;
  gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  gainNode.gain.setTargetAtTime(pendingGain, audioCtx.currentTime, 0.12);
}

function _clearCanvas() {
  if (!ctx || !bgCanvas) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  ctx.restore();
}

function _startVisualizer() {
  if (!ctx) return;
  if (clearCanvasTimer) window.clearTimeout(clearCanvasTimer);
  clearCanvasTimer = null;
  document.body.classList.add("ambient-playing");
  lastRenderAt = 0;
  if (!frameRequest) drawVisualizer();
}

function _stopVisualizer() {
  document.body.classList.remove("ambient-playing");
  if (frameRequest) cancelAnimationFrame(frameRequest);
  frameRequest = null;
  visual.pulse = 0;
  visual.ripples.length = 0;
  if (clearCanvasTimer) window.clearTimeout(clearCanvasTimer);
  clearCanvasTimer = window.setTimeout(() => {
    _clearCanvas();
    clearCanvasTimer = null;
  }, AMBIENT_FADE_DURATION);
}

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
  if (!analyser) return;
  analyser.getByteFrequencyData(frequencyData);
  analyser.getByteTimeDomainData(timeData);

  const bass = _bandAverage(frequencyData, 0, 14);
  const lowMid = _bandAverage(frequencyData, 14, 52);
  const highMid = _bandAverage(frequencyData, 52, 118);
  const air = _bandAverage(frequencyData, 118, frequencyData.length);
  const rms = _computeRms(timeData);
  const centroid = _computeCentroid(frequencyData);
  const flux = _computeFlux(frequencyData);

  // Extraer 16 bandas discretas del espectro de audio para la malla fluida
  const binStep = Math.floor(frequencyData.length / 16);
  for (let i = 0; i < 16; i++) {
    const bandVal = _bandAverage(frequencyData, i * binStep, (i + 1) * binStep);
    targetBands[i] = bandVal;
    spectrumBands[i] = _smooth(spectrumBands[i], targetBands[i], 18, 5.0, dt);
  }

  visual.bass = _smooth(visual.bass, bass, 16, 3.5, dt);
  visual.lowMid = _smooth(visual.lowMid, lowMid, 13, 3.0, dt);
  visual.highMid = _smooth(visual.highMid, highMid, 11, 2.6, dt);
  visual.air = _smooth(visual.air, air, 9, 2.4, dt);
  visual.rms = _smooth(visual.rms, rms, 15, 3.2, dt);
  visual.centroid = _smooth(visual.centroid, centroid, 6, 4, dt);
  visual.flux = _smooth(visual.flux, flux, 18, 8, dt);

  const energy = _clamp(
    (visual.bass * 1.5 + visual.lowMid * 1.1 + visual.highMid * 0.95 + visual.air * 0.7 + visual.rms * 1.3) / 5.5,
    0,
    1
  );
  visual.energy = _smooth(visual.energy, Math.max(0.08, energy), 9, 2.5, dt);
  visual.beatFloor = _smooth(visual.beatFloor, visual.bass, 1.2, 0.7, dt);
}

function _sceneFocus(width, height, time, motionScale) {
  const scene = visual.scene;
  return {
    x: width * scene.focusX + Math.sin(time * 0.22 * scene.drift) * width * 0.08 * motionScale + (visual.centroid - 0.5) * width * 0.18,
    y: height * scene.focusY + Math.cos(time * 0.18 * scene.drift) * height * 0.09 * motionScale + (visual.rms - 0.16) * height * 0.15,
  };
}

// ------------------------------------------------------------
// CAPA 1: Fondo Base de Cosmos & Nébula Dinámica
// ------------------------------------------------------------
function _drawBaseWash(width, height, energy) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, _rgba(visual.palette.shadow, 0.55));
  gradient.addColorStop(0.5, _rgba(visual.palette.shadow, 0.35));
  gradient.addColorStop(1, _rgba(visual.palette.shadow, 0.60));
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function _drawAtmosphere(width, height, short, time, focus, motionScale) {
  const energy = visual.energy;
  const scene = visual.scene;

  const glows = [
    {
      x: focus.x - width * 0.15 + Math.sin(time * 0.18) * width * 0.07 * motionScale,
      y: focus.y - height * 0.12,
      rx: short * (0.55 + visual.bass * 0.25),
      ry: short * (0.40 + visual.bass * 0.18),
      rotation: scene.rotation - 0.2,
      color: visual.palette.primary,
      alpha: 0.18 + visual.bass * 0.16,
    },
    {
      x: focus.x + width * 0.20 + Math.cos(time * 0.15) * width * 0.08 * motionScale,
      y: focus.y + height * 0.04,
      rx: short * (0.48 + visual.lowMid * 0.22),
      ry: short * (0.36 + visual.lowMid * 0.15),
      rotation: scene.rotation + 0.4,
      color: visual.palette.secondary,
      alpha: 0.15 + visual.lowMid * 0.14,
    },
    {
      x: focus.x + Math.sin(time * 0.25 + 2.0) * width * 0.15 * motionScale,
      y: focus.y + height * 0.25,
      rx: short * (0.42 + visual.highMid * 0.20),
      ry: short * (0.30 + visual.highMid * 0.14),
      rotation: scene.rotation - 0.6,
      color: visual.palette.tertiary,
      alpha: 0.13 + visual.highMid * 0.12,
    },
  ];

  ctx.globalCompositeOperation = "screen";
  glows.slice(0, LOW_POWER_MODE ? 2 : 3).forEach((glow) => {
    ctx.save();
    ctx.translate(glow.x, glow.y);
    ctx.rotate(glow.rotation);
    ctx.scale(glow.rx, glow.ry);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, _rgba(glow.color, glow.alpha + energy * 0.04));
    grad.addColorStop(0.45, _rgba(glow.color, glow.alpha * 0.40));
    grad.addColorStop(1, _rgba(glow.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

// ------------------------------------------------------------
// CAPA 2: Geometría de Escena Procedural (6 Escenas Únicas)
// ------------------------------------------------------------
function _drawSceneGeometry(width, height, short, time, focus, motionScale) {
  const sceneId = visual.scene.id;

  switch (sceneId) {
    case "cybergrid":
      _drawCyberGrid(width, height, time, motionScale);
      break;
    case "supernova":
      _drawSupernovaCore(width, height, short, time, focus);
      break;
    case "hyperdrive":
      _drawHyperdriveRays(width, height, time, focus);
      break;
    case "vortex":
      _drawVortexSpiral(width, height, short, time, focus);
      break;
    case "galaxy":
      _drawGalaxySwirl(width, height, short, time, focus);
      break;
    case "aurora":
    default:
      _drawAuroraMesh(width, height, short, time, motionScale);
      break;
  }
}

// 1. Quantum Fluid Aurora Mesh
function _drawAuroraMesh(width, height, short, time, motionScale) {
  const scene = visual.scene;
  const speed = (0.50 + visual.energy * 1.40) * motionScale * visual.flowFreq;
  const segments = LOW_POWER_MODE ? 10 : 16;

  ctx.save();
  ctx.translate(width * scene.focusX, height * scene.focusY);
  ctx.rotate(scene.rotation + visual.flowAngle * 0.15 + (visual.centroid - 0.5) * 0.35);
  ctx.translate(-width * scene.focusX, -height * scene.focusY);
  ctx.globalCompositeOperation = "screen";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const veils = [
    { y: 0.28, waves: 2.2, speed: speed * 0.75, color: visual.palette.primary, alpha: 0.12 + visual.bass * 0.12, width: short * 0.14 },
    { y: 0.50, waves: 1.8, speed: speed * 0.60, color: visual.palette.secondary, alpha: 0.10 + visual.lowMid * 0.11, width: short * 0.16 },
    { y: 0.70, waves: 2.5, speed: speed * 0.90, color: visual.palette.tertiary, alpha: 0.09 + visual.highMid * 0.10, width: short * 0.12 },
  ];

  veils.slice(0, LOW_POWER_MODE ? 2 : 3).forEach((cfg, vIdx) => {
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const r = i / segments;
      const x = -width * 0.15 + r * width * 1.30;
      const bandMod = spectrumBands[i % 16] * height * 0.15;
      const y = height * cfg.y + Math.sin(r * Math.PI * cfg.waves + time * cfg.speed + vIdx) * (height * 0.08 + visual.bass * 60) + bandMod;
      points.push({ x, y });
    }

    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, _rgba(cfg.color, 0));
    gradient.addColorStop(0.3, _rgba(cfg.color, cfg.alpha * 0.65));
    gradient.addColorStop(0.6, _rgba(_mixColor(cfg.color, visual.palette.accent, 0.4), cfg.alpha));
    gradient.addColorStop(1, _rgba(cfg.color, 0));

    ctx.strokeStyle = gradient;
    ctx.lineWidth = cfg.width;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.stroke();
  });

  ctx.restore();
}

// 2. Cosmic Supernova Core
function _drawSupernovaCore(width, height, short, time, focus) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";

  const coreRadius = short * (0.16 + visual.bass * 0.28 + visual.pulse * 0.15);
  const color = _mixColor(visual.palette.primary, visual.palette.accent, 0.4);

  const grad = ctx.createRadialGradient(focus.x, focus.y, 0, focus.x, focus.y, coreRadius);
  grad.addColorStop(0, _rgba(color, 0.28 + visual.bass * 0.20));
  grad.addColorStop(0.5, _rgba(visual.palette.secondary, 0.12 + visual.lowMid * 0.10));
  grad.addColorStop(1, _rgba(visual.palette.shadow, 0));

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(focus.x, focus.y, coreRadius, 0, Math.PI * 2);
  ctx.fill();

  // Anillos orbitales
  const ringCount = LOW_POWER_MODE ? 2 : 4;
  for (let r = 0; r < ringCount; r++) {
    const ringRad = coreRadius * (1.3 + r * 0.45);
    const rot = time * (0.2 + r * 0.1) * (r % 2 === 0 ? 1 : -1);
    ctx.save();
    ctx.translate(focus.x, focus.y);
    ctx.rotate(rot);
    ctx.scale(1.0, 0.45 + r * 0.1);
    ctx.strokeStyle = _rgba(r % 2 === 0 ? visual.palette.tertiary : visual.palette.accent, 0.15 + visual.highMid * 0.12);
    ctx.lineWidth = 2 + r;
    ctx.beginPath();
    ctx.arc(0, 0, ringRad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

// 3. Cyber Waveform Grid (3D Perspective)
function _drawCyberGrid(width, height, time, motionScale) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";

  const horizonY = height * 0.55;
  const lines = LOW_POWER_MODE ? 12 : 20;

  ctx.strokeStyle = _rgba(visual.palette.secondary, 0.12 + visual.energy * 0.10);
  ctx.lineWidth = 1.5;

  // Líneas de perspectiva vertical
  for (let i = -lines; i <= lines; i++) {
    const x1 = width * 0.5 + i * (width / lines) * 0.1;
    const x2 = width * 0.5 + i * (width / lines) * 1.2;
    ctx.beginPath();
    ctx.moveTo(x1, horizonY);
    ctx.lineTo(x2, height);
    ctx.stroke();
  }

  // Líneas horizontales en movimiento con modulación por bandas de audio
  const horizCount = LOW_POWER_MODE ? 6 : 10;
  for (let j = 0; j < horizCount; j++) {
    const progress = (j / horizCount + (time * 0.4) % (1 / horizCount));
    const y = horizonY + progress * progress * (height - horizonY);
    const bandIdx = Math.floor(progress * 15);
    const offset = spectrumBands[bandIdx] * 40 * (progress * 1.5);

    ctx.strokeStyle = _rgba(_mixColor(visual.palette.primary, visual.palette.accent, progress), 0.14 * progress + visual.bass * 0.1);
    ctx.beginPath();
    ctx.moveTo(0, y - offset);
    ctx.lineTo(width, y - offset);
    ctx.stroke();
  }

  ctx.restore();
}

// 4. Bioluminescent Vortex
function _drawVortexSpiral(width, height, short, time, focus) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.translate(focus.x, focus.y);

  const arms = LOW_POWER_MODE ? 3 : 5;
  const points = 24;
  const maxRadius = short * 0.6;

  for (let a = 0; a < arms; a++) {
    const angleOffset = (a / arms) * Math.PI * 2 + time * 0.3;
    ctx.beginPath();
    for (let p = 0; p < points; p++) {
      const r = (p / points) * maxRadius;
      const angle = angleOffset + (p / points) * Math.PI * 2.5;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r * 0.6;
      if (p === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const color = a % 2 === 0 ? visual.palette.primary : visual.palette.tertiary;
    ctx.strokeStyle = _rgba(color, 0.12 + visual.lowMid * 0.12);
    ctx.lineWidth = short * 0.025;
    ctx.stroke();
  }

  ctx.restore();
}

// 5. Hyperdrive Light Rays
function _drawHyperdriveRays(width, height, time, focus) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";

  const rayCount = LOW_POWER_MODE ? 10 : 20;
  const angleStep = (Math.PI * 2) / rayCount;

  for (let i = 0; i < rayCount; i++) {
    const angle = i * angleStep + time * 0.1;
    const rayLength = Math.max(width, height) * (0.6 + Math.sin(angle * 3 + time) * 0.2 + visual.bass * 0.3);
    const x2 = focus.x + Math.cos(angle) * rayLength;
    const y2 = focus.y + Math.sin(angle) * rayLength;

    const grad = ctx.createLinearGradient(focus.x, focus.y, x2, y2);
    const color = i % 3 === 0 ? visual.palette.primary : i % 3 === 1 ? visual.palette.secondary : visual.palette.accent;
    grad.addColorStop(0, _rgba(color, 0.20 + visual.energy * 0.15));
    grad.addColorStop(0.5, _rgba(color, 0.08));
    grad.addColorStop(1, _rgba(color, 0));

    ctx.strokeStyle = grad;
    ctx.lineWidth = 12 + Math.sin(i + time * 2) * 6;
    ctx.beginPath();
    ctx.moveTo(focus.x, focus.y);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.restore();
}

// 6. Starlight Galaxy Field
function _drawGalaxySwirl(width, height, short, time, focus) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.translate(focus.x, focus.y);

  const starCount = LOW_POWER_MODE ? 20 : 45;
  for (let i = 0; i < starCount; i++) {
    const angle = i * 0.3 + time * (0.2 + (i % 5) * 0.05);
    const dist = (0.1 + (i / starCount) * 0.85) * short * 0.55;
    const x = Math.cos(angle) * dist;
    const y = Math.sin(angle) * dist * 0.7;
    const size = 1.5 + (i % 3) * 1.5 + visual.air * 2;

    ctx.fillStyle = _rgba(i % 2 === 0 ? visual.palette.accent : visual.palette.primary, 0.25 + visual.air * 0.35);
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ------------------------------------------------------------
// CAPA 3: Ecualizador de Espectro Fluido (Spectrum Equalizer Ribbon)
// ------------------------------------------------------------
function _drawSpectrumRibbon(width, height, short, time) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.lineCap = "round";

  const points = 16;
  const step = width / (points - 1);
  const baselineY = height * 0.82;

  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const x = i * step;
    const h = spectrumBands[i] * height * 0.25;
    const y = baselineY - h;

    if (i === 0) ctx.moveTo(x, y);
    else {
      const prevX = (i - 1) * step;
      const mx = (prevX + x) / 2;
      ctx.quadraticCurveTo(prevX, baselineY - spectrumBands[i - 1] * height * 0.25, mx, y);
    }
  }

  const grad = ctx.createLinearGradient(0, baselineY - height * 0.25, width, baselineY);
  grad.addColorStop(0, _rgba(visual.palette.primary, 0.12 + visual.bass * 0.15));
  grad.addColorStop(0.5, _rgba(visual.palette.accent, 0.18 + visual.highMid * 0.15));
  grad.addColorStop(1, _rgba(visual.palette.tertiary, 0.12 + visual.air * 0.15));

  ctx.strokeStyle = grad;
  ctx.lineWidth = short * 0.015;
  ctx.stroke();

  ctx.restore();
}

// ------------------------------------------------------------
// CAPA 4: Campo de Partículas de Turbulencia Vectorial
// ------------------------------------------------------------
function _drawStarlight(width, height, time, dt) {
  if (!particles.length) return;

  ctx.save();
  ctx.globalCompositeOperation = "screen";

  const speedMult = 1 + visual.highMid * 1.8 + visual.air * 2.5;
  const brightnessMult = 0.7 + visual.air * 0.9 + visual.pulse * 0.6;

  particles.forEach((p) => {
    p.y += p.vy * dt * speedMult;
    p.x += p.vx * dt * speedMult;

    // Reciclar partícula
    if (p.y < -0.05) p.y = 1.05;
    if (p.y > 1.05) p.y = -0.05;
    if (p.x < -0.05) p.x = 1.05;
    if (p.x > 1.05) p.x = -0.05;

    const px = p.x * width;
    const py = p.y * height;
    const shimmer = Math.sin(time * 3 + p.phase) * 0.35 + 0.65;
    const alpha = _clamp(p.alpha * brightnessMult * shimmer, 0.05, 0.90);

    const rad = p.size * (1 + visual.air * 0.6);
    ctx.fillStyle = _rgba(visual.palette.accent, alpha);
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.restore();
}

// ------------------------------------------------------------
// CAPA 5: Beat Shockwaves & Aberración Cromática Sutil
// ------------------------------------------------------------
function _spawnRipple(focus, short) {
  visual.ripples.push({
    x: focus.x,
    y: focus.y,
    radius: short * 0.08,
    life: 1,
    colorA: visual.palette.primary,
    colorB: visual.palette.accent,
  });
  if (visual.ripples.length > (LOW_POWER_MODE ? 2 : 4)) visual.ripples.shift();
}

function _drawRipples(short, dt) {
  if (!visual.ripples.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  visual.ripples = visual.ripples.filter((ripple) => ripple.life > 0.025);
  visual.ripples.forEach((ripple) => {
    ripple.radius += (short * 0.25 + visual.energy * short * 0.18) * dt;
    ripple.life *= Math.exp(-2.5 * dt);

    // Aberración cromática doble anillo
    ctx.strokeStyle = _rgba(ripple.colorA, ripple.life * 0.14);
    ctx.lineWidth = short * 0.012 * ripple.life;
    ctx.beginPath();
    ctx.arc(ripple.x - 3, ripple.y, ripple.radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = _rgba(ripple.colorB, ripple.life * 0.14);
    ctx.beginPath();
    ctx.arc(ripple.x + 3, ripple.y, ripple.radius * 1.02, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();
}

function _drawPulseBloom(short, focus) {
  if (visual.pulse < 0.02) return;
  const radius = short * (0.22 + visual.pulse * 0.28);
  const color = _mixColor(visual.palette.accent, [255, 255, 255], 0.30);
  const gradient = ctx.createRadialGradient(focus.x, focus.y, 0, focus.x, focus.y, radius);
  gradient.addColorStop(0, _rgba(color, visual.pulse * 0.14));
  gradient.addColorStop(0.45, _rgba(color, visual.pulse * 0.05));
  gradient.addColorStop(1, _rgba(color, 0));
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(focus.x, focus.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

// ------------------------------------------------------------
// CAPA 6: Máscara de Viñeta Oscura Integrada (Garantiza Legibilidad UI)
// ------------------------------------------------------------
function _drawCenterVignette(width, height) {
  const gradient = ctx.createRadialGradient(width * 0.5, height * 0.5, height * 0.18, width * 0.5, height * 0.5, Math.max(width, height) * 0.75);
  gradient.addColorStop(0, "rgba(6, 8, 12, 0.28)");
  gradient.addColorStop(0.55, "rgba(6, 8, 12, 0.52)");
  gradient.addColorStop(1, "rgba(6, 8, 12, 0.78)");

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function _updateCss(time, motionScale) {
  const scene = visual.scene;
  const energy = visual.energy;
  const driftX = Math.sin(time * 0.28 * scene.drift) * (24 + energy * 46) * motionScale + (visual.centroid - 0.5) * 70;
  const driftY = Math.cos(time * 0.22 * scene.drift) * (20 + energy * 36) * motionScale + (visual.rms - 0.16) * 50;
  const intensity = _clamp(0.26 + energy * 0.55 + visual.flux * 0.14, 0.22, 0.80);
  const beatScale = _clamp(visual.pulse * 0.040, 0, 0.06);
  const rotation = scene.rotation * 40 + Math.sin(time * 0.14) * 6;

  const targets = [ambientOverlay, ambientArtwork, nowPlaying].filter(Boolean);
  targets.forEach((target) => {
    target.style.setProperty("--ambient-intensity", intensity.toFixed(3));
    target.style.setProperty("--ambient-beat-scale", beatScale.toFixed(3));
    target.style.setProperty("--ambient-shift-x", `${driftX.toFixed(1)}px`);
    target.style.setProperty("--ambient-shift-y", `${driftY.toFixed(1)}px`);
    target.style.setProperty("--ambient-local-x", `${(driftX * 0.25).toFixed(1)}px`);
    target.style.setProperty("--ambient-local-y", `${(driftY * 0.18).toFixed(1)}px`);
    target.style.setProperty("--ambient-rotate", `${rotation.toFixed(2)}deg`);
  });
}

function _adaptQuality(renderCost, now) {
  averageRenderCost = averageRenderCost ? averageRenderCost * 0.94 + renderCost * 0.06 : renderCost;
  if (now - qualityCheckAt < 2200 || LOW_POWER_MODE || reduceMotionQuery.matches) return;
  qualityCheckAt = now;

  if (averageRenderCost > 14 && quality > 0.72) {
    quality = 0.72;
    frameInterval = 1000 / DEGRADED_FPS;
    scheduleCanvasResize();
  } else if (averageRenderCost < 6.5 && quality < 1) {
    quality = 1;
    frameInterval = 1000 / NORMAL_FPS;
    scheduleCanvasResize();
  }
}

// Bucle Principal de Renderizado 60 FPS
function drawVisualizer(frameAt = performance.now()) {
  if (!ctx || document.hidden || audioPlayer.paused) {
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
  const motionScale = reduceMotionQuery.matches ? 0.12 : 1;

  beatCooldown = Math.max(0, beatCooldown - dt);
  _readAudio(dt);
  _lerpPalette(dt);
  const focus = _sceneFocus(width, height, time, motionScale);
  const transient = visual.bass - visual.beatFloor;

  if (!reduceMotionQuery.matches && beatCooldown === 0 && visual.bass > 0.30 && transient > 0.028 && visual.flux > 0.06) {
    visual.pulse = _clamp(visual.pulse + 0.45 + visual.flux * 0.32, 0, 1);
    _spawnRipple(focus, short);
    beatCooldown = 0.18;
  }
  visual.pulse *= Math.exp(-4.5 * dt);

  ctx.clearRect(0, 0, width, height);

  // Renderizado por capas (Paralaje & Dinamismo HD)
  _drawBaseWash(width, height, visual.energy);
  _drawAtmosphere(width, height, short, time, focus, motionScale);
  _drawSceneGeometry(width, height, short, time, focus, motionScale);
  _drawSpectrumRibbon(width, height, short, time);
  _drawStarlight(width, height, time, dt);
  _drawRipples(short, dt);
  _drawPulseBloom(short, focus);
  _drawCenterVignette(width, height);

  ctx.globalCompositeOperation = "source-over";

  if (frameAt - lastCssUpdateAt >= CSS_UPDATE_INTERVAL) {
    _updateCss(time, motionScale);
    lastCssUpdateAt = frameAt;
  }
  _adaptQuality(performance.now() - renderStartedAt, frameAt);
}

resizeCanvas();
_setSong({ title: DEFAULT_SONG_KEY });
_clearCanvas();
document.body.classList.toggle("ambient-low-power", LOW_POWER_MODE);

window.addEventListener("resize", scheduleCanvasResize, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (frameRequest) cancelAnimationFrame(frameRequest);
    frameRequest = null;
  } else if (!audioPlayer.paused) {
    _startVisualizer();
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
