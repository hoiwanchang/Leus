/**
 * filters.js — Canvas-based image filters for scanned documents.
 * All processing is local; no server calls.
 *
 * Filters:
 *   document  — adaptive grayscale threshold (crisp B/W text)
 *   whiteboard — enhanced whiteboard (remove background discolouration)
 *   photo     — auto-levels colour enhancement
 *   business  — high-contrast for business cards / printed material
 *   original  — no processing
 */

/* ── Public API ─────────────────────────────────────────────── */

/**
 * Apply a named filter to a canvas and return a NEW canvas.
 * The source canvas is not modified.
 *
 * @param {HTMLCanvasElement} srcCanvas
 * @param {'document'|'whiteboard'|'photo'|'business'|'original'} filterName
 * @returns {HTMLCanvasElement}
 */
export function applyFilter(srcCanvas, filterName) {
  const out = cloneCanvas(srcCanvas);
  switch (filterName) {
    case 'document':   return filterDocument(out);
    case 'whiteboard': return filterWhiteboard(out);
    case 'photo':      return filterPhoto(out);
    case 'business':   return filterBusiness(out);
    default:           return out;   // 'original' — return as-is
  }
}

/* ── Filters ────────────────────────────────────────────────── */

/** Document — adaptive threshold → crisp black text on white */
function filterDocument(canvas) {
  const ctx  = canvas.getContext('2d');
  const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const w    = canvas.width, h = canvas.height;

  // Step 1: grayscale
  toGrayscale(data);

  // Step 2: adaptive (local) threshold — blockSize ~ 1/16 of shorter side
  const blockR = Math.max(5, Math.round(Math.min(w, h) / 32)) | 1; // must be odd
  adaptiveThreshold(data, w, h, blockR, 10);

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Whiteboard — correct colour cast, enhance contrast, threshold lightly */
function filterWhiteboard(canvas) {
  const ctx  = canvas.getContext('2d');
  const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;

  // Normalize each channel independently (stretch histogram)
  normalizeChannels(data);

  // Light sharpening to make marker text clearer
  sharpen(data, canvas.width, canvas.height, 0.4);

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Photo — mild auto-levels + slight saturation boost */
function filterPhoto(canvas) {
  const ctx  = canvas.getContext('2d');
  const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;

  autoLevels(data, 0.5); // trim 0.5% from each tail
  boostSaturation(data, 1.15);

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Business card — high contrast grayscale, sharpen */
function filterBusiness(canvas) {
  const ctx  = canvas.getContext('2d');
  const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;

  toGrayscale(data);
  adjustBrightnessContrast(data, 0, 1.6);
  sharpen(data, canvas.width, canvas.height, 0.6);

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ── Image Processing Primitives ────────────────────────────── */

/** Convert RGBA data to grayscale in-place */
function toGrayscale(data) {
  for (let i = 0; i < data.length; i += 4) {
    const g = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
    data[i] = data[i+1] = data[i+2] = g;
  }
}

/**
 * Adaptive (local mean) threshold.
 * For each pixel: if value > localMean - C → white, else → black.
 */
function adaptiveThreshold(data, w, h, blockR, C) {
  // Build grayscale float array
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = data[i * 4];

  // Integral image for fast box mean
  const integral = buildIntegral(gray, w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - blockR);
      const y0 = Math.max(0, y - blockR);
      const x1 = Math.min(w - 1, x + blockR);
      const y1 = Math.min(h - 1, y + blockR);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum  = integralSum(integral, w, x0, y0, x1, y1);
      const mean = sum / area;
      const v    = gray[y * w + x] > mean - C ? 255 : 0;
      const idx  = (y * w + x) * 4;
      data[idx] = data[idx+1] = data[idx+2] = v;
    }
  }
}

function buildIntegral(gray, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      I[(y+1)*(w+1)+(x+1)] =
        gray[y*w+x] +
        I[y*(w+1)+(x+1)] +
        I[(y+1)*(w+1)+x] -
        I[y*(w+1)+x];
    }
  }
  return I;
}

function integralSum(I, w, x0, y0, x1, y1) {
  return I[(y1+1)*(w+1)+(x1+1)]
       - I[y0*(w+1)+(x1+1)]
       - I[(y1+1)*(w+1)+x0]
       + I[y0*(w+1)+x0];
}

/** Normalize each RGB channel independently (histogram stretch) */
function normalizeChannels(data) {
  const mins = [255, 255, 255], maxs = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (data[i+c] < mins[c]) mins[c] = data[i+c];
      if (data[i+c] > maxs[c]) maxs[c] = data[i+c];
    }
  }
  const ranges = maxs.map((mx, c) => mx - mins[c] || 1);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      data[i+c] = Math.round(((data[i+c] - mins[c]) / ranges[c]) * 255);
    }
  }
}

/** Auto-levels with percentile clipping (trimPct = %) */
function autoLevels(data, trimPct) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const total = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) hist[c][data[i+c]]++;
  }
  const clip  = total * trimPct / 100;
  const lows  = [0, 0, 0], highs = [255, 255, 255];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[c][v];
      if (acc >= clip) { lows[c] = v; break; }
    }
    acc = 0;
    for (let v = 255; v >= 0; v--) {
      acc += hist[c][v];
      if (acc >= clip) { highs[c] = v; break; }
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const range = highs[c] - lows[c] || 1;
      data[i+c] = clamp(Math.round(((data[i+c] - lows[c]) / range) * 255));
    }
  }
}

/** Brightness/contrast adjustment.  contrast=1 = no change. */
function adjustBrightnessContrast(data, brightness, contrast) {
  const factor = contrast;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      data[i+c] = clamp(Math.round((data[i+c] - 128) * factor + 128 + brightness));
    }
  }
}

/** Saturation boost using HSL-like approach */
function boostSaturation(data, factor) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const gray = 0.299*r + 0.587*g + 0.114*b;
    data[i]   = clamp(Math.round(gray + (r - gray) * factor));
    data[i+1] = clamp(Math.round(gray + (g - gray) * factor));
    data[i+2] = clamp(Math.round(gray + (b - gray) * factor));
  }
}

/** 3×3 unsharp-mask sharpen.  strength in [0..1] */
function sharpen(data, w, h, strength) {
  const kernel = [
     0, -1,  0,
    -1,  5, -1,
     0, -1,  0,
  ];
  const copy = new Uint8ClampedArray(data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            acc += copy[((y+ky)*w+(x+kx))*4+c] * kernel[(ky+1)*3+(kx+1)];
          }
        }
        data[idx+c] = clamp(Math.round(
          copy[idx+c] * (1 - strength) + acc * strength
        ));
      }
    }
  }
}

/* ── Utilities ──────────────────────────────────────────────── */

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function cloneCanvas(src) {
  const dst  = document.createElement('canvas');
  dst.width  = src.width;
  dst.height = src.height;
  dst.getContext('2d').drawImage(src, 0, 0);
  return dst;
}

window.LeusFilters = { applyFilter };
