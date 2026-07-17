// Copy this file to dev-server/local-config.js (which is git-ignored)
// and fill in real values.
//
// NEVER commit local-config.js — it contains a live Mapbox token.
// This example file is safe to commit because it has only placeholders.

window.SLIPMAT_CONFIG = {
  MAPBOX_TOKEN: 'pk.YOUR_MAPBOX_TOKEN_HERE',
  MAPBOX_STYLE_GL: 'mapbox://styles/sitwell/clit05fs0004101pn3jv5g4jt',
  MAPBOX_STYLE_STATIC: 'sitwell/clit05fs0004101pn3jv5g4jt',
  START_CENTER: [30.5234, 50.4501],
  START_ZOOM: 12,

  // slipmat-order block only (non-secret):
  // Leave ORDER_ENDPOINT empty to run submit in DRY-RUN (no POST, logs to console).
  // Point it at a local Worker (`wrangler dev`) e.g. 'http://localhost:8787' to test end-to-end.
  ORDER_ENDPOINT: '',
  TURNSTILE_SITE_KEY: '', // empty in dev → the anti-spam widget is skipped
  PRICE_UAH: 1000,
};
