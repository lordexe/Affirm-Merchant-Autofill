import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { chromium } from "playwright";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = 8787;
const USE_MOCK = process.env.USE_MOCK === "true";
const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

const AFFIRM_SEARCH_URL_TEMPLATE =
  "https://www.affirm.com/api/marketplace/search/v2/public?query={query}&entity_type=merchants";

const ACCESSORIES_URL = "https://www.affirm.com/shopping/accessories";
const ACCESSORIES_DETAILS_URL =
  "https://www.affirm.com/shopping/accessories?merchant_details_ari={merchantKey}";

const buildMock = (name) => {
  const encoded = encodeURIComponent(name);
  return {
    name,
    logoUrl: `https://via.placeholder.com/128?text=${encoded}+logo`,
    heroUrl: null,
  };
};

async function fetchJson(url) {
  if (DEBUG) console.log("[fetchJson] GET", url);

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.affirm.com/shopping",
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

function pickMerchant(data, queryName = "") {
  if (!data) return null;

  const moduleEntities = Array.isArray(data?.modules)
    ? data.modules.flatMap((m) => (Array.isArray(m?.entities) ? m.entities : []))
    : [];

  const resultsEntities = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.results?.merchants)
      ? data.results.merchants
      : [];

  const items = [...moduleEntities, ...resultsEntities].filter(Boolean);
  if (!items.length) return null;

  const q = String(queryName || "").trim().toLowerCase();

  const scored = items
    .map((item) => {
      const name =
        item?.title || item?.name || item?.merchant_name || item?.display_name || null;

      const nameLower = String(name || "").trim().toLowerCase();

      const merchantKey =
        item?.merchant_details_ari ||
        item?.merchantDetailsAri ||
        item?.merchant_ari ||
        item?.merchantAri ||
        item?.ari ||
        item?.id ||
        null;

      const icon = item?.icon_url || item?.iconUrl || null;
      const logoCandidate = item?.logo_url || item?.logoUrl || null;

      let logoUrl = logoCandidate;
      if (!logoUrl && icon && /\/logo/i.test(icon)) logoUrl = icon;
      if (!logoUrl && icon) logoUrl = icon;

      // scoring
      let score = 0;
      if (merchantKey) score += 200;
      if (q && nameLower === q) score += 120;
      if (q && nameLower.includes(q)) score += 60;
      if (logoUrl && /\/merchant\/promos\/A\//i.test(logoUrl)) score -= 120;
      if (logoUrl) score += 10;

      return { item, score, name, logoUrl, merchantKey };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;

  if (DEBUG) {
    console.log("[pickMerchant] top candidates:");
    scored.slice(0, 5).forEach((c, i) => {
      console.log(
        `  ${i + 1}. score=${c.score} name=${c.name} merchantKey=${c.merchantKey} logo=${c.logoUrl}`
      );
    });
  }

  return {
    name: best.name,
    logoUrl: best.logoUrl || null,
    heroUrl: null,
    merchantKey: best.merchantKey || null,
  };
}


async function scrapeMerchant(name) {
  const url = AFFIRM_SEARCH_URL_TEMPLATE.replace("{query}", encodeURIComponent(name));
  const json = await fetchJson(url);
  const picked = pickMerchant(json, name);

  if (DEBUG) {
    console.log("[scrapeMerchant] query=", name);
    console.log("[scrapeMerchant] picked=", picked);
  }

  return picked;
}

function extractMerchantKeyFromLogoUrl(logoUrl) {
  const s = String(logoUrl || "");
  let m = s.match(/\/vcn_buy\/v1\/merchants\/([A-Z0-9]+)\//i);
  if (m && m[1]) return m[1];
  m = s.match(/\/merchants\/([A-Z0-9]+)\//i);
  if (m && m[1]) return m[1];
  m = s.match(/\/merchant\/promos\/([A-Za-z0-9]+)\//);
  if (m && m[1] && m[1].length >= 8) return m[1];
  return null;
}

// ---- Playwright + caching ----

const cache = new Map();
const inFlight = new Map();
const TTL_MS = 12 * 60 * 60 * 1000;

let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

function isFresh(entry) {
  return entry && Date.now() - entry.ts < TTL_MS;
}

/**
 * FIXED: Now accepts both 'cdn-assets.affirm.com' AND 'cdn1.affirm.com'
 */
function isPromoImageUrl(u) {
  if (typeof u !== "string") return false;
  
  // Must be on one of the known Affirm CDN domains
  const isCdn = u.includes("cdn-assets.affirm.com") || u.includes("cdn1.affirm.com");
  if (!isCdn) return false;
  
  // Must be an image extension
  if (!/\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(u)) return false;

  // Filter out obvious noise
  if (u.includes("/icons/") || u.includes("/assets/icon")) return false;

  return true;
}

function pickBestHeroCandidate(urls) {
  if (!urls || urls.length === 0) return null;
  const uniq = Array.from(new Set(urls)).filter(Boolean);
  uniq.sort((a, b) => score(b) - score(a));
  return uniq[0] || null;

  function score(u) {
    let s = 0;
    if (/logo/i.test(u)) s -= 50;
    if (/icon/i.test(u)) s -= 25;
    if (/thumbnail/i.test(u)) s -= 10;

    // Boost things that look like hero images
    if (/\/hero20\d{6,}\//i.test(u)) s += 100;
    if (/\/hero/i.test(u)) s += 40; // This will catch ".../hero/hero2x.png"
    if (/hero/i.test(u)) s += 10;
    
    // Boost preferred formats
    if (/\.png(\?|$)/i.test(u)) s += 5;
    if (/\.webp(\?|$)/i.test(u)) s += 4;
    if (/\.jpe?g(\?|$)/i.test(u)) s += 3;
    return s;
  }
}

async function dismissOverlays(page, preserveContent = false) {
  const safeCandidates = [
    'button:has-text("Stay here")',
    'button:has-text("Go to the page")',
    'button:has-text("Reject All")',
    'button:has-text("Confirm My Choices")',
    'button:has-text("Allow All")',
    'button[aria-label="Close"]', 
  ];

  const aggressiveCandidates = [
    '[data-testid="modalCloseButton"]',
    '[data-testid="modal"] button', 
    'div[class*="Modal-modalBackdrop"]'
  ];

  const candidates = preserveContent 
    ? safeCandidates 
    : [...safeCandidates, ...aggressiveCandidates];

  for (let i = 0; i < 3; i++) { 
    let didSomething = false;

    // 1. Click buttons
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          if (DEBUG) console.log(`[dismissOverlays] clicking: ${sel}`);
          await loc.click({ timeout: 1000, force: true }).catch(() => {});
          didSomething = true;
          await page.waitForTimeout(300);
        }
      } catch {}
    }

    // 2. Escape key (only if NOT preserving content)
    if (!preserveContent) {
      try {
        const modalPresent = await page.locator('[data-testid="modal"]').isVisible().catch(() => false);
        if (modalPresent) {
           if (DEBUG) console.log("[dismissOverlays] Modal detected. Pressing ESCAPE.");
           await page.keyboard.press("Escape");
           didSomething = true;
           await page.waitForTimeout(300);
        }
      } catch {}
    }

    if (!didSomething) break;
  }
}

async function scrapeViaMerchantKey(merchantKey) {
  const ckey = `key:${merchantKey}`;
  const cached = cache.get(ckey);
  if (isFresh(cached)) return cached.value;
  if (inFlight.has(ckey)) return inFlight.get(ckey);

  const p = (async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });

    const promoCandidates = [];
    let heroUrl = null;

    const onRequest = (req) => {
      const u = req.url();
      if (isPromoImageUrl(u)) promoCandidates.push(u);
    };
    page.on("request", onRequest);

    try {
      const url = ACCESSORIES_DETAILS_URL.replace("{merchantKey}", encodeURIComponent(merchantKey));
      if (DEBUG) console.log("\n[KEY OPEN] merchantKey=", merchantKey, "url=", url);

      await page.goto(url, { waitUntil: "domcontentloaded" });
      
      // Preserve the modal content!
      await dismissOverlays(page, true);

      const deadline = Date.now() + 10000;
      while (!heroUrl && Date.now() < deadline) {
        const strategies = [
           'img[class*="MerchantDetailsPage-hero"]',
           'img[alt="hero"]',
           'img[alt*="hero"]'
        ];
        for (const sel of strategies) {
            const src = await page.getAttribute(sel, "src").catch(() => null);
            if (src && isPromoImageUrl(src)) {
              heroUrl = src;
              break;
            }
        }
        await page.waitForTimeout(150);
      }

      if (DEBUG) console.log(`[KEY OPEN] DOM search finished. heroUrl=${heroUrl}`);

      if (!heroUrl) {
          if (DEBUG) console.log("[KEY OPEN] Checking network requests...");
          heroUrl = pickBestHeroCandidate(promoCandidates);
      }

      const nameFromModal =
        (await page.textContent('div[class*="detailCard__title"]').catch(() => null)) || null;

      const value = {
        heroUrl: heroUrl || null,
        name: nameFromModal ? String(nameFromModal).trim() : null,
      };

      cache.set(ckey, { value, ts: Date.now() });
      return value;
    } finally {
      page.off("request", onRequest);
      await page.close().catch(() => {});
    }
  })();

  inFlight.set(ckey, p);
  try {
    return await p;
  } finally {
    inFlight.delete(ckey);
  }
}

async function scrapeViaAccessoriesSearch(merchantName) {
  const ckey = `search:${merchantName.toLowerCase()}`;
  const cached = cache.get(ckey);
  if (isFresh(cached)) return cached.value;
  if (inFlight.has(ckey)) return inFlight.get(ckey);

  const p = (async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });

    const promoCandidates = [];
    let heroUrl = null;
    let displayName = null;

    const onRequest = (req) => {
      const u = req.url();
      if (isPromoImageUrl(u)) promoCandidates.push(u);
    };
    page.on("request", onRequest);

    try {
      if (DEBUG) console.log("\n[UI SEARCH] Starting search fallback for:", merchantName);

      await page.goto(ACCESSORIES_URL, { waitUntil: "domcontentloaded" });
      
      // Kill overlays to type
      await dismissOverlays(page, false);
      
      try {
        await page.waitForSelector('[data-testid="modal"]', { state: 'detached', timeout: 3000 });
      } catch {
        if (DEBUG) console.log("[UI SEARCH] Warning: Modal might still be present.");
      }

      // --- FIND SEARCH BAR ---
      let searchInput = null;
      await page.waitForSelector('#SearchBar', { state: 'attached', timeout: 10000 });
      
      const searchStart = Date.now();
      while (Date.now() - searchStart < 5000) {
        const inputs = await page.locator('#SearchBar').all();
        for (const input of inputs) {
            if (await input.isVisible()) {
                searchInput = input;
                if (DEBUG) console.log("[UI SEARCH] ✅ Found visible search bar");
                break;
            }
        }
        if (searchInput) break;
        await page.waitForTimeout(300);
      }

      if (!searchInput) {
         if (DEBUG) console.log("[UI SEARCH] All search bars hidden. Attempting one last ESC press...");
         await page.keyboard.press("Escape");
         await page.waitForTimeout(500);
         
         const inputs = await page.locator('#SearchBar').all();
         for (const input of inputs) {
             if (await input.isVisible()) {
                 searchInput = input;
                 break;
             }
         }
         
         if (!searchInput) throw new Error("search_bar_not_interactable");
      }

      // --- INTERACTION ---
      try {
        await searchInput.click();
        await searchInput.clear();
        
        if (DEBUG) console.log(`[UI SEARCH] Typing "${merchantName}"...`);
        await searchInput.pressSequentially(merchantName, { delay: 100 }); 
        await page.waitForTimeout(1000); 

        await searchInput.press("ArrowDown");
        await page.waitForTimeout(500);
      } catch (e) {
        throw new Error(`interaction_failed: ${e.message}`);
      }

      await dismissOverlays(page, false); 

      // --- CLICK RESULT ---
      let optionClicked = false;
      const optionSelectors = [
        page.locator('[role="option"]').filter({ hasText: new RegExp(`^\\s*${merchantName}\\s*$`, "i") }).first(),
        page.locator('[role="option"]').filter({ hasText: new RegExp(merchantName, "i") }).first()
      ];

      for (const option of optionSelectors) {
        if (await option.isVisible().catch(() => false)) {
          if (DEBUG) console.log(`[UI SEARCH] Clicking option: "${await option.textContent()}"`);
          promoCandidates.length = 0; 
          await option.click();
          optionClicked = true;
          break;
        }
      }

      if (!optionClicked) {
         const firstOpt = page.locator('[role="option"]').first();
         if (await firstOpt.isVisible()) {
             if (DEBUG) console.log(`[UI SEARCH] Exact match failed. Clicking first option.`);
             promoCandidates.length = 0;
             await firstOpt.click();
             optionClicked = true;
         }
      }

      if (!optionClicked) {
        const value = { heroUrl: null, name: null, error: "no_autocomplete_options_found" };
        cache.set(ckey, { value, ts: Date.now() });
        return value;
      }

      // --- HERO IMAGE SCRAPING ---
      const deadline = Date.now() + 12000;
      while (!heroUrl && Date.now() < deadline) {
        const strategies = [
           'img[class*="MerchantDetailsPage-hero"]',
           'img[alt="hero"]',
           'img[alt*="hero"]'
        ];

        for (const sel of strategies) {
            const src = await page.getAttribute(sel, "src").catch(() => null);
            if (DEBUG && src) console.log(`[UI SEARCH] Found src via ${sel}: ${src}`);
            if (src && isPromoImageUrl(src)) {
                heroUrl = src;
                break;
            }
        }
        
        if (heroUrl) break;
        await page.waitForTimeout(150);
      }
      
      if (!heroUrl) {
          if (DEBUG) console.log("[UI SEARCH] DOM scrape failed, checking network candidates...");
          heroUrl = pickBestHeroCandidate(promoCandidates);
      }

      const title = (await page.textContent('div[class*="detailCard__title"]').catch(() => null)) || null;
      if (title && String(title).trim()) displayName = String(title).trim();

      const value = { heroUrl: heroUrl || null, name: displayName || null };
      cache.set(ckey, { value, ts: Date.now() });
      return value;
    } catch (e) {
      const value = { heroUrl: null, name: null, error: e?.message || String(e) };
      if (DEBUG) console.log("[UI SEARCH] ERROR TRACE:", value.error);
      cache.set(ckey, { value, ts: Date.now() });
      return value;
    } finally {
      page.off("request", onRequest);
      await page.close().catch(() => {});
    }
  })();

  inFlight.set(ckey, p);
  try {
    return await p;
  } finally {
    inFlight.delete(ckey);
  }
}

