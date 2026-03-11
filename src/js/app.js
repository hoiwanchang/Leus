/**
 * app.js — Leus main application controller.
 *
 * Responsibilities:
 *  - View routing (show/hide screens)
 *  - Coordinate camera → review → edit → save → documents flow
 *  - Wire all UI event listeners
 *  - Loading sequence (OpenCV + app init)
 */

import { loadOpenCv, perspectiveWarp, fullImageCorners, orderCorners } from './scanner.js';
import { applyFilter }    from './filters.js';
import { initOCR, recognizeText } from './ocr.js';
import { exportPDF, exportImage, canvasToDataUrl } from './export.js';
import {
  getAllDocuments, saveDocument, getDocument,
  updateDocument, addPage, deleteDocument,
} from './storage.js';
import { startCamera, stopCamera, flipCamera, captureFrame, importFiles } from './camera.js';

/* ════════════════════════════════════════════════════════════
   GLOBAL STATE
═══════════════════════════════════════════════════════════════ */
const App = {
  currentScreen: 'camera-screen',
  scanMode:      'document',       // current scan filter mode
  session: {                        // per-scan temporary data
    rawCanvas:     null,            // full-res captured image
    rawCorners:    null,            // detected corners in raw image coords
    warpedCanvas:  null,            // after perspective warp
    filteredCanvas:null,            // after filter
    activeFilter:  'document',
    ocrText:       '',
    rotation:      0,               // in degrees (multiples of 90)
  },
  editing: {                        // for editing existing document
    docId:       null,
    pageIndex:   0,
  },
  currentDocId:  null,              // for detail screen
};

/* ════════════════════════════════════════════════════════════
   BOOT  — loading sequence
═══════════════════════════════════════════════════════════════ */
async function boot() {
  setLoadingStatus('Starting up…', 5);

  // Kick off OpenCV load (non-blocking — app works without it)
  loadOpenCv((pct, msg) => {
    if (pct < 100) setLoadingStatus(msg || 'Loading engine…', 10 + Math.round(pct * 0.5));
  }).catch(() => console.warn('OpenCV unavailable — using JS fallback'));

  setLoadingStatus('Loading OCR…', 20);
  // Pre-warm OCR in background (don't wait for it)
  initOCR((pct, msg) => {
    // silent background init
  }).catch(() => console.warn('OCR pre-warm failed — will retry on first use'));

  setLoadingStatus('Loading documents…', 70);
  await loadDocumentsScreen();

  setLoadingStatus('Starting camera…', 85);
  await startCamera().catch(() => {/* handled inside startCamera */});

  setLoadingStatus('Ready!', 100);

  // Fade out loading screen
  setTimeout(() => {
    showScreen('camera-screen');
    document.getElementById('loading-screen').classList.remove('active');
  }, 400);
}

function setLoadingStatus(msg, pct) {
  const bar    = document.getElementById('loading-bar');
  const status = document.getElementById('loading-status');
  if (bar)    bar.style.width = `${pct}%`;
  if (status) status.textContent = msg;
}

/* ════════════════════════════════════════════════════════════
   SCREEN ROUTER
═══════════════════════════════════════════════════════════════ */
const SCREENS_WITH_NAV = ['camera-screen', 'documents-screen'];

function showScreen(id) {
  const all = document.querySelectorAll('.screen');
  all.forEach(s => {
    if (s.id === id) {
      s.classList.add('active');
      s.classList.remove('leaving');
    } else {
      s.classList.remove('active');
    }
  });
  App.currentScreen = id;

  // Update bottom nav
  const nav = document.querySelector('.bottom-nav');
  if (nav) {
    nav.style.display = SCREENS_WITH_NAV.includes(id) ? 'flex' : 'none';
    nav.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.target === id);
      btn.setAttribute('aria-current', btn.dataset.target === id ? 'page' : 'false');
    });
  }

  // Side-effects on entering screens
  if (id === 'camera-screen') {
    startCamera().catch(() => {});
  } else {
    stopCamera();
  }
}

