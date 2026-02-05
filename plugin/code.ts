figma.showUI(__html__, { width: 360, height: 520 });

type LookupResult = {
  query: string;
  name: string | null;
  logoProxy: string | null;
  heroProxy: string | null;
  error?: string;
};

async function postLookup(queries: string[]): Promise<LookupResult[]> {
  const resp = await fetch("http://localhost:8787/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Local server error (${resp.status}): ${txt}`);
  }

  const json = await resp.json();
  return (json.results || []) as LookupResult[];
}

function findAllCards(grid: SceneNode): SceneNode[] {
  if (!("findAll" in grid)) return [];
  // find frames/groups/instances named "Merchant Card"
  return (grid as any).findAll((n: SceneNode) => n.name === "Merchant Card") as SceneNode[];
}

function findOneByName(root: SceneNode, name: string): SceneNode | null {
  if (!("findOne" in root)) return null;
  return (root as any).findOne((n: SceneNode) => n.name === name) as SceneNode | null;
}

async function setText(node: SceneNode, value: string) {
  if (node.type !== "TEXT") return;
  await figma.loadFontAsync(node.fontName as FontName);
  node.characters = value;
}

async function setImageFill(node: SceneNode, imageUrl: string) {
  // We expect your targets ("image 161", "image 162") to be rectangles
  // If they’re not, we’ll try to find a rectangle inside.
  let target: SceneNode | null = node;

  if (
    (node.type === "FRAME" || node.type === "INSTANCE" || node.type === "COMPONENT") &&
    "findOne" in node
  ) {
    const rect = (node as any).findOne((n: SceneNode) => n.type === "RECTANGLE") as SceneNode | null;
    if (rect) target = rect;
  }

  if (!target || target.type !== "RECTANGLE") return;

  const img = await figma.createImageAsync(imageUrl);
  const paint: ImagePaint = { type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" };

  const fills = Array.isArray(target.fills) ? target.fills.slice() : [];
  if (fills.length === 0) fills.push(paint);
  else fills[0] = paint;

  target.fills = fills;
}

async function populateGrid(results: LookupResult[]) {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) throw new Error("Select exactly one layer: Merchant Grid.");
  const grid = sel[0];

  const cards = findAllCards(grid);
  if (cards.length === 0) throw new Error('No "Merchant Card" layers found under the selection.');

  const count = Math.min(cards.length, results.length);

  for (let i = 0; i < count; i++) {
    const card = cards[i];
    const r = results[i];
    if (r.error) continue;

    // Text: Content > Merchant name
    const content = findOneByName(card, "Content");
    const nameNode = content ? findOneByName(content, "Merchant name") : findOneByName(card, "Merchant name");
    if (nameNode) await setText(nameNode, r.name || r.query);

    // Logo: Merchant Logos > image 162
    if (r.logoProxy) {
      const logos = findOneByName(card, "Merchant Logos");
      const logoTarget = logos ? findOneByName(logos, "image 162") : findOneByName(card, "image 162");
      if (logoTarget) await setImageFill(logoTarget, r.logoProxy);
    }

    // Hero: image 161
    if (r.heroProxy) {
      const heroTarget = findOneByName(card, "image 161");
      if (heroTarget) await setImageFill(heroTarget, r.heroProxy);
    }
  }

  figma.notify(`Populated ${count} cards.`);
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "POPULATE") {
    try {
      const queries = (msg.queries || []) as string[];
      const results = await postLookup(queries);
      await populateGrid(results);
      figma.ui.postMessage({ type: "DONE", results });
    } catch (err: any) {
      figma.ui.postMessage({ type: "ERROR", error: String(err?.message || err) });
      figma.notify(`Error: ${String(err?.message || err)}`);
    }
  }
};
