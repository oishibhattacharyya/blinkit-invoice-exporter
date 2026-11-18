// Runs in the page (MAIN world). Watches Blinkit's own network calls so the extension can
// learn (a) your session headers and (b) which request produces the invoice PDF.
(() => {
  const TAG = "__bk_exporter__";
  const isBlinkit = (u) => { try { return new URL(u, location.href).hostname.endsWith("blinkit.com"); } catch { return false; } };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return String(u); } };
  const send = (patch) => window.postMessage({ [TAG]: true, patch }, location.origin);
  const logReq = (entry) => send({ log: { ts: Date.now(), ...entry } });

  const AUTH_RE = /auth|token|access|session|device|app_client|app_version|lat|lon|web_app/i;
  const pickAuth = (h) => {
    const out = {};
    if (!h) return out;
    const entries = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
    for (const [k, v] of entries) if (AUTH_RE.test(k)) out[k] = v;
    return out;
  };
  const findPdfLink = (o, d = 0) => {
    if (o == null || d > 6) return "";
    if (typeof o === "string") return /^https?:\/\/\S+/i.test(o) && /(\.pdf|invoice)/i.test(o) ? o : "";
    if (typeof o === "object") for (const v of Object.values(o)) { const r = findPdfLink(v, d + 1); if (r) return r; }
    return "";
  };
  const findB64 = (o, d = 0) => {
    if (o == null || d > 6) return "";
    if (typeof o === "string") return o.startsWith("JVBERi") ? "yes" : "";
    if (typeof o === "object") for (const v of Object.values(o)) { const r = findB64(v, d + 1); if (r) return r; }
    return "";
  };
  const inspect = (base, ct, getJson) => {
    if (/pdf/i.test(ct)) return logReq({ ...base, isPdf: true });
    if (/json/i.test(ct)) {
      Promise.resolve().then(getJson).then((d) => {
        const l = findPdfLink(d), b = findB64(d);
        if (l || b) logReq({ ...base, pdfLink: l || undefined, jsonPdf: !!b });
        else if (/invoice/i.test(base.url)) logReq(base);
      }).catch(() => {});
    } else if (/invoice/i.test(base.url)) logReq(base);
  };

  // fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const [resource, config] = args;
    const raw = typeof resource === "string" ? resource : resource?.url || String(resource);
    const mine = isBlinkit(raw);
    let base = null;
    if (mine) {
      const h = { ...pickAuth(resource?.headers), ...pickAuth(config?.headers) };
      if (Object.keys(h).length) send({ headers: h });
      base = {
        url: abs(raw),
        method: (config?.method || resource?.method || "GET").toUpperCase(),
        body: typeof config?.body === "string" ? config.body : ""
      };
    }
    const res = await origFetch.apply(this, args);
    if (mine) inspect(base, res.headers.get("content-type") || "", () => res.clone().json());
    return res;
  };

  // XHR
  const oOpen = XMLHttpRequest.prototype.open, oSet = XMLHttpRequest.prototype.setRequestHeader, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url, ...rest) { this.__m = String(m).toUpperCase(); this.__u = url; return oOpen.call(this, m, url, ...rest); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__u && isBlinkit(this.__u)) { const h = pickAuth({ [k]: v }); if (Object.keys(h).length) send({ headers: h }); }
    return oSet.call(this, k, v);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__u && isBlinkit(this.__u)) {
      const base = { url: abs(this.__u), method: this.__m || "GET", body: typeof body === "string" ? body : "" };
      this.addEventListener("load", () => {
        const ct = this.getResponseHeader("content-type") || "";
        inspect(base, ct, () => this.responseType === "json" ? this.response : JSON.parse(this.responseText));
      });
    }
    return oSend.call(this, body);
  };

  // Navigations / downloads
  const nav = (u) => { if (u && /invoice|\.pdf/i.test(String(u))) logReq({ url: abs(String(u)), method: "GET", nav: true }); };
  const oWinOpen = window.open;
  window.open = function (u, ...rest) { nav(u); return oWinOpen.call(this, u, ...rest); };
  document.addEventListener("click", (e) => { const a = e.target?.closest?.("a[href]"); if (a) nav(a.href); }, true);
  const oAClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { nav(this.href); return oAClick.call(this); };

  // PDF generated inside the page itself (no server URL to reuse)
  const oObj = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    if (obj && /pdf/i.test(obj.type || "")) logReq({ url: location.href, method: "GET", blobPdf: true });
    return oObj.call(this, obj);
  };
})();
