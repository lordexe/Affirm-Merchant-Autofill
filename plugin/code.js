// plugin/code.js
figma.showUI(__html__, { width: 340, height: 200 });

// Send stored settings to UI on load
figma.clientStorage.getAsync('merchantAutofillSettings').then(settings => {
  figma.ui.postMessage({ type: 'SETTINGS_LOADED', settings: settings || {} });
});

// Image resize request queue — ui.html handles Canvas resizing and posts bytes back
var _imageRequestId = 0;
var _pendingImageRequests = new Map();

figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "RESIZE") {
    figma.ui.resize(340, msg.height);
    return;
  }

  if (msg.type === "SAVE_SETTINGS") {
    figma.clientStorage.setAsync('merchantAutofillSettings', msg.settings);
    return;
  }

  if (msg.type === "IMAGE_RESIZED") {
    var pending = _pendingImageRequests.get(msg.requestId);
    if (pending) {
      _pendingImageRequests.delete(msg.requestId);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.bytes);
      }
    }
    return;
  }

  if (msg.type === "RUN") {
    const merchantNames = Array.isArray(msg.merchants)
      ? msg.merchants.map(function(s) { return String(s).trim(); })
      : [];

    const layerNames = msg.layerNames || {
      name: 'Merchant name',
      logo: 'Logo',
      hero: 'Hero'
    };

    const layerToggles = msg.layerToggles || {
      name: true,
      logo: true,
      hero: true,
      replaceVectorLogo: false
    };

    const selection = figma.currentPage.selection;
    const availableCards = findMerchantCardsInSelection(selection, layerNames);
    const isCreationMode = availableCards.length === 0;

    if (isCreationMode) {
      figma.notify("Creating " + merchantNames.length + " new cards...");
    } else {
      figma.notify("Updating " + Math.min(merchantNames.length, availableCards.length) + " cards...");
    }

    let errorCount = 0;
    let createdNodes = [];

    for (let i = 0; i < merchantNames.length; i++) {
      const merchantName = merchantNames[i];

      if (!isCreationMode && i >= availableCards.length) {
        figma.ui.postMessage({ type: "STATUS", index: i, code: "SKIPPED" });
        continue;
      }

      figma.ui.postMessage({ type: "STATUS", index: i, code: "FETCH" });

      try {
        const data = await lookupMerchant(merchantName);

        figma.ui.postMessage({ type: "STATUS", index: i, code: "POPULATE" });

        let populateResult;
        if (isCreationMode) {
            const newCard = await createMerchantCard(data, merchantName, i, layerNames, layerToggles);
            createdNodes.push(newCard);
            populateResult = { success: true };
        } else {
            const targetCard = availableCards[i];
            populateResult = await populateCard(targetCard, data, merchantName, layerNames, layerToggles);
        }

        if (populateResult && populateResult.errors && populateResult.errors.length > 0) {
          const errorMsg = populateResult.errors.join(", ") + " not found";
          figma.ui.postMessage({ type: "STATUS", index: i, code: "ERROR", error: errorMsg });
          errorCount++;
        } else {
          figma.ui.postMessage({ type: "STATUS", index: i, code: "DONE" });
        }
      } catch (e) {
        errorCount++;
        const errorMessage = (e && e.message) || String(e);
        console.error("❌ Error for " + merchantName + ":", errorMessage);
        figma.notify(merchantName + ": " + errorMessage, { error: true });
        figma.ui.postMessage({ type: "STATUS", index: i, code: "ERROR", error: errorMessage });
      }
    }

    if (createdNodes.length > 0) {
        figma.currentPage.selection = createdNodes;
        figma.viewport.scrollAndZoomIntoView(createdNodes);
    }
    figma.ui.postMessage({ type: "COMPLETE", errorCount: errorCount });
  }
};

// ==========================================
//              AFFIRM API
// ==========================================

var CORS_PROXY = "https://api.codetabs.com/v1/proxy?quest=";
var AFFIRM_API_BASE = "https://www.affirm.com/api";

async function affirmFetch(url) {
  const res = await fetch(CORS_PROXY + encodeURIComponent(url));
  if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
  return res.json();
}

