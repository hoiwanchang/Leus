/**
 * scanner.js — Document edge detection and perspective correction.
 *
 * Strategy:
 *  1. Try to use OpenCV.js (loaded lazily from CDN) for accurate
 *     Canny-edge + contour detection.
 *  2. Fall back to a pure-JS homography warp using manually placed
 *     corners (no automatic detection without OpenCV).
 *
 * All processing runs entirely in the browser — no cloud.
 */

/* ── OpenCV lazy loader ─────────────────────────────────────── */
let _cvReady   = false;
let _cvLoading = false;
const _cvWaiters = [];

/* ── Optional ONNX doc segmentation loader ─────────────────── */
let _ortReady = false;
let _ortLoading = false;
let _ortError = null;
let _docSession = null;
let _docInputName = 'input';

const DOC_MODEL_PATH = 'models/docseg-small.onnx';
const DOC_MODEL_SIZE = 256;

export function isOpenCvReady() { return _cvReady; }

export function loadOpenCv(onProgress) {
  if (_cvReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (_cvLoading) { _cvWaiters.push({ resolve, reject }); return; }
    _cvLoading = true;
    _cvWaiters.push({ resolve, reject });

    // OpenCV calls this when ready
    window.onOpenCvReady = () => {
      _cvReady   = true;
      _cvLoading = false;
      onProgress && onProgress(100, 'OpenCV ready');
      _cvWaiters.forEach(w => w.resolve());
      _cvWaiters.length = 0;
    };

    const script  = document.createElement('script');
    script.async  = true;
    // Use a stable, widely-cached CDN release
    script.src    = 'https://docs.opencv.org/4.8.0/opencv.js';
    script.onload = () => { onProgress && onProgress(80, 'Loading OpenCV…'); };
    script.onerror = (err) => {
      _cvLoading = false;
      _cvWaiters.forEach(w => w.reject(err));
      _cvWaiters.length = 0;
    };
    document.head.appendChild(script);
  });
}

export function isDocSegReady() {
  return _ortReady && !!_docSession;
}

