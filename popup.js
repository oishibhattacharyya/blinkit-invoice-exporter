const $ = (id) => document.getElementById(id);
const log = (m) => { $("log").textContent += m + "\n"; $("log").scrollTop = $("log").scrollHeight; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 600 + Math.random() * 400;
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);
const redact = (u) => { try { const x = new URL(u); return x.origin + x.pathname + (x.search ? "?" + [...x.searchParams.keys()].map((k) => k + "=…").join("&") : ""); } catch { return u; } };
const bufToB64 = (buf) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const isPdfBuf = (buf) => new TextDecoder().decode(buf.slice(0, 5)) === "%PDF-";
const fileName = (o) => `${safe(o.date)}_${o.cartId}_${o.orderId}_Rs${safe(o.amount)}.pdf`;
const PAGE_BASES = ["account"];   // https://blinkit.com/account/orders/{cartId}/{orderId}

let orders = [], templates = [], goodBase = null, pendingT0 = 0, stopFlag = false, worker = null;
let onlyIds = null;
let extraLog = [], capturing = false;   // browser-level events (navigations/downloads) seen while learning
let capture = { headers: {}, log: [] };

function parseOrders(raw) {
  const list = Array.isArray(raw) ? raw : raw.orders || raw.data?.orders || [];
  return list.map((o) => {
    let cartId = o.cartId ?? o.cart_id ?? "", orderId = o.orderId ?? o.order_id ?? o.id ?? "";
    const link = o.detailDeepLink || "";
    const c = link.match(/[?&]cart_id=([^&]+)/), d = link.match(/[?&]order_id=([^&]+)/);
    if (c) cartId = c[1]; if (d) orderId = d[1];
    return { orderId: String(orderId), cartId: String(cartId), date: String(o.date || "unknown-date"), amount: o.amount ?? 0, status: String(o.status || "") };
  }).filter((o) => o.orderId && o.cartId && !/cancel/i.test(o.status));
}
const safe = (s) => String(s).replace(/[\\/:*?"<>|,]+/g, "").replace(/\s+/g, "-");

async function loadCapture() {
  ({ capture = {} } = await chrome.storage.local.get("capture"));
  capture.headers = capture.headers || {}; capture.log = capture.log || [];
}
async function refresh() {
  await loadCapture();
  const n = Object.keys(capture.headers).length;
  $("authStatus").textContent = n ? "Yes" : "Not yet"; $("authStatus").className = "badge " + (n ? "ok" : "warn");
  $("endpointStatus").textContent = templates.length ? "Yes" : "Not yet"; $("endpointStatus").className = "badge " + (templates.length ? "ok" : "warn");
  $("tplView").textContent = templates.length ? templates.map((t, i) => `#${i + 1} ${t.method} ${t.url}${t.body ? "\nBody: " + t.body : ""}`).join("\n\n") : "–";
  $("detectBtn").disabled = !orders.length;
  $("startBtn").disabled = !(orders.length && templates.length);
}

// ---------- worker window (visible, so Blinkit renders normally) ----------
function navigate(tabId, url) {
  return new Promise((resolve) => {
    let saw = false;
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(to); resolve(); };
    const on = (id, info) => { if (id !== tabId) return; if (info.status === "loading") saw = true; if (info.status === "complete" && saw) done(); };
    const to = setTimeout(done, 30000);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.update(tabId, { url });
  });
}
async function ensureWorker() {
  if (worker) { try { await chrome.tabs.get(worker.tabId); return worker; } catch { worker = null; } }
  const w = await chrome.windows.create({ url: "about:blank", focused: true, width: 1100, height: 800 });
  worker = { winId: w.id, tabId: w.tabs[0].id };
  await navigate(worker.tabId, "https://blinkit.com/"); await sleep(1500);
  return worker;
}
// Blinkit's "Download invoice" sometimes opens the PDF in a new tab. We only need the request it
// made, so close any extra tab that opens from the worker window (after letting it register).
chrome.tabs.onCreated.addListener((tab) => {
  if (!worker || tab.id === worker.tabId) return;
  if (tab.openerTabId === worker.tabId || tab.windowId === worker.winId) {
    setTimeout(() => { chrome.tabs.remove(tab.id).catch(() => {}); }, 1500);
  }
});
// Browser-level watching: catches invoices that open as a PDF in the same tab, or that download
// directly, which in-page hooks can't see.
const isOrderOrHome = (u) => /\/account\/orders\//.test(u) || u.replace(/\/$/, "") === "https://blinkit.com" || u === "about:blank";
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (!capturing || !worker || d.tabId !== worker.tabId || d.frameId !== 0 || isOrderOrHome(d.url)) return;
  extraLog.push({ ts: Date.now(), url: d.url, method: "GET", nav: true, webnav: true });
});
chrome.downloads.onCreated.addListener((item) => {
  if (!capturing) return;
  extraLog.push({ ts: Date.now(), url: item.url, method: "GET", nav: true, download: true });
  // we only wanted to learn the address; don't leave stray PDFs in your Downloads folder
  chrome.downloads.cancel(item.id).catch(() => {}).finally(() => chrome.downloads.erase({ id: item.id }).catch(() => {}));
});
async function closeWorker() { capturing = false; if (worker) { try { await chrome.windows.remove(worker.winId); } catch {} worker = null; } }
async function goto(url) {
  const w = await ensureWorker();
  await navigate(w.tabId, url); await sleep(2000);
  return w.tabId;
}
async function tabInfo(tabId) { try { const t = await chrome.tabs.get(tabId); return `${t.url} — “${t.title}”`; } catch { return "(tab gone)"; } }
async function inTab(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

// ---------- code that runs inside the Blinkit page ----------
async function clickInvoiceInPage(waits) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clicked = new Set(), names = [];
  const find = () => {
    const els = [...document.querySelectorAll("a,button,[role=button],div,span,p,li")];
    const m = els.filter((e) => { const t = (e.innerText || "").trim(); return t && t.length < 40 && /invoice/i.test(t) && !clicked.has(e); });
    const deepest = m.filter((e) => !m.some((o) => o !== e && e.contains(o)));
    return deepest.find((e) => /download/i.test(e.innerText)) || deepest[0] || null;
  };
  for (const w of waits) {
    let el = null;
    for (let i = 0; i < w * 2 && !el; i++) { el = find(); if (!el) await sleep(500); }
    if (!el) break;
    clicked.add(el); names.push((el.innerText || "").trim());
    el.scrollIntoView({ block: "center" });
    el.click();
    await sleep(2500);
  }
  return { names, href: location.href };
}
async function fetchInPage(req, headers, linkOnly) {
  const findLink = (o, d = 0) => {
    if (o == null || d > 6) return "";
    if (typeof o === "string") return /^https?:\/\/\S+/i.test(o) && /(\.pdf|invoice)/i.test(o) ? o : "";
    if (typeof o === "object") for (const v of Object.values(o)) { const r = findLink(v, d + 1); if (r) return r; }
    return "";
  };
  const findB64 = (o, d = 0) => {
    if (o == null || d > 6) return "";
    if (typeof o === "string") return o.startsWith("JVBERi") ? o : "";
    if (typeof o === "object") for (const v of Object.values(o)) { const r = findB64(v, d + 1); if (r) return r; }
    return "";
  };
  const b64 = (buf) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const isPdf = (buf) => new TextDecoder().decode(buf.slice(0, 5)) === "%PDF-";
  try {
    const init = { method: req.method || "GET", headers: { ...headers }, credentials: "include" };
    if (req.body && init.method !== "GET") init.body = req.body;
    const res = await fetch(req.url, init);
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const ct = res.headers.get("content-type") || "";
    let buf;
    if (/json/i.test(ct)) {
      const j = await res.json();
      const inline = findB64(j);
      if (inline) return { base64: inline, size: Math.round(inline.length * 0.75) };
      const l = findLink(j);
      if (!l) return { error: "Server reply had no PDF in it" };
      if (linkOnly) return { link: l };
      const r2 = await fetch(l);
      if (!r2.ok) return { error: `PDF link HTTP ${r2.status}`, status: r2.status };
      buf = await r2.arrayBuffer();
    } else buf = await res.arrayBuffer();
    if (!isPdf(buf)) return { error: `Not a PDF (got ${ct.split(";")[0] || "unknown type"})` };
    return { base64: b64(buf), size: buf.byteLength };
  } catch (e) { return { error: e.message }; }
}

