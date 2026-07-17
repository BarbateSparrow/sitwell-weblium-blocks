# sitwell-weblium-blocks

Custom HTML/CSS/JS blocks embedded in the Weblium-hosted
[sitwell.com.ua](https://sitwell.com.ua) site. Weblium is a closed no-code
builder — we can only inject code through its **Custom Code** blocks — so this
repo produces standalone snippets, not a deployed app. No bundler, no framework,
no runtime dependencies.

## Repo layout

```
blocks/
  <block-name>/
    src/                 # source files edited by developers
      template.html      # HTML shell with {{STYLES}}, {{CONFIG_JSON}}, {{SCRIPT}} placeholders
      styles.css
      script.js
    config.json          # non-secret block config (map style, order keys, defaults)
    dist/                # generated, git-ignored
      index.html         # single-file reference (do NOT paste into Weblium)
      weblium.html       # paste into Weblium Custom Code -> HTML tab
      weblium.css        # paste into Weblium Custom Code -> CSS  tab
      weblium.js         # paste into Weblium Custom Code -> JS   tab
    README.md            # where this block lives on the site, notes
scripts/build.js         # zero-dependency Node build script
dev-server/              # local sandbox loading src/ files directly
  index.html             # slipmat-generator preview
  order.html             # slipmat-order preview
  local-config.example.js
workers/
  slipmat-order/         # Cloudflare Worker: receives orders (see its README)
.githooks/pre-commit     # secret-scan guard
.env.example             # copy to .env, fill in MAPBOX_TOKEN
```

## Setup

```bash
cp .env.example .env                                   # paste your Mapbox token
cp dev-server/local-config.example.js dev-server/local-config.js
# then edit both with real values (both are git-ignored)

git config core.hooksPath .githooks                    # enable the secret-scan pre-commit hook
```

## Develop

```bash
npm run dev                    # serves the repo at http://localhost:5173/
# slipmat-generator: http://localhost:5173/dev-server/
# slipmat-order:     http://localhost:5173/dev-server/order.html
```

Edit files under `blocks/<name>/src/` and refresh the browser. No build step is
needed for local development — the dev-server pages load the source files
directly.

## Build for Weblium

```bash
npm run build                  # builds all blocks
npm run build:slipmat          # builds just slipmat-generator
npm run build:order            # builds just slipmat-order
```

Weblium's **Custom Code** block has three separate tabs — HTML, CSS/LESS, and
JS — not a single monolithic HTML input. Pasting a self-contained HTML file
(with inline `<style>` and `<script>`) into the HTML tab causes Weblium to
mangle the code on save, so the build emits three files per block:

| File                               | Weblium tab         |
| ---------------------------------- | ------------------- |
| `blocks/<name>/dist/weblium.html`  | Code snippet / HTML |
| `blocks/<name>/dist/weblium.css`   | CSS / LESS          |
| `blocks/<name>/dist/weblium.js`    | JS                  |

Workflow: run the build, open the block in the Weblium editor, paste each file
into its matching tab, Save, then Publish.

`blocks/<name>/dist/index.html` is also generated but is only a reference view
of the fully-composed output; **do not paste it into Weblium.**

## Blocks

| Name | Purpose | Weblium page |
| ---- | ------- | ------------ |
| [slipmat-generator](./blocks/slipmat-generator/) | Mapbox generator → downloadable print-ready PDF | https://sitwell.com.ua/slipmats#services |
| [slipmat-order](./blocks/slipmat-order/) | Order variant: generates the PDF and sends it to a Worker (the customer never downloads it) | https://sitwell.com.ua/slipmats-with-custom-map *(not yet published)* |

## Order backend

`slipmat-order` POSTs each order (form fields + the generated PDF) to a
Cloudflare Worker in [`workers/slipmat-order/`](./workers/slipmat-order/), which
verifies it (Turnstile + honeypot) and notifies the shop via **Telegram** and
**email (Resend)** with the PDF attached. Setup, secrets, and deploy steps live
in that worker's README.

> **Note:** Weblium's native Store cart cannot be driven from custom code (no
> add-to-cart JS API, no checkout prefill), so ordering goes directly to the
> Worker rather than through a Weblium cart.

## Secrets

`.env`, `dev-server/local-config.js`, and `workers/*/.dev.vars` hold live tokens
and are git-ignored — never commit them. Worker secrets are set with
`wrangler secret put`. The `.githooks/pre-commit` hook (enable once with
`git config core.hooksPath .githooks`) blocks any commit that introduces a
token or private key.
```
