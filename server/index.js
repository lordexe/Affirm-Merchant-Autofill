// server/index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = 8787;
const PROXY_BASE = `http://localhost:${PORT}`;

// Suggestions endpoint (gives you merchant name + logo)
const AFFIRM_SEARCH_URL_TEMPLATE =
  "https://www.affirm.com/api/marketplace/search/v2/public?query={query}&entity_type=merchants";

// Merchant details page (gives you hero image in the modal)
const DETAILS_PAGE_BASE =
  "https://www.affirm.com/shopping/accessories?merchant_details_ari=";

function buildAffirmUrl(query) {
  const q = encodeURIComponent(query);
  return AFFIRM_SEARCH_URL_TEMPLATE.replace("{query}", q);
}

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

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url} :: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { _rawText: text };
  }
}

/**
 * Recursive “merchant-likeness” scorer. Picks the object that most looks like a merchant suggestion.
 */
function pickMerchantFromJson(data) {
  const candidates = [];

  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object") {
      candidates.push(node);
      for (const k of Object.keys(node)) walk(node[k]);
    }
  }

  walk(data);

  function getString(o, keys) {
    for (const k of keys) {
      if (typeof o?.[k] === "string" && o[k].trim()) return o[k].trim();
    }
    return null;
  }

  function getAny(o, keys) {
    for (const k of keys) {
      const v = o?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  }

  const scored = candidates.map((o) => {
    const name =
      getString(o, ["merchant_name", "display_name", "name", "title"]) ||
      getString(o?.attributes, ["merchant_name", "display_name", "name", "title"]);

    const merchantAri =
      getAny(o, ["merchant_details_ari", "merchant_ari", "ari"]) ||
      getAny(o?.attributes, ["merchant_details_ari", "merchant_ari", "ari"]);

    // logos are the key thing you said you need (they live in suggestions)
    const logoUrl =
      getAny(o, ["logo_url", "logoUrl", "logo", "icon_url", "iconUrl"]) ||
      getAny(o?.images, ["logo", "logoUrl", "logo_url", "icon", "iconUrl", "icon_url"]) ||
      getAny(o?.attributes, ["logo_url", "logoUrl", "logo", "icon_url", "iconUrl"]) ||
      getAny(o?.attributes?.images, ["logo", "logoUrl", "logo_url", "icon", "iconUrl", "icon_url"]);

    const imageUrl =
      getAny(o, ["hero_url", "heroUrl", "image_url", "imageUrl", "image"]) ||
      getAny(o?.images, ["hero", "image", "imageUrl", "image_url"]) ||
      getAny(o?.attributes, ["hero_url", "heroUrl", "image_url", "imageUrl", "image"]) ||
      getAny(o?.attributes?.images, ["hero", "image", "imageUrl", "image_url"]);

    const isGeneric = name && name.toLowerCase() === "search results";

    let score = 0;
    if (name) score += 3;
    if (merchantAri) score += 2;
    if (logoUrl) score += 6; // strong preference for suggestion logo presence
    if (imageUrl) score += 1;
    if (isGeneric) score -= 50;

    return { name, merchantAri, logoUrl, imageUrl, score, raw: o };
  });

  scored.sort((a, b) => b.score - a.score);

  // require at least a name + logo-ish signal
  return scored.find((s) => s.score >= 6) || null;
}

/**
 * Finds any string value whose key includes "ari" within an object tree.
 * This is defensive because Affirm may change exact key names.
 */
function findAriDeep(node) {
  let found = null;

  function walk(x) {
    if (!x || found) return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x !== "object") return;

    for (const [k, v] of Object.entries(x)) {
      if (found) return;

      // Prefer keys that look like merchant_details_ari, but accept any *ari*
      if (typeof v === "string" && /ari/i.test(k) && v.length >= 10) {
        found = v;
        return;
      }
      walk(v);
    }
  }

  walk(node);
  return found;
}

/**
 * Fetch the merchant details page and parse out the hero image and canonical merchant name.
 */
