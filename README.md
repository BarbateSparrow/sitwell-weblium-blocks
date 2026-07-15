# sitwell-weblium-blocks

Custom HTML/CSS/JS blocks embedded in the Weblium-hosted
[sitwell.com.ua](https://sitwell.com.ua) site.

## Repo layout

```
blocks/
  <block-name>/
    src/                 # source files edited by developers
      template.html      # HTML shell with {{STYLES}}, {{CONFIG_JSON}}, {{SCRIPT}} placeholders
      styles.css
      script.js
    config.json          # non-secret block config (map style, defaults)
    dist/                # generated, git-ignored
      index.html         # legacy single-file reference (do not paste into Weblium)
      weblium.html       # paste into Weblium Custom Code -> HTML tab
      weblium.css        # paste into Weblium Custom Code -> CSS  tab
      weblium.js         # paste into Weblium Custom Code -> JS   tab
    README.md            # where this block lives on the site, screenshots, notes
scripts/
  build.js               # zero-dependency Node build script
dev-server/
  index.html             # local sandbox loading src/ files directly
  local-config.example.js
.env.example             # copy to .env, fill in MAPBOX_TOKEN
```

## Setup

```bash
cp .env.example .env                                  # paste your Mapbox token
cp dev-server/local-config.example.js dev-server/local-config.js
# then edit local-config.js and .env with real values
```

## Develop

```bash
npm run dev                    # serves the repo at http://localhost:5173/
# open http://localhost:5173/dev-server/
```

Edit files under `blocks/<name>/src/` and refresh the browser. No build step
is needed for local development — the dev-server page loads the source files
directly.

## Build for Weblium

```bash
npm run build                  # builds all blocks
npm run build:slipmat          # builds just slipmat-generator
```

Weblium's **Custom Code** block has three separate tabs — HTML, CSS/LESS, and
JS — not a single monolithic HTML input. Pasting a self-contained HTML file
(with inline `<style>` and `<script>`) into the HTML tab causes Weblium to
mangle the code on save, so the build emits three files per block:

| File                                  | Weblium tab              |
| ------------------------------------- | ------------------------ |
| `blocks/<name>/dist/weblium.html`     | Code snippet / HTML      |
| `blocks/<name>/dist/weblium.css`      | CSS / LESS               |
| `blocks/<name>/dist/weblium.js`       | JS                       |

Workflow: run the build, open the block in the Weblium editor, paste each
file into its matching tab, Save, then Publish.

`blocks/<name>/dist/index.html` is also generated but is only kept as a
reference view of the fully-composed output; do not paste it into Weblium.

## Blocks

| Name                                              | Purpose                                                 | Weblium page                                    |
| ------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| [slipmat-generator](./blocks/slipmat-generator/)  | Mapbox-based generator that produces a print-ready map  | https://sitwell.com.ua/slipmats#services        |
