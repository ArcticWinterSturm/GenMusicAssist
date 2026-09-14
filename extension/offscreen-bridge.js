// The offscreen document owns blob URLs; only the service worker downloads.
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
let creationPromise = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  if (!creationPromise) {
    creationPromise = (async () => {
      if (!await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: ['BLOBS'], justification: 'Create blob URLs for saving captured audio' });
      }
      return true;
    })().finally(() => { creationPromise = null; });
  }
  return creationPromise;
}
async function downloadViaOffscreen(bytes, mime, filename, timeoutMs) {
  const key = `download:${crypto.randomUUID()}`;
  await captureStore('put', key, { bytes, mime });
  try {
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-url', key });
    if (!result?.ok || !result.url) throw new Error(result?.error || 'Offscreen document did not respond');
    const id = await chrome.downloads.download({ url: result.url, filename, saveAs: false, conflictAction: 'uniquify' });
    if (!await waitForDownload(id, timeoutMs)) throw new Error(`download ${id} did not complete`);
    return id;
  } finally {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-revoke', key }).catch(() => {});
    await captureStore('delete', key);
  }
}
