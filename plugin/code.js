// plugin/code.js
figma.showUI(__html__, { width: 340, height: 232 });

figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.type) return;

  // Handle resize request
  if (msg.type === "RESIZE") {
    figma.ui.resize(340, msg.height);
    return;
  }

  if (msg.type === "RUN") {
    let serverRaw = (msg.serverBase || "http://localhost:8787").trim();
    if (!serverRaw.startsWith("http")) serverRaw = "http://" + serverRaw;
    const serverBase = serverRaw.replace(/\/$/, "");

    const merchantNames = Array.isArray(msg.merchants)
      ? msg.merchants.map(function(s) { return String(s).trim(); })
      : [];

    // Get layer names (with defaults)
    const layerNames = msg.layerNames || {
      name: 'Merchant name',
      logo: 'Logo',
      hero: 'Hero'
    };

    // Get layer toggles (with defaults)
    const layerToggles = msg.layerToggles || {
      name: true,
      logo: true,
      hero: true
    };

    console.log("🚀 Run started with merchants:", merchantNames);
    console.log("🏷️  Using layer names:", layerNames);
    console.log("🔘 Layer toggles:", layerToggles);

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
        const url = serverBase + "/lookup?name=" + encodeURIComponent(merchantName);
        const res = await fetch(url);

        if (!res.ok) {
          // Try to see if the server sent a specific error message in the body
          const errorBody = await res.text().catch(function() { return "No error body"; });
          console.error("Server Error Details:", errorBody);

          // Custom message based on status
          if (res.status === 500) {
            throw new Error("Server crashed (500). Check your backend terminal logs.");
          } else if (res.status === 504 || res.status === 408) {
            throw new Error("Timed out trying to get asset");
          } else {
            throw new Error("HTTP " + res.status + ": " + res.statusText);
          }
        }

        const data = await res.json();

        // FIX: Replaced optional chaining with logical AND checks
        console.log("✅ Lookup success for " + merchantName, {
          resolvedName: (data && data.name) || null,
          hasLogo: Boolean(data && data.logoUrl),
          hasHero: Boolean(data && data.heroUrl),
          merchantAri: (data && data.merchantAri) || null,
        });

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

        // Check if there were any layer-specific errors
        if (populateResult && populateResult.errors && populateResult.errors.length > 0) {
          const errorMsg = populateResult.errors.join(", ") + " not found";
          figma.ui.postMessage({ type: "STATUS", index: i, code: "ERROR", error: errorMsg });
          errorCount++;
        } else {
          figma.ui.postMessage({ type: "STATUS", index: i, code: "DONE" });
        }
      } catch (e) {
        errorCount++;
        // FIX: Replaced e?.message with (e && e.message)
        const errorMessage = (e && e.message) || String(e);
        console.error("❌ Error for " + merchantName + ":", errorMessage);
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
//              LOGIC HELPERS
// ==========================================

function findMerchantCardsInSelection(nodes, layerNames) {
  if (!nodes || nodes.length === 0) return [];
  let results = [];

  for (const node of nodes) {
    const isGrid = node.name.toLowerCase().indexOf("grid") !== -1;

    if (isMerchantCard(node, layerNames) && !isGrid) {
      results.push(node);
    } else if ("children" in node) {
      results = results.concat(findMerchantCardsInSelection(node.children, layerNames));
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

    // Only look for layers that are enabled
    const logoNode = layerToggles.logo ? card.findAll(function(n) { return n.name === layerNames.logo; })[0] : null;
    const heroNode = layerToggles.hero ? card.findAll(function(n) { return n.name === layerNames.hero; })[0] : null;

    const nameTextNode = layerToggles.name ? (card.findAll(function(n) {
      return n.type === "TEXT" &&
      (n.name.toLowerCase().indexOf("name") !== -1 || n.name === layerNames.name);
    })[0] || card.findAll(function(n) {
      return n.type === "TEXT" && n.name !== layerNames.logo && n.name !== layerNames.hero;
    })[0]) : null;

    // Try to populate each enabled layer and track failures
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
        await setNodeImageFill(logoNode, data.logoUrl);
      } else if (!logoNode) {
        errors.push("Logo layer");
      }
    }

    if (layerToggles.hero) {
      if (heroNode && data && data.heroUrl) {
        await setNodeImageFill(heroNode, data.heroUrl);
      } else if (!heroNode) {
        errors.push("Image layer");
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

  // Only create layers that are enabled
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
  try {
    const bytes = await fetch(imageUrl).then(function(res) { return res.arrayBuffer(); });
    const image = figma.createImage(new Uint8Array(bytes));
    node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  } catch (e) { console.error("Fill Error:", e); }
}