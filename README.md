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
    dist/
      index.html         # built file to paste into Weblium's "Embed code" block
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

Then open `blocks/<name>/dist/index.html`, copy its full contents, and paste
into the corresponding Weblium **Embed code** block.

## Blocks

| Name                                              | Purpose                                                 | Weblium page                                    |
| ------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| [slipmat-generator](./blocks/slipmat-generator/)  | Mapbox-based generator that produces a print-ready map  | https://sitwell.com.ua/slipmats#services        |
