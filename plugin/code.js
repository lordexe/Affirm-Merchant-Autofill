// plugin/code.js
figma.showUI(__html__, { width: 360, height: 400 }); // Increased height for status log

figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "RUN") {
    const serverBase = (msg.serverBase || "http://localhost:8787").replace(/\/$/, "");
    const merchantNames = Array.isArray(msg.merchants)
      ? msg.merchants.map((s) => String(s).trim()).filter(Boolean)
      : [];

    if (merchantNames.length === 0) {
      figma.notify("Enter at least one merchant name.");
      return;
    }

    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
      figma.notify("Select exactly one layer: the Merchant Grid frame/group.");
      return;
    }

    const grid = selection[0];
    if (!grid || typeof grid.findAll !== "function") {
      figma.notify("Selection must be a frame/group/component with children.");
      return;
    }

    // ✅ Find REAL merchant cards
    const cards = findMerchantCards(grid);

    if (cards.length === 0) {
      figma.notify('No cards found. I looked for nodes containing "Logo", "Hero", and "Merchant name".');
      return;
    }

    figma.notify(`Found ${cards.length} card(s). Starting...`);

    // Process sequentially (One by one)
    const count = Math.min(cards.length, merchantNames.length);

    for (let i = 0; i < count; i++) {
      const merchantName = merchantNames[i];
      const card = cards[i];

      // 1. Tell UI we are fetching
      figma.ui.postMessage({ type: "STATUS", name: merchantName, status: "Fetching..." });

      try {
        // Fetch
        const url = `${serverBase}/lookup?name=${encodeURIComponent(merchantName)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // 2. Tell UI we are populating
        figma.ui.postMessage({ type: "STATUS", name: merchantName, status: "Populating..." });

        // Populate logic
        const logoNode = findFirstByName(card, "Logo");
        const heroNode = findFirstByName(card, "Hero");
        const nameTextNode = findFirstByNameCI(card, "Merchant name");

        // Set Text
        if (nameTextNode && nameTextNode.type === "TEXT") {
          const nextName = data.name || merchantName;
          await loadAllFontsForTextNode(nameTextNode);
          nameTextNode.characters = nextName;
        }

        // Set Logo
        if (logoNode && data.logoUrl) {
          await setNodeImageFill(logoNode, data.logoUrl);
        }

        // Set Hero
        if (heroNode && data.heroUrl) {
          await setNodeImageFill(heroNode, data.heroUrl);
        }

        // 3. Success
        figma.ui.postMessage({ type: "STATUS", name: merchantName, status: "✅ Done" });

      } catch (e) {
        console.error("Fetch failed:", e);
        // 4. Error
        figma.ui.postMessage({ type: "STATUS", name: merchantName, status: `❌ Error: ${e.message}` });
      }
    }

    figma.notify("Batch complete.");
    return;
  }

  if (msg.type === "CLOSE") {
    figma.closePlugin();
  }
};

// -------- helpers (same as before) --------

function findMerchantCards(root) {
  const candidates = root.findAll((n) => {
    if (typeof n.findAll !== "function") return false;
    const hasLogo = n.findAll((x) => x.name === "Logo").length > 0;
    const hasHero = n.findAll((x) => x.name === "Hero").length > 0;
    const hasMerchantNameText = n.findAll(
        (x) => x.type === "TEXT" && typeof x.name === "string" && x.name.toLowerCase() === "merchant name"
      ).length > 0;
    return hasLogo && hasHero && hasMerchantNameText;
  });

  const cards = candidates.filter((node) => {
    return !candidates.some((other) => other !== node && isDescendant(other, node));
  });

  cards.sort((a, b) => {
    const ay = a.absoluteTransform[1][2];
    const by = b.absoluteTransform[1][2];
    if (Math.abs(ay - by) > 1) return ay - by;
    const ax = a.absoluteTransform[0][2];
    const bx = b.absoluteTransform[0][2];
    return ax - bx;
  });

  return cards;
}

function isDescendant(node, ancestor) {
  let p = node.parent;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

function findFirstByName(root, name) {
  if (!root || typeof root.findAll !== "function") return null;
  const found = root.findAll((n) => n.name === name);
  return found && found.length ? found[0] : null;
}

function findFirstByNameCI(root, name) {
  if (!root || typeof root.findAll !== "function") return null;
  const target = String(name || "").toLowerCase();
  const found = root.findAll((n) => String(n.name || "").toLowerCase() === target);
  return found && found.length ? found[0] : null;
}

async function loadAllFontsForTextNode(textNode) {
  if (!textNode || textNode.type !== "TEXT") return;
  if (textNode.fontName !== figma.mixed) {
    await figma.loadFontAsync(textNode.fontName);
    return;
  }
  const len = textNode.characters.length;
  const seen = new Set();
  for (let i = 0; i < len; i++) {
    const font = textNode.getRangeFontName(i, i + 1);
    const key = `${font.family}::${font.style}`;
    if (!seen.has(key)) {
      seen.add(key);
      await figma.loadFontAsync(font);
    }
  }
}

async function setNodeImageFill(node, imageUrl) {
  if (!node || !("fills" in node)) return;
  const bytes = await fetchImageBytes(imageUrl);
  const image = figma.createImage(bytes);
  const newFill = {
    type: "IMAGE",
    imageHash: image.hash,
    scaleMode: "FILL",
  };
  const currentFills = Array.isArray(node.fills) ? node.fills : [];
  const nextFills = currentFills.filter((p) => p.type !== "IMAGE").concat([newFill]);
  node.fills = nextFills;
}

async function fetchImageBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  return new Uint8Array(arrayBuf);
}