/**
 * ocr.js — Tesseract.js OCR wrapper.
 * Runs entirely in the browser via a Web Worker — no cloud.
 * Supports Chinese Simplified + Traditional + English.
 */

/* ── Worker singleton ───────────────────────────────────────── */
let _worker   = null;
let _workerReady = false;
let _initPromise = null;

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

/** Load Tesseract.js lazily from CDN, return promise */
function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s   = document.createElement('script');
    s.src     = TESSERACT_CDN;
    s.async   = true;
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/**
 * Initialise the Tesseract worker (called once, cached).
 * @param {function} onProgress  (pct, msg) => void
 */
export async function initOCR(onProgress) {
  if (_workerReady) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    onProgress && onProgress(0, 'Loading OCR engine…');
    await loadTesseractScript();
    onProgress && onProgress(20, 'Creating OCR worker…');

    // Tesseract v5 API
    _worker = await window.Tesseract.createWorker(
      ['chi_sim', 'chi_tra', 'eng'],
      1,
      {
        workerPath:  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
        langPath:    'https://tessdata.projectnaptha.com/4.0.0',
        corePath:    'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
        logger: (m) => {
          if (m.status === 'recognizing text') {
            onProgress && onProgress(20 + Math.round(m.progress * 75), 'Recognising text…');
          }
        },
      }
    );
    _workerReady = true;
    onProgress && onProgress(100, 'OCR ready');
  })();

  return _initPromise;
}

/**
 * Run OCR on a canvas or image element.
 * @param {HTMLCanvasElement|HTMLImageElement|string} source
 * @param {function} onProgress  optional (pct, status) => void
 * @returns {Promise<{text: string, confidence: number, words: Array}>}
 */
export async function recognizeText(source, onProgress) {
  if (!_workerReady) {
    await initOCR(onProgress);
  }
  onProgress && onProgress(0, 'Starting recognition…');

  const result = await _worker.recognize(source);
  const { text, confidence, words } = result.data;

  onProgress && onProgress(100, 'Done');
  return { text: text.trim(), confidence, words };
}

/** Release the worker when no longer needed (optional, rarely called) */
export async function terminateOCR() {
  if (_worker) {
    await _worker.terminate();
    _worker      = null;
    _workerReady = false;
    _initPromise = null;
  }
}

window.LeusOCR = { initOCR, recognizeText, terminateOCR };
