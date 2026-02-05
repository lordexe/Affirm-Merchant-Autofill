// server/index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = 8787;
const USE_MOCK = process.env.USE_MOCK === "true";

const AFFIRM_SEARCH_URL_TEMPLATE =
  "https://www.affirm.com/api/marketplace/search/v2/public?query={query}&entity_type=merchants";

const buildMock = (name) => {
  const encoded = encodeURIComponent(name);
  return {
    name,
    logoUrl: `https://via.placeholder.com/128?text=${encoded}+logo`,
    heroUrl: `https://via.placeholder.com/600x300?text=${encoded}+hero`,
  };
};

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.affirm.com/shopping",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  return res.json();
}

function pickMerchant(data) {
  if (!data) return null;
  const items = Array.isArray(data?.results) ? data.results : data?.results?.merchants;
  if (!Array.isArray(items)) return null;

  const first = items.find((item) => item?.name || item?.merchant_name || item?.logo_url);
  if (!first) return null;

  return {
    name: first.name || first.merchant_name || null,
    logoUrl: first.logo_url || first.logoUrl || null,
    heroUrl: first.hero_url || first.heroUrl || null,
  };
}

async function scrapeMerchant(name) {
  const url = AFFIRM_SEARCH_URL_TEMPLATE.replace("{query}", encodeURIComponent(name));
  const json = await fetchJson(url);
  return pickMerchant(json);
}

async function lookupMerchant(name) {
  const mock = buildMock(name);

  if (USE_MOCK) {
    return mock;
  }

  try {
    const scraped = await scrapeMerchant(name);
    if (!scraped) return mock;

    return {
      name: scraped.name || name,
      logoUrl: scraped.logoUrl || mock.logoUrl,
      heroUrl: scraped.heroUrl || mock.heroUrl,
    };
  } catch (error) {
    console.warn(`Scrape failed for ${name}:`, error);
    return mock;
  }
}

/**
 * How to test:
 * 1) cd server && USE_MOCK=true node index.js
 * 2) GET http://localhost:8787/lookup?name=Nike
 */
app.get("/lookup", async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing name query param" });

  const result = await lookupMerchant(name);
  return res.json({
    name: result.name,
    logoUrl: result.logoUrl,
    heroUrl: result.heroUrl,
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Merchant lookup API running on http://localhost:${PORT}`);
  console.log(`   USE_MOCK: ${USE_MOCK}`);
});
