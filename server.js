// server.js — HTTP-first with node-fetch fallback for HTML, PDF text extraction for LLMs,
// and browser fallback only if needed. Tunable timeouts via env.

import express from "express";
import { chromium, request as pwRequest } from "playwright";
import fetch from "node-fetch";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SCRAPER_TOKEN || "changeme";

// Timeouts (ms) — adjust in Render if needed
const HTTP_TIMEOUT_MS = parseInt(process.env.ACNC_HTTP_TIMEOUT_MS || "20000", 10);   // HTML GETs
const NAV_TIMEOUT_MS  = parseInt(process.env.ACNC_NAV_TIMEOUT_MS  || "25000", 10);   // page.goto

// Preview defaults; can be overridden by request body pdfText
const PREVIEW_DEFAULT = String(process.env.SCRAPER_PREVIEW || "true").toLowerCase() !== "false";
const DEFAULT_PREVIEW_CHARS = parseInt(process.env.SCRAPER_PREVIEW_CHARS || "800", 10);
const MAX_FULL_PDF_CHARS = parseInt(process.env.SCRAPER_MAX_PDF_TEXT_BYTES || "200000", 10); // treat as chars

// Public health endpoint (no auth)
app.get("/", (_req, res) => res.send("ACNC scraper ready"));

// Auth only on POST
function auth(req, res, next) {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || got === TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.8",
  "Accept-Encoding": "gzip, deflate", // drop br (brotli)
  "Referer": "https://www.acnc.gov.au/"
};

const spaceAbn = abn => `${abn.slice(0,2)} ${abn.slice(2,5)} ${abn.slice(5,8)} ${abn.slice(8)}`;
const stripTags = html => html
  .replace(/<script[\s\S]*?<\/script>/gi,"")
  .replace(/<style[\s\S]*?<\/style>/gi,"")
  .replace(/<[^>]+>/g," ")
  .replace(/\s+/g," ")
  .trim();

function absUrl(href, base) {
  try { return href.startsWith("http") ? href : new URL(href, base).toString(); }
  catch { return href; }
}

// ---------- PDF helpers ----------
async function pdfTextFromBuffer(buf) {
  const loadingTask = pdfjs.getDocument({ data: buf });
  const pdf = await loadingTask.promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map(x => x.str || "").join(" ") + "\n";
    if (out.length > MAX_FULL_PDF_CHARS) break; // safety cap
  }
  return out;
}

async function extractPdfTextVia(rq, url, charLimit) {
  // 1) Try Playwright request (shares headers/cookies)
  try {
    const pr = await rq.get(url, { timeout: HTTP_TIMEOUT_MS });
    if (pr.ok()) {
      const buf = Buffer.from(await pr.body());
      if (buf.slice(0,4).toString("hex") === "25504446") {
        const text = await pdfTextFromBuffer(buf).catch(()=> "");
        return (text || "").slice(0, charLimit);
      }
    }
  } catch {}
  // 2) Fallback: node-fetch with AbortController
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    const r = await fetch(url, { signal: ctrl.signal, headers: COMMON_HEADERS });
    clearTimeout(t);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.slice(0,4).toString("hex") === "25504446") {
        const text = await pdfTextFromBuffer(buf).catch(()=> "");
        return (text || "").slice(0, charLimit);
      }
    }
  } catch {}
  return null;
}

// ---------- HTML fetchers (HTTP-first with node-fetch fallback) ----------
async function getHtmlWithRquest(rq, url, timeout) {
  const r = await rq.get(url, { timeout });
  if (!r.ok()) throw new Error(`GET ${url} -> ${r.status()}`);
  return await r.text();
}

async function getHtmlWithNodeFetch(url, timeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: COMMON_HEADERS });
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function getHtmlWithFallback(rq, url, timeout) {
  try {
    return await getHtmlWithRquest(rq, url, timeout);
  } catch (e1) {
    // quick retry via node-fetch
    try {
      return await getHtmlWithNodeFetch(url, timeout);
    } catch (e2) {
      throw e1; // surface the original (Playwright) error
    }
  }
}

