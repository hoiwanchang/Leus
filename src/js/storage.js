/**
 * storage.js — IndexedDB wrapper for Leus document persistence.
 * All data stays local in the browser. No network calls.
 */

const DB_NAME    = 'leus-db';
const DB_VERSION = 1;
const STORE_DOCS = 'documents';

let _db = null;

/** Open (or create) the database */
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        const store = db.createObjectStore(STORE_DOCS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror    = (e) => reject(e.target.error);
  });
}

/** Generic transaction helper */
async function tx(mode, fn) {
  const db       = await openDB();
  const trans    = db.transaction(STORE_DOCS, mode);
  const store    = trans.objectStore(STORE_DOCS);
  return new Promise((resolve, reject) => {
    const req = fn(store);
    if (req && typeof req.onsuccess === 'undefined') {
      // fn returned nothing — resolve on complete
      trans.oncomplete = () => resolve();
      trans.onerror    = (e) => reject(e.target.error);
    } else {
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    }
  });
}

/** All documents, newest first */
export async function getAllDocuments() {
  const db    = await openDB();
  const trans = db.transaction(STORE_DOCS, 'readonly');
  const store = trans.objectStore(STORE_DOCS);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = (e) => {
      const docs = e.target.result || [];
      docs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      resolve(docs);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/** Get a single document by id */
export function getDocument(id) {
  return tx('readonly', (store) => store.get(id));
}

/**
 * Save a new document.
 * @param {Object} doc  — { title, pages: [{ id, imageDataUrl, thumbnailDataUrl, filter, text }] }
 * @returns {string} generated id
 */
export async function saveDocument(doc) {
  const id  = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();
  const record = {
    id,
    title:     doc.title     || `Scan ${new Date(now).toLocaleDateString()}`,
    createdAt: now,
    updatedAt: now,
    pages:     doc.pages     || [],
  };
  await tx('readwrite', (store) => store.put(record));
  return id;
}

/**
 * Update an existing document (merge — does not replace unknown fields).
 */
export async function updateDocument(id, updates) {
  const existing = await getDocument(id);
  if (!existing) throw new Error(`Document ${id} not found`);
  const updated = { ...existing, ...updates, id, updatedAt: Date.now() };
  await tx('readwrite', (store) => store.put(updated));
  return updated;
}

/** Append a page to an existing document */
export async function addPage(docId, page) {
  const doc = await getDocument(docId);
  if (!doc) throw new Error(`Document ${docId} not found`);
  const pageId = `page_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const newPage = { id: pageId, ...page };
  doc.pages.push(newPage);
  doc.updatedAt = Date.now();
  await tx('readwrite', (store) => store.put(doc));
  return pageId;
}

/** Delete a document */
export async function deleteDocument(id) {
  await tx('readwrite', (store) => store.delete(id));
}

/** Expose to window for other modules */
window.LeusStorage = {
  getAllDocuments,
  getDocument,
  saveDocument,
  updateDocument,
  addPage,
  deleteDocument,
};
