/**
 * camera.js — Camera access, live document detection overlay, and capture.
 */

import {
  detectDocumentCorners,
  drawDetectionOverlay,
  fullImageCorners,
  isOpenCvReady,
} from './scanner.js';

/* ── State ──────────────────────────────────────────────────── */
const state = {
  stream:       null,
  facingMode:   'environment',  // rear camera
  detectionRAF: null,
  lastCorners:  null,
  stableFrames: 0,
  lastAutoCaptureTs: 0,
  isCapturing:  false,
};

const AUTO_CAPTURE_REQUIRED_FRAMES = 8;
const AUTO_CAPTURE_COOLDOWN_MS = 2600;
const MAX_STABLE_JUMP_PX = 16;
const MIN_DOC_AREA_RATIO = 0.16;

const el = {
  video:       () => document.getElementById('camera-video'),
  overlay:     () => document.getElementById('detection-canvas'),
  hint:        () => document.getElementById('camera-hint'),
  noCamera:    () => document.getElementById('no-camera-msg'),
  captureBtn:  () => document.getElementById('capture-btn'),
  flipBtn:     () => document.getElementById('flip-camera-btn'),
  flashBtn:    () => document.getElementById('flash-btn'),
  fileInput:   () => document.getElementById('file-input'),
  importBtn:   () => document.getElementById('import-btn'),
};

/* ── Start / Stop ───────────────────────────────────────────── */

export async function startCamera() {
  stopCamera(); // stop any existing stream
  try {
    const constraints = {
      video: {
        facingMode: { ideal: state.facingMode },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const video  = el.video();
    video.srcObject = state.stream;
    await video.play();
    el.noCamera().style.display = 'none';
    resizeOverlay();
    startDetectionLoop();
  } catch (err) {
    console.warn('Camera error:', err);
    el.video().style.display    = 'none';
    el.noCamera().style.display = 'flex';
  }
}

export function stopCamera() {
  stopDetectionLoop();
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  const video = el.video();
  if (video) { video.srcObject = null; }
}

export function flipCamera() {
  state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
  startCamera();
}

/* ── Live Detection Loop ────────────────────────────────────── */

function startDetectionLoop() {
  stopDetectionLoop();
  const video   = el.video();
  const overlay = el.overlay();
  const hint    = el.hint();
  const detectCanvas = document.createElement('canvas');
  const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });
  const DETECT_MAX_DIM = 960;

  function loop() {
    state.detectionRAF = requestAnimationFrame(loop);

    if (video.readyState < 2) return;
    resizeOverlay();

    if (!isOpenCvReady()) {
      state.lastCorners = null;
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      hint.textContent = 'Preparing edge detection…';
      hint.classList.remove('found');
      el.captureBtn().classList.remove('scanning');
      return;
    }

    const ratio = Math.min(1, DETECT_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
    const dW = Math.max(2, Math.round(video.videoWidth * ratio));
    const dH = Math.max(2, Math.round(video.videoHeight * ratio));
    if (detectCanvas.width !== dW) detectCanvas.width = dW;
    if (detectCanvas.height !== dH) detectCanvas.height = dH;
    detectCtx.drawImage(video, 0, 0, dW, dH);

    const detected = detectDocumentCorners(detectCanvas);
    if (detected) {
      const prevCorners = state.lastCorners;
      const rawCorners = detected.map(p => ({
        x: p.x / ratio,
        y: p.y / ratio,
      }));
      const stabilized = smoothCorners(prevCorners, rawCorners);
      const stableNow = isStableDetection(
        prevCorners,
        stabilized,
        video.videoWidth,
        video.videoHeight
      );

      if (stableNow) {
        state.stableFrames = Math.min(state.stableFrames + 1, 60);
      } else {
        state.stableFrames = Math.max(state.stableFrames - 1, 0);
      }

      // Scale coords to overlay dimensions
      const scaleX = overlay.width  / video.videoWidth;
      const scaleY = overlay.height / video.videoHeight;
      const scaled = stabilized.map(p => ({
        x: Math.round(p.x * scaleX),
        y: Math.round(p.y * scaleY),
      }));
      state.lastCorners = stabilized; // store in video coords
      drawDetectionOverlay(overlay, scaled, '#4ecca3');

      if (state.stableFrames >= AUTO_CAPTURE_REQUIRED_FRAMES) {
        hint.textContent = 'Locked - auto capture';
      } else {
        const left = AUTO_CAPTURE_REQUIRED_FRAMES - state.stableFrames;
        hint.textContent = left > 2
          ? 'Hold steady for auto capture'
          : 'Almost there...';
      }
      hint.classList.add('found');
      el.captureBtn().classList.add('scanning');

      const now = Date.now();
      if (
        state.stableFrames >= AUTO_CAPTURE_REQUIRED_FRAMES
        && (now - state.lastAutoCaptureTs) > AUTO_CAPTURE_COOLDOWN_MS
      ) {
        state.lastAutoCaptureTs = now;
        document.dispatchEvent(new CustomEvent('leus:auto-capture'));
      }
    } else {
      state.lastCorners = null;
      state.stableFrames = 0;
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      hint.textContent = 'Point camera at a document';
      hint.classList.remove('found');
      el.captureBtn().classList.remove('scanning');
    }
  }
  loop();
}

function stopDetectionLoop() {
  if (state.detectionRAF) {
    cancelAnimationFrame(state.detectionRAF);
    state.detectionRAF = null;
  }
  state.stableFrames = 0;
}

/* ── Capture ────────────────────────────────────────────────── */

/**
 * Capture the current video frame.
 * @returns {{ canvas: HTMLCanvasElement, corners: Array<{x,y}> }}
 */
export function captureFrame() {
  const video = el.video();
  if (!video || video.readyState < 2) return null;

  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  // Re-run detection on the captured frame for a more accurate review preview.
  const detectedNow = detectDocumentCorners(canvas);
  if (detectedNow) state.lastCorners = detectedNow;

  const corners = detectedNow
    || state.lastCorners
    || fullImageCorners(video.videoWidth, video.videoHeight);

  return { canvas, corners };
}

/* ── File import ────────────────────────────────────────────── */

/**
 * Trigger file picker and return an array of { canvas, corners }.
 */
export function importFiles() {
  return new Promise((resolve) => {
    const input = el.fileInput();
    input.value = '';
    input.onchange = async () => {
      const results = [];
      for (const file of input.files) {
        const canvas  = await fileToCanvas(file);
        const corners = detectDocumentCorners(canvas)
          || fullImageCorners(canvas.width, canvas.height);
        results.push({ canvas, corners });
      }
      resolve(results);
    };
    input.click();
  });
}

async function fileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url    = URL.createObjectURL(file);
    const img    = new Image();
    img.onload   = () => {
      const canvas  = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror  = reject;
    img.src      = url;
  });
}

