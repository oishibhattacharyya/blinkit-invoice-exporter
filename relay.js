// Isolated-world content script: receives messages from interceptor.js, stores in extension storage.
const TAG = "__bk_exporter__";
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || !e.data[TAG]) return;
  const patch = e.data.patch || {};
  chrome.storage.local.get("capture", ({ capture }) => {
    const prev = capture || {};
    chrome.storage.local.set({
      capture: {
        ...prev,
        ...patch,
        headers: { ...(prev.headers || {}), ...(patch.headers || {}) },
        updatedAt: Date.now()
      }
    });
  });
});
