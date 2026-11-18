// Isolated-world content script: receives messages from interceptor.js, saves to extension storage.
const TAG = "__bk_exporter__";
let queue = Promise.resolve();
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || !e.data[TAG]) return;
  const patch = e.data.patch || {};
  queue = queue.then(() => new Promise((done) => {
    chrome.storage.local.get("capture", ({ capture }) => {
      const prev = capture || {};
      const log = [...(prev.log || [])];
      if (patch.log) log.push(patch.log);
      chrome.storage.local.set({
        capture: { headers: { ...(prev.headers || {}), ...(patch.headers || {}) }, log: log.slice(-60), updatedAt: Date.now() }
      }, done);
    });
  }));
});
