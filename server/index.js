// server/index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = 8787;
const USE_MOCK = process.env.USE_MOCK === "true";

const AFFIRM_SEARCH_URL_TEMPLATE =
  "https://www.affirm.com/api/marketplace/search/v2/public?query={query}&entity_type=merchants";

// We load the page that opens a merchant details modal by ARI.
// The hero image is requested directly as an image (not via XHR), so we observe network requests.
const AFFIRM_ACCESSORIES_URL_TEMPLATE =
  "https://www.affirm.com/shopping/accessories?merchant_details_ari={merchantAri}";

const buildMock = (name) => {
  const encoded = encodeURIComponent(name);
  return {
    name,
    logoUrl: `https://via.placeholder.com/128?text=${encoded}+logo`,
    heroUrl: null,
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

  // 1) Newer observed shape: { modules: [{ entities: [...] }] }
  const moduleEntities = Array.isArray(data?.modules)
    ? data.modules.flatMap((m) => (Array.isArray(m?.entities) ? m.entities : []))
    : [];

  // 2) Older/alternative shape: { results: [...] } or { results: { merchants: [...] } }
  const resultsEntities = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.results?.merchants)
      ? data.results.merchants
      : [];

  const items = [...moduleEntities, ...resultsEntities].filter(Boolean);
  if (!items.length) return null;

  const first = items.find(
    (item) =>
      item?.title ||
      item?.name ||
      item?.merchant_name ||
      item?.icon_url ||
      item?.logo_url ||
      item?.logoUrl
  );

  if (!first) return null;

  const name = first.title || first.name || first.merchant_name || null;

  const icon = first.icon_url || first.iconUrl || null;
  const logoCandidate = first.logo_url || first.logoUrl || null;

  let logoUrl = logoCandidate;
  if (!logoUrl && icon && /\/logo/i.test(icon)) logoUrl = icon;
  if (!logoUrl && icon) logoUrl = icon;

  // Search payload typically does NOT include hero; we will fill it via Playwright later.
  return { name, logoUrl, heroUrl: null };
}

async function scrapeMerchant(name) {
  const url = AFFIRM_SEARCH_URL_TEMPLATE.replace(
    "{query}",
    encodeURIComponent(name)
  );
  const json = await fetchJson(url);
  return pickMerchant(json);
}

// Extract the merchant ARI from the logo URL you already get, e.g.
// https://cdn-assets.affirm.com/vcn_buy/v1/merchants/44WXOQ22LJEYREMX/logo.../logo_offer.png
function extractMerchantAriFromLogoUrl(logoUrl) {
  const s = String(logoUrl || "");
  const m = s.match(/\/merchants\/([A-Z0-9]+)\//i);
  return m ? m[1] : null;
}

// ---- Playwright hero scraping with caching ----

const heroCache = new Map(); // merchantAri -> { heroUrl, ts }
const heroInFlight = new Map(); // merchantAri -> Promise<string|null>
const HERO_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

function isCacheFresh(entry) {
  return entry && Date.now() - entry.ts < HERO_CACHE_TTL_MS;
}

async function scrapeHeroUrlFromAccessories(merchantAri) {
  const cacheEntry = heroCache.get(merchantAri);
  if (isCacheFresh(cacheEntry)) return cacheEntry.heroUrl;

  if (heroInFlight.has(merchantAri)) {
    return heroInFlight.get(merchantAri);
  }

  const p = (async () => {
    const url = AFFIRM_ACCESSORIES_URL_TEMPLATE.replace(
      "{merchantAri}",
      encodeURIComponent(merchantAri)
    );

    const browser = await getBrowser();
    const page = await browser.newPage();

    let heroUrl = null;

    const onRequest = (req) => {
      const u = req.url();

      // Match hero assets like:
      // https://cdn-assets.affirm.com/merchant/promos/<ARI>/hero.../...HERO.png
      if (
        u.startsWith("https://cdn-assets.affirm.com/merchant/promos/") &&
        u.includes(`/${merchantAri}/`) &&
        /HERO\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(u)
      ) {
        heroUrl = u;
      }
    };

    page.on("request", onRequest);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      // Wait until we see the heroUrl or time out
      const deadline = Date.now() + 8000;
      while (!heroUrl && Date.now() < deadline) {
        await page.waitForTimeout(100);
      }
    } catch (e) {
      // Swallow: we'll just return null and let caller decide
      console.warn(`Hero scrape failed for ${merchantAri}:`, e?.message || e);
    } finally {
      page.off("request", onRequest);
      await page.close().catch(() => {});
    }

    heroCache.set(merchantAri, { heroUrl: heroUrl || null, ts: Date.now() });
    return heroUrl || null;
  })();

  heroInFlight.set(merchantAri, p);

  try {
    return await p;
  } finally {
    heroInFlight.delete(merchantAri);
  }
}

async function lookupMerchant(name) {
  const mock = buildMock(name);

  if (USE_MOCK) return mock;

  try {
    const scraped = await scrapeMerchant(name);
    if (!scraped) return mock;

    const merchantAri = extractMerchantAriFromLogoUrl(scraped.logoUrl);

    // Only attempt hero scrape if we can derive ARI
    const heroUrl = merchantAri ? await scrapeHeroUrlFromAccessories(merchantAri) : null;

    return {
      name: scraped.name || name,
      logoUrl: scraped.logoUrl || null,
      heroUrl,
      merchantAri: merchantAri || null, // helpful debug; you said you don’t need it, but it’s useful.
    };
  } catch (error) {
    console.warn(`Lookup failed for ${name}:`, error);
    return mock;
  }
}

app.get("/lookup", async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing name query param" });

  const result = await lookupMerchant(name);

  return res.json({
    name: result.name,
    logoUrl: result.logoUrl,
    heroUrl: result.heroUrl,
    // keep for debugging; remove if you want
    merchantAri: result.merchantAri || null,
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Merchant lookup API running on http://localhost:${PORT}`);
  console.log(`   USE_MOCK: ${USE_MOCK}`);
});

// Optional: clean shutdown of shared browser
process.on("SIGINT", async () => {
  try {
    if (sharedBrowser) await sharedBrowser.close();
  } catch {}
  process.exit(0);
});
