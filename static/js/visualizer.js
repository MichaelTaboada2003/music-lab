// ============================================================
// visualizer.js — aurora ambiental reactiva al audio (Web Audio API)
// ============================================================

import { audioPlayer } from "./player.js";

const DEFAULT_SONG_KEY = "Music Lab Ambient";
const AMBIENT_ROOT = document.documentElement;
const bgCanvas = document.getElementById("bgCanvas");
const ctx = bgCanvas ? bgCanvas.getContext("2d") : null;
const ambientOverlay = document.querySelector(".bg-overlay");
const nowPlaying = document.querySelector(".now-playing");
const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const deviceMemory = Number(navigator.deviceMemory) || 8;
const cpuCores = Number(navigator.hardwareConcurrency) || 8;
const LOW_POWER_MODE = reduceMotionQuery.matches || deviceMemory <= 4 || cpuCores <= 4;
const ACTIVE_FRAME_INTERVAL = 1000 / (LOW_POWER_MODE ? 18 : 24);
const CSS_UPDATE_INTERVAL = LOW_POWER_MODE ? 180 : 130;
const AMBIENT_FADE_DURATION = 320;
const DESKTOP_PIXEL_BUDGET = LOW_POWER_MODE ? 850_000 : 1_300_000;
const MOBILE_PIXEL_BUDGET = LOW_POWER_MODE ? 360_000 : 560_000;

const SCENES = [
  {
    id: "horizon",
    focusX: 0.34,
    focusY: 0.36,
    ribbonRotation: -0.16,
    beamRotation: 0.26,
    motion: 1.0,
    spread: 0.88,
    phase: 0.3,
  },
  {
    id: "eclipse",
    focusX: 0.56,
    focusY: 0.42,
    ribbonRotation: 0.44,
    beamRotation: -0.14,
    motion: 0.88,
    spread: 0.74,
    phase: 1.8,
  },
  {
    id: "prism",
    focusX: 0.62,
    focusY: 0.30,
    ribbonRotation: -0.68,
    beamRotation: 0.84,
    motion: 1.12,
    spread: 0.92,
    phase: 2.9,
  },
  {
    id: "tidal",
    focusX: 0.46,
    focusY: 0.68,
    ribbonRotation: 0.14,
    beamRotation: 0.08,
    motion: 0.96,
    spread: 1.04,
    phase: 4.4,
  },
];

let audioCtx;
let analyser;
let source;
let gainNode;
let pendingGain = 1;
let dataArray;
let timeDataArray;
let bufferLength;
let visualizerRAF = null;
let lastRenderAt = 0;
let lastCssUpdateAt = 0;
let beatCooldown = 0;
let clearCanvasTimer = null;
let resizeRAF = null;

const _viz = {
  bass: 0,
  mid: 0,
  high: 0,
  presence: 0,
  rms: 0,
  centroid: 0.5,
  flux: 0,
  flash: 0,
  seed: _hashString(DEFAULT_SONG_KEY),
  currentPalette: _buildPalette(DEFAULT_SONG_KEY),
  targetPalette: _buildPalette(DEFAULT_SONG_KEY),
  scene: _sceneFromKey(DEFAULT_SONG_KEY),
  previousSpectrum: null,
  ripples: [],
};

function resizeCanvas() {
  if (!bgCanvas || !ctx) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pixelBudget = width <= 768 ? MOBILE_PIXEL_BUDGET : DESKTOP_PIXEL_BUDGET;
  const budgetScale = Math.sqrt(pixelBudget / Math.max(1, width * height));
  const renderScale = Math.min(
    window.devicePixelRatio || 1,
    LOW_POWER_MODE ? 0.82 : 1,
    budgetScale
  );

  bgCanvas.width = Math.floor(width * renderScale);
  bgCanvas.height = Math.floor(height * renderScale);
  bgCanvas.style.width = `${width}px`;
  bgCanvas.style.height = `${height}px`;
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
}

