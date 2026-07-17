# slipmat-order

Stage 2 order variant of [`slipmat-generator`](../slipmat-generator/). Live on
https://sitwell.com.ua/slipmats-with-custom-map (Weblium Custom Code block).

Reuses the Stage 1 print geometry, tile stitching and PDF pipeline, but instead
of `pdf.save()` (customer download) it builds a **Blob** and POSTs it — together
with the order fields — to a Cloudflare Worker. **The customer never downloads
the file**; a manager receives it and handles payment.

## What it does now (current dist)

- Dark Sitwell theme (red accent `#eb4025`), two sections:
  - **Map banner** — full-width 3:1 interactive `mapbox-gl` map with an 8 px
    centered dot marking the print center. A hairline frame sets it off from the
    near-black page.
  - **Order section** — round live preview on the left (mirrors the map area
    that will print; edge highlight + inner vignette lift it off the page),
    price `PRICE_UAH × qty` below it; the form on the right.
- **"Назва міста" is a geocoder** (in the form) that names the order and flies
  the map. The customer then fine-tunes the framing by panning/zooming the map —
  the **PDF is the source of truth** for what actually prints.
- **Delivery** is a separate Nova Poshta pair: city autocomplete → warehouse /
  poshtomat combobox. Both are proxied through the Worker so the NP key stays
  server-side. If the NP proxy is unavailable the block shows a notice and
  delivery becomes optional (the Worker only requires name + phone).
- Quantity stepper (−/+), a "Деякі побажання" toggle that reveals a comment
  textarea (sent as `comment`), Turnstile (`appearance: 'interaction-only'`) and
  a honeypot field for spam protection.
- On submit: validates, generates the print-ready PDF (same 310 × 310 mm
  geometry as slipmat-generator — see that block's README), POSTs
  `multipart/form-data` to the Worker, then shows an inline thank-you that
  auto-restores the form after ~7 s. Phone validation accepts UA forms only:
  `0XXXXXXXXX` (10 digits) or `380XXXXXXXXX` (12 digits).
- **DRY-RUN:** when `order_endpoint` is empty the submit only logs to the console
  (no POST) — handy for local development.

## Config

Non-secret values live in [`config.json`](./config.json):

| Key                   | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `mapbox_style_gl`     | Style URL used by the interactive `mapbox-gl` map          |
| `mapbox_style_static` | Style ID used by the Static Images API (PDF tiles)         |
| `start_center`        | `[lng, lat]` of the initial map view (Kyiv)                |
| `start_zoom`          | Initial zoom                                               |
| `price_uah`           | Unit price in UAH (× quantity for the displayed total)     |
| `order_endpoint`      | Worker URL; empty ⇒ DRY-RUN (no POST)                      |
| `turnstile_site_key`  | **Public** Turnstile site key (must pair with the Worker's `TURNSTILE_SECRET` — same widget) |

`MAPBOX_TOKEN` is read from the repo-level `.env` at build time and injected as
`window.SLIPMAT_CONFIG.MAPBOX_TOKEN` into the built `dist/weblium.js`. It is
never committed (that is why `dist/` is git-ignored).

## Runtime config contract

The script reads `window.SLIPMAT_CONFIG` and expects:

```js
{
  MAPBOX_TOKEN: 'pk...',
  MAPBOX_STYLE_GL: 'mapbox://styles/...',
  MAPBOX_STYLE_STATIC: 'user/styleid',
  START_CENTER: [30.5234, 50.4501],
  START_ZOOM: 12,
  PRICE_UAH: 1000,
  ORDER_ENDPOINT: 'https://slipmat-order.sitwell.workers.dev',
  TURNSTILE_SITE_KEY: '0x...'
}
```

Missing map token/style ⇒ the script logs and returns without rendering. Empty
`ORDER_ENDPOINT` ⇒ DRY-RUN (see above).

## Backend

The order endpoint is a Cloudflare Worker in
[`workers/slipmat-order/`](../../workers/slipmat-order/). It verifies Turnstile +
honeypot, then notifies via **Telegram `sendDocument`** and **Resend email**,
both with the PDF attached, and proxies the Nova Poshta city/warehouse lookups.
Deploy, secrets and the endpoint contract are documented in that folder's
README.

## Publishing to Weblium

The Weblium **Custom Code** block has three tabs. After `npm run build:order`,
paste each generated file into its matching tab:

- `dist/weblium.html` → **HTML**
- `dist/weblium.css`  → **CSS**
- `dist/weblium.js`   → **JS**

Save, then Publish. `dist/index.html` is a single-file reference only — never
paste it (Weblium mangles inline `<style>`/`<script>`). After a code change,
rebuild and re-paste **only the tabs that changed** — the build prints each
file's size so you can tell which moved.

> Weblium's CSS tab prefixes every selector with the embed scope, so `:root`
> custom properties silently vanish. This block keeps its CSS variables on the
> `.so-wrap` element instead — do not move them to `:root`.