/* ── Helpers ────────────────────────────────────────────────── */

function resizeOverlay() {
  const video   = el.video();
  const overlay = el.overlay();
  if (!video || !overlay) return;
  // Match overlay to the video's displayed size
  const rect = video.getBoundingClientRect();
  if (overlay.width  !== Math.round(rect.width))  overlay.width  = Math.round(rect.width);
  if (overlay.height !== Math.round(rect.height)) overlay.height = Math.round(rect.height);
}

function smoothCorners(prev, next, alpha = 0.4) {
  if (!prev || prev.length !== 4 || !next || next.length !== 4) return next;

  const maxJump = Math.max(
    ...next.map((p, i) => Math.hypot(p.x - prev[i].x, p.y - prev[i].y))
  );

  // If corners jump too much, trust fresh detection (likely scene changed).
  if (maxJump > 120) return next;

  return next.map((p, i) => ({
    x: prev[i].x * (1 - alpha) + p.x * alpha,
    y: prev[i].y * (1 - alpha) + p.y * alpha,
  }));
}

function isStableDetection(prev, next, frameW, frameH) {
  if (!next || next.length !== 4) return false;
  const areaRatio = quadArea(next) / Math.max(1, frameW * frameH);
  if (areaRatio < MIN_DOC_AREA_RATIO) return false;
  if (!prev || prev.length !== 4) return false;

  const maxJump = Math.max(
    ...next.map((p, i) => Math.hypot(p.x - prev[i].x, p.y - prev[i].y))
  );
  return maxJump <= MAX_STABLE_JUMP_PX;
}

function quadArea(corners) {
  let sum = 0;
  for (let i = 0; i < corners.length; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % corners.length];
    sum += (p.x * q.y) - (q.x * p.y);
  }
  return Math.abs(sum) * 0.5;
}

window.LeusCamera = { startCamera, stopCamera, flipCamera, captureFrame, importFiles };
