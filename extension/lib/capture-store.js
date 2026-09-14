// Extension-origin storage shared by the worker and offscreen document.
// Content scripts have a different origin and must transfer bytes explicitly.
async function captureStore(op, key, value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('genmusicassist-transfer', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('items');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('items', op === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('items');
      const request = op === 'put' ? store.put(value, key) : store[op](key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Capture storage failed'));
    });
  } finally { db.close(); }
}
function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function base64ToBytes(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid base64 audio payload');
  }
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
