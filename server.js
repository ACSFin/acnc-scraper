// server.js
// ACNC financials scraper — Render Web Service (Playwright 1.55+, resilient fallbacks)

import express from "express";
import { chromium } from "playwright";
import fetch from "node-fetch";
// pdfjs-dist v4 legacy ESM entry:
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SCRAPER_TOKEN || "changeme";
const PREVIEW = String(process.env.SCRAPER_PREVIEW || "true").toLowerCase() !== "false";

// ---- Auth (global; move into POST only if you want "/" to be public)
app.use((req, res, next) => {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || got === TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

// ---- Utils
const spaceAbn = abn => `${abn.slice(0,2)} ${abn.slice(2,5)} ${abn.slice(5,8)} ${abn.slice(8)}`;

async function pdfTextFromBuffer(buf) {
  const loadingTask = pdfjs.getDocument({ data: buf });
  const pdf = await loadingTask.promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map(x => x.str || "").join(" ") + "\n";
    if (out.length > 20000) break;
  }
  return out;
}

function absUrl(href, base) {
  try { return href.startsWith("http") ? href : new URL(href, base).toString(); }
  catch { return href; }
}

function stripTags(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "")
             .replace(/<style[\s\S]*?<\/style>/gi, "")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ")
             .trim();
}

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "en-AU,en;q=0.8",
  "Referer": "https://www.acnc.gov.au/"
};

async function fetchHtml(url) {
  const r = await fetch(url, { headers: COMMON_HEADERS });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return await r.text();
}

function findCharityLink(html) {
  // Prefer fully-qualified uuid path and either /profile or /documents
  let m = html.match(/href="([^"]*\/charity\/charities\/[0-9a-f-]{36}\/(?:profile|documents)\/?)"/i);
  if (m) return m[1];
  // Fallbacks
  m = html.match(/href="([^"]*\/charity\/charities\/[^"']+?\/profile\/?)"/i)
    || html.match(/href="([^"]*\/charity\/charities\/[^"']+?)"/i);
  return m ? m[1] : null;
}

// If direct /documents stalls, click the FINANCIALS & DOCUMENTS tab
async function maybeClickDocsTab(page) {
  const docsTabSelectors = [
    'a:has-text("FINANCIALS & DOCUMENTS")',
    'button:has-text("FINANCIALS & DOCUMENTS")',
    'a[role="tab"]:has-text("FINANCIALS & DOCUMENTS")'
  ];
  for (const sel of docsTabSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await Promise.all([page.waitForLoadState("domcontentloaded"), el.click()]);
      await page.waitForLoadState("networkidle").catch(()=>{});
      return true;
    }
  }
  return false;
}

// ---- HTTP-only fallback (no Playwright navigation)
async function scrapeViaHttpOnly(abn) {
  const searchUrl = `https://www.acnc.gov.au/charity/charities?search=${abn}`;
  const searchHtml = await fetchHtml(searchUrl);

  const rawLink = findCharityLink(searchHtml);
  if (!rawLink) throw new Error("No charity link found in search HTML");
  const firstLink = absUrl(rawLink, "https://www.acnc.gov.au");

  // Go straight to /documents/
  const u = new URL(firstLink);
  u.pathname = u.pathname.replace(/\/profile\/?$/, "/documents/");
  const docHtml = await fetchHtml(u.toString());

  // Extract table rows
  const rows = [...docHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const docs = [];
  for (const row of rows) {
    const inner = row[1] || "";
    const titleCell = (inner.match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [,""])[1];
    const titleText = stripTags(titleCell || "");
    if (!titleText) continue;

    // Prefer PDF links, else any Download/View/AIS link, else first link
    const linkMatch =
      inner.match(/<a[^>]+href="([^"]+\.pdf)"[^>]*>/i) ||
      inner.match(/<a[^>]+href="([^"]+)"[^>]*>(?:\s*(?:download|view|ais)[^<]*)<\/a>/i) ||
      inner.match(/<a[^>]+href="([^"]+)"[^>]*>/i);
    if (!linkMatch) continue;

    const url = absUrl(linkMatch[1], "https://www.acnc.gov.au");
    const ym = titleText.match(/\b(20\d{2})\b/);
    const year = ym ? parseInt(ym[1], 10) : null;

    const type = /annual information statement|ais/i.test(titleText)
      ? "AIS"
      : /financial/i.test(titleText)
        ? "Financial Report"
        : "Other";

    docs.push({ year, type, source_url: url, title: titleText });
  }

  const latestAis = docs.filter(d => d.type === "AIS" && Number.isInteger(d.year)).sort((a,b)=>b.year-a.year)[0] || null;
  const latestFr  = docs.filter(d => d.type === "Financial Report" && Number.isInteger(d.year)).sort((a,b)=>b.year-a.year)[0] || null;

  // Optional PDF preview
  let frTextPreview = null;
  if (latestFr && PREVIEW) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const pr = await fetch(latestFr.source_url, { signal: ctrl.signal });
      if (pr.ok) {
        const buf = Buffer.from(await pr.arrayBuffer());
        if (buf.slice(0,4).toString("hex") === "25504446") {
          const text = await pdfTextFromBuffer(buf).catch(()=> "");
          frTextPreview = (text || "").slice(0,800);
        }
      }
    } finally { clearTimeout(t); }
  }

  return {
    docs,
    latestAis,
    latestFr,
    detailUrl: u.toString().replace(/\/documents\/?$/, "/profile"),
    frTextPreview
  };
}

// ---- Routes
app.get("/", (_req, res) => res.send("ACNC scraper ready"));

