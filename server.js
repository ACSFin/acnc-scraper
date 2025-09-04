import express from "express";
import { chromium } from "playwright";
import fetch from "node-fetch";
import pdf from "pdf-parse";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SCRAPER_TOKEN || "";      // set in Render
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;  // set in Render if you want LLM fallback

// --- tiny auth so only your Base44 can call this ---
app.use((req, res, next) => {
  if (!TOKEN) return next();
  const hdr = req.headers.authorization || "";
  const got = hdr.replace(/^Bearer\s+/i, "");
  if (got && got === TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const spaceAbn = (abn) => `${abn.slice(0,2)} ${abn.slice(2,5)} ${abn.slice(5,8)} ${abn.slice(8)}`;

function pickLatestByType(rows, type) {
  const arr = rows.filter(d => d.type === type && Number.isInteger(d.year))
                  .sort((a,b) => b.year - a.year);
  return arr[0] || null;
}

function extractWithRegex(text) {
  const grab = (re) => {
    const m = text.match(re);
    if (!m) return null;
    const n = m[1].replace(/[, ]/g, "");
    const val = Number(n);
    return Number.isFinite(val) ? val : null;
  };
  // tolerant patterns (case-insensitive)
  const total_revenue     = grab(/total\s+revenue[^0-9\-]*([\d,]+(?:\.\d+)?)/i);
  const total_expenses    = grab(/total\s+expenses?[^0-9\-]*([\d,]+(?:\.\d+)?)/i);
  const total_assets      = grab(/total\s+assets?[^0-9\-]*([\d,]+(?:\.\d+)?)/i);
  const total_liabilities = grab(/total\s+liabilit(?:y|ies)[^0-9\-]*([\d,]+(?:\.\d+)?)/i);
  return { total_revenue, total_expenses, total_assets, total_liabilities };
}

async function extractWithLLM(text, year) {
  if (!openai) return null;
  const prompt = `
Return ONLY valid JSON (no prose) in this exact schema:
{
  "year": ${year},
  "financial_report": {
    "total_revenue": number | null,
    "total_expenses": number | null,
    "total_assets": number | null,
    "total_liabilities": number | null,
    "audited": boolean | null
  }
}
Be tolerant of synonyms (income vs revenue, net result vs surplus, etc.). If unknown, use null.
Text begins:
"""${text.slice(0, 12000)}"""
`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: "You are a strict JSON extractor. Reply with JSON only." },
      { role: "user", content: prompt }
    ],
    max_tokens: 500
  });
  try {
    return JSON.parse(resp.choices[0]?.message?.content || "{}");
  } catch {
    return null;
  }
}

app.post("/fetchAcncFinancials", async (req, res) => {
  const abn = String(req.body?.abn || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(abn)) {
    return res.status(400).json({ error: "ABN must be 11 digits" });
  }

  let browser;
  const notes = [];

  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const ctx = await browser.newContext({
      locale: "en-AU",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    });
    const page = await ctx.newPage();

    // 1) Search by ABN (the live UI path)
    await page.goto(`https://www.acnc.gov.au/charity/charities?search=${abn}`, {
      waitUntil: "domcontentloaded", timeout: 60000
    });

    // Accept cookie/consent if present
    const consent = page.locator('button:has-text("Accept")');
    if (await consent.isVisible().catch(()=>false)) { await consent.click().catch(()=>{}); }

    // Find result row whose last column equals the ABN (spaced or unspaced)
    const spaced = spaceAbn(abn);
    const rows = page.locator("table tbody tr");
    const matchedRow = rows.filter({
      has: page.locator(`td:last-child:has-text("${spaced}"), td:last-child:has-text("${abn}")`)
    }).first();

    const exists = await matchedRow.locator('a[href*="/charity/charities/"]').first().isVisible().catch(()=>false);
    if (!exists) {
      notes.push("Could not locate result row; the site layout might have changed.");
      return res.status(404).json({ error: "Charity not found on search results", notes });
    }

    // Click into profile
    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      matchedRow.locator('a[href*="/charity/charities/"]').first().click()
    ]);
    await sleep(300);

    // 2) Go to /documents
    const u = new URL(page.url());
    u.pathname = u.pathname.replace(/\/profile\/?$/, "/documents/");
    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });

    // 3) Parse Annual reporting table; pick rows with a real link in Download column
    const docRows = page.locator("table tbody tr");
    const count = await docRows.count();
    const docs = [];
    for (let i = 0; i < count; i++) {
      const r = docRows.nth(i);
      const t0 = (await r.locator("td").nth(0).innerText().catch(()=>"" )).trim();   // Title cell
      const a  = r.locator("td").nth(3).locator("a").first();                        // Download / View AIS
      if (!(await a.isVisible().catch(()=>false))) continue;

      const href = await a.getAttribute("href");
      if (!href) continue;
      const abs = href.startsWith("http") ? href : new URL(href, page.url()).toString();

      const m = t0.match(/\b(20\d{2})\b/);
      const year = m ? parseInt(m[1], 10) : null;
      const type = /annual information statement/i.test(t0) ? "AIS" : "Financial Report";

      docs.push({ year, type, source_url: abs, title: t0 });
    }

    const latestAis = pickLatestByType(docs, "AIS");
    const latestFr  = pickLatestByType(docs, "Financial Report");

    if (!latestFr && !latestAis) {
      notes.push("No actionable links found (rows may be pending or withheld).");
      return res.json({
        abn,
        acnc_detail_url: page.url().replace(/\/documents\/?$/, "/profile"),
        latest: { financial_report: null, ais: null },
        all_documents: docs,
        years: [],
        notes
      });
    }

    // 4) Download latest FR PDF and extract text
    let frYear = latestFr?.year ?? null;
    let frUrl  = latestFr?.source_url ?? null;
    let frText = null;

    if (frUrl) {
      const r = await fetch(frUrl);
      if (!r.ok) throw new Error(`Failed to download FR PDF (${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      const parsed = await pdf(buf);
      frText = parsed.text || null;
    }

    // 5) Regex attempt
    const regexVals = frText ? extractWithRegex(frText) : {};
    let out = {
      year: frYear,
      financial_report: {
        total_revenue: regexVals.total_revenue ?? null,
        total_expenses: regexVals.total_expenses ?? null,
        total_assets: regexVals.total_assets ?? null,
        total_liabilities: regexVals.total_liabilities ?? null,
        audited: null
      }
    };

    // 6) LLM fallback if key items are missing
    const needsLLM = !out.financial_report.total_revenue || !out.financial_report.total_expenses;
    if (needsLLM && frText && openai) {
      const llm = await extractWithLLM(frText, frYear || new Date().getFullYear());
      if (llm?.financial_report) {
        out = llm;
      } else {
        notes.push("LLM fallback failed or returned invalid JSON.");
      }
    } else if (needsLLM && !openai) {
      notes.push("LLM fallback disabled (no OPENAI_API_KEY).");
    }

    // 7) Response
    return res.json({
      abn,
      acnc_detail_url: page.url().replace(/\/documents\/?$/, "/profile"),
      latest: {
        financial_report: latestFr ? { year: latestFr.year, source_url: latestFr.source_url } : null,
        ais: latestAis ? { year: latestAis.year, source_url: latestAis.source_url } : null
      },
      all_documents: docs,
      years: out.year ? [out] : [],
      notes
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
});

app.get("/", (_, res) => res.send("ACNC scraper ready"));
app.listen(PORT, () => console.log(`listening on :${PORT}`));
