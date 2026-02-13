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

function logDebug(...args) {
  if (DEBUG) console.log("[debug]", ...args);
}

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
  logDebug("[fetchJson] GET", url);

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
    throw new Error(`HTTP ${res.status} fetching ${url} body=${body.slice(0, 500)}`);
  }
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

  logDebug("[pickMerchant] top candidates", scored.slice(0, 5));

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

  logDebug("[scrapeMerchant] query=", name);
  logDebug("[scrapeMerchant] picked=", picked);

  return picked;
}

function extractMerchantKeyFromLogoUrl(logoUrl) {
  const s = String(logoUrl || "");
  let m = s.match(/\/vcn_buy\/v1\/merchants\/([A-Z0-9]+)\//i);
  if (m && m[1]) return m[1];
  m = s.match(/\/merchants\/([A-Z0-9]+)\//i);
  if (m && m[1]) return m[1];
  // Only extract from /merchant/promos/ if it looks like a valid ID (mostly uppercase, alphanumeric)
  m = s.match(/\/merchant\/promos\/([A-Z0-9]{10,})\//);
  if (m && m[1]) {
    const key = m[1];
    // Check if it's at least 50% uppercase (valid keys are mostly uppercase)
    const upperCount = (key.match(/[A-Z]/g) || []).length;
    if (upperCount >= key.length * 0.5) {
      return key;
    }
  }
  return null;
}

// ---- Playwright + caching ----

const cache = new Map();
const inFlight = new Map();
const TTL_MS = 12 * 60 * 60 * 1000;

let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  
  const macChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const launchOptions = { 
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  };
  
  try {
    sharedBrowser = await chromium.launch({ 
      ...launchOptions,
      executablePath: macChromePath
    });
    logDebug("✅ Playwright launched using system Chrome");
  } catch (err) {
    logDebug("⚠️ System Chrome path failed, launching default Chromium...");
    sharedBrowser = await chromium.launch(launchOptions);
  }
  
  return sharedBrowser;
}

function isFresh(entry) {
  return entry && Date.now() - entry.ts < TTL_MS;
}

function isPromoImageUrl(u) {
  if (typeof u !== "string") return false;
  const isCdn = u.includes("cdn-assets.affirm.com") || u.includes("cdn1.affirm.com");
  if (!isCdn) return false;
  if (!/\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(u)) return false;
  if (u.includes("/icons/") || u.includes("/assets/icon")) return false;
  if (u.includes("/fallback/")) return false; // Reject Affirm's generic fallback images
  return true;
}

function pickBestHeroCandidate(urls, merchantName = null) {
  if (!urls || urls.length === 0) return null;
  const uniq = Array.from(new Set(urls)).filter(Boolean);

  // If we have a merchant name, strongly prefer images with that name in the URL
  if (merchantName) {
    const merchantSlug = merchantName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matchingName = uniq.filter(u => {
      const urlLower = u.toLowerCase().replace(/[^a-z0-9]/g, '');
      return urlLower.includes(merchantSlug);
    });
    if (matchingName.length > 0) {
      matchingName.sort((a, b) => score(b) - score(a));
      return matchingName[0];
    }
  }

  uniq.sort((a, b) => score(b) - score(a));
  return uniq[0] || null;

  function score(u) {
    let s = 0;
    if (/logo/i.test(u)) s -= 50;
    if (/icon/i.test(u)) s -= 25;
    if (/thumbnail/i.test(u)) s -= 10;
    if (/\/hero20\d{6,}\//i.test(u)) s += 100;
    if (/\/hero/i.test(u)) s += 40;
    if (/hero/i.test(u)) s += 10;
    if (/width=\d{3,}/i.test(u)) s += 20; // Prefer larger images
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
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          await loc.click({ timeout: 1000, force: true }).catch(() => {});
          didSomething = true;
          await page.waitForTimeout(300);
        }
      } catch {}
    }
    if (!preserveContent) {
      try {
        const modalPresent = await page.locator('[data-testid="modal"]').isVisible().catch(() => false);
        if (modalPresent) {
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
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });

      const promoCandidates = [];
      let heroUrl = null;

      const onRequest = (req) => {
        const u = req.url();
        if (isPromoImageUrl(u)) promoCandidates.push(u);
      };
      page.on("request", onRequest);

      logDebug("[scrapeViaMerchantKey] start", { merchantKey });
      const url = ACCESSORIES_DETAILS_URL.replace("{merchantKey}", encodeURIComponent(merchantKey));
      logDebug("[scrapeViaMerchantKey] goto", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await dismissOverlays(page, true);

      const deadline = Date.now() + 10000;
      while (!heroUrl && Date.now() < deadline) {
        const strategies = [
           'div[role="dialog"] img[class*="MerchantDetailsPage-hero"]',
           'div[role="dialog"] img[alt="hero"]',
           'div[class*="MerchantDetailsPage-modal"] img[alt="hero"]',
           'div[class*="MerchantDetailsPage-modal"] img[class*="MerchantDetailsPage-hero"]'
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

      if (!heroUrl) {
        const nameFromModal = (await page.textContent('div[class*="detailCard__title"]').catch(() => null)) || null;
        const searchName = nameFromModal ? String(nameFromModal).trim() : null;
        heroUrl = pickBestHeroCandidate(promoCandidates, searchName);
      }

      const nameFromModal = (await page.textContent('div[class*="detailCard__title"]').catch(() => null)) || null;

      const value = {
        heroUrl: heroUrl || null,
        name: nameFromModal ? String(nameFromModal).trim() : null,
      };

      logDebug("[scrapeViaMerchantKey] result", value);
      cache.set(ckey, { value, ts: Date.now() });
      return value;
    } catch (e) {
      throw e;
    } finally {
      if (page) await page.close().catch(() => {});
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
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      const promoCandidates = [];
      let heroUrl = null;
      let displayName = null;

      const onRequest = (req) => {
        const u = req.url();
        if (isPromoImageUrl(u)) promoCandidates.push(u);
      };
      page.on("request", onRequest);

      logDebug("[scrapeViaAccessoriesSearch] start", { merchantName });
      await page.goto(ACCESSORIES_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await dismissOverlays(page, false);

      try { await page.waitForSelector('[data-testid="modal"]', { state: 'detached', timeout: 3000 }); } catch {}

      let searchInput = null;
      try {
        await page.waitForSelector('#SearchBar', { state: 'attached', timeout: 10000 });
      } catch (e) {
        throw new Error("search_bar_not_found");
      }

      const searchStart = Date.now();
      while (Date.now() - searchStart < 5000) {
        const inputs = await page.locator('#SearchBar').all();
        for (const input of inputs) {
            if (await input.isVisible()) {
                searchInput = input;
                break;
            }
        }
        if (searchInput) break;
        await page.waitForTimeout(300);
      }

      if (!searchInput) {
         await page.keyboard.press("Escape");
         await page.waitForTimeout(500);
         const inputs = await page.locator('#SearchBar').all();
         for (const input of inputs) { if (await input.isVisible()) { searchInput = input; break; } }
         if (!searchInput) throw new Error("search_bar_not_interactable");
      }

      await searchInput.click({ timeout: 5000 });
      await searchInput.clear({ timeout: 5000 });
      await searchInput.pressSequentially(merchantName, { delay: 100 });
      await page.waitForTimeout(1500);
      await searchInput.press("ArrowDown");
      await page.waitForTimeout(500);
      await dismissOverlays(page, false); 

      let optionClicked = false;
      const optionSelectors = [
        page.locator('[role="option"]').filter({ hasText: new RegExp(`^\\s*${merchantName}\\s*$`, "i") }).first(),
        page.locator('[role="option"]').filter({ hasText: new RegExp(merchantName, "i") }).first()
      ];

      for (const option of optionSelectors) {
        if (await option.isVisible().catch(() => false)) {
          promoCandidates.length = 0;
          await option.click({ timeout: 5000 });
          optionClicked = true;
          break;
        }
      }

      if (!optionClicked) {
         const firstOpt = page.locator('[role="option"]').first();
         if (await firstOpt.isVisible().catch(() => false)) {
             promoCandidates.length = 0;
             await firstOpt.click({ timeout: 5000 });
             optionClicked = true;
         }
      }

      if (!optionClicked) {
        const value = { heroUrl: null, name: null, error: "no_autocomplete_options_found" };
        cache.set(ckey, { value, ts: Date.now() });
        return value;
      }

      const deadline = Date.now() + 12000;
      while (!heroUrl && Date.now() < deadline) {
        const strategies = [
          'div[role="dialog"] img[class*="MerchantDetailsPage-hero"]',
          'div[role="dialog"] img[alt="hero"]',
          'div[class*="MerchantDetailsPage-modal"] img[alt="hero"]',
          'div[class*="MerchantDetailsPage-modal"] img[class*="MerchantDetailsPage-hero"]'
        ];
        for (const sel of strategies) {
            const src = await page.getAttribute(sel, "src").catch(() => null);
            if (src && isPromoImageUrl(src)) {
              heroUrl = src;
              break;
            }
        }
        if (heroUrl) break;
        await page.waitForTimeout(150);
      }

      if (!heroUrl) heroUrl = pickBestHeroCandidate(promoCandidates, merchantName);

      const title = (await page.textContent('div[class*="detailCard__title"]').catch(() => null)) || null;
      if (title && String(title).trim()) displayName = String(title).trim();

      const value = { heroUrl: heroUrl || null, name: displayName || null };
      logDebug("[scrapeViaAccessoriesSearch] result", value);
      cache.set(ckey, { value, ts: Date.now() });
      return value;
    } catch (e) {
      throw e;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  })();

  inFlight.set(ckey, p);
  try { return await p; } finally { inFlight.delete(ckey); }
}

async function lookupMerchant(queryName) {
  const mock = buildMock(queryName);
  if (USE_MOCK) return mock;

  logDebug("[lookupMerchant] start", { queryName });

  let scraped = null;
  try {
    scraped = await scrapeMerchant(queryName);
  } catch (e) {
    scraped = null;
  }

  if (!scraped) {
    const viaUI = await scrapeViaAccessoriesSearch(queryName);
    return { name: viaUI.name || queryName, logoUrl: null, heroUrl: viaUI.heroUrl || null, merchantAri: null };
  }

  const merchantKey = scraped.merchantKey || extractMerchantKeyFromLogoUrl(scraped.logoUrl) || null;

  if (merchantKey) {
    const viaKey = await scrapeViaMerchantKey(merchantKey);
    // Only use the heroUrl from merchantKey if it's valid and not a fallback
    if (viaKey.heroUrl && isPromoImageUrl(viaKey.heroUrl)) {
      return { name: viaKey.name || scraped.name || queryName, logoUrl: scraped.logoUrl || null, heroUrl: viaKey.heroUrl, merchantAri: merchantKey };
    }
    // Fall back to UI search if merchantKey didn't give us a good hero image
    const viaUI = await scrapeViaAccessoriesSearch(scraped.name || queryName);
    return { name: viaUI.name || scraped.name || queryName, logoUrl: scraped.logoUrl || null, heroUrl: viaUI.heroUrl || null, merchantAri: merchantKey };
  }

  const viaUI = await scrapeViaAccessoriesSearch(scraped.name || queryName);
  return { name: viaUI.name || scraped.name || queryName, logoUrl: scraped.logoUrl || null, heroUrl: viaUI.heroUrl || null, merchantAri: null };
}

app.get("/lookup", async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing name query param" });

  try {
    const result = await lookupMerchant(name);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: "lookup_failed", message: e?.message || String(e) });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/clear-cache", (_, res) => {
  const cacheSize = cache.size;
  cache.clear();
  inFlight.clear();
  return res.json({ ok: true, cleared: cacheSize });
});

app.listen(PORT, () => {
  console.log(`✅ Merchant helper is now running. Please keep this running to use the Figma plugin`);
});

process.on("SIGINT", async () => {
  try { if (sharedBrowser) await sharedBrowser.close(); } catch {}
  process.exit(0);
});