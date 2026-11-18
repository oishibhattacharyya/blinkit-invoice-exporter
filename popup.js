const $ = (id) => document.getElementById(id);
const log = (m) => { $("log").textContent += m + "\n"; $("log").scrollTop = $("log").scrollHeight; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 400 + Math.random() * 300;
const PAGE_BASES = ["accounts", "account"]; // /accounts/orders/{cartId}/{orderId}

let orders = [];
let capture = { headers: {}, log: [] };
let template = null;       // { url, method, body } with {orderId}/{cartId} placeholders
let pendingT0 = 0;

function parseOrders(raw) {
  const list = Array.isArray(raw) ? raw : raw.orders || raw.data?.orders || [];
  return list.map((o) => {
    let cartId = o.cartId ?? o.cart_id ?? "";
    let orderId = o.orderId ?? o.order_id ?? o.id ?? "";
    const link = o.detailDeepLink || "";
    const c = link.match(/[?&]cart_id=([^&]+)/), d = link.match(/[?&]order_id=([^&]+)/);
    if (c) cartId = c[1];
    if (d) orderId = d[1];
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
  $("authStatus").textContent = n ? "Yes" : "Not yet";
  $("authStatus").className = "badge " + (n ? "ok" : "warn");
  $("endpointStatus").textContent = template ? "Yes" : "Not yet";
  $("endpointStatus").className = "badge " + (template ? "ok" : "warn");
  $("tplView").textContent = template ? `${template.method} ${template.url}${template.body ? "\nBody: " + template.body : ""}` : "–";
  $("detectBtn").disabled = !orders.length;
  $("startBtn").disabled = !(orders.length && template);
}

// ---------- tabs ----------
function waitLoaded(tabId) {
  return new Promise((res) => {
    const on = (id, info) => { if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(on); res(); } };
    chrome.tabs.onUpdated.addListener(on);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(on); res(); }, 25000);
  });
}
async function openTab(url) { const t = await chrome.tabs.create({ url, active: false }); await waitLoaded(t.id); await sleep(1500); return t; }