export async function loadDocSegModel(onProgress) {
  if (_docSession) {
    _ortReady = true;
    return;
  }
  if (_ortLoading) return;

  _ortLoading = true;
  _ortError = null;
  try {
    const ort = await ensureOrtLoaded(onProgress);
    const modelResponse = await fetch(DOC_MODEL_PATH, { cache: 'force-cache' });
    if (!modelResponse.ok) throw new Error(`Model not found: ${DOC_MODEL_PATH}`);
    const modelData = await modelResponse.arrayBuffer();
    _docSession = await ort.InferenceSession.create(modelData, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    _docInputName = _docSession.inputNames[0] || 'input';
    _ortReady = true;
    onProgress && onProgress(100, 'Doc model ready');
  } catch (err) {
    _ortReady = false;
    _ortError = err;
    console.warn('Doc segmentation model unavailable, using OpenCV fallback:', err);
  } finally {
    _ortLoading = false;
  }
}

export async function detectDocumentCornersHybrid(source) {
  const modelCorners = await detectDocumentCornersByModel(source);
  if (modelCorners) return modelCorners;
  return detectDocumentCorners(source);
}

export async function detectDocumentCornersByModel(source) {
  if (!isDocSegReady()) return null;
  try {
    const srcCanvas = sourceToCanvas(source);
    if (!srcCanvas) return null;

    const modelCanvas = document.createElement('canvas');
    modelCanvas.width = DOC_MODEL_SIZE;
    modelCanvas.height = DOC_MODEL_SIZE;
    const mctx = modelCanvas.getContext('2d', { willReadFrequently: true });
    mctx.drawImage(srcCanvas, 0, 0, DOC_MODEL_SIZE, DOC_MODEL_SIZE);

    const input = canvasToNchwTensor(modelCanvas);
    const outputs = await _docSession.run({ [_docInputName]: input });
    const outputName = _docSession.outputNames[0];
    const outTensor = outputs[outputName];
    const mask = tensorToMask(outTensor);
    if (!mask) return null;

    const quad = quadFromMask(mask.data, mask.width, mask.height);
    if (!quad) return null;

    const sx = srcCanvas.width / mask.width;
    const sy = srcCanvas.height / mask.height;
    const scaled = quad.map(p => ({
      x: Math.max(0, Math.min(srcCanvas.width - 1, p.x * sx)),
      y: Math.max(0, Math.min(srcCanvas.height - 1, p.y * sy)),
    }));

    return orderCorners(scaled);
  } catch (err) {
    console.warn('Doc model detect error, fallback to OpenCV:', err);
    return null;
  }
}

/* ── Document detection (OpenCV) ────────────────────────────── */

/**
 * Detect the largest quadrilateral (document) in an image.
 * @param {HTMLCanvasElement|HTMLVideoElement|HTMLImageElement} source
 * @returns {Array<{x,y}>|null}  4 corners in TL/TR/BR/BL order, or null
 */
export function detectDocumentCorners(source) {
  if (!_cvReady || typeof cv === 'undefined') return null;
  try {
    const src  = cv.imread(source);
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edge = new cv.Mat();
    const contours   = new cv.MatVector();
    const hierarchy  = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edge, 20, 100);

    // Close gaps, then strengthen edge continuity
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(edge, edge, cv.MORPH_CLOSE, kernel);
    cv.dilate(edge, edge, kernel, new cv.Point(-1, -1), 2);
    kernel.delete();

    let bestPoly    = null;
    let bestArea    = 0;
    // Keep sensitivity high enough for farther/smaller documents while
    // still rejecting tiny noise contours.
    const minArea   = src.rows * src.cols * 0.008; // at least 0.8% of image

    const findBestQuad = (binaryMat) => {
      cv.findContours(binaryMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c    = contours.get(i);
        const peri = cv.arcLength(c, true);
        for (const ratio of [0.01, 0.015, 0.02, 0.03, 0.04]) {
          const approx = new cv.Mat();
          cv.approxPolyDP(c, approx, ratio * peri, true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const area = Math.abs(cv.contourArea(approx));
            if (area > bestArea && area > minArea) {
              if (bestPoly) bestPoly.delete();
              bestArea = area;
              bestPoly = approx;
              break;
            } else {
              approx.delete();
            }
          } else {
            approx.delete();
          }
        }
        c.delete();
        if (bestArea >= src.rows * src.cols * 0.85) break;
      }
    };

    findBestQuad(edge);

    if (!bestPoly) {
      // Fallback pass: adaptive threshold handles low-contrast edges better.
      const adapt = new cv.Mat();
      const adaptKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.adaptiveThreshold(
        blur,
        adapt,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY,
        21,
        8
      );
      cv.morphologyEx(adapt, adapt, cv.MORPH_CLOSE, adaptKernel);
      findBestQuad(adapt);
      adaptKernel.delete();
      adapt.delete();
    }

    // Cleanup
    [src, gray, blur, edge, contours, hierarchy].forEach(m => m.delete());

    if (!bestPoly) return null;

    const pts = [];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: bestPoly.intAt(i, 0), y: bestPoly.intAt(i, 1) });
    }
    bestPoly.delete();

    return orderCorners(pts);
  } catch (err) {
    console.warn('OpenCV detection error:', err);
    return null;
  }
}

async function ensureOrtLoaded(onProgress) {
  if (window.ort && window.ort.InferenceSession) {
    _ortReady = true;
    return window.ort;
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-ort="1"]');
    if (existing) {
      const done = () => {
        if (window.ort && window.ort.InferenceSession) {
          _ortReady = true;
          resolve(window.ort);
        } else {
          reject(new Error('ONNX Runtime loaded but unavailable'));
        }
      };
      existing.addEventListener('load', done, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.dataset.ort = '1';
    script.async = true;
    script.src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js';
    script.onload = () => {
      if (window.ort && window.ort.InferenceSession) {
        _ortReady = true;
        onProgress && onProgress(70, 'ONNX runtime ready');
        resolve(window.ort);
      } else {
        reject(new Error('ONNX Runtime script loaded but window.ort missing'));
      }
    };
    script.onerror = () => reject(new Error('Failed to load ONNX Runtime'));
    document.head.appendChild(script);
  });
}

function sourceToCanvas(source) {
  if (source instanceof HTMLCanvasElement) return source;
  if (source instanceof HTMLImageElement || source instanceof HTMLVideoElement) {
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(source, 0, 0, width, height);
    return canvas;
  }
  return null;
}

function canvasToNchwTensor(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const chw = new Float32Array(3 * width * height);
  const stride = width * height;

  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    chw[i] = r;
    chw[stride + i] = g;
    chw[stride * 2 + i] = b;
  }

  return new window.ort.Tensor('float32', chw, [1, 3, height, width]);
}

function tensorToMask(tensor) {
  if (!tensor || !tensor.data || !Array.isArray(tensor.dims)) return null;
  const { data, dims } = tensor;

  // Common outputs: [1,1,H,W] logits/probabilities or [1,H,W,1].
  if (dims.length === 4 && dims[1] === 1) {
    const h = dims[2], w = dims[3];
    return { data: toProbability(data), width: w, height: h };
  }
  if (dims.length === 4 && dims[3] === 1) {
    const h = dims[1], w = dims[2];
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out[y * w + x] = data[((y * w + x) * 1)];
      }
    }
    return { data: toProbability(out), width: w, height: h };
  }
  return null;
}