app.post("/fetchAcncFinancials", async (req, res) => {
  const t0 = Date.now();
  const abn = String(req.body?.abn || "").replace(/\D/g, "");
  console.log("[ACNC] start", { abn });

  if (!/^\d{11}$/.test(abn)) {
    return res.status(400).json({ error: "ABN must be 11 digits" });
  }

  // Playwright launch with H2/H3 mitigations
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-http2",   // avoid H2 flake
      "--disable-quic"     // avoid H3/QUIC flake
    ]
  });
  const ctx = await browser.newContext({
    locale: "en-AU",
    ignoreHTTPSErrors: true,
    userAgent: COMMON_HEADERS["User-Agent"]
  });
  const page = await ctx.newPage();

  try {
    const searchUrl = `https://www.acnc.gov.au/charity/charities?search=${abn}`;

    // Helper: fast commit-level nav then DOM readiness
    async function gotoWithCommit(url) {
      await page.goto(url, { waitUntil: "commit", timeout: 30000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(()=>{});
    }

    let usedHttpFallback = false;

    // Try primary nav to the search page
    try {
      await gotoWithCommit(searchUrl);
      await page.locator("table tbody tr").first().waitFor({ timeout: 15000 }).catch(()=>{});
    } catch (e) {
      console.warn("[ACNC] primary nav error", e?.message || e);
      usedHttpFallback = true;
    }

    let docs = [], latestAis = null, latestFr = null, frTextPreview = null, detailUrl = null;

    if (usedHttpFallback) {
      // Full HTTP-only path (no Playwright navigation)
      const out = await scrapeViaHttpOnly(abn);
      docs = out.docs; latestAis = out.latestAis; latestFr = out.latestFr; frTextPreview = out.frTextPreview; detailUrl = out.detailUrl;
    } else {
      // We’re on search results; click into the correct charity then go to documents
      const spaced = spaceAbn(abn);
      let link = page
        .locator("table tbody tr")
        .filter({
          has: page.locator(`td:last-child:has-text("${spaced}"), td:last-child:has-text("${abn}")`)
        })
        .locator('a[href*="/charity/charities/"]')
        .first();
      const hasLink = await link.isVisible().catch(()=>false);
      if (!hasLink) link = page.locator('a[href*="/charity/charities/"]').first();

      await link.waitFor({ timeout: 20000 });
      await Promise.all([page.waitForLoadState("networkidle"), link.click()]);

      // Direct to /documents
      const u = new URL(page.url());
      u.pathname = u.pathname.replace(/\/profile\/?$/, "/documents/");
      await page.goto(u.toString(), { waitUntil: "networkidle", timeout: 60000 }).catch(()=>{});

      // If the table didn't appear, try clicking the tab explicitly
      const firstRow = page.locator("table tbody tr").first();
      if (!(await firstRow.isVisible().catch(()=>false))) {
        const clicked = await maybeClickDocsTab(page);
        if (!clicked) {
          // If still no tab, try a lighter wait
          await page.waitForLoadState("domcontentloaded").catch(()=>{});
        }
      }

      // Scrape rows on documents page
      const rows = page.locator("table tbody tr");
      const count = await rows.count();
      if (count === 0) throw new Error("No annual reporting rows found on ACNC documents tab.");

      for (let i = 0; i < count; i++) {
        const r = rows.nth(i);
        const cells = r.locator("td");
        const cellCount = await cells.count();
        if (cellCount < 2) continue;

        const title = (await cells.nth(0).innerText().catch(()=> "")).trim();
        const a = r.locator("a").filter({ hasText: /download|view|ais/i }).first();
        const visible = await a.isVisible().catch(()=> false);
        if (!visible) continue;

        const href = await a.getAttribute("href").catch(()=> null);
        if (!href) continue;

        const url = absUrl(href, page.url());
        const m = title.match(/\b(20\d{2})\b/);
        const year = m ? parseInt(m[1], 10) : null;

        const type = /annual information statement|ais/i.test(title)
          ? "AIS"
          : /financial/i.test(title)
            ? "Financial Report"
            : "Other";

        docs.push({ year, type, source_url: url, title });
      }

      latestAis = docs.filter(d => d.type === "AIS" && Number.isInteger(d.year)).sort((a,b)=>b.year-a-year)[0] || null;
      latestFr  = docs.filter(d => d.type === "Financial Report" && Number.isInteger(d.year)).sort((a,b)=>b.year-a.year)[0] || null;

      // Optional preview
      if (latestFr && PREVIEW) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000);
        try {
          const pr = await fetch(latestFr.source_url, { signal: ctrl.signal });
          if (pr.ok) {
            const buf = Buffer.from(await pr.arrayBuffer());
            if (buf.slice(0,4).toString("hex") === "25504446") {
              const text = await pdfTextFromBuffer(buf).catch(()=> "");
              frTextPreview = (text || "").slice(0,800);
            }
          }
        } finally { clearTimeout(t); }
      }

      detailUrl = page.url().replace(/\/documents\/?$/, "/profile");
    }

    res.json({
      abn,
      acnc_detail_url: detailUrl,
      latest: {
        financial_report: latestFr ? { year: latestFr.year, source_url: latestFr.source_url } : null,
        ais: latestAis ? { year: latestAis.year, source_url: latestAis.source_url } : null
      },
      all_documents: docs,
      preview: frTextPreview ? { financial_report_text_preview: frTextPreview } : undefined,
      notes: []
    });

    console.log("[ACNC] success in", Date.now() - t0, "ms");
  } catch (e) {
    console.error("[ACNC] ERROR", e?.message || e);
    res.status(500).json({ error: e?.message || String(e), step: "fetchAcncFinancials", abn });
  } finally {
    await ctx.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
});

// ---- Boot
app.listen(PORT, () => {
  console.log(`✅ Server started and listening on port ${PORT}`);
});