// ---------- HTML parsing ----------
function parseDocsFromHtml(docHtml) {
  const rows = [...docHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const docs = [];
  for (const row of rows) {
    const inner = row[1] || "";
    const titleCell = (inner.match(/<td[^>]*>([\s\S]*?)<\/td>/i) || [,""])[1];
    const titleText = stripTags(titleCell || "");
    if (!titleText) continue;

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
  return docs;
}

app.post("/fetchAcncFinancials", auth, async (req, res) => {
  const abn = String(req.body?.abn || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(abn)) return res.status(400).json({ error: "ABN must be 11 digits" });

  // pdfText mode: "none" | "preview" | "full"
  const bodyMode = String(req.body?.pdfText || "").toLowerCase();
  const pdfTextMode = ["none","preview","full"].includes(bodyMode)
    ? bodyMode
    : (PREVIEW_DEFAULT ? "preview" : "none");

  const t0 = Date.now();
  console.log("[ACNC] start", { abn, pdfTextMode });

  let rq; // Playwright request context (HTTP-first)
  let browser, ctx, page;

  try {
    // --------- HTTP-FIRST (NO browser launch) ----------
    rq = await pwRequest.newContext({
      extraHTTPHeaders: COMMON_HEADERS,
      userAgent: COMMON_HEADERS["User-Agent"],
      ignoreHTTPSErrors: true
    });

    const searchUrl = `https://www.acnc.gov.au/charity/charities?search=${abn}`;
    const searchHtml = await getHtmlWithFallback(rq, searchUrl, HTTP_TIMEOUT_MS);

    // prefer row that contains ABN (spaced or plain)
    const abnSp = spaceAbn(abn).replace(/\s/g, "\\s+");
    const tr = [...searchHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
      .map(m => m[0])
      .find(tr => new RegExp(`(?:${abn}|${abnSp})`).test(tr));

    let rawLink = tr
      ? (tr.match(/href="([^"]*\/charity\/charities\/[0-9a-f-]{36}\/(?:profile|documents)\/?)"/i) ||
         tr.match(/href="([^"]*\/charity\/charities\/[^"']+?\/profile\/?)"/i) ||
         tr.match(/href="([^"]*\/charity\/charities\/[^"']+?)"/i))
      : null;
    rawLink = rawLink ? rawLink[1] : null;
    if (!rawLink) throw new Error("No matching charity link found for ABN");

    const firstLink = absUrl(rawLink, "https://www.acnc.gov.au");
    const u = new URL(firstLink);
    u.pathname = u.pathname.replace(/\/profile\/?$/, "/documents/");

    const docHtml = await getHtmlWithFallback(rq, u.toString(), HTTP_TIMEOUT_MS);

    const docs = parseDocsFromHtml(docHtml);
    const latestAis = docs.filter(d => d.type === "AIS" && Number.isInteger(d.year)).sort((a,b)=>b.year - a.year)[0] || null;
    const latestFr  = docs.filter(d => d.type === "Financial Report" && Number.isInteger(d.year)).sort((a,b)=>b.year - a.year)[0] || null;

    // Optional PDF text
    let previewObj;
    let pdfFullText;
    if (latestFr && pdfTextMode !== "none") {
      const cap = pdfTextMode === "full" ? MAX_FULL_PDF_CHARS : DEFAULT_PREVIEW_CHARS;
      const extracted = await extractPdfTextVia(rq, latestFr.source_url, cap);
      if (extracted) {
        if (pdfTextMode === "full") pdfFullText = extracted;
        else previewObj = { financial_report_text_preview: extracted };
      }
    }

    console.log("[ACNC] HTTP path OK in", Date.now() - t0, "ms");
    return res.json({
      abn,
      acnc_detail_url: u.toString().replace(/\/documents\/?$/, "/profile"),
      latest: {
        financial_report: latestFr ? { year: latestFr.year, source_url: latestFr.source_url } : null,
        ais: latestAis ? { year: latestAis.year, source_url: latestAis.source_url } : null
      },
      all_documents: docs,
      ...(pdfFullText ? { pdf_text: pdfFullText } : {}),
      ...(previewObj ? { preview: previewObj } : {}),
      notes: []
    });

  } catch (httpErr) {
    console.warn("[ACNC] HTTP path failed, falling back to browser:", httpErr?.message || httpErr);

    // --------- BROWSER FALLBACK (only if HTTP failed) ----------
    browser = await chromium.launch({
      args: ["--no-sandbox","--disable-dev-shm-usage","--disable-http2","--disable-quic"]
    });
    ctx = await browser.newContext({
      locale: "en-AU",
      ignoreHTTPSErrors: true,
      userAgent: COMMON_HEADERS["User-Agent"]
    });
    page = await ctx.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(15000);
    await page.setExtraHTTPHeaders(COMMON_HEADERS);

    const searchUrl = `https://www.acnc.gov.au/charity/charities?search=${abn}`;

    const goto = async url => {
      // give the site time to respond; 'domcontentloaded' after initial commit
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      // settle, but don't fail the whole run if this times out
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(()=>{});
    };

    try {
      await goto(searchUrl);

      const spaced = spaceAbn(abn);
      let link = page
        .locator("table tbody tr")
        .filter({ has: page.locator(`td:last-child:has-text("${spaced}"), td:last-child:has-text("${abn}")`) })
        .locator('a[href*="/charity/charities/"]')
        .first();
      if (!(await link.isVisible().catch(()=>false)))
        link = page.locator('a[href*="/charity/charities/"]').first();

      await link.waitFor({ timeout: 8000 });
      await Promise.all([page.waitForLoadState("domcontentloaded"), link.click()]);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(()=>{});

      const u = new URL(page.url());
      u.pathname = u.pathname.replace(/\/profile\/?$/, "/documents/");
      await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(()=>{});
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(()=>{});

      const tab = page.locator('a:has-text("FINANCIALS & DOCUMENTS"), button:has-text("FINANCIALS & DOCUMENTS"), a[role="tab"]:has-text("FINANCIALS & DOCUMENTS")').first();
      const firstRow = page.locator("table tbody tr").first();
      if (!(await firstRow.isVisible().catch(()=>false)) && await tab.isVisible().catch(()=>false)) {
        await Promise.all([page.waitForLoadState("domcontentloaded"), tab.click()]);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(()=>{});
      }

      const rows = page.locator("table tbody tr");
      const count = await rows.count();
      if (count === 0) throw new Error("No annual reporting rows found");

      const docs = [];
      for (let i = 0; i < count; i++) {
        const r = rows.nth(i);
        const cells = r.locator("td");
        const title = (await cells.nth(0).innerText().catch(()=> "")).trim();
        const a = r.locator("a").filter({ hasText: /download|view|ais/i }).first();
        if (!(await a.isVisible().catch(()=>false))) continue;
        const href = await a.getAttribute("href").catch(()=> null);
        if (!href) continue;

        const url = absUrl(href, page.url());
        const ym = title.match(/\b(20\d{2})\b/);
        const year = ym ? parseInt(ym[1], 10) : null;

        const type = /annual information statement|ais/i.test(title)
          ? "AIS"
          : /financial/i.test(title)
            ? "Financial Report"
            : "Other";

        docs.push({ year, type, source_url: url, title });
      }

      const latestAis = docs.filter(d => d.type === "AIS" && Number.isInteger(d.year)).sort((a,b)=>b.year - a.year)[0] || null;
      const latestFr  = docs.filter(d => d.type === "Financial Report" && Number.isInteger(d.year)).sort((a,b)=>b.year - a.year)[0] || null;

      // PDF text on browser fallback only if explicitly asked (to keep it quick)
      let previewObj;
      let pdfFullText;
      if (latestFr && (pdfTextMode === "preview" || pdfTextMode === "full")) {
        const rrq = await pwRequest.newContext({
          extraHTTPHeaders: COMMON_HEADERS,
          userAgent: COMMON_HEADERS["User-Agent"],
          ignoreHTTPSErrors: true
        });
        try {
          const cap = pdfTextMode === "full" ? MAX_FULL_PDF_CHARS : DEFAULT_PREVIEW_CHARS;
          const extracted = await extractPdfTextVia(rrq, latestFr.source_url, cap);
          if (extracted) {
            if (pdfTextMode === "full") pdfFullText = extracted;
            else previewObj = { financial_report_text_preview: extracted };
          }
        } finally {
          await rrq.dispose().catch(()=>{});
        }
      }

      console.log("[ACNC] Browser fallback OK in", Date.now() - t0, "ms");
      return res.json({
        abn,
        acnc_detail_url: page.url().replace(/\/documents\/?$/, "/profile"),
        latest: {
          financial_report: latestFr ? { year: latestFr.year, source_url: latestFr.source_url } : null,
          ais: latestAis ? { year: latestAis.year, source_url: latestAis.source_url } : null
        },
        all_documents: docs,
        ...(pdfFullText ? { pdf_text: pdfFullText } : {}),
        ...(previewObj ? { preview: previewObj } : {}),
        notes: []
      });

    } catch (e) {
      console.error("[ACNC] Browser fallback failed:", e?.message || e);
      return res.status(500).json({ error: e?.message || String(e), step: "browser-fallback", abn });
    }

  } finally {
    if (page) await page.close().catch(()=>{});
    if (ctx) await ctx.close().catch(()=>{});
    if (browser) await browser.close().catch(()=>{});
    if (rq) await rq.dispose().catch(()=>{});
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server started and listening on port ${PORT}`);
});