async function fetchHeroFromAri(merchantDetailsAri) {
  const url = `${DETAILS_PAGE_BASE}${encodeURIComponent(merchantDetailsAri)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.affirm.com/shopping/accessories",
    },
  });

  if (!res.ok) return { heroUrl: null, detailsUrl: url, canonicalName: null };

  const html = await res.text();
  const $ = cheerio.load(html);

  // Matches your earlier modal snippet; fallback to alt='hero'
  const hero =
    $("img.MerchantDetailsPage-hero--5qsED").attr("src") ||
    $("img[alt='hero']").attr("src") ||
    null;

  const name =
    $(".MerchantDetailsPage-detailCard__title--7HOQB").first().text().trim() ||
    null;

  return { heroUrl: hero, detailsUrl: url, canonicalName: name };
}

async function lookupMerchant(query) {
  const url = buildAffirmUrl(query);

  let json;
  try {
    json = await fetchJson(url);
  } catch (err) {
    return { query, error: err.message };
  }

  if (process.env.DEBUG_AFFIRM_JSON === "1") {
    console.log("AFFIRM SEARCH URL:", url);
    try {
      console.log(JSON.stringify(json).slice(0, 4000));
    } catch {
      console.log("AFFIRM JSON (raw):", json?._rawText?.slice(0, 4000) || "<no dump>");
    }
  }

  const picked = pickMerchantFromJson(json);
  if (!picked) return { query, error: "No merchant-like object found in JSON" };

  const normalize = (u) => (u && u.startsWith("//") ? "https:" + u : u);

  const logoUrl = normalize(picked.logoUrl);
  const suggestionImageUrl = normalize(picked.imageUrl) || null;

  // Pull merchant_details_ari from either the scored field or deep inside the picked raw object
  const merchantDetailsAri = picked.merchantAri || findAriDeep(picked.raw) || null;

  // Fetch hero (for image 161)
  let heroUrl = null;
  let detailsUrl = null;
  let canonicalName = null;

  if (merchantDetailsAri) {
    const hero = await fetchHeroFromAri(merchantDetailsAri);
    heroUrl = normalize(hero.heroUrl);
    detailsUrl = hero.detailsUrl;
    canonicalName = hero.canonicalName;
  }

  const finalName = canonicalName || picked.name || null;

  return {
    query,
    name: finalName,
    merchantAri: merchantDetailsAri,

    // Logo for "image 162"
    logoUrl,
    logoProxy: logoUrl ? `${PROXY_BASE}/image?url=${encodeURIComponent(logoUrl)}` : null,

    // Hero for "image 161"
    heroUrl,
    heroProxy: heroUrl ? `${PROXY_BASE}/image?url=${encodeURIComponent(heroUrl)}` : null,

    // Optional: keep suggestion image too (sometimes same as logo)
    suggestionImageUrl,
    suggestionImageProxy: suggestionImageUrl
      ? `${PROXY_BASE}/image?url=${encodeURIComponent(suggestionImageUrl)}`
      : null,

    sourceUrl: url,
    detailsUrl,
  };
}

/**
 * Image proxy endpoint so Figma can load images reliably.
 */
app.get("/image", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url param");
  if (!/^https?:\/\//i.test(url)) return res.status(400).send("Invalid url");

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://www.affirm.com/",
      },
    });

    if (!resp.ok) return res.status(resp.status).send("Failed to fetch image");

    res.setHeader("Content-Type", resp.headers.get("content-type") || "application/octet-stream");
    resp.body.pipe(res);
  } catch (err) {
    console.error("Image proxy error:", err);
    res.status(500).send("Error fetching image");
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/lookup", async (req, res) => {
  const { queries } = req.body;
  if (!Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: "Body must be { queries: string[] }" });
  }

  const cleaned = queries.map((q) => String(q || "").trim()).filter(Boolean).slice(0, 50);

  const out = [];
  for (const q of cleaned) out.push(await lookupMerchant(q));

  res.json({ results: out });
});

app.listen(PORT, () => {
  console.log(`✅ Scraper API running on http://localhost:${PORT}`);
  console.log(`   AFFIRM_SEARCH_URL_TEMPLATE: ${AFFIRM_SEARCH_URL_TEMPLATE}`);
  console.log(`   PROXY_BASE: ${PROXY_BASE}`);
});
