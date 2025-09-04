// server.js
// ACNC financials scraper (Render Web Service, Dockerized)
// Node ESM compatible

import express from "express";
import { chromium } from "playwright";
import fetch from "node-fetch";
// pdfjs-dist v4 legacy ESM entry point:
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SCRAPER_TOKEN || "changeme";

// --- Simple bearer auth (optional if TOKEN unset) ---
app.use((req, res, next) => {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || got === TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

// --- Utils ---
const spaceAbn = (abn) =>
  `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}`;

async function pdfTextFromBuffer(buf) {
  const loadingTask = pdfjs.getDocument({ data: buf });
  const pdf = await loadingTask.promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map((x) => x.str || "").join(" ") + "\n";
    if (out.length > 20000) break; // safety limit
  }
  return out;
}

// --- Routes ---
app.get("/", (_req, res) => res.send("ACNC scraper ready"));

app.post("/fetchAcncFinancials", async (req, res) => {
  const t0 = Date.now();
  const abn = String(req.body?.abn || "").replace(/\D/g, "");
  console.log("[ACNC] start", { abn });

  if (!/^\d{11}$/.test(abn)) {
    console.log("[ACNC] bad abn");
    return res.status(400).json({ error: "ABN must be 11 digits" });
  }

  const browser = await chromium.launch({
    // Render-friendly flags
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  console.log("[ACNC] browser launched");

  const ctx = await browser.newContext({ locale: "en-AU" });
  const page = await ctx.newPage();

  try {
    // 1) Search by ABN
    await page.goto(`https://www.acnc.gov.au/charity/charities?search=${abn}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    console.log("[ACNC] search page loaded");

    // Ensure results (table or links) exist
    await page.waitForTimeout(500);
    await page.locator("table tbody tr").first().waitFor({ timeout: 15000 }).catch(() => {});
    const spaced = spaceAbn(abn);

    // Prefer row with ABN match in last column
    let link = page
      .locator("table tbody tr")
      .filter({
        has: page.locator(
          `td:last-child:has-text("${spaced}"), td:last-child:has-text("${abn}")`
        )
      })
      .locator('a[href*="/charity/charities/"]')
      .first();

    // Fallback: first result that looks like a charity profile
    const hasLink = await link.isVisible().catch(() => false);
    if (!hasLink) {
      link = page.locator('a[href*="/charity/charities/"]').first();
    }

    await link.waitFor({ timeout: 20000 });
    await Promise.all([page.waitForLoadState("networkidle"), link.click()]);
    console.log("[ACNC] opened charity profile");

    // 3) Jump to documents tab
    const u = new URL(page.url());
    u.pathname = u.pathname.replace(/\/profile\/?$/, "/documents/");
    await page.goto(u.toString(), { waitUntil: "networkidle", timeout: 60000 });
    console.log("[ACNC] documents tab loaded");

    // 4) Scrape Annual reporting rows
    const rows = page.locator("table tbody tr");
    const count = await rows.count();
    if (count === 0) {
      throw new Error("No annual reporting rows found on ACNC documents tab.");
    }

    const docs = [];
    for (let i = 0; i < count; i++) {
      const r = rows.nth(i);
      const cells = r.locator("td");
      const cellCount = await cells.count();
      if (cellCount < 2) continue;

      const title = (await cells.nth(0).innerText().catch(() => ""))?.trim() || "";

      // Download/View link may move columns; find any relevant anchor in row
      const a = r.locator("a").filter({ hasText: /download|view|ais/i }).first();
      const visible = await a.isVisible().catch(() => false);
      if (!visible) continue;

      const href = await a.getAttribute("href").catch(() => null);
      if (!href) continue;

      const url = href.startsWith("http") ? href : new URL(href, page.url()).toString();

      const m = title.match(/\b(20\d{2})\b/);
      const year = m ? parseInt(m[1], 10) : null;

      const type = /annual information statement|ais/i.test(title)
        ? "AIS"
        : /financial/i.test(title)
          ? "Financial Report"
          : "Other";

      docs.push({ year, type, source_url: url, title });
    }

    // 5) Latest AIS + Latest Financial Report
    const latestAis =
      docs
        .filter((d) => d.type === "AIS" && Number.isInteger(d.year))
        .sort((a, b) => b.year - a.year)[0] || null;

    const latestFr =
      docs
        .filter((d) => d.type === "Financial Report" && Number.isInteger(d.year))
        .sort((a, b) => b.year - a.year)[0] || null;

    // 6) Optional: fetch & parse preview of latest Financial Report
    let frTextPreview = null;
    if (latestFr) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000); // 12s cap
      try {
        const r = await fetch(latestFr.source_url, { signal: ctrl.signal });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          // quick PDF magic-number check: 0x25 0x50 0x44 0x46 = '%PDF'
          if (buf.slice(0, 4).toString("hex") === "25504446") {
            const text = await pdfTextFromBuffer(buf).catch(() => "");
            frTextPreview = (text || "").slice(0, 800);
          }
        }
      } catch {
        // ignore preview failure
      } finally {
        clearTimeout(t);
      }
    }

    const detailUrl = page.url().replace(/\/documents\/?$/, "/profile");

    res.json({
      abn,
      acnc_detail_url: detailUrl,
      latest: {
        financial_report: latestFr
          ? { year: latestFr.year, source_url: latestFr.source_url }
          : null,
        ais: latestAis
          ? { year: latestAis.year, source_url: latestAis.source_url }
          : null
      },
      all_documents: docs,
      preview: frTextPreview ? { financial_report_text_preview: frTextPreview } : undefined,
      notes: []
    });

    console.log("[ACNC] success in", Date.now() - t0, "ms");
  } catch (e) {
    console.error("[ACNC] ERROR", e?.message || e);
    res.status(500).json({
      error: e?.message || String(e),
      step: "fetchAcncFinancials",
      abn
    });
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

// --- Boot ---
app.listen(PORT, () => {
  console.log(`✅ Server started and listening on port ${PORT}`);
});
