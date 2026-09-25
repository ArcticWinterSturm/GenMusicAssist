const urls = new Map();
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'offscreen-revoke') {
    const url = urls.get(msg.key);
    if (url) URL.revokeObjectURL(url);
    urls.delete(msg.key);
    respond({ ok: true });
    return;
  }
  if (msg.type === 'offscreen-url') {
    (async () => {
      const item = await captureStore('get', msg.key);
      if (!item?.bytes?.byteLength) throw new Error('Download audio missing from extension storage');
      const url = URL.createObjectURL(new Blob([item.bytes], { type: item.mime }));
      urls.set(msg.key, url);
      respond({ ok: true, url });
    })().catch((e) => respond({ ok: false, error: e.message }));
    return true;
  }
});