/* ════════════════════════════════════════════════════════════
   REVIEW SCREEN  — crop / adjust corners
═══════════════════════════════════════════════════════════════ */
const cropState = {
  handles:   ['h-tl', 'h-tr', 'h-br', 'h-bl'],
  corners:   [],  // {x, y} in SVG/display coords
  dragging:  null,
  scale:     1,
  offsetX:   0,
  offsetY:   0,
  imgW:      0,
  imgH:      0,
};

function normalizeReviewCorners(canvas, corners) {
  const valid = Array.isArray(corners)
    && corners.length === 4
    && corners.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  const base = valid
    ? orderCorners(corners)
    : fullImageCorners(canvas.width, canvas.height);
  return base.map(p => ({
    x: Math.max(0, Math.min(canvas.width, p.x)),
    y: Math.max(0, Math.min(canvas.height, p.y)),
  }));
}

function openReviewScreen(canvas, corners) {
  const normalizedCorners = normalizeReviewCorners(canvas, corners);
  App.session.rawCanvas  = canvas;
  App.session.rawCorners = normalizedCorners;

  const cropCanvas = document.getElementById('crop-canvas');
  const cropSVG    = document.getElementById('crop-svg');
  cropCanvas.width  = canvas.width;
  cropCanvas.height = canvas.height;
  cropCanvas.getContext('2d').drawImage(canvas, 0, 0);

  showScreen('review-screen');

  const layoutCropOverlay = (attempt = 0) => {
    const wrap = document.getElementById('crop-wrap');
    const { clientWidth: wW, clientHeight: wH } = wrap;
    if ((!wW || !wH) && attempt < 4) {
      requestAnimationFrame(() => layoutCropOverlay(attempt + 1));
      return;
    }
    const safeW = wW || canvas.width;
    const safeH = wH || canvas.height;
    const scale  = Math.min(safeW / canvas.width, safeH / canvas.height, 1);
    const dispW  = Math.round(canvas.width  * scale);
    const dispH  = Math.round(canvas.height * scale);
    cropCanvas.style.width  = dispW + 'px';
    cropCanvas.style.height = dispH + 'px';

    // Position SVG over canvas (relative to crop-wrap)
    const left = Math.max(0, (safeW - dispW) / 2);
    const top  = Math.max(0, (safeH - dispH) / 2);
    cropSVG.style.left   = left + 'px';
    cropSVG.style.top    = top + 'px';
    cropSVG.style.width  = dispW + 'px';
    cropSVG.style.height = dispH + 'px';
    cropSVG.setAttribute('viewBox', `0 0 ${dispW} ${dispH}`);

    cropState.scale   = scale;
    cropState.offsetX = 0;
    cropState.offsetY = 0;
    cropState.imgW    = canvas.width;
    cropState.imgH    = canvas.height;

    // Convert image-space corners to display-space
    cropState.corners = normalizedCorners.map(p => ({
      x: p.x * scale,
      y: p.y * scale,
    }));
    updateCropHandles();
  };
  requestAnimationFrame(() => layoutCropOverlay());
}

function updateCropHandles() {
  const poly    = document.getElementById('crop-poly');
  const corners = cropState.corners;
  poly.setAttribute('points', corners.map(p => `${p.x},${p.y}`).join(' '));

  cropState.handles.forEach((id, i) => {
    const h = document.getElementById(id);
    h.setAttribute('cx', corners[i].x);
    h.setAttribute('cy', corners[i].y);
  });
}

function initCropHandlers() {
  cropState.handles.forEach((id, idx) => {
    const h = document.getElementById(id);
    const onStart = (e) => {
      e.preventDefault();
      cropState.dragging = idx;
    };
    const onMove = (e) => {
      if (cropState.dragging === null) return;
      e.preventDefault();
      const svg  = document.getElementById('crop-svg');
      const rect = svg.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const x = Math.max(0, Math.min(clientX - rect.left, svg.clientWidth));
      const y = Math.max(0, Math.min(clientY - rect.top,  svg.clientHeight));
      cropState.corners[cropState.dragging] = { x, y };
      updateCropHandles();
    };
    const onEnd = () => { cropState.dragging = null; };

    h.addEventListener('mousedown',  onStart);
    h.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('mousemove',  onMove);
    document.addEventListener('touchmove',  onMove, { passive: false });
    document.addEventListener('mouseup',    onEnd);
    document.addEventListener('touchend',   onEnd);
  });
}

