import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = 8787;
const USE_MOCK = process.env.USE_MOCK === "true";
const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

function logDebug(...args) {
  if (DEBUG) console.log("[debug]", ...args);
}

// ==========================================
//        AFFIRM INTERNAL API ENDPOINTS
// ==========================================

const AFFIRM_API_BASE = "https://www.affirm.com/api";

const API_ENDPOINTS = {
  // Search for merchants by name (public)
  searchV2: (query) =>
    `${AFFIRM_API_BASE}/marketplace/search/v2/public?query=${encodeURIComponent(query)}&entity_type=merchants`,

  // Get merchant details including hero image (public)
  merchantDetails: (merchantAri) =>
    `${AFFIRM_API_BASE}/marketplace/merchants/v2/public/${encodeURIComponent(merchantAri)}/details`,
};

// ==========================================
//              MOCK DATA
// ==========================================

const buildMock = (name) => {
  const encoded = encodeURIComponent(name);
  return {
    name,
    logoUrl: `https://via.placeholder.com/128?text=${encoded}+logo`,
    heroUrl: `https://via.placeholder.com/800x400?text=${encoded}+hero`,
    merchantAri: "MOCK123",
  };
};

// ==========================================
//              API FETCHING
// ==========================================

async function fetchAffirmAPI(url) {
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
    const body = await res.text().catch(() => "<unable_to_read_response_body>");
    throw new Error(`HTTP ${res.status} fetching ${url}\nBody: ${body.slice(0, 500)}`);
  }

  return res.json();
}

// ==========================================
//          MERCHANT SEARCH & SELECTION
// ==========================================

/**
 * Search for a merchant using the search v2 API
 * Returns the best matching merchant from search results
 */
async function searchMerchant(queryName) {
  const url = API_ENDPOINTS.searchV2(queryName);
  const data = await fetchAffirmAPI(url);

  // Extract merchants from the modules array
  const moduleEntities = Array.isArray(data?.modules)
    ? data.modules.flatMap((m) => (Array.isArray(m?.entities) ? m.entities : []))
    : [];

  if (!moduleEntities.length) {
    throw new Error(`No merchants found for query: ${queryName}`);
  }

  // Score and pick the best match
  const queryLower = queryName.trim().toLowerCase();

  const scored = moduleEntities
    .map((entity) => {
      const title = entity?.title || "";
      const titleLower = title.toLowerCase();
      const merchantAri = entity?.action?.merchant_detail_page?.merchant_ari || null;
      const iconUrl = entity?.icon_url || null;
      const subtitle = entity?.subtitle || "";

      let score = 0;
      if (titleLower === queryLower) score += 100;
      if (titleLower.includes(queryLower)) score += 50;
      const queryWords = queryLower.split(/\s+/);
      const titleWords = titleLower.split(/\s+/);
      const matchingWords = queryWords.filter(qw => titleWords.some(tw => tw.includes(qw)));
      score += matchingWords.length * 20;
      if (!merchantAri) score -= 1000;
      if (iconUrl) score += 10;

      return {
        title,
        merchantAri,
        iconUrl,
        subtitle,
        score,
      };
    })
    .filter(item => item.merchantAri)
    .sort((a, b) => b.score - a.score);

  logDebug("[searchMerchant] Scored results:", scored.slice(0, 5));

  if (scored.length === 0) {
    throw new Error(`No valid merchants found for query: ${queryName}`);
  }

  return scored[0];
}

/**
 * Get public merchant details including hero image and about text
 */
async function getMerchantDetails(merchantAri) {
  const url = API_ENDPOINTS.merchantDetails(merchantAri);
  const data = await fetchAffirmAPI(url);

  logDebug("[getMerchantDetails] Raw response:", {
    merchantAri,
    hasHeroImage: Boolean(data?.hero_image_url),
    name: data?.merchant_name,
  });

  const about = data?.copy_modules?.find(m => m.module_name === "merchant_about")?.data?.text || null;

  return {
    heroImageUrl: data?.hero_image_url || null,
    about,
  };
}

// ==========================================
//          CACHING
// ==========================================

const cache = new Map();
const inFlight = new Map();
const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function isFresh(entry) {
  return entry && Date.now() - entry.ts < TTL_MS;
}

// ==========================================
//          MAIN LOOKUP FUNCTION
// ==========================================

/**
 * Main function to lookup merchant data
 * 1. Search for merchant by name → ARI + logo
 * 2. Fetch public details → hero image + about
 */
async function lookupMerchant(queryName) {
  if (USE_MOCK) {
    return buildMock(queryName);
  }

  const searchResult = await searchMerchant(queryName);

  logDebug("[lookupMerchant] Found merchant:", {
    title: searchResult.title,
    merchantAri: searchResult.merchantAri,
    hasLogo: Boolean(searchResult.iconUrl),
  });

  const details = await getMerchantDetails(searchResult.merchantAri);

  const result = {
    name: searchResult.title,
    logoUrl: searchResult.iconUrl || null,
    heroUrl: details.heroImageUrl,
    about: details.about,
    merchantAri: searchResult.merchantAri,
    subtitle: searchResult.subtitle || null,
  };

  return result;
}

// ==========================================
//              CACHING LAYER
// ==========================================

async function cachedLookup(queryName) {
  const cacheKey = queryName.toLowerCase().trim();

  // Check cache
  const cached = cache.get(cacheKey);
  if (isFresh(cached)) {
    logDebug("[cachedLookup] Cache hit for:", queryName);
    return cached.value;
  }

  // Check in-flight requests
  if (inFlight.has(cacheKey)) {
    logDebug("[cachedLookup] Waiting for in-flight request:", queryName);
    return inFlight.get(cacheKey);
  }

  // Make new request
  const promise = lookupMerchant(queryName);
  inFlight.set(cacheKey, promise);

  try {
    const result = await promise;
    cache.set(cacheKey, { value: result, ts: Date.now() });
    return result;
  } finally {
    inFlight.delete(cacheKey);
  }
}

// ==========================================
//              EXPRESS ROUTES
// ==========================================

app.get("/lookup", async (req, res) => {
  const name = String(req.query.name || "").trim();

  if (!name) {
    return res.status(400).json({
      error: "Missing name query param",
      usage: "/lookup?name=MerchantName"
    });
  }

  try {
    const result = await cachedLookup(name);
    return res.json(result);
  } catch (error) {
    console.error("❌ Lookup failed for:", name, error.message);
    return res.status(500).json({
      error: "lookup_failed",
      message: error?.message || String(error),
      merchantName: name
    });
  }
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    cacheSize: cache.size,
    inFlight: inFlight.size,
    uptime: process.uptime()
  });
});

app.post("/clear-cache", (_, res) => {
  const cacheSize = cache.size;
  cache.clear();
  inFlight.clear();
  console.log("🗑️  Cache cleared:", cacheSize, "entries");
  return res.json({ ok: true, cleared: cacheSize });
});

// ==========================================
//              SERVER STARTUP
// ==========================================

app.listen(PORT, () => {
  console.log("✅ Merchant Autofill Server Running on http://localhost:" + PORT);
  if (DEBUG) console.log("🐛 DEBUG MODE ENABLED");
  if (USE_MOCK) console.log("⚠️  MOCK MODE ENABLED - Returning placeholder data");
});

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});