function toProbability(arr) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  // If values are already in [0,1], keep them. Otherwise sigmoid.
  if (min >= 0 && max <= 1) return arr;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = 1 / (1 + Math.exp(-arr[i]));
  }
  return out;
}

function quadFromMask(mask, width, height, threshold = 0.5) {
  let area = 0;
  let tl = null, tr = null, br = null, bl = null;
  let bestTL = Infinity;
  let bestTR = -Infinity;
  let bestBR = -Infinity;
  let bestBL = -Infinity;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = mask[y * width + x];
      if (v < threshold) continue;
      area++;

      const s = x + y;
      const d = x - y;
      if (s < bestTL) { bestTL = s; tl = { x, y }; }
      if (d > bestTR) { bestTR = d; tr = { x, y }; }
      if (s > bestBR) { bestBR = s; br = { x, y }; }
      if (-d > bestBL) { bestBL = -d; bl = { x, y }; }
    }
  }

  if (!tl || !tr || !br || !bl) return null;
  if (area < width * height * 0.04) return null;
  return [tl, tr, br, bl];
}

/* ── Perspective correction ─────────────────────────────────── */

/**
 * Apply perspective warp using OpenCV (preferred) or pure-JS fallback.
 * @param {HTMLCanvasElement} srcCanvas   Source image
 * @param {Array<{x,y}>}      corners     4 corners (TL/TR/BR/BL) in *image* coordinates
 * @returns {HTMLCanvasElement}           New canvas with corrected image
 */
export function perspectiveWarp(srcCanvas, corners) {
  if (_cvReady && typeof cv !== 'undefined') {
    return _perspectiveWarpCV(srcCanvas, corners);
  }
  return _perspectiveWarpJS(srcCanvas, corners);
}

function _perspectiveWarpCV(srcCanvas, corners) {
  const [tl, tr, br, bl] = corners;

  // Compute output dimensions
  const widthTop    = dist(tl, tr);
  const widthBottom = dist(bl, br);
  const maxW        = Math.round(Math.max(widthTop, widthBottom));
  const heightLeft  = dist(tl, bl);
  const heightRight = dist(tr, br);
  const maxH        = Math.round(Math.max(heightLeft, heightRight));

  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, maxW - 1, 0, maxW - 1, maxH - 1, 0, maxH - 1,
  ]);

  const src  = cv.imread(srcCanvas);
  const dst  = new cv.Mat();
  const M    = cv.getPerspectiveTransform(srcPts, dstPts);
  cv.warpPerspective(src, dst, M, new cv.Size(maxW, maxH));

  const out = document.createElement('canvas');
  out.width  = maxW;
  out.height = maxH;
  cv.imshow(out, dst);

  [src, dst, M, srcPts, dstPts].forEach(m => m.delete());
  return out;
}

/* ── Pure-JS perspective warp (fallback) ────────────────────── */
/**
 * Compute a 3×3 homography matrix mapping srcPts → dstPts.
 * Solves the 8×8 linear system Ah=b via Gaussian elimination.
 */
function computeHomography(src4, dst4) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const sx = src4[i].x, sy = src4[i].y;
    const dx = dst4[i].x, dy = dst4[i].y;
    A.push([sx, sy, 1,  0,  0, 0, -dx*sx, -dx*sy]);
    b.push(dx);
    A.push([ 0,  0, 0, sx, sy, 1, -dy*sx, -dy*sy]);
    b.push(dy);
  }
  const h = gaussElim(A, b);
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7],    1],
  ];
}

/** Gaussian elimination with partial pivoting for an n×n system */
function gaussElim(A, b) {
  const n = b.length;
  // Augment A with b
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-10) continue;
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / M[col][col];
      for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
    }
  }
  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
    x[i] /= M[i][i] || 1;
  }
  return x;
}

/** Inverse of a 3×3 matrix */
function inv3(m) {
  const [[a,b,c],[d,e,f],[g,h,i]] = m;
  const det = a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    [(e*i-f*h)*inv, (c*h-b*i)*inv, (b*f-c*e)*inv],
    [(f*g-d*i)*inv, (a*i-c*g)*inv, (c*d-a*f)*inv],
    [(d*h-e*g)*inv, (b*g-a*h)*inv, (a*e-b*d)*inv],
  ];
}

