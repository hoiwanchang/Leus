/**
 * export.js — PDF and image export using jsPDF.
 * All processing is local; files are downloaded directly to the device.
 */

const JSPDF_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

let _jsPDFLoaded = false;

function loadJsPDF() {
  if (_jsPDFLoaded || (window.jspdf && window.jspdf.jsPDF)) {
    _jsPDFLoaded = true;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const s   = document.createElement('script');
    s.src     = JSPDF_CDN;
    s.async   = true;
    s.onload  = () => { _jsPDFLoaded = true; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/* ── Public API ─────────────────────────────────────────────── */

/**
 * Export one or more pages as a PDF and trigger download.
 * @param {Array<{imageDataUrl: string}>} pages  Array of page objects
 * @param {string} filename  e.g. "my-document.pdf"
 */
export async function exportPDF(pages, filename = 'leus-scan.pdf') {
  await loadJsPDF();
  const { jsPDF } = window.jspdf;

  let pdf = null;

  for (let i = 0; i < pages.length; i++) {
    const dataUrl = pages[i].imageDataUrl;
    const { w: imgW, h: imgH } = await getImageSize(dataUrl);

    // A4 = 210 × 297 mm; scale to fit
    const pageW  = 210;
    const pageH  = Math.round((imgH / imgW) * pageW);
    const orient = pageH > pageW ? 'portrait' : 'landscape';

    if (!pdf) {
      pdf = new jsPDF({ orientation: orient, unit: 'mm', format: [pageW, pageH] });
    } else {
      pdf.addPage([pageW, pageH], orient);
    }

    pdf.addImage(dataUrl, 'JPEG', 0, 0, pageW, pageH, undefined, 'FAST');
  }

  if (!pdf) return;
  pdf.save(filename);
}

/**
 * Export a single canvas/dataUrl as a JPEG image and trigger download.
 */
export async function exportImage(dataUrl, filename = 'leus-scan.jpg', type = 'jpeg') {
  const ext  = type === 'png' ? 'png' : 'jpg';
  const mime = type === 'png' ? 'image/png' : 'image/jpeg';
  const link = document.createElement('a');
  link.href     = await toMime(dataUrl, mime);
  link.download = filename.replace(/\.(jpg|jpeg|png)$/i, '') + '.' + ext;
  link.click();
}

/**
 * Export multiple pages as individual JPEG images (zipped via JSZip if available,
 * otherwise downloaded one-by-one).
 */
export function exportImages(pages, baseName = 'leus-scan', type = 'jpeg') {
  pages.forEach((page, i) => {
    exportImage(page.imageDataUrl, `${baseName}-p${i + 1}`, type);
  });
}

/* ── Utilities ──────────────────────────────────────────────── */

function getImageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.src    = dataUrl;
  });
}

/** Re-encode a dataUrl to a specific MIME type (canvas round-trip) */
function toMime(dataUrl, mime) {
  if (dataUrl.startsWith(`data:${mime}`)) return dataUrl;
  return new Promise((resolve) => {
    const img  = new Image();
    img.onload = () => {
      const canvas  = document.createElement('canvas');
      canvas.width  = img.naturalWidth  || 1;
      canvas.height = img.naturalHeight || 1;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas.toDataURL(mime, 0.92));
    };
    img.src = dataUrl;
  });
}

/**
 * Convert a canvas to a dataUrl (JPEG by default).
 */
export function canvasToDataUrl(canvas, type = 'jpeg', quality = 0.92) {
  const mime = type === 'png' ? 'image/png' : 'image/jpeg';
  return canvas.toDataURL(mime, quality);
}

window.LeusExport = { exportPDF, exportImage, exportImages, canvasToDataUrl };
