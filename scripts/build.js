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

  const output = template
    .replace('{{STYLES}}', styles)
    .replace('{{CONFIG_JSON}}', JSON.stringify(runtimeConfig))
    .replace('{{SCRIPT}}', script);

  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  const outPath = path.join(distDir, 'index.html');
  fs.writeFileSync(outPath, output);

  const sizeKb = (output.length / 1024).toFixed(1);
  console.log(`✓ ${blockName} → ${path.relative(ROOT, outPath)}  (${sizeKb} KB)`);
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