// ---------- runs inside the Blinkit page ----------
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
      const l = findLink(await res.json());
      if (!l) return { error: "Server reply had no PDF link" };
      const r2 = await fetch(l);
      if (!r2.ok) return { error: `PDF link HTTP ${r2.status}`, status: r2.status };
      buf = await r2.arrayBuffer();
    } else buf = await res.arrayBuffer();
    if (!isPdf(buf)) return { error: `Not a PDF (got ${ct.split(";")[0] || "unknown type"})` };
    return { base64: b64(buf), size: buf.byteLength };
  } catch (e) { return { error: e.message }; }
}
async function inTab(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

// ---------- template handling ----------
function toTemplate(req, o) {
  const pairs = [[o.orderId, "{orderId}"], [o.cartId, "{cartId}"]].sort((a, b) => b[0].length - a[0].length);
  const sub = (s) => pairs.reduce((acc, [v, p]) => acc.split(v).join(p), s || "");
  return { url: sub(req.url), method: req.method || "GET", body: sub(req.body) };
}
const fill = (t, o) => ({
  url: t.url.split("{orderId}").join(o.orderId).split("{cartId}").join(o.cartId),
  method: t.method,
  body: t.body.split("{orderId}").join(o.orderId).split("{cartId}").join(o.cartId)
});
function pickRequest(t0) {
  const c = capture.log.filter((e) => e.ts >= t0);
  return c.find((e) => e.isPdf) || c.find((e) => e.pdfLink) || c.find((e) => e.nav) || [...c].reverse().find((e) => /invoice/i.test(e.url)) || null;
}

async function tryFinish(tabId, t0) {
  await sleep(1500); await loadCapture();
  if (capture.log.some((e) => e.ts >= t0 && e.blobPdf) && !pickRequest(t0)) {
    log("Blinkit builds the PDF inside the page, so there's no link to reuse. Use ‘Copy diagnostic info’ and send it to me."); return false;
  }
  const req = pickRequest(t0);
  if (!req) return false;
  const t = toTemplate(req, orders[0]);
  if (!/\{(orderId|cartId)\}/.test(t.url + t.body)) { log("Found a download, but it doesn't contain the order's ID, so it can't be repeated for other orders."); return false; }
  log("Found it. Testing on your first order…");
  const r = await inTab(tabId, fetchInPage, [fill(t, orders[0]), capture.headers]);
  if (!r.base64) { log("Test download failed: " + r.error); return false; }
  template = t; log(`Test OK (${Math.round(r.size / 1024)} KB PDF). You can start the full download.`);
  return true;
}

async function detect() {
  $("detectBtn").disabled = true; $("recheckBtn").style.display = "none";
  const o = orders[0];
  for (const base of PAGE_BASES) {
    log(`Opening your first order (${base})…`);
    const t0 = Date.now(); pendingT0 = t0;
    let tab;
    try { tab = await openTab(`https://blinkit.com/${base}/orders/${o.cartId}/${o.orderId}`); } catch (e) { log("Couldn't open tab: " + e.message); continue; }
    let res;
    try { res = await inTab(tab.id, clickInvoiceInPage, [[12, 4]]); } catch (e) { log("Page not ready: " + e.message); chrome.tabs.remove(tab.id); continue; }
    if (!res.names.length) { log(`No “Invoice” button seen on ${res.href}`); chrome.tabs.remove(tab.id); continue; }
    log("Clicked: " + res.names.join(" → "));
    if (await tryFinish(tab.id, t0)) { chrome.tabs.remove(tab.id); await refresh(); return; }
    // leave the last tab open so the user can click it by hand
    log("Couldn't catch it automatically. In the Blinkit tab that's open, click the invoice download yourself, then press ‘check again’.");
    $("recheckBtn").style.display = "block"; $("recheckBtn").dataset.tab = tab.id;
    await refresh(); return;
  }
  log("Couldn't find the Invoice button. Make sure you're logged in to Blinkit, then try again or use ‘Copy diagnostic info’.");
  await refresh();
}

// ---------- bulk ----------
async function run() {
  $("startBtn").disabled = true;
  const bar = $("progressBar"); bar.style.display = "block"; bar.max = orders.length; bar.value = 0;
  const tab = await openTab("https://blinkit.com/");
  await loadCapture();
  const zip = new JSZip(), used = new Set(), failed = [];
  let ok = 0;
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    let r;
    for (let a = 0; a < 3; a++) {
      r = await inTab(tab.id, fetchInPage, [fill(template, o), capture.headers]);
      if (r.base64 || ![429, 502, 503].includes(r.status)) break;
      log("  Blinkit asked us to slow down, waiting…"); await sleep(3000 * (a + 1));
    }
    if (r.base64) {
      let name = `${safe(o.date)}_${o.cartId}_${o.orderId}_Rs${safe(o.amount)}.pdf`;
      while (used.has(name)) name = name.replace(".pdf", "_dup.pdf");
      used.add(name); zip.file(name, r.base64, { base64: true }); ok++;
      log(`[${i + 1}/${orders.length}] ${name}`);
    } else {
      failed.push(`${o.orderId}\t${r.error}`);
      log(`[${i + 1}/${orders.length}] FAILED ${o.orderId}: ${r.error}`);
      if (r.status === 401 || r.status === 403) { log("Blinkit rejected the login. Log in again, redo Step 2, and retry."); break; }
    }
    bar.value = i + 1; await sleep(jitter());
  }
  chrome.tabs.remove(tab.id);
  if (failed.length) zip.file("_failed_orders.txt", failed.join("\n"));
  if (!ok) { log("No invoices could be downloaded."); $("startBtn").disabled = false; return; }
  log(`\nZipping ${ok} PDFs…`);
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `blinkit_invoices_${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  log(`Done. ${ok} saved, ${failed.length} failed.`);
  $("startBtn").disabled = false;
}

// ---------- wiring ----------
$("jsonFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { orders = parseOrders(JSON.parse(await f.text())); } catch (err) { return log("That file isn't valid JSON: " + err.message); }
  template = null; $("orderCount").textContent = `${orders.length} deliverable orders loaded`; refresh();
});
$("detectBtn").addEventListener("click", detect);
$("recheckBtn").addEventListener("click", async () => {
  const tabId = Number($("recheckBtn").dataset.tab);
  if (await tryFinish(tabId, pendingT0)) { chrome.tabs.remove(tabId); $("recheckBtn").style.display = "none"; await refresh(); }
  else log("Still nothing caught. Use ‘Copy diagnostic info’.");
});
$("startBtn").addEventListener("click", run);
$("clearBtn").addEventListener("click", async () => { await chrome.storage.local.remove("capture"); template = null; log("Saved login data cleared."); refresh(); });
$("diagBtn").addEventListener("click", async () => {
  await loadCapture();
  const red = (u) => { try { const x = new URL(u); return x.origin + x.pathname + (x.search ? "?" + [...x.searchParams.keys()].map((k) => k + "=…").join("&") : ""); } catch { return u; } };
  const txt = capture.log.map((e) => `${e.method} ${red(e.url)} ${e.isPdf ? "[PDF]" : ""}${e.pdfLink ? "[JSON→PDF link]" : ""}${e.nav ? "[navigation]" : ""}${e.blobPdf ? "[in-page PDF]" : ""}`).join("\n")
    + `\n\nheader names: ${Object.keys(capture.headers).join(", ")}\n\nlog:\n` + $("log").textContent;
  await navigator.clipboard.writeText(txt); log("Diagnostic info copied (no tokens or cookies included).");
});
refresh();