// ---------- templates ----------
function toTemplate(req, o) {
  const pairs = [[o.orderId, "{orderId}"], [o.cartId, "{cartId}"]].sort((a, b) => b[0].length - a[0].length);
  const sub = (s) => pairs.reduce((acc, [v, p]) => acc.split(v).join(p), s || "");
  return { url: sub(req.url), method: req.method || "GET", body: sub(req.body) };
}
const fillStr = (s, o) => s.split("{orderId}").join(o.orderId).split("{cartId}").join(o.cartId);
const fill = (t, o) => ({ url: fillStr(t.url, o), method: t.method, body: fillStr(t.body, o) });
function pickRequest(t0, o) {
  const c = [...capture.log, ...extraLog].filter((e) => e.ts >= t0 && !/X-Amz-Signature=/i.test(e.url)).sort((a, b) => a.ts - b.ts);
  const hasId = (e) => (e.url + (e.body || "")).includes(o.orderId) || (e.url + (e.body || "")).includes(o.cartId);
  const classes = [(e) => e.isPdf, (e) => e.pdfLink || e.jsonPdf, (e) => e.nav, (e) => /invoice/i.test(e.url)];
  for (const f of classes) { const hit = c.filter(f).find(hasId); if (hit) return hit; }
  for (const f of classes) { const m = c.filter(f); if (m.length) return m[0]; }
  return null;
}
async function fetchPdf(tabId, t, o) {
  const req = fill(t, o);
  // Stage 1 — inside the Blinkit tab: ask Blinkit for this invoice (login + headers come along).
  const r = await withTimeout(inTab(tabId, fetchInPage, [req, capture.headers, true]), 60000, "request").catch((e) => ({ error: e.message }));
  if (r.base64 || !r.link) return r;
  // Stage 2 — from the extension: fetch the PDF from its storage link (the page itself is often blocked from this).
  try {
    const res = await withTimeout(fetch(r.link), 60000, "file download");
    if (!res.ok) return { link: r.link, status: res.status, error: `file HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    if (!isPdfBuf(buf)) return { link: r.link, error: "file wasn't a PDF" };
    return { base64: bufToB64(buf), size: buf.byteLength };
  } catch (e) { return { link: r.link, error: e.message }; }
}

// Work out a template from what the page just did, and prove it by downloading this order's PDF.
async function finishFromCapture(tabId, o, t0) {
  // the click may have left this tab on a PDF page; go back to a normal Blinkit page so we can run code in it
  await sleep(500); await navigate(tabId, "https://blinkit.com/"); await sleep(1500);
  await loadCapture();
  const req = pickRequest(t0, o);
  if (!req) {
    const signed = [...capture.log, ...extraLog].some((e) => e.ts >= t0 && /X-Amz-Signature=/i.test(e.url));
    log(signed ? "  Saw only the one-time S3 file link, not the Blinkit request that creates it (S3 links can't be reused). Use ‘Copy diagnostic info’."
               : "  Nothing invoice-like was requested after the click.");
    return { error: "no invoice request caught" };
  }
  log(`  Using: ${req.method} ${redact(req.url)} [${req.isPdf ? "PDF" : req.pdfLink || req.jsonPdf ? "JSON with PDF link" : req.download ? "download" : req.webnav ? "page navigation" : "page request"}]`);
  const t = toTemplate(req, o);
  if (!/\{(orderId|cartId)\}/.test(t.url + t.body)) { log("  The download doesn't contain the order ID, so it can't be repeated for other orders."); return { error: "request has no order id" }; }
  const r = await fetchPdf(tabId, t, o);
  if (!r.base64 && !r.link) { log("  Test download failed: " + r.error); return { error: r.error }; }
  if (!r.base64) log("  Blinkit's request works, but the file couldn't be read directly; I'll fall back to Chrome downloads for those.");
  return { template: t, r };
}
async function waitForSignal(since, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (extraLog.some((x) => x.ts >= since)) return "navigation";
    await loadCapture();
    if (capture.log.some((e) => e.ts >= since && (e.isPdf || e.pdfLink || e.jsonPdf))) return "invoice request";
    await sleep(400);
  }
  return null;
}
async function learn(o, keep = false) {
  capturing = true;
  for (const base of goodBase ? [goodBase] : PAGE_BASES) {
    const t0 = Date.now(); pendingT0 = t0;
    log(`  Opening order ${o.orderId}…`);
    const tabId = await goto(`https://blinkit.com/${base}/orders/${o.cartId}/${o.orderId}`);
    log("  Page loaded. Looking for “Download invoice”…");
    const tClick = Date.now();
    // If the click navigates away, the click script never reports back — so also watch for the effect itself.
    const clickP = inTab(tabId, clickInvoiceInPage, [[12, 4]]).then((r) => ({ names: r.names }), () => ({ names: [] }));
    const first = await Promise.race([clickP, waitForSignal(tClick, 45000).then((sig) => ({ sig }))]);
    let names = first.names || [];
    if (first.sig) { names = ["(clicked)"]; log(`  Saw it: ${first.sig}.`); await sleep(2000); }
    else if (!names.length) {
      if (await waitForSignal(tClick, 3000)) names = ["(clicked)"];
      else { log(`  No “Download invoice” text found. Tab is at: ${await tabInfo(tabId)}`); continue; }
    }
    goodBase = base; log("  Clicked: " + names.join(" → "));
    await sleep(3500);
    log("  Working out the download address…");
    const out = await finishFromCapture(tabId, o, t0);
    if (out.template || !keep) capturing = false;
    return out;
  }
  if (!keep) capturing = false;
  return { error: "invoice button not found" };
}

// ---------- Step 2 ----------
async function detect() {
  $("detectBtn").disabled = true; $("recheckBtn").style.display = "none";
  log("Finding the invoice link using your first order…");
  const L = await learn(orders[0], true);
  if (L.template) { templates = [L.template]; log(L.r.base64 ? `Found it. Test PDF OK (${Math.round(L.r.size / 1024)} KB). You can start Step 3.` : "Found it (files will be saved via Chrome downloads if they can't go in the ZIP). You can start Step 3."); await closeWorker(); }
  else { log("Couldn't catch it automatically. In the Blinkit window that's open, click “Download invoice” yourself, then press ‘check again’."); $("recheckBtn").style.display = "block"; }
  await refresh();
}

// ---------- Step 3 ----------
async function download(o) {
  await loadCapture();
  const w = await ensureWorker();
  let last = { error: "no known format" };
  for (const t of [...templates]) {
    let r;
    for (let a = 0; a < 3; a++) {
      r = await fetchPdf(w.tabId, t, o);
      if (r.base64 || r.link || ![429, 502, 503].includes(r.status)) break;
      log("  Blinkit asked us to slow down, waiting…"); await sleep(4000 * (a + 1));
    }
    if (r.base64 || r.link) { templates = [t, ...templates.filter((x) => x !== t)]; return r; }
    last = r;
    if ([401, 403, 429].includes(r.status)) return r;
  }
  log(`  Known formats didn't work for ${o.orderId} (${last.error}) — learning from the page…`);
  const L = await learn(o);
  if (L.template) {
    if (!templates.some((x) => x.url === L.template.url && x.body === L.template.body && x.method === L.template.method)) templates.unshift(L.template);
    log("  Learned a format for this order."); await refresh(); return L.r;
  }
  return { error: L.error };
}
async function run() {
  stopFlag = false; capturing = false; $("startBtn").disabled = true; $("stopBtn").style.display = "block";
  const todo = onlyIds ? orders.filter((o) => onlyIds.has(o.orderId)) : orders;
  const bar = $("progressBar"); bar.style.display = "block"; bar.max = todo.length; bar.value = 0;
  const zip = new JSZip(), used = new Set(), failed = []; let ok = 0, viaDl = 0;
  for (let i = 0; i < todo.length && !stopFlag; i++) {
    const o = todo[i], tag = `[${i + 1}/${todo.length}]`;
    const r = await download(o);
    let name = fileName(o);
    while (used.has(name)) name = name.replace(".pdf", "_dup.pdf");
    used.add(name);
    if (r.base64) {
      zip.file(name, r.base64, { base64: true }); ok++; log(`${tag} ${name}`);
    } else if (r.link) {
      try {
        await chrome.downloads.download({ url: r.link, filename: `blinkit_invoices_unzipped/${name}`, conflictAction: "uniquify" });
        viaDl++; log(`${tag} ${name}  (saved by Chrome, outside the ZIP — see Downloads/blinkit_invoices_unzipped)`);
      } catch (e) { failed.push(`${o.date}\t${o.orderId}\t${r.error}; ${e.message}`); log(`${tag} FAILED ${o.orderId}: ${r.error}`); }
    } else {
      failed.push(`${o.date}\t${o.orderId}\t${r.error}`);
      log(`${tag} FAILED ${o.orderId}: ${r.error}`);
      if (r.status === 401 || r.status === 403) { log("Blinkit rejected the login. Log in again, redo Step 2, and retry."); break; }
    }
    bar.value = i + 1; await sleep(jitter());
  }
  await closeWorker(); $("stopBtn").style.display = "none";
  if (failed.length) zip.file("_failed_orders.txt", failed.join("\n"));
  if (ok || failed.length) {
    log(`\nZipping ${ok} PDFs…`);
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `blinkit_invoices_${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
  }
  log(`Done. ${ok} in the ZIP, ${viaDl} saved by Chrome separately, ${failed.length} failed.${failed.length ? " (see _failed_orders.txt inside the ZIP)" : ""}`);
  $("startBtn").disabled = false;
}

// ---------- wiring ----------
$("jsonFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { orders = parseOrders(JSON.parse(await f.text())); } catch (err) { return log("That file isn't valid JSON: " + err.message); }
  templates = []; $("orderCount").textContent = `${orders.length} deliverable orders loaded`; refresh();
});
$("failedFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) { onlyIds = null; $("onlyCount").textContent = ""; return; }
  const ids = (await f.text()).split(/\r?\n/).map((l) => (l.split("\t")[1] || "").trim()).filter(Boolean);
  onlyIds = ids.length ? new Set(ids) : null;
  $("onlyCount").textContent = onlyIds ? `Will retry only ${onlyIds.size} orders from that list.` : "No order IDs found in that file.";
});
$("detectBtn").addEventListener("click", detect);
$("recheckBtn").addEventListener("click", async () => {
  const w = await ensureWorker();
  const L = await finishFromCapture(w.tabId, orders[0], pendingT0);
  if (L.template) { templates = [L.template]; log("Found it. You can start Step 3."); $("recheckBtn").style.display = "none"; await closeWorker(); await refresh(); }
  else log("Still nothing caught. Use ‘Copy diagnostic info’.");
});
$("startBtn").addEventListener("click", run);
$("stopBtn").addEventListener("click", () => { stopFlag = true; log("Stopping after the current invoice…"); });
$("clearBtn").addEventListener("click", async () => { await chrome.storage.local.remove("capture"); templates = []; log("Saved login data cleared."); refresh(); });
$("diagBtn").addEventListener("click", async () => {
  await loadCapture();
  const red = (u) => { try { const x = new URL(u); return x.origin + x.pathname + (x.search ? "?" + [...x.searchParams.keys()].map((k) => k + "=…").join("&") : ""); } catch { return u; } };
  const reqs = [...capture.log, ...extraLog].map((e) => `${e.method} ${red(e.url)} ${e.isPdf ? "[PDF]" : ""}${e.pdfLink ? "[JSON→PDF link]" : ""}${e.jsonPdf ? "[JSON has PDF data]" : ""}${e.nav ? "[navigation]" : ""}${e.blobPdf ? "[in-page PDF]" : ""}${e.webnav ? "[browser navigation]" : ""}${e.download ? "[browser download]" : ""}`).join("\n");
  const tpls = templates.map((t) => `${t.method} ${red(t.url)} body:${t.body ? "yes" : "no"}`).join("\n");
  await navigator.clipboard.writeText(`header names: ${Object.keys(capture.headers).join(", ")}\n\nlearned formats:\n${tpls || "(none)"}\n\nrecent requests:\n${reqs}\n\nlog:\n${$("log").textContent}`);
  log("Diagnostic info copied (no tokens or cookies included).");
});
refresh();
