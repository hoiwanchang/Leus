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
    cv.Canny(blur, edge, 30, 120);

    // Close gaps, then strengthen edge continuity
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(edge, edge, cv.MORPH_CLOSE, kernel);
    cv.dilate(edge, edge, kernel);
    kernel.delete();

    cv.findContours(edge, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestPoly    = null;
    let bestArea    = 0;
    const minArea   = src.rows * src.cols * 0.02; // at least 2% of image

    for (let i = 0; i < contours.size(); i++) {
      const c    = contours.get(i);
      const peri = cv.arcLength(c, true);
      for (const ratio of [0.015, 0.02, 0.03, 0.04]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(c, approx, ratio * peri, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const area = Math.abs(cv.contourArea(approx));
          if (area > bestArea && area > minArea) {
            if (bestPoly) bestPoly.delete();
            bestArea = area;
            bestPoly = approx;
          } else {
            approx.delete();
          }
        } else {
          approx.delete();
        }
      }
      c.delete();
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
 * TR has min diff (x-y), BL has max diff.
 */
export function orderCorners(pts) {
  const bySumDiff = [...pts];
  bySumDiff.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const TL = bySumDiff[0], BR = bySumDiff[3];
  const rest = [bySumDiff[1], bySumDiff[2]];
  rest.sort((a, b) => (a.x - a.y) - (b.x - b.y));
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
  detectDocumentCorners,
  perspectiveWarp,
  orderCorners,
  fullImageCorners,
  drawDetectionOverlay,
};
