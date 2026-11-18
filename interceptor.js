// Runs in the page (MAIN world). Observes fetch/XHR to learn auth headers and the invoice URL.
// Sends findings to relay.js via postMessage; nothing is written to the page's localStorage.
(() => {
  const TAG = "__bk_exporter__";
  const isBlinkit = (u) => {
    try { return new URL(u, location.href).hostname.endsWith("blinkit.com"); }
    catch { return false; }
  };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const send = (patch) => window.postMessage({ [TAG]: true, patch }, location.origin);

  const AUTH_RE = /auth|token|access|session|device|app_client|app_version|lat|lon|web_app/i;
  const pickAuth = (h) => {
    const out = {};
    if (!h) return out;
    const entries = h instanceof Headers ? [...h.entries()]
      : Array.isArray(h) ? h : Object.entries(h);
    for (const [k, v] of entries) if (AUTH_RE.test(k)) out[k] = v;
    return out;
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [resource, config] = args;
    const rawUrl = typeof resource === "string" ? resource : resource?.url || String(resource);
    const mine = isBlinkit(rawUrl);
    if (mine) {
      const hdrs = { ...pickAuth(resource?.headers), ...pickAuth(config?.headers) };
      if (Object.keys(hdrs).length) send({ headers: hdrs });
      if (/invoice/i.test(rawUrl)) send({ invoiceUrlSample: abs(rawUrl) });
    }
    const res = await origFetch.apply(this, args);
    if (mine && /invoice/i.test(rawUrl)) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        res.clone().json().then((d) => send({ invoiceJsonSample: JSON.stringify(d).slice(0, 2000) })).catch(() => {});
      }
    }
    return res;
  };

  const oOpen = XMLHttpRequest.prototype.open;
  const oSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, url, ...rest) {
    this.__u = url;
    if (isBlinkit(url) && /invoice/i.test(String(url))) send({ invoiceUrlSample: abs(url) });
    return oOpen.call(this, m, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__u && isBlinkit(this.__u)) {
      const h = pickAuth({ [k]: v });
      if (Object.keys(h).length) send({ headers: h });
    }
    return oSet.call(this, k, v);
  };

  // Also catch invoices opened via window.open / link clicks
  const oWinOpen = window.open;
  window.open = function (url, ...rest) {
    if (url && /invoice/i.test(String(url))) send({ invoiceUrlSample: abs(String(url)) });
    return oWinOpen.call(this, url, ...rest);
  };
})();