function _perspectiveWarpJS(srcCanvas, corners) {
  const [tl, tr, br, bl] = corners;
  const widthTop    = dist(tl, tr);
  const widthBottom = dist(bl, br);
  const maxW        = Math.round(Math.max(widthTop, widthBottom));
  const heightLeft  = dist(tl, bl);
  const heightRight = dist(tr, br);
  const maxH        = Math.round(Math.max(heightLeft, heightRight));

  const dst4 = [
    { x: 0,        y: 0 },
    { x: maxW - 1, y: 0 },
    { x: maxW - 1, y: maxH - 1 },
    { x: 0,        y: maxH - 1 },
  ];

  const H    = computeHomography(dst4, corners); // dst→src mapping
  const invH = inv3(H);

  if (!invH) {
    // Degenerate — just copy original
    const out = document.createElement('canvas');
    out.width  = srcCanvas.width;
    out.height = srcCanvas.height;
    out.getContext('2d').drawImage(srcCanvas, 0, 0);
    return out;
  }

  // We actually want src→dst, so use H directly (dst→src for inverse mapping)
  const [[h00,h01,h02],[h10,h11,h12],[h20,h21,h22]] = H;

  const srcCtx   = srcCanvas.getContext('2d');
  const srcData  = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const srcPixels = srcData.data;
  const sW = srcCanvas.width, sH = srcCanvas.height;

  const out     = document.createElement('canvas');
  out.width     = maxW;
  out.height    = maxH;
  const outCtx  = out.getContext('2d');
  const outData = outCtx.createImageData(maxW, maxH);
  const outPx   = outData.data;

  for (let dy = 0; dy < maxH; dy++) {
    for (let dx = 0; dx < maxW; dx++) {
      const w  = h20 * dx + h21 * dy + h22;
      const sx = (h00 * dx + h01 * dy + h02) / w;
      const sy = (h10 * dx + h11 * dy + h12) / w;

      // Bilinear interpolation
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = x0 + 1,         y1 = y0 + 1;
      if (x0 < 0 || y0 < 0 || x1 >= sW || y1 >= sH) continue;

      const fx = sx - x0, fy = sy - y0;
      const idx00 = (y0 * sW + x0) * 4;
      const idx10 = (y0 * sW + x1) * 4;
      const idx01 = (y1 * sW + x0) * 4;
      const idx11 = (y1 * sW + x1) * 4;

      const dIdx = (dy * maxW + dx) * 4;
      for (let c = 0; c < 3; c++) {
        outPx[dIdx + c] = Math.round(
          srcPixels[idx00+c]*(1-fx)*(1-fy) +
          srcPixels[idx10+c]*fx*(1-fy)    +
          srcPixels[idx01+c]*(1-fx)*fy    +
          srcPixels[idx11+c]*fx*fy
        );
      }
      outPx[dIdx + 3] = 255;
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return out;
}

/* ── Utilities ──────────────────────────────────────────────── */

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Order 4 points as [TL, TR, BR, BL].
 * Uses sum / diff trick: TL has min sum, BR has max sum,
 * TR has min diff (y-x), BL has max diff.
 */
export function orderCorners(pts) {
  const bySumDiff = [...pts];
  bySumDiff.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const TL = bySumDiff[0], BR = bySumDiff[3];
  const rest = [bySumDiff[1], bySumDiff[2]];
  // In image coordinates (y grows downward), using (y - x)
  // correctly separates TR and BL to avoid mirrored warps.
  rest.sort((a, b) => (a.y - a.x) - (b.y - b.x));
  const TR = rest[0], BL = rest[1];
  return [TL, TR, BR, BL];
}

/**
 * Generate a full-image quad for the given canvas (no detection).
 */
export function fullImageCorners(w, h, margin = 20) {
  return [
    { x: margin,     y: margin },
    { x: w - margin, y: margin },
    { x: w - margin, y: h - margin },
    { x: margin,     y: h - margin },
  ];
}

/**
 * Draw the detected quad on an overlay canvas.
 */
export function drawDetectionOverlay(canvas, corners, color = '#4ecca3') {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!corners || corners.length !== 4) return;
  const [tl, tr, br, bl] = corners;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(tr.x, tr.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.fillStyle   = 'rgba(78,204,163,0.12)';
  ctx.strokeStyle = color;
  ctx.lineWidth   = 3;
  ctx.fill();
  ctx.stroke();
  // Corners
  for (const pt of [tl, tr, br, bl]) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

window.LeusScanner = {
  loadOpenCv,
  isOpenCvReady,
  loadDocSegModel,
  isDocSegReady,
  detectDocumentCorners,
  detectDocumentCornersByModel,
  detectDocumentCornersHybrid,
  perspectiveWarp,
  orderCorners,
  fullImageCorners,
  drawDetectionOverlay,
};
