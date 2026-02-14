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
  // Search for merchants by name
  searchV2: (query) =>
    `${AFFIRM_API_BASE}/marketplace/search/v2/?query=${encodeURIComponent(query)}&entity_type=merchants`,

  // Get merchant details including hero image
  merchantDetails: (merchantAri) =>
    `${AFFIRM_API_BASE}/marketplace/merchants/v2/${encodeURIComponent(merchantAri)}/details`,
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
  logDebug("[fetchAffirmAPI] GET", url);

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

  logDebug("[searchMerchant] Raw response:", JSON.stringify(data, null, 2));

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

      // Calculate match score
      let score = 0;

      // Exact match bonus
      if (titleLower === queryLower) score += 100;

      // Partial match bonus
      if (titleLower.includes(queryLower)) score += 50;

      // Word match bonus
      const queryWords = queryLower.split(/\s+/);
      const titleWords = titleLower.split(/\s+/);
      const matchingWords = queryWords.filter(qw => titleWords.some(tw => tw.includes(qw)));
      score += matchingWords.length * 20;

      // Must have merchantAri
      if (!merchantAri) score -= 1000;

      // Bonus for having logo
      if (iconUrl) score += 10;

      return {
        title,
        merchantAri,
        iconUrl,
        subtitle,
        score,
      };
    })
    .filter(item => item.merchantAri) // Only keep items with merchantAri
    .sort((a, b) => b.score - a.score);

  logDebug("[searchMerchant] Scored results:", scored.slice(0, 5));

  if (scored.length === 0) {
    throw new Error(`No valid merchants found for query: ${queryName}`);
  }

  return scored[0];
}

/**
 * Get detailed merchant information including hero image
 */
async function getMerchantDetails(merchantAri) {
  const url = API_ENDPOINTS.merchantDetails(merchantAri);
  const data = await fetchAffirmAPI(url);

  logDebug("[getMerchantDetails] Raw response:", {
    merchantAri,
    hasHeroImage: Boolean(data?.hero_image_url),
    hasIconImage: Boolean(data?.icon_image_url),
  });

  return {
    heroImageUrl: data?.hero_image_url || null,
    iconImageUrl: data?.icon_image_url || null,
    modules: data?.modules || [],
  };
}

// ==========================================
//          MAIN LOOKUP FUNCTION
// ==========================================

/**
 * Main function to lookup merchant data
 * 1. Search for merchant by name
 * 2. Get detailed info including images
 */
async function lookupMerchant(queryName) {
  if (USE_MOCK) {
    return buildMock(queryName);
  }

  logDebug("[lookupMerchant] Starting lookup for:", queryName);

  try {
    // Step 1: Search for the merchant
    const searchResult = await searchMerchant(queryName);

    if (!searchResult.merchantAri) {
      throw new Error("No merchant ARI found in search results");
    }

    logDebug("[lookupMerchant] Found merchant:", {
      title: searchResult.title,
      merchantAri: searchResult.merchantAri,
    });

    // Step 2: Get detailed merchant info
    const details = await getMerchantDetails(searchResult.merchantAri);

    // Use icon from search if details doesn't have one
    const logoUrl = details.iconImageUrl || searchResult.iconUrl || null;

    const result = {
      name: searchResult.title,
      logoUrl,
      heroUrl: details.heroImageUrl || null,
      merchantAri: searchResult.merchantAri,
      subtitle: searchResult.subtitle || null,
    };

    logDebug("[lookupMerchant] Final result:", result);

    return result;
  } catch (error) {
    logDebug("[lookupMerchant] Error:", error.message);
    throw error;
  }
}

// ==========================================
//              CACHING LAYER
// ==========================================

const cache = new Map();
const inFlight = new Map();
const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function isFresh(entry) {
  return entry && Date.now() - entry.ts < TTL_MS;
}

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
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║                                                           ║");
  console.log("║   ✅  Merchant Autofill Server Running                    ║");
  console.log("║                                                           ║");
  console.log(`║   🌐  Server: http://localhost:${PORT}                        ║`);
  console.log("║   🔍  Endpoint: /lookup?name=MerchantName                 ║");
  console.log("║   ❤️   Health: /health                                     ║");
  console.log("║   🗑️   Clear Cache: POST /clear-cache                     ║");
  console.log("║                                                           ║");
  console.log("║   💡 Using Direct API Calls (No Browser Needed!)          ║");
  console.log("║                                                           ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  if (USE_MOCK) {
    console.log("⚠️  MOCK MODE ENABLED - Returning placeholder data");
  }

  if (DEBUG) {
    console.log("🐛 DEBUG MODE ENABLED - Verbose logging active");
  }
});

process.on("SIGINT", async () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});
