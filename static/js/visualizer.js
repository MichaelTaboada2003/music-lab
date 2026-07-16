// ============================================================
// visualizer.js — fondo inmersivo reactivo al audio (Web Audio API)
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

const NORMAL_FPS = reduceMotionQuery.matches ? 15 : LOW_POWER_MODE ? 24 : 40;
const DEGRADED_FPS = reduceMotionQuery.matches ? 12 : 24;
const CSS_UPDATE_INTERVAL = LOW_POWER_MODE ? 120 : 80;
const AMBIENT_FADE_DURATION = 560;
const BASE_PIXEL_BUDGET = LOW_POWER_MODE ? 620_000 : 1_050_000;
const MOBILE_PIXEL_BUDGET = LOW_POWER_MODE ? 340_000 : 520_000;

const SCENES = [
  { id: "horizon", focusX: 0.36, focusY: 0.42, rotation: -0.16, drift: 1.0, spread: 0.92, phase: 0.3 },
  { id: "eclipse", focusX: 0.60, focusY: 0.38, rotation: 0.38, drift: 0.86, spread: 0.78, phase: 1.8 },
  { id: "prism", focusX: 0.64, focusY: 0.30, rotation: -0.58, drift: 1.12, spread: 1.02, phase: 2.9 },
  { id: "tidal", focusX: 0.44, focusY: 0.66, rotation: 0.12, drift: 0.96, spread: 1.08, phase: 4.4 },
];

let audioCtx;
let analyser;
let source;
let gainNode;
let pendingGain = 1;
let frequencyData;
let timeData;
let previousSpectrum;
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
};

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
  const hue = _hashString(songKey) % 360;
  return {
    primary: _hslToRgb(hue, 82, 58),
    secondary: _hslToRgb(hue + 48, 78, 60),
    tertiary: _hslToRgb(hue + 116, 72, 60),
    accent: _hslToRgb(hue + 188, 70, 68),
    shadow: _hslToRgb(hue + 14, 38, 18),
  };
}

function _paletteFromArtwork(colors) {
  const [primary, secondary, tertiary] = colors;
  return {
    primary: _mixColor(primary, [255, 255, 255], 0.08),
    secondary: _mixColor(secondary, [255, 255, 255], 0.06),
    tertiary: _mixColor(tertiary, [255, 255, 255], 0.10),
    accent: _mixColor(secondary, tertiary, 0.52),
    shadow: _mixColor(primary, [6, 8, 13], 0.72),
  };
}

function _sceneFromKey(songKey) {
  return SCENES[_hashString(songKey) % SCENES.length];
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
  analyser.smoothingTimeConstant = 0.70;
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
  analyser.getByteFrequencyData(frequencyData);
  analyser.getByteTimeDomainData(timeData);

  const bass = _bandAverage(frequencyData, 0, 12);
  const lowMid = _bandAverage(frequencyData, 12, 48);
  const highMid = _bandAverage(frequencyData, 48, 112);
  const air = _bandAverage(frequencyData, 112, frequencyData.length);
  const rms = _computeRms(timeData);
  const centroid = _computeCentroid(frequencyData);
  const flux = _computeFlux(frequencyData);

  visual.bass = _smooth(visual.bass, bass, 15, 3.2, dt);
  visual.lowMid = _smooth(visual.lowMid, lowMid, 12, 2.8, dt);
  visual.highMid = _smooth(visual.highMid, highMid, 10, 2.5, dt);
  visual.air = _smooth(visual.air, air, 8, 2.2, dt);
  visual.rms = _smooth(visual.rms, rms, 14, 3.1, dt);
  visual.centroid = _smooth(visual.centroid, centroid, 5, 4, dt);
  visual.flux = _smooth(visual.flux, flux, 17, 7, dt);

  const energy = _clamp(
    (visual.bass * 1.42 + visual.lowMid * 1.12 + visual.highMid * 0.90 + visual.air * 0.62 + visual.rms * 1.24) / 5.30,
    0,
    1
  );
  visual.energy = _smooth(visual.energy, Math.max(0.07, energy), 8.5, 2.4, dt);
  visual.beatFloor = _smooth(visual.beatFloor, visual.bass, 1.1, 0.65, dt);
}

function _sceneFocus(width, height, time, motionScale) {
  const scene = visual.scene;
  return {
    x: width * scene.focusX + Math.sin(time * 0.20 * scene.drift + scene.phase) * width * 0.075 * motionScale + (visual.centroid - 0.5) * width * 0.20,
    y: height * scene.focusY + Math.cos(time * 0.16 * scene.drift + scene.phase * 1.2) * height * 0.085 * motionScale + (visual.rms - 0.16) * height * 0.17,
  };
}