async function lookupMerchant(merchantName) {
  const query = encodeURIComponent(merchantName.trim());

  // Step 1: Search → ARI + logo
  const searchData = await affirmFetch(
    AFFIRM_API_BASE + "/marketplace/search/v2/public?query=" + query + "&entity_type=merchants"
  );

  const moduleEntities = Array.isArray(searchData && searchData.modules)
    ? searchData.modules.reduce(function(acc, m) {
        return acc.concat(Array.isArray(m && m.entities) ? m.entities : []);
      }, [])
    : [];

  if (!moduleEntities.length) throw new Error("No merchants found for: " + merchantName);

  const queryLower = merchantName.trim().toLowerCase();

  const scored = moduleEntities
    .map(function(entity) {
      var title = (entity && entity.title) || "";
      var titleLower = title.toLowerCase();
      var merchantAri = (entity && entity.action && entity.action.merchant_detail_page && entity.action.merchant_detail_page.merchant_ari) || null;
      var iconUrl = (entity && entity.icon_url) || null;
      var subtitle = (entity && entity.subtitle) || "";

      var score = 0;
      if (titleLower === queryLower) score += 100;
      if (titleLower.indexOf(queryLower) !== -1) score += 50;
      var queryWords = queryLower.split(/\s+/);
      var titleWords = titleLower.split(/\s+/);
      score += queryWords.filter(function(qw) {
        return titleWords.some(function(tw) { return tw.indexOf(qw) !== -1; });
      }).length * 20;
      if (!merchantAri) score -= 1000;
      if (iconUrl) score += 10;

      return { title: title, merchantAri: merchantAri, iconUrl: iconUrl, subtitle: subtitle, score: score };
    })
    .filter(function(item) { return item.merchantAri; })
    .sort(function(a, b) { return b.score - a.score; });

  if (!scored.length) throw new Error("No valid merchants found for: " + merchantName);

  var best = scored[0];

  // Step 2: Merchant details → hero image
  var detailsData = await affirmFetch(
    AFFIRM_API_BASE + "/marketplace/merchants/v2/public/" + encodeURIComponent(best.merchantAri) + "/details"
  );

  return {
    name: best.title,
    logoUrl: best.iconUrl || null,
    heroUrl: (detailsData && detailsData.hero_image_url) || null,
    merchantAri: best.merchantAri,
    subtitle: best.subtitle || null,
  };
}

// ==========================================
//              LOGIC HELPERS
// ==========================================

function findMerchantCardsInSelection(nodes, layerNames) {
  if (!nodes || nodes.length === 0) return [];
  let results = [];

  for (const node of nodes) {
    const isGrid = node.name.toLowerCase().indexOf("grid") !== -1;

    if ("children" in node) {
      // Always recurse first — prefer inner cards over treating a container as a card
      const childCards = findMerchantCardsInSelection(node.children, layerNames);
      if (childCards.length > 0) {
        results = results.concat(childCards);
      } else if (isMerchantCard(node, layerNames) && !isGrid) {
        results.push(node);
      }
    } else if (isMerchantCard(node, layerNames) && !isGrid) {
      results.push(node);
    }
  }
  return sortNodesByPosition(results);
}

function isMerchantCard(node, layerNames) {
  if (!node || typeof node.findAll !== "function") return false;

  const hasLogo = node.findAll(function(n) { return n.name === layerNames.logo; }).length > 0;
  const hasHero = node.findAll(function(n) { return n.name === layerNames.hero; }).length > 0;

  if (node.name.toLowerCase().indexOf("grid") !== -1) return false;

  return hasLogo && hasHero;
}