async function lookupMerchant(queryName) {
  const mock = buildMock(queryName);
  if (USE_MOCK) return mock;

  let scraped = null;
  try {
    scraped = await scrapeMerchant(queryName);
  } catch (e) {
    if (DEBUG) console.log("[lookupMerchant] scrapeMerchant failed:", e?.message || e);
    scraped = null;
  }

  if (DEBUG) console.log("\n[lookupMerchant] queryName=", queryName, "scraped=", scraped);

  if (!scraped) {
    const viaUI = await scrapeViaAccessoriesSearch(queryName);
    return {
      name: viaUI.name || queryName,
      logoUrl: null,
      heroUrl: viaUI.heroUrl || null,
      merchantAri: null,
      ...(DEBUG && viaUI.error ? { debugError: viaUI.error } : {}),
    };
  }

  const merchantKey = scraped.merchantKey || extractMerchantKeyFromLogoUrl(scraped.logoUrl) || null;

  if (DEBUG) console.log("[lookupMerchant] merchantKey=", merchantKey, "logoUrl=", scraped.logoUrl);

  if (merchantKey) {
    const viaKey = await scrapeViaMerchantKey(merchantKey);
    if (viaKey.heroUrl) {
      return {
        name: viaKey.name || scraped.name || queryName,
        logoUrl: scraped.logoUrl || null,
        heroUrl: viaKey.heroUrl,
        merchantAri: merchantKey,
      };
    }
    const viaUI = await scrapeViaAccessoriesSearch(scraped.name || queryName);
    return {
      name: viaUI.name || scraped.name || queryName,
      logoUrl: scraped.logoUrl || null,
      heroUrl: viaUI.heroUrl || null,
      merchantAri: merchantKey,
      ...(DEBUG && viaUI.error ? { debugError: viaUI.error } : {}),
    };
  }

  const viaUI = await scrapeViaAccessoriesSearch(scraped.name || queryName);
  return {
    name: viaUI.name || scraped.name || queryName,
    logoUrl: scraped.logoUrl || null,
    heroUrl: viaUI.heroUrl || null,
    merchantAri: null,
    ...(DEBUG && viaUI.error ? { debugError: viaUI.error } : {}),
  };
}

app.get("/lookup", async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing name query param" });

  try {
    const result = await lookupMerchant(name);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({
      error: "lookup_failed",
      message: e?.message || String(e),
      name,
      logoUrl: null,
      heroUrl: null,
    });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Merchant lookup API running on http://localhost:${PORT}`);
  console.log(`   USE_MOCK: ${USE_MOCK}`);
  console.log(`   DEBUG: ${DEBUG}`);
});

process.on("SIGINT", async () => {
  try {
    if (sharedBrowser) await sharedBrowser.close();
  } catch {}
  process.exit(0);
});