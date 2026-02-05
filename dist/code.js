(() => {
  // plugin/code.ts
  figma.showUI(__html__, { width: 360, height: 320 });
  var LOOKUP_ENDPOINT = "http://localhost:8787/lookup?name=";
  async function fetchLookup(name) {
    const url = `${LOOKUP_ENDPOINT}${encodeURIComponent(name)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Lookup failed (${response.status}) for ${name}`);
    }
    return await response.json();
  }
  function parseMerchantNames(input) {
    return input.split(",").map((value) => value.trim()).filter(Boolean);
  }
  function getMerchantCards(parent) {
    if (!("children" in parent)) return [];
    return parent.children.filter((child) => child.name === "Merchant Card");
  }
  function findFirstByName(root, name) {
    if ("findOne" in root) {
      return root.findOne((node) => node.name === name);
    }
    return null;
  }
  function resolveCardNodes(card) {
    const nameNode = findFirstByName(card, "Merchant name");
    const logoNode = findFirstByName(card, "image 162");
    const heroNode = findFirstByName(card, "image 161");
    return {
      nameNode: (nameNode == null ? void 0 : nameNode.type) === "TEXT" ? nameNode : null,
      logoNode,
      heroNode
    };
  }
  async function setText(node, value) {
    await figma.loadFontAsync(node.fontName);
    node.characters = value;
  }
  function supportsFills(node) {
    return "fills" in node;
  }
  async function loadImageBytes(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Image fetch failed (${response.status})`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
  async function setImageFill(node, url) {
    if (!supportsFills(node)) {
      console.warn(`Node ${node.name} does not support fills.`);
      return;
    }
    const fills = Array.isArray(node.fills) ? [...node.fills] : [];
    if (fills.length === 0) {
      console.warn(`Node ${node.name} has no fills; skipping image update.`);
      return;
    }
    const bytes = await loadImageBytes(url);
    const image = figma.createImage(bytes);
    const imagePaint = {
      type: "IMAGE",
      imageHash: image.hash,
      scaleMode: "FILL"
    };
    let replaced = false;
    for (let i = 0; i < fills.length; i++) {
      if (fills[i].type === "IMAGE" || fills[i].type === "SOLID") {
        fills[i] = imagePaint;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      fills[0] = imagePaint;
    }
    node.fills = fills;
  }
  async function populateCards(parent, merchants) {
    const cards = getMerchantCards(parent);
    if (cards.length === 0) {
      figma.notify('No "Merchant Card" children found in the selection.');
      return;
    }
    const count = Math.min(cards.length, merchants.length);
    console.log(`Populating ${count} cards...`);
    for (let index = 0; index < count; index += 1) {
      const card = cards[index];
      const merchant = merchants[index];
      const { nameNode, logoNode, heroNode } = resolveCardNodes(card);
      if (nameNode) {
        await setText(nameNode, merchant.name || "");
      } else {
        console.warn(`Missing Merchant name node on card ${index + 1}`);
      }
      if (logoNode && merchant.logoUrl) {
        try {
          await setImageFill(logoNode, merchant.logoUrl);
        } catch (error) {
          console.warn(`Logo image failed for ${merchant.name}:`, error);
        }
      }
      if (heroNode && merchant.heroUrl) {
        try {
          await setImageFill(heroNode, merchant.heroUrl);
        } catch (error) {
          console.warn(`Hero image failed for ${merchant.name}:`, error);
        }
      }
    }
    figma.notify(`Done: filled ${count} cards`);
  }
  figma.ui.onmessage = async (msg) => {
    if ((msg == null ? void 0 : msg.type) !== "RUN_MERCHANT_AUTOFILL") return;
    const payload = typeof msg.payload === "string" ? msg.payload : "";
    const names = parseMerchantNames(payload);
    if (names.length === 0) {
      figma.notify("Please enter at least one merchant name.");
      return;
    }
    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
      figma.notify("Select exactly one layer: Merchant Grid.");
      return;
    }
    const parent = selection[0];
    if (parent.type !== "FRAME" && parent.type !== "GROUP" && parent.type !== "COMPONENT") {
      figma.notify("Selection must be a frame containing Merchant Cards.");
      return;
    }
    figma.notify(`Looking up ${names.length} merchants...`);
    try {
      const merchants = [];
      for (const name of names) {
        try {
          const result = await fetchLookup(name);
          merchants.push(result);
        } catch (error) {
          console.warn(`Lookup failed for ${name}:`, error);
          merchants.push({ name, logoUrl: null, heroUrl: null });
        }
      }
      await populateCards(parent, merchants);
    } catch (error) {
      console.warn("Unexpected error:", error);
      figma.notify("Something went wrong while filling cards.");
    } finally {
      figma.closePlugin();
    }
  };
})();
//# sourceMappingURL=code.js.map
