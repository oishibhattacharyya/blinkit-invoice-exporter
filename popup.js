let orders = [];
let capture = { headers: {} };
const $ = (id) => document.getElementById(id);
const log = (m) => { $("log").textContent += m + "\n"; $("log").scrollTop = $("log").scrollHeight; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 400 + Math.random() * 300;

function parseOrders(raw) {
  const list = Array.isArray(raw) ? raw : raw.orders || raw.data?.orders || [];
  return list.map((o) => {
    let cartId = o.cartId ?? o.cart_id ?? "";
    let orderId = o.orderId ?? o.order_id ?? o.id ?? "";
    const link = o.detailDeepLink || "";
    const c = link.match(/[?&]cart_id=([^&]+)/), d = link.match(/[?&]order_id=([^&]+)/);
    if (c) cartId = c[1];
    if (d) orderId = d[1];
    return {
      orderId: String(orderId), cartId: String(cartId),
      date: String(o.date || "unknown-date"), amount: o.amount ?? 0, status: String(o.status || "")
    };
  }).filter((o) => o.orderId && o.cartId && !/cancel/i.test(o.status));
}

const safe = (s) => String(s).replace(/[\\/:*?"<>|,]+/g, "").replace(/\s+/g, "-");

function buildTemplate(sample, list) {
  let t = sample;
  for (const o of list.slice(0, 50)) {
    if (o.orderId && t.includes(o.orderId)) t = t.split(o.orderId).join("{orderId}");
    if (o.cartId && t.includes(o.cartId)) t = t.split(o.cartId).join("{cartId}");
  }
  return t;
}

async function activeBlinkitTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && /^https:\/\/([^/]+\.)?blinkit\.com\//.test(tab.url || "") ? tab : null;
}

async function refresh() {
  ({ capture = { headers: {} } } = await chrome.storage.local.get("capture"));
  const n = Object.keys(capture.headers || {}).length;
  $("authStatus").textContent = n ? `Captured (${n} headers)` : "Not captured";
  $("authStatus").className = "badge " + (n ? "ok" : "warn");
  if (capture.invoiceUrlSample) {
    $("endpointStatus").textContent = "Captured";
    $("endpointStatus").className = "badge ok";
    if (!$("urlTemplate").value)
      $("urlTemplate").value = buildTemplate(capture.invoiceUrlSample, orders) || capture.invoiceUrlSample;
  }
  const ready = orders.length > 0 && $("urlTemplate").value.trim();
  $("startBtn").disabled = !ready;
  $("testBtn").disabled = !ready;
}

// Runs inside the Blinkit tab so cookies/origin match.
async function fetchInTab(tabId, url, headers) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, args: [url, headers],
    func: async (url, headers) => {
      try {
        const res = await fetch(url, { headers, credentials: "include" });
        if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
        let blob;
        if ((res.headers.get("content-type") || "").includes("json")) {
          const j = await res.json();
          const u = j?.url || j?.invoice_url || j?.invoiceUrl || j?.data?.url || j?.data?.invoice_url || j?.data?.invoiceUrl;
          if (!u) return { error: "No PDF URL in JSON: " + JSON.stringify(j).slice(0, 120) };
          const r2 = await fetch(u);
          if (!r2.ok) return { error: `PDF HTTP ${r2.status}` };
          blob = await r2.blob();
        } else blob = await res.blob();
        return await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onloadend = () => resolve({ base64: String(fr.result).split(",")[1], size: blob.size });
          fr.readAsDataURL(blob);
        });
      } catch (e) { return { error: e.message }; }
    }
  });
  return result || { error: "No result" };
}

async function run(list) {
  const tab = await activeBlinkitTab();
  const tpl = $("urlTemplate").value.trim();
  if (!tab) return log("Switch to a logged-in blinkit.com tab first, then reopen the popup.");
  if (!tpl) return log("Endpoint template is empty.");

  $("startBtn").disabled = $("testBtn").disabled = true;
  const bar = $("progressBar"); bar.style.display = "block"; bar.max = list.length; bar.value = 0;
  const zip = new JSZip(); const used = new Set(); const failed = [];
  let ok = 0;

  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const url = tpl.split("{orderId}").join(o.orderId).split("{cartId}").join(o.cartId);
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetchInTab(tab.id, url, capture.headers || {});
      if (r.base64 || ![429, 502, 503].includes(r.status)) break;
      log(`  rate-limited, backing off (${attempt + 1}/3)…`);
      await sleep(3000 * (attempt + 1));
    }
    if (r.base64 && r.size > 500) {
      let name = `${safe(o.date)}_${o.cartId}_${o.orderId}_Rs${safe(o.amount)}.pdf`;
      while (used.has(name)) name = name.replace(".pdf", "_dup.pdf");
      used.add(name);
      zip.file(name, r.base64, { base64: true });
      ok++; log(`[${i + 1}/${list.length}] ${name}`);
    } else {
      failed.push(o.orderId);
      log(`[${i + 1}/${list.length}] FAILED ${o.orderId}: ${r.error || "empty file"}`);
      if (i === 0 && list.length > 1 && r.status === 401) { log("Auth rejected — re-capture and retry."); break; }
    }
    bar.value = i + 1;
    await sleep(jitter());
  }

  if (failed.length) zip.file("_failed_orders.txt", failed.join("\n"));
  if (ok === 0 && !failed.length) return;
  log(`\nZipping ${ok} PDFs…`);
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `blinkit_invoices_${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  log(`Done. ${ok} saved, ${failed.length} failed.`);
  $("startBtn").disabled = $("testBtn").disabled = false;
}

$("jsonFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { orders = parseOrders(JSON.parse(await f.text())); }
  catch (err) { return log("Invalid JSON: " + err.message); }
  $("orderCount").textContent = `${orders.length} deliverable orders loaded`;
  if (capture.invoiceUrlSample) $("urlTemplate").value = buildTemplate(capture.invoiceUrlSample, orders);
  refresh();
});
$("urlTemplate").addEventListener("input", refresh);
$("startBtn").addEventListener("click", () => run(orders));
$("testBtn").addEventListener("click", () => run(orders.slice(0, 1)));
$("clearBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove("capture"); $("urlTemplate").value = ""; capture = { headers: {} };
  $("endpointStatus").textContent = "Not captured"; $("endpointStatus").className = "badge warn";
  refresh(); log("Captured session data cleared.");
});
refresh();
