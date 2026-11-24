// IndexedDB persistence layer. Everything lives in the browser; export/import gives portable backups.

const DB_NAME = 'equity-research';
const DB_VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('companies')) db.createObjectStore('companies', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('companyId', 'companyId');
      }
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: 'id' });
        s.createIndex('companyId', 'companyId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(store, id) { listeners.forEach(fn => { try { fn(store, id); } catch (e) { console.error(e); } }); }

export const db = {
  async all(store) { return tx(store, 'readonly', s => s.getAll()); },
  async get(store, id) { return tx(store, 'readonly', s => s.get(id)); },
  async byIndex(store, index, value) { return tx(store, 'readonly', s => s.index(index).getAll(value)); },
  async put(store, obj, { silent = false } = {}) {
    if (store !== 'kv' && store !== 'files') obj.updatedAt = obj.updatedAt && silent ? obj.updatedAt : Date.now();
    await tx(store, 'readwrite', s => s.put(obj));
    if (!silent) emit(store, obj.id);
    return obj;
  },
  async putMany(store, objs) {
    await tx(store, 'readwrite', s => { objs.forEach(o => s.put(o)); });
    emit(store, null);
  },
  async del(store, id) { await tx(store, 'readwrite', s => s.delete(id)); emit(store, id); },
  async clear(store) { await tx(store, 'readwrite', s => s.clear()); emit(store, null); },
  async getKV(key, fallback = null) {
    const v = await tx('kv', 'readonly', s => s.get(key));
    return v === undefined ? fallback : v;
  },
  async setKV(key, value) { await tx('kv', 'readwrite', s => s.put(value, key)); },
};

// ---- Backup / restore ---------------------------------------------------

function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
async function dataURLToBlob(url) { return (await fetch(url)).blob(); }

export async function exportAll({ includeFiles = true } = {}) {
  const [companies, notes, files] = await Promise.all([db.all('companies'), db.all('notes'), includeFiles ? db.all('files') : []]);
  const outFiles = [];
  for (const f of files) outFiles.push({ ...f, blob: undefined, dataURL: await blobToDataURL(f.blob) });
  return { app: 'equity-research', version: 1, exportedAt: new Date().toISOString(), companies, notes, files: outFiles };
}

export async function importAll(data, { mode = 'merge' } = {}) {
  if (!data || data.app !== 'equity-research') throw new Error('Not an equity-research backup file');
  if (mode === 'replace') { await db.clear('companies'); await db.clear('notes'); await db.clear('files'); }
  const keepNewer = async (store, items) => {
    const existing = new Map((await db.all(store)).map(x => [x.id, x]));
    const toPut = items.filter(x => !existing.has(x.id) || (x.updatedAt || 0) >= (existing.get(x.id).updatedAt || 0));
    if (toPut.length) await tx(store, 'readwrite', s => toPut.forEach(o => s.put(o)));
    return toPut.length;
  };
  const c = await keepNewer('companies', data.companies || []);
  const n = await keepNewer('notes', data.notes || []);
  const files = [];
  for (const f of data.files || []) {
    if (!f.dataURL) continue;
    const { dataURL, ...rest } = f;
    files.push({ ...rest, blob: await dataURLToBlob(dataURL) });
  }
  if (files.length) await tx('files', 'readwrite', s => files.forEach(o => s.put(o)));
  emit(null, null);
  return { companies: c, notes: n, files: files.length };
}
