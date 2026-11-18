const $ = (id) => document.getElementById(id);
const log = (m) => { $("log").textContent += m + "\n"; $("log").scrollTop = $("log").scrollHeight; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 400 + Math.random() * 300;
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);
const PAGE_BASES = ["accounts", "account"];   // https://blinkit.com/accounts/orders/{cartId}/{orderId}

let orders = [], templates = [], goodBase = null, pendingT0 = 0, stopFlag = false, worker = null;
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
  return worker;
}
async function closeWorker() { if (worker) { try { await chrome.windows.remove(worker.winId); } catch {} worker = null; } }
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
async function fetchInPage(req, headers) {
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
function pickRequest(t0) {
  const c = capture.log.filter((e) => e.ts >= t0);
  return c.find((e) => e.isPdf) || c.find((e) => e.pdfLink || e.jsonPdf) || c.find((e) => e.nav) || [...c].reverse().find((e) => /invoice/i.test(e.url)) || null;
}
const fetchPdf = (tabId, t, o) => withTimeout(inTab(tabId, fetchInPage, [fill(t, o), capture.headers]), 60000, "download").catch((e) => ({ error: e.message }));

// Work out a template from what the page just did, and prove it by downloading this order's PDF.
async function finishFromCapture(tabId, o, t0) {
  await loadCapture();
  const req = pickRequest(t0);
  if (!req) { log("  Nothing invoice-like was requested after the click."); return { error: "no invoice request caught" }; }
  const t = toTemplate(req, o);
  if (!/\{(orderId|cartId)\}/.test(t.url + t.body)) { log("  The download doesn't contain the order ID, so it can't be repeated for other orders."); return { error: "request has no order id" }; }
  const r = await fetchPdf(tabId, t, o);
  if (!r.base64) { log("  Test download failed: " + r.error); return { error: r.error }; }
  return { template: t, r };
}
async function learn(o) {
  for (const base of goodBase ? [goodBase] : PAGE_BASES) {
    const t0 = Date.now(); pendingT0 = t0;
    log(`  Opening order ${o.orderId} (${base})…`);
    const tabId = await goto(`https://blinkit.com/${base}/orders/${o.cartId}/${o.orderId}`);
    let res;
    try { res = await withTimeout(inTab(tabId, clickInvoiceInPage, [[12, 4]]), 60000, "page click"); }
    catch (e) { log(`  ${e.message}. Tab is at: ${await tabInfo(tabId)}`); continue; }
    if (!res.names.length) { log(`  No “Download invoice” text found. Tab is at: ${await tabInfo(tabId)}`); continue; }
    goodBase = base; log("  Clicked: " + res.names.join(" → "));
    await sleep(2500);
    return await finishFromCapture(tabId, o, t0);
  }
  return { error: "invoice button not found" };
}

// ---------- Step 2 ----------
async function detect() {
  $("detectBtn").disabled = true; $("recheckBtn").style.display = "none";
  log("Finding the invoice link using your first order…");
  const L = await learn(orders[0]);
  if (L.template) { templates = [L.template]; log(`Found it. Test PDF OK (${Math.round(L.r.size / 1024)} KB). You can start Step 3.`); await closeWorker(); }
  else { log("Couldn't catch it automatically. In the Blinkit window that's open, click “Download invoice” yourself, then press ‘check again’."); $("recheckBtn").style.display = "block"; }
  await refresh();
}

// ---------- Step 3 ----------
async function download(o) {
  await loadCapture();
  const w = await ensureWorker();
  for (const t of [...templates]) {
    let r;
    for (let a = 0; a < 3; a++) {
      r = await fetchPdf(w.tabId, t, o);
      if (r.base64 || ![429, 502, 503].includes(r.status)) break;
      log("  Blinkit asked us to slow down, waiting…"); await sleep(3000 * (a + 1));
    }
    if (r.base64) { templates = [t, ...templates.filter((x) => x !== t)]; return r; }
    if (r.status === 401 || r.status === 403) return r;
  }
  log(`  Known formats didn't work for ${o.orderId} — learning this order's format from the page…`);
  const L = await learn(o);
  if (L.template) { templates.unshift(L.template); log("  New format learned."); await refresh(); return L.r; }
  return { error: L.error };
}
async function run() {
  stopFlag = false; $("startBtn").disabled = true; $("stopBtn").style.display = "block";
  const bar = $("progressBar"); bar.style.display = "block"; bar.max = orders.length; bar.value = 0;
  const zip = new JSZip(), used = new Set(), failed = []; let ok = 0;
  for (let i = 0; i < orders.length && !stopFlag; i++) {
    const o = orders[i];
    const r = await download(o);
    if (r.base64) {
      let name = `${safe(o.date)}_${o.cartId}_${o.orderId}_Rs${safe(o.amount)}.pdf`;
      while (used.has(name)) name = name.replace(".pdf", "_dup.pdf");
      used.add(name); zip.file(name, r.base64, { base64: true }); ok++;
      log(`[${i + 1}/${orders.length}] ${name}`);
    } else {
      failed.push(`${o.date}\t${o.orderId}\t${r.error}`);
      log(`[${i + 1}/${orders.length}] FAILED ${o.orderId}: ${r.error}`);
      if (r.status === 401 || r.status === 403) { log("Blinkit rejected the login. Log in again, redo Step 2, and retry."); break; }
    }
    bar.value = i + 1; await sleep(jitter());
  }
  await closeWorker(); $("stopBtn").style.display = "none";
  if (failed.length) zip.file("_failed_orders.txt", failed.join("\n"));
  if (!ok) { log("No invoices could be downloaded."); $("startBtn").disabled = false; return; }
  log(`\nZipping ${ok} PDFs…`);
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `blinkit_invoices_${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  log(`Done. ${ok} saved, ${failed.length} failed.${failed.length ? " (see _failed_orders.txt inside the zip)" : ""}`);
  $("startBtn").disabled = false;
}

// ---------- wiring ----------
$("jsonFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { orders = parseOrders(JSON.parse(await f.text())); } catch (err) { return log("That file isn't valid JSON: " + err.message); }
  templates = []; $("orderCount").textContent = `${orders.length} deliverable orders loaded`; refresh();
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
  const reqs = capture.log.map((e) => `${e.method} ${red(e.url)} ${e.isPdf ? "[PDF]" : ""}${e.pdfLink ? "[JSON→PDF link]" : ""}${e.jsonPdf ? "[JSON has PDF data]" : ""}${e.nav ? "[navigation]" : ""}${e.blobPdf ? "[in-page PDF]" : ""}`).join("\n");
  const tpls = templates.map((t) => `${t.method} ${red(t.url)} body:${t.body ? "yes" : "no"}`).join("\n");
  await navigator.clipboard.writeText(`header names: ${Object.keys(capture.headers).join(", ")}\n\nlearned formats:\n${tpls || "(none)"}\n\nrecent requests:\n${reqs}\n\nlog:\n${$("log").textContent}`);
  log("Diagnostic info copied (no tokens or cookies included).");
});
refresh();