function getCropCornersInImageSpace() {
  const s = cropState.scale || 1;
  return cropState.corners.map(p => ({ x: p.x / s, y: p.y / s }));
}

/* ════════════════════════════════════════════════════════════
   EDIT SCREEN  — filters + OCR
═══════════════════════════════════════════════════════════════ */

function openEditScreen(warpedCanvas) {
  App.session.warpedCanvas = warpedCanvas;
  App.session.rotation     = 0;
  applyCurrentFilter();
  showScreen('edit-screen');
}

function applyCurrentFilter() {
  const src      = App.session.warpedCanvas;
  if (!src) return;
  const rotated  = rotateCanvas(src, App.session.rotation);
  const filtered = applyFilter(rotated, App.session.activeFilter);
  App.session.filteredCanvas = filtered;

  const editCanvas = document.getElementById('edit-canvas');
  editCanvas.width  = filtered.width;
  editCanvas.height = filtered.height;
  editCanvas.getContext('2d').drawImage(filtered, 0, 0);
}

function rotateCanvas(src, deg) {
  if (deg === 0) return src;
  const rad  = (deg * Math.PI) / 180;
  const cos  = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const newW = Math.round(src.width * cos + src.height * sin);
  const newH = Math.round(src.width * sin + src.height * cos);
  const out  = document.createElement('canvas');
  out.width  = newW;
  out.height = newH;
  const ctx  = out.getContext('2d');
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

/* ════════════════════════════════════════════════════════════
   DOCUMENTS SCREEN
═══════════════════════════════════════════════════════════════ */

async function loadDocumentsScreen() {
  const docs = await getAllDocuments();
  renderDocGrid(docs);
}

function renderDocGrid(docs) {
  const grid  = document.getElementById('doc-grid');
  const empty = document.getElementById('empty-state');
  // Remove existing cards (keep empty state element)
  Array.from(grid.children).forEach(c => {
    if (c !== empty) grid.removeChild(c);
  });

  if (!docs || docs.length === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  const fragment = document.createDocumentFragment();
  docs.forEach(doc => {
    const card = createDocCard(doc);
    fragment.appendChild(card);
  });
  grid.appendChild(fragment);
}

function createDocCard(doc) {
  const thumb = (doc.pages && doc.pages[0] && doc.pages[0].thumbnailDataUrl)
    || (doc.pages && doc.pages[0] && doc.pages[0].imageDataUrl)
    || '';

  const card  = document.createElement('div');
  card.className    = 'doc-card';
  card.setAttribute('role', 'listitem');
  card.dataset.id   = doc.id;

  const imgEl = document.createElement('img');
  imgEl.className = 'doc-thumb';
  imgEl.alt       = doc.title;
  imgEl.loading   = 'lazy';
  if (thumb) imgEl.src = thumb;

  const info = document.createElement('div');
  info.className = 'doc-info';

  const name = document.createElement('div');
  name.className   = 'doc-name';
  name.textContent = doc.title;

  const meta = document.createElement('div');
  meta.className   = 'doc-meta';
  const pageCount  = (doc.pages || []).length;
  meta.textContent = `${pageCount} page${pageCount !== 1 ? 's' : ''} · ${formatDate(doc.createdAt)}`;

  info.appendChild(name);
  info.appendChild(meta);
  card.appendChild(imgEl);
  card.appendChild(info);

  card.addEventListener('click', () => openDetailScreen(doc.id));
  return card;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ════════════════════════════════════════════════════════════
   DETAIL SCREEN
═══════════════════════════════════════════════════════════════ */

async function openDetailScreen(docId) {
  App.currentDocId = docId;
  const doc = await getDocument(docId);
  if (!doc) { showToast('Document not found', 'error'); return; }

  document.getElementById('detail-title').textContent = doc.title;
  renderPageStrip(doc.pages || []);
  document.getElementById('detail-ocr-panel').classList.remove('visible');
  document.getElementById('detail-ocr-text').textContent = '';

  showScreen('detail-screen');
}

function renderPageStrip(pages) {
  const strip = document.getElementById('page-strip');
  strip.innerHTML = '';
  pages.forEach((page, i) => {
    const item = document.createElement('div');
    item.className = 'page-item';
    item.setAttribute('role', 'listitem');

    const header = document.createElement('div');
    header.className   = 'page-item-header';
    header.textContent = `Page ${i + 1}`;

    const img   = document.createElement('img');
    img.src     = page.imageDataUrl || '';
    img.alt     = `Page ${i + 1}`;
    img.loading = 'lazy';

    item.appendChild(header);
    item.appendChild(img);
    strip.appendChild(item);
  });
}

/* ════════════════════════════════════════════════════════════
   SAVE  (end of scan flow)
═══════════════════════════════════════════════════════════════ */

async function saveCurrentScan() {
  const canvas = App.session.filteredCanvas;
  if (!canvas) { showToast('Nothing to save', 'error'); return; }

  showToast('Saving…');

  const imageDataUrl = canvasToDataUrl(canvas, 'jpeg', 0.88);
  const thumbCanvas  = makeThumbnail(canvas, 300);
  const thumbnailDataUrl = canvasToDataUrl(thumbCanvas, 'jpeg', 0.7);

  const page = {
    imageDataUrl,
    thumbnailDataUrl,
    filter: App.session.activeFilter,
    text:   App.session.ocrText || '',
  };

  const title = `Scan ${new Date().toLocaleDateString()}`;

  try {
    const id = await saveDocument({ title, pages: [page] });
    showToast('Saved!', 'success');
    App.session = resetSession();
    await loadDocumentsScreen();
    showScreen('documents-screen');
  } catch (err) {
    console.error('Save error:', err);
    showToast('Failed to save', 'error');
  }
}

function makeThumbnail(canvas, maxDim) {
  const scale  = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
  const out    = document.createElement('canvas');
  out.width    = Math.round(canvas.width  * scale);
  out.height   = Math.round(canvas.height * scale);
  out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

function resetSession() {
  return {
    rawCanvas: null, rawCorners: null, warpedCanvas: null,
    filteredCanvas: null, activeFilter: 'document',
    ocrText: '', rotation: 0,
  };
}

/* ════════════════════════════════════════════════════════════
   OCR
═══════════════════════════════════════════════════════════════ */

async function runOCR(canvas, targetEl, panelEl) {
  if (!canvas) { showToast('No image to process', 'error'); return; }

  targetEl.innerHTML = '<div class="ocr-loading"><div class="spinner"></div>Recognising text…</div>';
  panelEl.classList.add('visible');

  try {
    const { text } = await recognizeText(canvas, (pct, msg) => {
      targetEl.innerHTML = `<div class="ocr-loading"><div class="spinner"></div>${msg} (${pct}%)</div>`;
    });
    targetEl.textContent = text || '(No text detected)';
    return text;
  } catch (err) {
    console.error('OCR error:', err);
    targetEl.textContent = 'OCR failed. Please try again.';
    showToast('OCR failed', 'error');
    return '';
  }
}

/* ════════════════════════════════════════════════════════════
   EXPORT MODAL
═══════════════════════════════════════════════════════════════ */
let _exportTarget = null; // 'edit' | 'detail'

function openExportModal(target) {
  _exportTarget = target;
  document.getElementById('export-modal').style.display = 'flex';
}
function closeExportModal() {
  document.getElementById('export-modal').style.display = 'none';
}

async function handleExport(type) {
  closeExportModal();
  if (_exportTarget === 'edit') {
    const canvas = App.session.filteredCanvas;
    if (!canvas) return;
    if (type === 'pdf') {
      await exportPDF([{ imageDataUrl: canvasToDataUrl(canvas) }], 'leus-scan.pdf');
    } else {
      exportImage(canvasToDataUrl(canvas, type), 'leus-scan', type);
    }
  } else if (_exportTarget === 'detail' && App.currentDocId) {
    const doc = await getDocument(App.currentDocId);
    if (!doc) return;
    if (type === 'pdf') {
      await exportPDF(doc.pages, `${doc.title}.pdf`);
    } else {
      doc.pages.forEach((p, i) =>
        exportImage(p.imageDataUrl, `${doc.title}-p${i+1}`, type)
      );
    }
  }
  showToast('Download started!', 'success');
}

/* ════════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════════════ */
let _toastTimer = null;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = `toast show ${type}`;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

/* ════════════════════════════════════════════════════════════
   SEARCH
═══════════════════════════════════════════════════════════════ */
async function handleSearch(query) {
  const docs    = await getAllDocuments();
  const q       = query.trim().toLowerCase();
  const results = q
    ? docs.filter(d =>
        d.title.toLowerCase().includes(q) ||
        (d.pages || []).some(p => (p.text || '').toLowerCase().includes(q))
      )
    : docs;
  renderDocGrid(results);
}

/* ════════════════════════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════════════════════════ */
function wireEvents() {

  /* ── Bottom nav ─────────────────────────────────── */
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target === 'documents-screen') loadDocumentsScreen();
      showScreen(target);
    });
  });

  /* ── Camera screen ──────────────────────────────── */
  document.getElementById('capture-btn').addEventListener('click', () => {
    const captured = captureFrame();
    if (!captured) { showToast('Camera not ready', 'error'); return; }
    openReviewScreen(captured.canvas, captured.corners);
  });

  document.getElementById('flip-camera-btn').addEventListener('click', flipCamera);

  document.getElementById('import-btn').addEventListener('click', async () => {
    const items = await importFiles();
    if (!items || !items.length) return;
    // Open first imported image in review
    openReviewScreen(items[0].canvas, items[0].corners);
  });

  document.getElementById('gallery-open-btn').addEventListener('click', async () => {
    await loadDocumentsScreen();
    showScreen('documents-screen');
  });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      App.scanMode = btn.dataset.mode;
      // Pre-select matching filter
      App.session.activeFilter = btn.dataset.mode;
    });
  });

  /* ── Review screen ──────────────────────────────── */
  document.getElementById('review-back-btn').addEventListener('click', () => {
    showScreen('camera-screen');
  });

  document.getElementById('review-retake-btn').addEventListener('click', () => {
    App.session = resetSession();
    showScreen('camera-screen');
  });

  document.getElementById('review-auto-btn').addEventListener('click', () => {
    // Re-run auto detection on current raw canvas
    if (!App.session.rawCanvas) return;
    const { detectDocumentCorners: detect, fullImageCorners: full }
      = window.LeusScanner;
    const corners = detect(App.session.rawCanvas)
      || full(App.session.rawCanvas.width, App.session.rawCanvas.height);
    openReviewScreen(App.session.rawCanvas, corners);
  });

  document.getElementById('review-apply-btn').addEventListener('click', () => {
    const corners = getCropCornersInImageSpace();
    const warped  = perspectiveWarp(App.session.rawCanvas, corners);
    // Pre-apply the scan mode filter
    App.session.activeFilter = App.scanMode;
    openEditScreen(warped);
  });

  /* ── Edit screen ────────────────────────────────── */
  document.getElementById('edit-back-btn').addEventListener('click', () => {
    showScreen('review-screen');
  });

  document.getElementById('rotate-btn').addEventListener('click', () => {
    App.session.rotation = (App.session.rotation + 90) % 360;
    applyCurrentFilter();
  });

  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => {
        c.classList.remove('active');
        c.setAttribute('aria-checked', 'false');
      });
      chip.classList.add('active');
      chip.setAttribute('aria-checked', 'true');
      App.session.activeFilter = chip.dataset.filter;
      applyCurrentFilter();
    });
  });

  document.getElementById('ocr-trigger-btn').addEventListener('click', async () => {
    const text = await runOCR(
      App.session.filteredCanvas,
      document.getElementById('ocr-text'),
      document.getElementById('ocr-panel'),
    );
    App.session.ocrText = text;
  });

  document.getElementById('ocr-close-btn').addEventListener('click', () => {
    document.getElementById('ocr-panel').classList.remove('visible');
  });

  document.getElementById('ocr-copy-btn').addEventListener('click', () => {
    const text = document.getElementById('ocr-text').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
  });

  document.getElementById('edit-save-btn').addEventListener('click', saveCurrentScan);

  document.getElementById('edit-export-btn').addEventListener('click', () => {
    openExportModal('edit');
  });

  /* ── Documents screen ───────────────────────────── */
  document.getElementById('new-scan-btn').addEventListener('click', () => {
    showScreen('camera-screen');
  });

  document.getElementById('start-scan-btn').addEventListener('click', () => {
    showScreen('camera-screen');
  });

  document.getElementById('docs-search-btn').addEventListener('click', () => {
    const wrap = document.getElementById('search-bar-wrap');
    const visible = wrap.style.display !== 'none';
    wrap.style.display = visible ? 'none' : 'block';
    if (!visible) document.getElementById('docs-search-input').focus();
  });

  document.getElementById('docs-search-input').addEventListener('input', (e) => {
    handleSearch(e.target.value);
  });

  /* ── Detail screen ──────────────────────────────── */
  document.getElementById('detail-back-btn').addEventListener('click', async () => {
    await loadDocumentsScreen();
    showScreen('documents-screen');
  });

  document.getElementById('detail-delete-btn').addEventListener('click', async () => {
    if (!App.currentDocId) return;
    if (!confirm('Delete this document?')) return;
    await deleteDocument(App.currentDocId);
    App.currentDocId = null;
    showToast('Deleted', 'success');
    await loadDocumentsScreen();
    showScreen('documents-screen');
  });

  document.getElementById('detail-add-page-btn').addEventListener('click', async () => {
    // Go to camera for an additional page
    App.editing.docId = App.currentDocId;
    showScreen('camera-screen');
  });

  document.getElementById('detail-ocr-btn').addEventListener('click', async () => {
    const doc = await getDocument(App.currentDocId);
    if (!doc || !doc.pages.length) return;
    // Concatenate OCR from all pages
    const panel  = document.getElementById('detail-ocr-panel');
    const target = document.getElementById('detail-ocr-text');
    panel.classList.add('visible');
    target.innerHTML = '<div class="ocr-loading"><div class="spinner"></div>Processing all pages…</div>';

    let allText = '';
    for (let i = 0; i < doc.pages.length; i++) {
      const page = doc.pages[i];
      target.innerHTML = `<div class="ocr-loading"><div class="spinner"></div>Page ${i+1}/${doc.pages.length}…</div>`;
      if (page.text) {
        allText += (allText ? '\n\n' : '') + `[Page ${i+1}]\n` + page.text;
      } else {
        // Run OCR on page image
        const img = new Image();
        img.src = page.imageDataUrl;
        await new Promise(r => { img.onload = r; });
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const { text } = await recognizeText(canvas);
        allText += (allText ? '\n\n' : '') + `[Page ${i+1}]\n` + text;
        // Cache OCR result
        page.text = text;
      }
    }
    await updateDocument(App.currentDocId, { pages: doc.pages });
    target.textContent = allText || '(No text detected)';
  });

  document.getElementById('detail-ocr-close-btn').addEventListener('click', () => {
    document.getElementById('detail-ocr-panel').classList.remove('visible');
  });

  document.getElementById('detail-ocr-copy-btn').addEventListener('click', () => {
    const text = document.getElementById('detail-ocr-text').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
  });

  document.getElementById('detail-export-btn').addEventListener('click', () => {
    openExportModal('detail');
  });

  /* ── Export modal ───────────────────────────────── */
  document.getElementById('export-pdf-btn').addEventListener('click', () => handleExport('pdf'));
  document.getElementById('export-jpg-btn').addEventListener('click', () => handleExport('jpeg'));
  document.getElementById('export-png-btn').addEventListener('click', () => handleExport('png'));
  document.getElementById('export-cancel-btn').addEventListener('click', closeExportModal);
  document.getElementById('export-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeExportModal();
  });

  /* ── Window resize — fix crop SVG position ──────── */
  window.addEventListener('resize', () => {
    if (App.currentScreen === 'review-screen') {
      openReviewScreen(App.session.rawCanvas, App.session.rawCorners);
    }
  });
}

/* ════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  initCropHandlers();
  wireEvents();
  await boot();
});

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {/* non-critical */});
  });
}
