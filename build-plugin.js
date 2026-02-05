#!/usr/bin/env node
/**
 * build-plugin.js
 *
 * Usage:
 *   node build-plugin.js          # one-time build
 *   node build-plugin.js --watch  # rebuild on changes
 */

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const isWatch = process.argv.includes("--watch");

// Define ROOT/DIST first (fixes your ReferenceError)
const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, "dist");

// Inputs
const CODE_ENTRY = path.join(ROOT, "plugin", "code.ts");
const UI_ENTRY = path.join(ROOT, "plugin", "ui.tsx");
const MANIFEST_IN = path.join(ROOT, "plugin", "manifest.json");

// Outputs
const CODE_OUT = path.join(DIST_DIR, "code.js");
const UI_OUT = path.join(DIST_DIR, "ui.js");
const UI_HTML_OUT = path.join(DIST_DIR, "ui.html");
const MANIFEST_OUT = path.join(DIST_DIR, "manifest.json");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyManifest() {
  if (!fs.existsSync(MANIFEST_IN)) {
    throw new Error(`Missing manifest at: ${MANIFEST_IN}`);
  }
  fs.copyFileSync(MANIFEST_IN, MANIFEST_OUT);
}

function writeUiHtml() {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Merchant Autofill</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; }
      #root { height: 100%; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="ui.js"></script>
  </body>
</html>
`;
  fs.writeFileSync(UI_HTML_OUT, html, "utf8");
}

const shared = {
  bundle: true,
  platform: "browser",
  format: "iife",
  sourcemap: true,
  logLevel: "info",

  // Important: downlevel modern syntax (?. and ??) for Figma plugin runtime
  target: ["es2017"],
};

const codeBuild = {
  ...shared,
  entryPoints: [CODE_ENTRY],
  outfile: CODE_OUT,
};

const uiBuild = {
  ...shared,
  entryPoints: [UI_ENTRY],
  outfile: UI_OUT,
};

function prepareDist() {
  ensureDir(DIST_DIR);
  copyManifest();
  writeUiHtml();
}

async function buildOnce() {
  prepareDist();
  await Promise.all([esbuild.build(codeBuild), esbuild.build(uiBuild)]);
  console.log("✅ Build complete");
}

async function watch() {
  prepareDist();

  const codeCtx = await esbuild.context(codeBuild);
  const uiCtx = await esbuild.context(uiBuild);

  await Promise.all([codeCtx.watch(), uiCtx.watch()]);
  console.log("✅ Watching for changes... (Ctrl+C to stop)");
}

(async function main() {
  if (isWatch) await watch();
  else await buildOnce();
})().catch((err) => {
  console.error("❌ Build failed");
  console.error(err);
  process.exit(1);
});
