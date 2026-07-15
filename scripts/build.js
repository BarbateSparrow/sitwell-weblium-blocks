#!/usr/bin/env node
/**
 * Build script for Weblium HTML blocks.
 *
 * Usage:
 *   node scripts/build.js                  # build all blocks
 *   node scripts/build.js slipmat-generator
 *
 * For each block, reads:
 *   blocks/<name>/src/template.html
 *   blocks/<name>/src/styles.css
 *   blocks/<name>/src/script.js
 *   blocks/<name>/config.json
 *   .env  (for MAPBOX_TOKEN and other secrets)
 *
 * Writes:
 *   blocks/<name>/dist/index.html
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BLOCKS_DIR = path.join(ROOT, 'blocks');
const ENV_PATH = path.join(ROOT, '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const out = {};
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function buildBlock(blockName, env) {
  const blockDir = path.join(BLOCKS_DIR, blockName);
  const srcDir = path.join(blockDir, 'src');
  const distDir = path.join(blockDir, 'dist');
  const configPath = path.join(blockDir, 'config.json');

  if (!fs.existsSync(srcDir)) {
    console.error(`✗ ${blockName}: no src/ dir`);
    return false;
  }

  const template = fs.readFileSync(path.join(srcDir, 'template.html'), 'utf8');
  const styles = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8');
  const script = fs.readFileSync(path.join(srcDir, 'script.js'), 'utf8');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Compose the runtime config that will be exposed as window.SLIPMAT_CONFIG
  const runtimeConfig = {
    MAPBOX_TOKEN: env.MAPBOX_TOKEN || '',
    MAPBOX_STYLE_GL: config.mapbox_style_gl,
    MAPBOX_STYLE_STATIC: config.mapbox_style_static,
    START_CENTER: config.start_center,
    START_ZOOM: config.start_zoom,
  };

  if (!runtimeConfig.MAPBOX_TOKEN) {
    console.warn(`⚠  ${blockName}: MAPBOX_TOKEN missing in .env — dist will have empty token`);
  }

  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

  // -----------------------------------------------------------------------
  // 1) Legacy monolithic dist/index.html — kept for reference / dev preview.
  //    This is a single self-contained file where template.html placeholders
  //    are filled in. It is NOT what gets pasted into Weblium anymore, but
  //    it is useful for inspecting the fully-composed output in one place.
  // -----------------------------------------------------------------------
  const output = template
    .replace('{{STYLES}}', styles)
    .replace('{{CONFIG_JSON}}', JSON.stringify(runtimeConfig))
    .replace('{{SCRIPT}}', script);

  const indexOutPath = path.join(distDir, 'index.html');
  fs.writeFileSync(indexOutPath, output);

  // -----------------------------------------------------------------------
  // 2) Three-file split for Weblium's Custom Code block, which has three
  //    separate tabs (HTML / CSS / JS). Pasting a monolithic file into the
  //    HTML tab does not work reliably — Weblium's editor mangles inline
  //    <style> and <script> content on save.
  //
  //    Workflow: after `npm run build:slipmat`, open Weblium editor →
  //    Custom Code block → paste each dist/weblium.* file into its matching
  //    tab → Save → Publish.
  // -----------------------------------------------------------------------

  // HTML tab: strip inline <style>...</style> and inline <script> blocks
  // (those without a src attribute). Keep CDN <link> and <script src=...>
  // tags — those must live in the HTML tab so the browser loads them.
  let webliumHtml = template;
  webliumHtml = webliumHtml.replace(/\{\{STYLES\}\}/g, '');
  webliumHtml = webliumHtml.replace(/\{\{CONFIG_JSON\}\}/g, '');
  webliumHtml = webliumHtml.replace(/\{\{SCRIPT\}\}/g, '');
  webliumHtml = webliumHtml.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  webliumHtml = webliumHtml.replace(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '');
  webliumHtml = webliumHtml.replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const htmlOutPath = path.join(distDir, 'weblium.html');
  fs.writeFileSync(htmlOutPath, webliumHtml);

  // CSS tab: raw stylesheet content (no <style> wrapper).
  const cssOutPath = path.join(distDir, 'weblium.css');
  fs.writeFileSync(cssOutPath, styles.trim() + '\n');

  // JS tab: runtime config declaration first, then the script IIFE.
  const configLine = `window.SLIPMAT_CONFIG = ${JSON.stringify(runtimeConfig, null, 2)};\n`;
  const jsOutPath = path.join(distDir, 'weblium.js');
  fs.writeFileSync(jsOutPath, configLine + '\n' + script.trim() + '\n');

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------
  const sizeKb = (p) => (fs.statSync(p).size / 1024).toFixed(1) + ' KB';
  console.log(`✓ ${blockName}:`);
  console.log(
    `    ${path.relative(ROOT, indexOutPath)}   (${sizeKb(indexOutPath)})  — reference, do not paste`
  );
  console.log(
    `    ${path.relative(ROOT, htmlOutPath)}  (${sizeKb(htmlOutPath)})  → Weblium HTML tab`
  );
  console.log(
    `    ${path.relative(ROOT, cssOutPath)}   (${sizeKb(cssOutPath)})  → Weblium CSS tab`
  );
  console.log(`    ${path.relative(ROOT, jsOutPath)}    (${sizeKb(jsOutPath)})  → Weblium JS tab`);
  return true;
}

function main() {
  const arg = process.argv[2];
  const env = loadEnv();

  let blocks;
  if (arg) {
    blocks = [arg];
  } else {
    blocks = fs.readdirSync(BLOCKS_DIR).filter(function (name) {
      return fs.statSync(path.join(BLOCKS_DIR, name)).isDirectory();
    });
  }

  let ok = 0;
  for (const b of blocks) {
    if (buildBlock(b, env)) ok++;
  }
  console.log(`\nBuilt ${ok}/${blocks.length} block(s).`);
}

main();
