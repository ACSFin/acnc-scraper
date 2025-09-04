import express from "express";
import { chromium } from "playwright";
import fetch from "node-fetch";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SCRAPER_TOKEN || "changeme";

// simple bearer-auth
app.use((req, res, next) => {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || got === TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

const spaceAbn = abn =>
  `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}`;

async function pdfTextFromBuffer(buf) {
  const loadingTask = pdfjs.getDocument({ data: buf });
  const pdf = await loadingTask.promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map(x => x.str || "").join(" ") + "\n";
    if (out.length > 20000) break; // safety limit
  }
  return out;
}

app.post("/fetchAcncFinancials", async (req, res) => {
  const abn = String(req.body?.abn || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(abn))
    return res.status(400).json({ error: "ABN must be 11 digits" });

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ locale: "en-AU" });
  const page = await ctx.newPage();

  try {
    // 1) Search by ABN
    await page.goto(
      `https://www.acnc.gov.au/charity/charities?search=${abn}`,
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );

    // 2) Click first result row that matches ABN column
    const spaced = spaceAbn(abn);
    const row = page
      .locator("table tbody tr")
      .filter({
        has: page.locator(
          `td:last-child:has-text("${spaced}"), td:last-child:has-text("${abn}")`
        )
      })
      .first();
    const link = row.locator('a[href*="/charity/charities/"]').first();
    await link.waitFor({ timeout: 15000 });
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      link.click()
    ]);

    // 3) Jump to documents tab
    const u = new URL(page.url());
    u.pathname = u.pathname.replace(/\/profile\/?$/, "/documents/");
    await page.goto(u.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // 4) Read Annual reporting table — only rows with a real link in "Download" column
    const rows = page.locator("table tbody tr");
    const count = await rows.count();
    const docs = [];
    for (let i = 0; i < count; i++) {
      const r = rows.nth(i);
      const title = (await r.locator("td").nth(0).innerText()).trim();
      const a = r.locator("td").nth(3).locator("a").first(); // Download or View AIS
      if (!(await a.isVisible().catch(() => false))) continue;
      const href = await a.getAttribute("href");
      if (!href) continue;
      const url = href.startsWith("http")
        ? href
        : new URL(href, page.url()).toString();
      const m = title.match(/\b(20\d{2})\b/);
      const year = m ? parseInt(m[1], 10) : null;
      const type = /annual information statement/i.test(title)
        ? "AIS"
        : "Financial Report";
      docs.push({ year, type, source_url: url, title });
    }

    // 5) Latest AIS + latest downloadable Financial Report
    const latestAis =
      docs
        .filter(d => d.type === "AIS" && Number.isInteger(d.year))
        .sort((a, b) => b.year - a.year)[0] || null;
    const latestFr =
      docs
        .filter(d => d.type === "Financial Report" && Number.isInteger(d.year))
        .sort((a, b) => b.year - a.year)[0] || null;

    // (Optional) fetch & parse the latest FR text preview
    let frTextPreview = null;
    if (latestFr) {
      const r = await fetch(latestFr.source_url);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const text = await pdfTextFromBuffer(buf);
        frTextPreview = (text || "").slice(0, 800);
      }
    }

    res.json({
      abn,
      acnc_detail_url: page.url().replace(/\/documents\/?$/, "/profile"),
      latest: {
        financial_report: latestFr
          ? { year: latestFr.year, source_url: latestFr.source_url }
          : null,
        ais: latestAis
          ? { year: latestAis.year, source_url: latestAis.source_url }
          : null
      },
      all_documents: docs,
      preview: frTextPreview
        ? { financial_report_text_preview: frTextPreview }
        : undefined,
      notes: []
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

app.get("/", (_, res) => res.send("ACNC scraper ready"));
app.listen(PORT, () => console.log(`listening on :${PORT}`));