function scheduleCanvasResize() {
  if (resizeRAF) return;
  resizeRAF = requestAnimationFrame(() => {
    resizeRAF = null;
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
  analyser.smoothingTimeConstant = 0.76;
  bufferLength = analyser.frequencyBinCount;
  dataArray = new Uint8Array(bufferLength);
  timeDataArray = new Uint8Array(bufferLength);
  _viz.previousSpectrum = new Float32Array(bufferLength);

  source = audioCtx.createMediaElementSource(audioPlayer);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = pendingGain;
  source.connect(gainNode);
  gainNode.connect(analyser);
  analyser.connect(audioCtx.destination);
}

function setTrackGain(gainDb) {
  const value = Number(gainDb) || 0;
  pendingGain = _clamp(Math.pow(10, value / 20), 0.25, 4);
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
  if (clearCanvasTimer) {
    window.clearTimeout(clearCanvasTimer);
    clearCanvasTimer = null;
  }

  document.body.classList.add("ambient-playing");
  lastRenderAt = 0;
  if (!visualizerRAF) drawVisualizer();
}

function _stopVisualizer() {
  document.body.classList.remove("ambient-playing");
  if (visualizerRAF) cancelAnimationFrame(visualizerRAF);
  visualizerRAF = null;
  _viz.flash = 0;
  _viz.ripples.length = 0;

  if (clearCanvasTimer) window.clearTimeout(clearCanvasTimer);
  clearCanvasTimer = window.setTimeout(() => {
    _clearCanvas();
    clearCanvasTimer = null;
  }, AMBIENT_FADE_DURATION);
}

function _bandAvg(data, from, to) {
  let sum = 0;
  const end = Math.min(to, data.length);
  for (let i = from; i < end; i++) sum += data[i];
  return sum / Math.max(1, end - from) / 255;
}

function _hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function _clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function _hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = _clamp(s, 0, 100) / 100;
  const lig = _clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function _mixColor(from, to, amount) {
  return from.map((value, index) =>
    Math.round(value + (to[index] - value) * amount)
  );
}

function _rgba(color, alpha) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

function _buildPalette(songKey) {
  const seed = _hashString(songKey);
  const baseHue = seed % 360;
  return {
    primary: _hslToRgb(baseHue, 86, 58),
    secondary: _hslToRgb(baseHue + 54, 82, 60),
    tertiary: _hslToRgb(baseHue + 124, 78, 62),
    accent: _hslToRgb(baseHue + 192, 72, 66),
    shadow: _hslToRgb(baseHue + 18, 54, 24),
  };
}

function _sceneFromKey(songKey) {
  return SCENES[_hashString(songKey) % SCENES.length];
}

function _songKeyFromDetail(detail) {
  const title = detail?.title || DEFAULT_SONG_KEY;
  const filename = detail?.filename || "";
  return [title, filename].filter(Boolean).join("::");
}

function _setAmbientPalette(songKey) {
  const resolvedKey = songKey || DEFAULT_SONG_KEY;
  const palette = _buildPalette(resolvedKey);
  const scene = _sceneFromKey(resolvedKey);

  _viz.targetPalette = palette;
  _viz.seed = _hashString(resolvedKey);
  _viz.scene = scene;

  AMBIENT_ROOT.style.setProperty("--ambient-primary", palette.primary.join(", "));
  AMBIENT_ROOT.style.setProperty("--ambient-secondary", palette.secondary.join(", "));
  AMBIENT_ROOT.style.setProperty("--ambient-tertiary", palette.tertiary.join(", "));
  document.body.dataset.ambientScene = scene.id;
}

function _lerpPalette() {
  _viz.currentPalette.primary = _mixColor(
    _viz.currentPalette.primary,
    _viz.targetPalette.primary,
    0.06
  );
  _viz.currentPalette.secondary = _mixColor(
    _viz.currentPalette.secondary,
    _viz.targetPalette.secondary,
    0.06
  );
  _viz.currentPalette.tertiary = _mixColor(
    _viz.currentPalette.tertiary,
    _viz.targetPalette.tertiary,
    0.06
  );
  _viz.currentPalette.accent = _mixColor(
    _viz.currentPalette.accent,
    _viz.targetPalette.accent,
    0.06
  );
  _viz.currentPalette.shadow = _mixColor(
    _viz.currentPalette.shadow,
    _viz.targetPalette.shadow,
    0.06
  );
}

function _computeRms(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const centered = (data[i] - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / Math.max(1, data.length));
}

function _computeSpectralCentroid(data) {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < data.length; i++) {
    const value = data[i] / 255;
    weighted += value * i;
    total += value;
  }
  if (!total) return 0.5;
  return weighted / total / Math.max(1, data.length - 1);
}

function _computeSpectralFlux(data) {
  if (!_viz.previousSpectrum) return 0;

  let flux = 0;
  for (let i = 0; i < data.length; i++) {
    const normalized = data[i] / 255;
    const diff = normalized - _viz.previousSpectrum[i];
    if (diff > 0) flux += diff;
    _viz.previousSpectrum[i] = normalized;
  }

  return _clamp(flux / Math.max(1, data.length * 0.16), 0, 1);
}

function _getSceneFocus(w, h, t, scene, energy, motionScale) {
  const centroidOffset = (_viz.centroid - 0.5) * w * 0.22;
  const rmsOffset = (_viz.rms - 0.18) * h * 0.22;

  return {
    x:
      w * scene.focusX +
      Math.sin(t * (0.22 + scene.motion * 0.04) + scene.phase) *
        (w * 0.065 * motionScale) +
      centroidOffset,
    y:
      h * scene.focusY +
      Math.cos(t * (0.18 + scene.motion * 0.05) + scene.phase * 1.2) *
        (h * 0.075 * motionScale) +
      rmsOffset,
  };
}

function _spawnRipple(focus, energy, short) {
  _viz.ripples.push({
    x: focus.x,
    y: focus.y,
    radius: short * (0.10 + energy * 0.05),
    alpha: 0.16 + energy * 0.18,
    lineWidth: 10 + energy * 14,
    color: _mixColor(
      _viz.currentPalette.secondary,
      _viz.currentPalette.accent,
      0.46
    ),
    life: 1,
  });

  if (_viz.ripples.length > (LOW_POWER_MODE ? 3 : 6)) _viz.ripples.shift();
}

function _drawRibbon(w, t, config) {
  const gradient = ctx.createLinearGradient(
    0,
    config.yBase,
    w,
    config.yBase + config.amplitude
  );
  gradient.addColorStop(0, _rgba(config.color, 0));
  gradient.addColorStop(0.16, _rgba(config.color, config.alpha));
  gradient.addColorStop(
    0.50,
    _rgba(
      _mixColor(config.color, _viz.currentPalette.accent, 0.38),
      config.alpha * 1.08
    )
  );
  gradient.addColorStop(0.84, _rgba(config.color, config.alpha * 0.78));
  gradient.addColorStop(1, _rgba(config.color, 0));

  ctx.beginPath();
  for (let x = -80; x <= w + 80; x += 32) {
    const waveA = Math.sin(x * config.waveDensity + t * config.speed + config.phase);
    const waveB = Math.cos(
      x * config.waveDensity * 1.7 - t * config.speed * 0.72 + config.phase * 0.58
    );
    const waveC = Math.sin(
      x * config.waveDensity * 0.72 + t * config.speed * 0.46 + config.phase * 1.22
    );
    const y =
      config.yBase +
      waveA * config.amplitude +
      waveB * config.amplitude * 0.42 +
      waveC * config.amplitude * 0.18;

    if (x === -80) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.lineWidth = config.thickness;
  ctx.lineCap = "round";
  ctx.strokeStyle = gradient;
  ctx.stroke();
}

function _drawGlowEllipse(x, y, rx, ry, rotation, color, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.scale(rx, ry);

  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, _rgba(color, alpha));
  gradient.addColorStop(0.42, _rgba(color, alpha * 0.42));
  gradient.addColorStop(1, _rgba(color, 0));

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function _updateAmbientCss(t, scene, energy, motionScale) {
  const driftX =
    Math.sin(t * (0.30 + scene.motion * 0.06) + scene.phase) *
      (26 + energy * 58) *
      motionScale +
    (_viz.centroid - 0.5) * 120;
  const driftY =
    Math.cos(t * (0.24 + scene.motion * 0.05) + scene.phase * 1.3) *
      (20 + energy * 40) *
      motionScale +
    (_viz.rms - 0.18) * 86;

  const intensity = _clamp(0.22 + energy * 0.86 + _viz.flux * 0.24, 0.20, 1);
  const beatScale = _clamp(_viz.flash * 0.08, 0, 0.12);
  const rotation = scene.ribbonRotation * 54 + Math.sin(t * 0.20 + scene.phase) * 12;

  if (ambientOverlay) {
    ambientOverlay.style.setProperty("--ambient-intensity", intensity.toFixed(3));
    ambientOverlay.style.setProperty("--ambient-beat-scale", beatScale.toFixed(3));
    ambientOverlay.style.setProperty("--ambient-shift-x", `${driftX.toFixed(1)}px`);
    ambientOverlay.style.setProperty("--ambient-shift-y", `${driftY.toFixed(1)}px`);
    ambientOverlay.style.setProperty("--ambient-rotate", `${rotation.toFixed(2)}deg`);
  }

  if (nowPlaying) {
    nowPlaying.style.setProperty("--ambient-intensity", intensity.toFixed(3));
    nowPlaying.style.setProperty("--ambient-beat-scale", beatScale.toFixed(3));
    nowPlaying.style.setProperty("--ambient-local-x", `${(driftX * 0.42).toFixed(1)}px`);
    nowPlaying.style.setProperty("--ambient-local-y", `${(driftY * 0.28).toFixed(1)}px`);
  }
}

function _drawBeamField(w, h, short, t, focus, scene, energy, motionScale) {
  const wobble = Math.sin(t * 0.22 + scene.phase) * 0.28;
  const beams = [
    {
      x: focus.x - w * 0.08,
      y: focus.y - h * 0.08,
      rx: w * (0.28 + energy * 0.08),
      ry: short * (0.050 + _viz.bass * 0.026),
      rotation: scene.beamRotation + wobble,
      color: _viz.currentPalette.primary,
      alpha: 0.11 + _viz.bass * 0.10,
    },
    {
      x: focus.x + w * 0.10,
      y: focus.y + h * 0.04,
      rx: w * (0.24 + energy * 0.08),
      ry: short * (0.042 + _viz.mid * 0.020),
      rotation: scene.beamRotation - 0.46 + wobble * 0.7,
      color: _viz.currentPalette.secondary,
      alpha: 0.10 + _viz.mid * 0.10,
    },
    {
      x: focus.x + Math.sin(t * 0.34 + scene.phase) * (w * 0.06 * motionScale),
      y: focus.y - h * 0.12,
      rx: w * (0.18 + energy * 0.06),
      ry: short * (0.034 + _viz.high * 0.018),
      rotation: scene.beamRotation + 0.74 - wobble * 0.5,
      color: _viz.currentPalette.tertiary,
      alpha: 0.08 + _viz.high * 0.08,
    },
  ];

  ctx.globalCompositeOperation = "screen";
  beams.slice(0, LOW_POWER_MODE ? 2 : beams.length).forEach((beam) =>
    _drawGlowEllipse(
      beam.x,
      beam.y,
      beam.rx,
      beam.ry,
      beam.rotation,
      beam.color,
      beam.alpha
    )
  );
}

function _drawRibbonField(w, h, short, t, scene, energy, motionScale) {
  const speed = (0.66 + energy * 1.65) * motionScale;

  ctx.save();
  ctx.translate(w * scene.focusX, h * scene.focusY);
  ctx.rotate(
    scene.ribbonRotation +
      Math.sin(t * 0.16 + scene.phase) * 0.16 +
      (_viz.centroid - 0.5) * 0.56
  );
  ctx.translate(-w * scene.focusX, -h * scene.focusY);

  const ribbons = [
    {
      yBase: h * (0.20 + _viz.bass * 0.05),
      amplitude: h * (0.06 + energy * 0.08) * motionScale,
      waveDensity: 0.0058,
      speed: 0.86 * speed,
      phase: scene.phase,
      thickness: short * (0.046 + _viz.bass * 0.020),
      color: _viz.currentPalette.primary,
      alpha: 0.11 + _viz.bass * 0.10,
    },
    {
      yBase: h * (0.44 + _viz.mid * 0.06),
      amplitude: h * (0.07 + energy * 0.09) * motionScale,
      waveDensity: 0.0044,
      speed: 0.64 * speed,
      phase: scene.phase + 1.8,
      thickness: short * (0.052 + _viz.mid * 0.022),
      color: _viz.currentPalette.secondary,
      alpha: 0.10 + _viz.mid * 0.10,
    },
    {
      yBase: h * (0.70 - _viz.high * 0.05),
      amplitude: h * (0.06 + energy * 0.07) * motionScale,
      waveDensity: 0.0049,
      speed: 0.94 * speed,
      phase: scene.phase + 3.4,
      thickness: short * (0.044 + _viz.high * 0.018),
      color: _viz.currentPalette.tertiary,
      alpha: 0.09 + _viz.high * 0.08,
    },
    {
      yBase: h * (0.54 + _viz.presence * 0.04),
      amplitude: h * (0.05 + energy * 0.05) * motionScale,
      waveDensity: 0.0066,
      speed: 1.04 * speed,
      phase: scene.phase + 4.6,
      thickness: short * (0.022 + _viz.flux * 0.018),
      color: _viz.currentPalette.accent,
      alpha: 0.05 + _viz.flux * 0.10,
    },
  ];

  ctx.globalCompositeOperation = "screen";
  ribbons.slice(0, LOW_POWER_MODE ? 3 : ribbons.length).forEach((ribbon) =>
    _drawRibbon(w, t, ribbon)
  );
  ctx.restore();
}

function _drawContourRings(short, t, focus, scene, energy) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";

  for (let i = 0; i < (LOW_POWER_MODE ? 2 : 3); i++) {
    const radius =
      short * (0.16 + i * 0.095 + energy * 0.02) +
      Math.sin(t * (0.46 + i * 0.08) + scene.phase + i) * 8;

    ctx.lineWidth = 5 + i * 2 + _viz.flux * 9;
    ctx.strokeStyle = _rgba(
      i % 2 === 0 ? _viz.currentPalette.secondary : _viz.currentPalette.accent,
      0.035 + _viz.flux * 0.08 - i * 0.006
    );
    ctx.beginPath();
    ctx.ellipse(
      focus.x,
      focus.y,
      radius * (1.12 + i * 0.04),
      radius * (0.60 + scene.spread * 0.16),
      scene.ribbonRotation + i * 0.18,
      0,
      Math.PI * 2
    );
    ctx.stroke();
  }

  ctx.restore();
}

function _drawOrbField(w, h, short, t, focus, energy, motionScale) {
  const orbs = [
    {
      x:
        focus.x -
        w * 0.16 +
        Math.sin(t * 0.22 + _viz.scene.phase) * (w * 0.08 * motionScale),
      y:
        focus.y -
        h * 0.18 +
        Math.cos(t * 0.28 + 0.8) * (h * 0.08 * motionScale),
      rx: short * (0.30 + _viz.bass * 0.16),
      ry: short * (0.24 + _viz.bass * 0.12),
      rotation: -0.4,
      color: _viz.currentPalette.primary,
      alpha: 0.15 + _viz.bass * 0.12,
    },
    {
      x:
        focus.x +
        w * 0.18 +
        Math.cos(t * 0.18 + 1.2) * (w * 0.09 * motionScale),
      y:
        focus.y -
        h * 0.02 +
        Math.sin(t * 0.24 + 0.1) * (h * 0.10 * motionScale),
      rx: short * (0.28 + _viz.mid * 0.15),
      ry: short * (0.21 + _viz.mid * 0.10),
      rotation: 0.7,
      color: _viz.currentPalette.secondary,
      alpha: 0.14 + _viz.mid * 0.12,
    },
    {
      x:
        focus.x -
        w * 0.04 +
        Math.sin(t * 0.26 + 3.1) * (w * 0.08 * motionScale),
      y:
        focus.y +
        h * 0.20 +
        Math.cos(t * 0.20 + 2.4) * (h * 0.08 * motionScale),
      rx: short * (0.22 + _viz.high * 0.12),
      ry: short * (0.18 + _viz.high * 0.10),
      rotation: -0.9,
      color: _viz.currentPalette.tertiary,
      alpha: 0.11 + _viz.high * 0.10,
    },
    {
      x:
        focus.x +
        Math.sin(t * 0.30 + 4.4) * (w * 0.05 * motionScale),
      y:
        focus.y +
        Math.cos(t * 0.18 + 0.5) * (h * 0.06 * motionScale),
      rx: short * (0.18 + energy * 0.12),
      ry: short * (0.14 + energy * 0.10),
      rotation: 0.16,
      color: _viz.currentPalette.accent,
      alpha: 0.08 + energy * 0.08,
    },
  ];

  ctx.globalCompositeOperation = "lighter";
  orbs.slice(0, LOW_POWER_MODE ? 3 : orbs.length).forEach((orb) =>
    _drawGlowEllipse(
      orb.x,
      orb.y,
      orb.rx,
      orb.ry,
      orb.rotation,
      orb.color,
      orb.alpha
    )
  );
}

function _drawParticleField(short, t, focus, scene, energy, motionScale) {
  const count = LOW_POWER_MODE ? 4 : 8;

  ctx.save();
  ctx.globalCompositeOperation = "screen";

  for (let i = 0; i < count; i++) {
    const lane = (i / count) * Math.PI * 2 + scene.phase;
    const orbit = short * (0.18 + (i % 5) * 0.045 + energy * 0.08);
    const drift = t * (0.18 + scene.motion * 0.04) + i * 0.42;
    const x =
      focus.x +
      Math.cos(lane + drift) *
        orbit *
        (1.14 + Math.sin(drift * 0.8 + i) * 0.10) *
        motionScale;
    const y =
      focus.y +
      Math.sin(lane * scene.spread + drift * 0.92) *
        orbit *
        (0.72 + Math.cos(drift * 0.6 + i) * 0.12) *
        motionScale;
    const size = 1.4 + _viz.presence * 3.6 + (i % 4 === 0 ? 1.2 : 0);
    const alpha = 0.06 + _viz.high * 0.10 + _viz.flux * 0.08;
    const color =
      i % 4 === 0
        ? _viz.currentPalette.accent
        : i % 2 === 0
          ? _viz.currentPalette.secondary
          : _viz.currentPalette.tertiary;

    ctx.fillStyle = _rgba(color, alpha);
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function _drawRipples(short, energy, motionScale) {
  ctx.globalCompositeOperation = "screen";
  _viz.ripples = _viz.ripples.filter((ripple) => ripple.life > 0.02);

  _viz.ripples.forEach((ripple) => {
    ripple.radius += (18 + energy * 48) * motionScale;
    ripple.life *= 0.94;
    ctx.lineWidth = ripple.lineWidth * ripple.life;
    ctx.strokeStyle = _rgba(ripple.color, ripple.alpha * ripple.life);
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
    ctx.stroke();
  });
}

function _drawFocusFlash(short, focus, energy) {
  if (_viz.flash <= 0.02) return;

  const flashRadius = short * (0.22 + _viz.flash * 0.30 + energy * 0.06);
  const flashColor = _mixColor(_viz.currentPalette.accent, [255, 255, 255], 0.24);
  const flashGradient = ctx.createRadialGradient(
    focus.x,
    focus.y,
    0,
    focus.x,
    focus.y,
    flashRadius
  );

  flashGradient.addColorStop(0, _rgba(flashColor, _viz.flash * 0.12));
  flashGradient.addColorStop(0.44, _rgba(flashColor, _viz.flash * 0.05));
  flashGradient.addColorStop(1, _rgba(flashColor, 0));

  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = flashGradient;
  ctx.beginPath();
  ctx.arc(focus.x, focus.y, flashRadius, 0, Math.PI * 2);
  ctx.fill();
}

function drawVisualizer(frameAt = performance.now()) {
  if (!ctx || document.hidden || audioPlayer.paused) {
    visualizerRAF = null;
    return;
  }

  visualizerRAF = requestAnimationFrame(drawVisualizer);
  const elapsed = frameAt - lastRenderAt;
  if (elapsed < ACTIVE_FRAME_INTERVAL) return;
  lastRenderAt = frameAt - (elapsed % ACTIVE_FRAME_INTERVAL);

  _lerpPalette();

  const now = frameAt;
  const dt = Math.min(elapsed / 1000, 0.12);
  beatCooldown = Math.max(0, beatCooldown - dt);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const short = Math.min(w, h);
  const t = now / 1000;
  const motionScale = reduceMotionQuery.matches ? 0.42 : 1;

  let bass = 0;
  let mid = 0;
  let high = 0;
  let presence = 0;
  let rms = 0;
  let centroid = 0.5;
  let flux = 0;

  if (analyser && dataArray && timeDataArray && !audioPlayer.paused) {
    analyser.getByteFrequencyData(dataArray);
    analyser.getByteTimeDomainData(timeDataArray);

    bass = _bandAvg(dataArray, 0, 10);
    mid = _bandAvg(dataArray, 10, 60);
    high = _bandAvg(dataArray, 60, bufferLength);
    presence = _bandAvg(dataArray, 32, 100);
    rms = _computeRms(timeDataArray);
    centroid = _computeSpectralCentroid(dataArray);
    flux = _computeSpectralFlux(dataArray);
  }

  _viz.bass = Math.max(bass, _viz.bass * 0.91);
  _viz.mid = Math.max(mid, _viz.mid * 0.93);
  _viz.high = Math.max(high, _viz.high * 0.95);
  _viz.presence = Math.max(presence, _viz.presence * 0.92);
  _viz.rms = Math.max(rms, _viz.rms * 0.90);
  _viz.centroid += (centroid - _viz.centroid) * 0.10;
  _viz.flux = Math.max(flux, _viz.flux * 0.72);

  const liveEnergy = _clamp(
    (_viz.bass * 1.35 +
      _viz.mid * 1.10 +
      _viz.high * 0.88 +
      _viz.rms * 1.18 +
      _viz.flux * 0.94) /
      5.45,
    0,
    1
  );
  const ambientEnergy = Math.max(0.08, liveEnergy);

  const focus = _getSceneFocus(
    w,
    h,
    t,
    _viz.scene,
    ambientEnergy,
    motionScale
  );

  if (
    _viz.bass > 0.42 &&
    (_viz.flux > 0.16 || _viz.rms > 0.17) &&
    beatCooldown === 0 &&
    !reduceMotionQuery.matches
  ) {
    _viz.flash = Math.min(1, _viz.flash + _viz.bass * 0.56 + _viz.flux * 0.22);
    _spawnRipple(focus, ambientEnergy, short);
    beatCooldown = 0.16;
  }

  _viz.flash *= 0.94;
  if (now - lastCssUpdateAt >= CSS_UPDATE_INTERVAL) {
    _updateAmbientCss(t, _viz.scene, ambientEnergy, motionScale);
    lastCssUpdateAt = now;
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = _rgba(_viz.currentPalette.shadow, 0.12);
  ctx.fillRect(0, 0, w, h);

  const wash = ctx.createLinearGradient(0, 0, w, h);
  wash.addColorStop(0, _rgba(_viz.currentPalette.primary, 0.08 + ambientEnergy * 0.06));
  wash.addColorStop(
    0.46,
    _rgba(
      _mixColor(_viz.currentPalette.secondary, _viz.currentPalette.tertiary, 0.48),
      0.06 + ambientEnergy * 0.04
    )
  );
  wash.addColorStop(1, _rgba(_viz.currentPalette.tertiary, 0.08 + ambientEnergy * 0.05));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  _drawBeamField(w, h, short, t, focus, _viz.scene, ambientEnergy, motionScale);
  _drawRibbonField(w, h, short, t, _viz.scene, ambientEnergy, motionScale);
  _drawContourRings(short, t, focus, _viz.scene, ambientEnergy);
  _drawOrbField(w, h, short, t, focus, ambientEnergy, motionScale);
  _drawParticleField(short, t, focus, _viz.scene, ambientEnergy, motionScale);
  _drawRipples(short, ambientEnergy, motionScale);
  _drawFocusFlash(short, focus, ambientEnergy);

  ctx.globalCompositeOperation = "source-over";
}

resizeCanvas();
_setAmbientPalette(DEFAULT_SONG_KEY);
_clearCanvas();
document.body.classList.toggle("ambient-low-power", LOW_POWER_MODE);

window.addEventListener("resize", scheduleCanvasResize, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (visualizerRAF) cancelAnimationFrame(visualizerRAF);
    visualizerRAF = null;
    return;
  }
  if (!audioPlayer.paused) _startVisualizer();
});
window.addEventListener("music-lab:songchange", (event) => {
  _setAmbientPalette(_songKeyFromDetail(event.detail));
});
window.addEventListener("music-lab:trackgain", (event) => {
  setTrackGain(event.detail?.gainDb);
});

// Inicializar en el primer clic en la página (política del navegador: AudioContext
// requiere gesto del usuario antes de poder crear nodos de audio).
document.body.addEventListener("click", initAudioVisualizer, { once: true });
audioPlayer.addEventListener("play", () => {
  initAudioVisualizer();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  _startVisualizer();
});
audioPlayer.addEventListener("pause", _stopVisualizer);
audioPlayer.addEventListener("ended", _stopVisualizer);
