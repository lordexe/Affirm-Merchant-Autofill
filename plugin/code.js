// plugin/code.js
figma.showUI(__html__, { width: 340, height: 200 });

figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "RUN") {
    let serverRaw = (msg.serverBase || "http://localhost:8787").trim();
    if (!serverRaw.startsWith("http")) serverRaw = `http://${serverRaw}`;
    const serverBase = serverRaw.replace(/\/$/, "");

    const merchantNames = Array.isArray(msg.merchants) 
      ? msg.merchants.map(s => String(s).trim())
      : [];

    console.log("🚀 Run started with merchants:", merchantNames);

    // 1. CAPTURE SELECTION
    const selection = figma.currentPage.selection;
    console.log("📍 Selection count:", selection.length);

    // 2. FIND CARDS (Ensuring we don't treat the Grid as a Card)
    const availableCards = findMerchantCardsInSelection(selection);
    console.log("🗂️ Identified Cards:", availableCards.map(c => `${c.name} (${c.id})`));

    const isCreationMode = availableCards.length === 0;

    if (isCreationMode) {
      figma.notify(`Creating ${merchantNames.length} new cards...`);
    } else {
      figma.notify(`Updating ${Math.min(merchantNames.length, availableCards.length)} cards...`);
    }

    let errorCount = 0;
    let createdNodes = [];
    
    for (let i = 0; i < merchantNames.length; i++) {
      const merchantName = merchantNames[i];
      
      if (!isCreationMode && i >= availableCards.length) {
        console.log(`⚠️ Skipping "${merchantName}" - No card at index ${i}`);
        figma.ui.postMessage({ type: "STATUS", index: i, code: "SKIPPED" });
        continue;
      }

      figma.ui.postMessage({ type: "STATUS", index: i, code: "FETCH" });

      try {
        const url = `${serverBase}/lookup?name=${encodeURIComponent(merchantName)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        figma.ui.postMessage({ type: "STATUS", index: i, code: "POPULATE" });

        if (isCreationMode) {
            const newCard = await createMerchantCard(data, merchantName, i);
            createdNodes.push(newCard);
        } else {
            const targetCard = availableCards[i];
            console.log(`✏️ Updating Card [${i}]: ${targetCard.name}`);
            await populateCard(targetCard, data, merchantName);
        }

        figma.ui.postMessage({ type: "STATUS", index: i, code: "DONE" });
      } catch (e) {
        errorCount++;
        console.error(`❌ Error for "${merchantName}":`, e.message);
        figma.ui.postMessage({ type: "STATUS", index: i, code: "ERROR", error: e.message });
      }
    }

    if (createdNodes.length > 0) {
        figma.currentPage.selection = createdNodes;
        figma.viewport.scrollAndZoomIntoView(createdNodes);
    }
    figma.ui.postMessage({ type: "COMPLETE", errorCount });
  }
};

// ==========================================
//              LOGIC HELPERS
// ==========================================

function findMerchantCardsInSelection(nodes) {
  if (!nodes || nodes.length === 0) return [];
  let results = [];

  for (const node of nodes) {
    // FIX: Only treat as a card if it's named "Merchant Card" OR it has the specific layers
    // and is NOT named "Merchant Grid"
    const nameMatch = node.name.toLowerCase().includes("card");
    const isGrid = node.name.toLowerCase().includes("grid");

    if (isMerchantCard(node) && !isGrid) {
      results.push(node);
    } else if ("children" in node) {
      // If it's a grid, look inside for the actual cards
      results = results.concat(findMerchantCardsInSelection(node.children));
    }
  }
  return sortNodesByPosition(results);
}

function isMerchantCard(node) {
  if (!node || typeof node.findAll !== "function") return false;
  
  // A card must have these layers as NEAR children, not buried deep in another card
  const hasLogo = node.findAll(n => n.name === "Logo").length > 0;
  const hasHero = node.findAll(n => n.name === "Hero").length > 0;
  
  // If the node's name contains "Grid", don't treat it as a single card
  if (node.name.toLowerCase().includes("grid")) return false;

  return hasLogo && hasHero;
}

async function populateCard(card, data, fallbackName) {
    // Search strictly within THIS card
    const logoNode = card.findAll(n => n.name === "Logo")[0];
    const heroNode = card.findAll(n => n.name === "Hero")[0];
    
    // Find the text layer
    const nameTextNode = card.findAll(n => 
      n.type === "TEXT" && 
      (n.name.toLowerCase().includes("name") || n.name === "Merchant name")
    )[0] || card.findAll(n => n.type === "TEXT" && n.name !== "Logo" && n.name !== "Hero")[0];

    if (nameTextNode) {
        await loadAllFontsForTextNode(nameTextNode);
        nameTextNode.characters = data.name || fallbackName;
    }
    
    if (logoNode && data.logoUrl) await setNodeImageFill(logoNode, data.logoUrl);
    if (heroNode && data.heroUrl) await setNodeImageFill(heroNode, data.heroUrl);
}

async function createMerchantCard(data, fallbackName, index) {
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

  const hero = figma.createRectangle();
  hero.name = "Hero";
  hero.resize(200, 200);
  hero.layoutAlign = "STRETCH";
  if (data.heroUrl) await setNodeImageFill(hero, data.heroUrl);
  frame.appendChild(hero);

  const logo = figma.createRectangle();
  logo.name = "Logo";
  logo.resize(50, 50);
  if (data.logoUrl) await setNodeImageFill(logo, data.logoUrl);
  frame.appendChild(logo);

  const text = figma.createText();
  text.name = "Merchant name";
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  text.characters = data.name || fallbackName;
  frame.appendChild(text);

  return frame;
}

function sortNodesByPosition(nodes) {
  return nodes.sort((a, b) => {
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
    const bytes = await fetch(imageUrl).then(res => res.arrayBuffer());
    const image = figma.createImage(new Uint8Array(bytes));
    node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  } catch (e) { console.error("Fill Error:", e); }
}