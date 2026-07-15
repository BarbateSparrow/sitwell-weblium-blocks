# slipmat-generator

Interactive Mapbox-based generator for round vinyl slipmat prints.
Embedded on https://sitwell.com.ua/slipmats#services (Weblium "Embed code" block).

## What it does now (current dist)

- 80/20 split layout: interactive `mapbox-gl` map on the left, side column on the right.
- Side column shows a live round preview (via Mapbox Static Images API, mirrors
  the interactive map including bearing/pitch), a geocoder search field, and a
  "Згенерувати макет" button.
- On generate, downloads a **print-ready PDF**:
  - 310 × 310 mm, includes bleed
  - Circular map area, transparent background outside the circle (saves ink)
  - 5 mm centered pin-hole (transparent) with a hairline circle + 1 mm cross
    marker for the printer's alignment
  - Map raster inside is stitched from 4 Mapbox Static tiles (2560×2560 each →
    5120×5120 composite → downscaled to 3661×3661 ≈ 300 DPI on 310 mm)
  - Bearing and pitch are forced to 0 during tile generation to keep the stitch
    seamless; the interactive map on screen keeps its rotation/tilt.
- Filename is transliterated from the last searched location or reverse-geocoded
  from the current center: e.g. `slipmat-map-kyiv.pdf`.

## Runtime error handling

- Any single tile fetch is retried once after 500 ms on failure.
- If any step in the pipeline throws, the button is re-enabled and an alert is
  shown; details are logged to the console under the `[slipmat]` prefix.

## Config

Non-secret values live in [`config.json`](./config.json):

| Key                     | Meaning                                         |
| ----------------------- | ----------------------------------------------- |
| `mapbox_style_gl`       | Style URL used by the interactive `mapbox-gl` map |
| `mapbox_style_static`   | Style ID used by the Static Images API          |
| `start_center`          | `[lng, lat]` of the initial map view (Kyiv)     |
| `start_zoom`            | Initial zoom                                    |

`MAPBOX_TOKEN` is read from the repo-level `.env` at build time and injected
as `window.SLIPMAT_CONFIG.MAPBOX_TOKEN` in the built `dist/index.html`.

## Runtime config contract

The script reads `window.SLIPMAT_CONFIG` and expects:

```js
{
  MAPBOX_TOKEN: 'pk...',
  MAPBOX_STYLE_GL: 'mapbox://styles/...',
  MAPBOX_STYLE_STATIC: 'user/styleid',
  START_CENTER: [30.5234, 50.4501],
  START_ZOOM: 12
}
```

If `MAPBOX_TOKEN` or either style is missing, the script logs to console and
returns without rendering anything.

## Roadmap

### Stage 2 — order flow (TODO)

- Order form (name, contact, quantity, comment) attached to the generated PDF.
- Submit PDF + form fields to email / a form endpoint.
- Thank-you state, validation, error handling.
- Optionally, TIFF export (either server-side conversion, or a heavier client
  bundle like UTIF.js if printer requires TIFF specifically).
