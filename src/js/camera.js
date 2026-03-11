/**
 * camera.js — Camera access, live document detection overlay, and capture.
 */

import { detectDocumentCorners, drawDetectionOverlay, fullImageCorners } from './scanner.js';

/* ── State ──────────────────────────────────────────────────── */
const state = {
  stream:       null,
  facingMode:   'environment',  // rear camera
  detectionRAF: null,
  lastCorners:  null,
  isCapturing:  false,
};

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

  function loop() {
    state.detectionRAF = requestAnimationFrame(loop);

    if (video.readyState < 2) return;
    resizeOverlay();

    // Scale coords to canvas size
    const scaleX = overlay.width  / video.videoWidth;
    const scaleY = overlay.height / video.videoHeight;

    // Draw current frame to a temp canvas for OpenCV processing
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width  = video.videoWidth;
    tmpCanvas.height = video.videoHeight;
    tmpCanvas.getContext('2d').drawImage(video, 0, 0);

    const rawCorners = detectDocumentCorners(tmpCanvas);
    if (rawCorners) {
      // Scale to overlay dimensions
      const scaled = rawCorners.map(p => ({
        x: Math.round(p.x * scaleX),
        y: Math.round(p.y * scaleY),
      }));
      state.lastCorners = rawCorners; // store in video coords
      drawDetectionOverlay(overlay, scaled, '#4ecca3');
      hint.textContent = 'Document detected — tap to capture';
      hint.classList.add('found');
      el.captureBtn().classList.add('scanning');
    } else {
      state.lastCorners = null;
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

  const corners = state.lastCorners
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

window.LeusCamera = { startCamera, stopCamera, flipCamera, captureFrame, importFiles };