async function populateCard(card, data, fallbackName, layerNames, layerToggles) {
    const errors = [];

    const logoNode = layerToggles.logo ? card.findAll(function(n) { return n.name === layerNames.logo; })[0] : null;
    const heroNode = layerToggles.hero ? card.findAll(function(n) { return n.name === layerNames.hero; })[0] : null;

    const nameTextNode = layerToggles.name ? (card.findAll(function(n) {
      return n.type === "TEXT" &&
      (n.name.toLowerCase().indexOf("name") !== -1 || n.name === layerNames.name);
    })[0] || card.findAll(function(n) {
      return n.type === "TEXT" && n.name !== layerNames.logo && n.name !== layerNames.hero;
    })[0]) : null;

    if (layerToggles.name) {
      if (nameTextNode) {
        await loadAllFontsForTextNode(nameTextNode);
        nameTextNode.characters = (data && data.name) || fallbackName;
      } else {
        errors.push("Name layer");
      }
    }

    if (layerToggles.logo) {
      if (logoNode && data && data.logoUrl) {
        if (layerToggles.replaceVectorLogo && 'children' in logoNode) {
          // component instances don't allow child removal — hide instead
          for (const child of logoNode.children) { child.visible = false; }
        }
        try { await setNodeImageFill(logoNode, data.logoUrl); }
        catch (e) { errors.push("Logo image (fetch failed)"); }
      } else if (!logoNode) {
        errors.push("Logo layer");
      }
    }

    if (layerToggles.hero) {
      if (heroNode && data && data.heroUrl) {
        try { await setNodeImageFill(heroNode, data.heroUrl); }
        catch (e) { errors.push("Hero image (fetch failed)"); }
      } else if (!heroNode) {
        errors.push("Image layer");
      } else if (heroNode && (!data || !data.heroUrl)) {
        errors.push("Hero image (no URL from API)");
      }
    }

    return { success: errors.length === 0, errors: errors };
}

async function createMerchantCard(data, fallbackName, index, layerNames, layerToggles) {
  const frame = figma.createFrame();
  frame.name = "Merchant Card";
  frame.resize(232, 340);
  frame.layoutMode = "VERTICAL";
  frame.primaryAxisSizingMode = "AUTO";
  frame.paddingLeft = 16; frame.paddingRight = 16; frame.paddingTop = 16; frame.paddingBottom = 16;
  frame.itemSpacing = 12;
  frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];

  const col = index % 4;
  const row = Math.floor(index / 4);
  frame.x = figma.viewport.center.x + (col * 256);
  frame.y = figma.viewport.center.y + (row * 380);

  if (layerToggles.hero) {
    const hero = figma.createRectangle();
    hero.name = layerNames.hero;
    hero.resize(200, 200);
    hero.layoutAlign = "STRETCH";
    if (data && data.heroUrl) await setNodeImageFill(hero, data.heroUrl);
    frame.appendChild(hero);
  }

  if (layerToggles.logo) {
    const logo = figma.createRectangle();
    logo.name = layerNames.logo;
    logo.resize(50, 50);
    if (data && data.logoUrl) await setNodeImageFill(logo, data.logoUrl);
    frame.appendChild(logo);
  }

  if (layerToggles.name) {
    const text = figma.createText();
    text.name = layerNames.name;
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    text.characters = (data && data.name) || fallbackName;
    frame.appendChild(text);
  }

  return frame;
}

function sortNodesByPosition(nodes) {
  return nodes.sort(function(a, b) {
    const ay = a.absoluteTransform[1][2];
    const by = b.absoluteTransform[1][2];
    const ax = a.absoluteTransform[0][2];
    const bx = b.absoluteTransform[0][2];
    if (Math.abs(ay - by) > 15) return ay - by;
    return ax - bx;
  });
}

async function loadAllFontsForTextNode(textNode) {
  if (textNode.fontName !== figma.mixed) {
    await figma.loadFontAsync(textNode.fontName);
  } else {
    const len = textNode.characters.length;
    for (let i = 0; i < len; i++) {
      await figma.loadFontAsync(textNode.getRangeFontName(i, i + 1));
    }
  }
}

async function setNodeImageFill(node, imageUrl) {
  const proxiedUrl = CORS_PROXY + encodeURIComponent(imageUrl);
  const requestId = ++_imageRequestId;

  // Delegate fetch + resize to ui.html (which has Canvas API); code.js has none
  const bytes = await new Promise(function(resolve, reject) {
    _pendingImageRequests.set(requestId, { resolve: resolve, reject: reject });
    figma.ui.postMessage({ type: 'RESIZE_IMAGE', url: proxiedUrl, maxDim: 1200, requestId: requestId });
  });

  const image = figma.createImage(bytes);
  node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
}