function _drawBaseWash(width, height, energy) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, _rgba(visual.palette.primary, 0.16 + energy * 0.07));
  gradient.addColorStop(0.48, _rgba(visual.palette.shadow, 0.10));
  gradient.addColorStop(1, _rgba(visual.palette.tertiary, 0.15 + energy * 0.06));
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function _drawGlow(x, y, radiusX, radiusY, rotation, color, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.scale(radiusX, radiusY);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, _rgba(color, alpha));
  gradient.addColorStop(0.42, _rgba(color, alpha * 0.44));
  gradient.addColorStop(1, _rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function _drawAtmosphere(width, height, short, time, focus, motionScale) {
  const energy = visual.energy;
  const scene = visual.scene;
  const glows = [
    {
      x: focus.x - width * 0.20 + Math.sin(time * 0.17 + scene.phase) * width * 0.08 * motionScale,
      y: focus.y - height * 0.16,
      rx: short * (0.54 + visual.bass * 0.20),
      ry: short * (0.42 + visual.bass * 0.13),
      rotation: scene.rotation - 0.35,
      color: visual.palette.primary,
      alpha: 0.22 + visual.bass * 0.15,
    },
    {
      x: focus.x + width * 0.24 + Math.cos(time * 0.14 + scene.phase) * width * 0.10 * motionScale,
      y: focus.y + height * 0.02,
      rx: short * (0.50 + visual.lowMid * 0.18),
      ry: short * (0.38 + visual.lowMid * 0.12),
      rotation: scene.rotation + 0.55,
      color: visual.palette.secondary,
      alpha: 0.20 + visual.lowMid * 0.14,
    },
    {
      x: focus.x + Math.sin(time * 0.23 + 2.1) * width * 0.18 * motionScale,
      y: focus.y + height * 0.30,
      rx: short * (0.44 + visual.highMid * 0.15),
      ry: short * (0.32 + visual.highMid * 0.10),
      rotation: scene.rotation - 0.8,
      color: visual.palette.tertiary,
      alpha: 0.17 + visual.highMid * 0.12,
    },
  ];

  ctx.globalCompositeOperation = "screen";
  glows.slice(0, LOW_POWER_MODE ? 2 : 3).forEach((glow) =>
    _drawGlow(glow.x, glow.y, glow.rx, glow.ry, glow.rotation, glow.color, glow.alpha + energy * 0.04)
  );
}

function _flowPoints(width, height, time, config) {
  const points = [];
  const segments = LOW_POWER_MODE ? 7 : 10;
  for (let index = 0; index <= segments; index++) {
    const ratio = index / segments;
    const x = -width * 0.12 + ratio * width * 1.24;
    const wave =
      Math.sin(ratio * Math.PI * config.waves + time * config.speed + config.phase) * config.amplitude +
      Math.cos(ratio * Math.PI * (config.waves * 0.54) - time * config.speed * 0.68 + config.phase) * config.amplitude * 0.34;
    points.push({ x, y: height * config.y + wave });
  }
  return points;
}

function _strokeSmoothPath(points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length - 1; index++) {
    const midpointX = (points[index].x + points[index + 1].x) / 2;
    const midpointY = (points[index].y + points[index + 1].y) / 2;
    ctx.quadraticCurveTo(points[index].x, points[index].y, midpointX, midpointY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function _drawFlowVeils(width, height, short, time, motionScale) {
  const scene = visual.scene;
  const speed = (0.48 + visual.energy * 1.45) * motionScale;
  const configs = [
    { y: 0.28, waves: 2.2, speed: speed * 0.78, phase: scene.phase, amplitude: height * (0.08 + visual.bass * 0.10), color: visual.palette.primary, alpha: 0.12 + visual.bass * 0.10, width: short * (0.15 + visual.bass * 0.055) },
    { y: 0.52, waves: 1.8, speed: speed * 0.60, phase: scene.phase + 1.8, amplitude: height * (0.10 + visual.lowMid * 0.11), color: visual.palette.secondary, alpha: 0.11 + visual.lowMid * 0.10, width: short * (0.17 + visual.lowMid * 0.06) },
    { y: 0.73, waves: 2.6, speed: speed * 0.92, phase: scene.phase + 3.5, amplitude: height * (0.07 + visual.highMid * 0.09), color: visual.palette.tertiary, alpha: 0.09 + visual.highMid * 0.09, width: short * (0.12 + visual.highMid * 0.05) },
  ];

  ctx.save();
  ctx.translate(width * scene.focusX, height * scene.focusY);
  ctx.rotate(scene.rotation + (visual.centroid - 0.5) * 0.44 + Math.sin(time * 0.11 + scene.phase) * 0.08);
  ctx.translate(-width * scene.focusX, -height * scene.focusY);
  ctx.globalCompositeOperation = "screen";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  configs.slice(0, LOW_POWER_MODE ? 2 : 3).forEach((config) => {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, _rgba(config.color, 0));
    gradient.addColorStop(0.20, _rgba(config.color, config.alpha * 0.62));
    gradient.addColorStop(0.52, _rgba(_mixColor(config.color, visual.palette.accent, 0.30), config.alpha));
    gradient.addColorStop(0.82, _rgba(config.color, config.alpha * 0.54));
    gradient.addColorStop(1, _rgba(config.color, 0));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = config.width;
    ctx.shadowColor = _rgba(config.color, config.alpha * 0.65);
    ctx.shadowBlur = LOW_POWER_MODE ? 0 : 18;
    _strokeSmoothPath(_flowPoints(width, height, time, config));
  });
  ctx.restore();
}

function _spawnRipple(focus, short) {
  visual.ripples.push({
    x: focus.x,
    y: focus.y,
    radius: short * 0.09,
    life: 1,
    color: _mixColor(visual.palette.secondary, visual.palette.accent, 0.48),
  });
  if (visual.ripples.length > (LOW_POWER_MODE ? 1 : 3)) visual.ripples.shift();
}

function _drawRipples(short, dt) {
  if (!visual.ripples.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  visual.ripples = visual.ripples.filter((ripple) => ripple.life > 0.025);
  visual.ripples.forEach((ripple) => {
    ripple.radius += (short * 0.24 + visual.energy * short * 0.12) * dt;
    ripple.life *= Math.exp(-2.2 * dt);
    ctx.strokeStyle = _rgba(ripple.color, ripple.life * 0.14);
    ctx.lineWidth = short * 0.012 * ripple.life;
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();
}

function _drawPulseBloom(short, focus) {
  if (visual.pulse < 0.02) return;
  const radius = short * (0.22 + visual.pulse * 0.26);
  const color = _mixColor(visual.palette.accent, [255, 255, 255], 0.22);
  const gradient = ctx.createRadialGradient(focus.x, focus.y, 0, focus.x, focus.y, radius);
  gradient.addColorStop(0, _rgba(color, visual.pulse * 0.13));
  gradient.addColorStop(0.48, _rgba(color, visual.pulse * 0.045));
  gradient.addColorStop(1, _rgba(color, 0));
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(focus.x, focus.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function _updateCss(time, motionScale) {
  const scene = visual.scene;
  const energy = visual.energy;
  const driftX = Math.sin(time * 0.24 * scene.drift + scene.phase) * (28 + energy * 54) * motionScale + (visual.centroid - 0.5) * 82;
  const driftY = Math.cos(time * 0.19 * scene.drift + scene.phase) * (22 + energy * 40) * motionScale + (visual.rms - 0.16) * 62;
  const intensity = _clamp(0.28 + energy * 0.64 + visual.flux * 0.14, 0.26, 0.88);
  const beatScale = _clamp(visual.pulse * 0.045, 0, 0.06);
  const rotation = scene.rotation * 42 + Math.sin(time * 0.15 + scene.phase) * 7;

  const targets = [ambientOverlay, ambientArtwork, nowPlaying].filter(Boolean);
  targets.forEach((target) => {
    target.style.setProperty("--ambient-intensity", intensity.toFixed(3));
    target.style.setProperty("--ambient-beat-scale", beatScale.toFixed(3));
    target.style.setProperty("--ambient-shift-x", `${driftX.toFixed(1)}px`);
    target.style.setProperty("--ambient-shift-y", `${driftY.toFixed(1)}px`);
    target.style.setProperty("--ambient-local-x", `${(driftX * 0.30).toFixed(1)}px`);
    target.style.setProperty("--ambient-local-y", `${(driftY * 0.22).toFixed(1)}px`);
    target.style.setProperty("--ambient-rotate", `${rotation.toFixed(2)}deg`);
  });
}

function _adaptQuality(renderCost, now) {
  averageRenderCost = averageRenderCost ? averageRenderCost * 0.94 + renderCost * 0.06 : renderCost;
  if (now - qualityCheckAt < 2200 || LOW_POWER_MODE || reduceMotionQuery.matches) return;
  qualityCheckAt = now;

  if (averageRenderCost > 13 && quality > 0.72) {
    quality = 0.72;
    frameInterval = 1000 / DEGRADED_FPS;
    scheduleCanvasResize();
  } else if (averageRenderCost < 7 && quality < 1) {
    quality = 1;
    frameInterval = 1000 / NORMAL_FPS;
    scheduleCanvasResize();
  }
}

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
  const dt = Math.min(elapsed / 1000, 0.12);
  const width = window.innerWidth;
  const height = window.innerHeight;
  const short = Math.min(width, height);
  const time = frameAt / 1000;
  const motionScale = reduceMotionQuery.matches ? 0.14 : 1;

  beatCooldown = Math.max(0, beatCooldown - dt);
  _readAudio(dt);
  _lerpPalette(dt);
  const focus = _sceneFocus(width, height, time, motionScale);
  const transient = visual.bass - visual.beatFloor;

  if (!reduceMotionQuery.matches && beatCooldown === 0 && visual.bass > 0.34 && transient > 0.035 && visual.flux > 0.08) {
    visual.pulse = _clamp(visual.pulse + 0.46 + visual.flux * 0.34, 0, 1);
    _spawnRipple(focus, short);
    beatCooldown = 0.18;
  }
  visual.pulse *= Math.exp(-4.2 * dt);

  ctx.clearRect(0, 0, width, height);
  _drawBaseWash(width, height, visual.energy);
  _drawAtmosphere(width, height, short, time, focus, motionScale);
  _drawFlowVeils(width, height, short, time, motionScale);
  _drawRipples(short, dt);
  _drawPulseBloom(short, focus);
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
