// db.js — IndexedDB 封装，存采集结果（正文/引用/DOM）、截图（Blob 单独存）、会话（抽屉）。
// storage.session 只放轻量任务状态；storage.local 放当前活动会话 id；大数据走这里。

const DB_NAME = 'geo_collect';
const DB_VERSION = 3;
const STORE = 'results';
const SHOTS = 'screenshots';
const SESS = 'sessions';
const ACTIVE_KEY = 'geo_active_session';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        os.createIndex('runId', 'runId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SHOTS)) {
        db.createObjectStore(SHOTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SESS)) {
        db.createObjectStore(SESS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- 结果 ----
export async function saveResult(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add({ deleted: false, ...record, savedAt: record.savedAt || Date.now() });
    tx.oncomplete = () => resolve(req.result); // 返回自增 id
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllResults() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// 软删除 / 恢复一条结果
export async function setResultDeleted(id, deleted) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    const g = os.get(id);
    g.onsuccess = () => {
      const rec = g.result;
      if (rec) { rec.deleted = !!deleted; os.put(rec); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearResults() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, SHOTS], 'readwrite');
    tx.objectStore(STORE).clear();
    tx.objectStore(SHOTS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- 会话（抽屉）----
export async function createSession(session) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESS, 'readwrite');
    tx.objectStore(SESS).put({ deleted: false, ...session });
    tx.oncomplete = () => resolve(session);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllSessions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESS, 'readonly');
    const req = tx.objectStore(SESS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function getSession(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESS, 'readonly');
    const req = tx.objectStore(SESS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function setSessionDeleted(id, deleted) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESS, 'readwrite');
    const os = tx.objectStore(SESS);
    const g = os.get(id);
    g.onsuccess = () => {
      const s = g.result;
      if (s) { s.deleted = !!deleted; os.put(s); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function renameSession(id, title) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESS, 'readwrite');
    const os = tx.objectStore(SESS);
    const g = os.get(id);
    g.onsuccess = () => {
      const s = g.result;
      if (s) { s.title = title; os.put(s); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- 当前活动会话 id（storage.local，popup 与 SW 共享）----
export async function getActiveSessionId() {
  const o = await chrome.storage.local.get(ACTIVE_KEY);
  return o[ACTIVE_KEY] || null;
}

export async function setActiveSessionId(id) {
  await chrome.storage.local.set({ [ACTIVE_KEY]: id });
}

// ---- 截图 ----
export async function saveScreenshot(id, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SHOTS, 'readwrite');
    tx.objectStore(SHOTS).put({ id, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getScreenshot(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SHOTS, 'readonly');
    const req = tx.objectStore(SHOTS).get(id);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  });
}
