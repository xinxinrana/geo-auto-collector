const NAME = 'geo_collector_mvp';
let opening;
function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('tasks', { keyPath: 'id' }); req.result.createObjectStore('settings'); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  return opening;
}
export async function transaction(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode); const request = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('存储事务中断'));
  });
}
export const getTask = id => transaction('tasks', 'readonly', s => s.get(id));
export const allTasks = () => transaction('tasks', 'readonly', s => s.getAll());
export const putTask = task => transaction('tasks', 'readwrite', s => s.put(task));
export const getSetting = key => transaction('settings', 'readonly', s => s.get(key));
export const putSetting = (key, value) => transaction('settings', 'readwrite', s => s.put(value, key));
