/**
 * Slipmat Order
 *
 * Behavior:
 *   - Full-width interactive map (mapbox-gl) with a fixed center dot (CSS) and
 *     an on-map geocoder: picking a place names the order and flies the map
 *     there (customer then fine-tunes the framing).
 *   - Round live preview via Mapbox Static Images API (reflects the live map,
 *     incl. bearing/pitch), zoom-matched to the exported PDF.
 *   - Order form (recipient, phone, Nova Poshta delivery, quantity). On submit
 *     the print-ready PDF is generated in-browser and POSTed to the order Worker
 *     with the fields. The customer never downloads the file.
 *
 * Print target (identical to slipmat-generator Stage 1):
 *   - 310 mm outer diameter (incl. bleed), 5 mm centered pin hole (transparent),
 *     hairline circle + 1 mm cross alignment marker, transparent outside circle.
 *   - Raster stitched from 4 Mapbox Static tiles @ bearing=0, pitch=0,
 *     composited to 5120×5120, downscaled to 3661×3661 (≈300 DPI on 310 mm).
 *
 * Runtime config (window.SLIPMAT_CONFIG, injected by build.js / local-config.js):
 *   MAPBOX_TOKEN, MAPBOX_STYLE_GL, MAPBOX_STYLE_STATIC, START_CENTER, START_ZOOM,
 *   ORDER_ENDPOINT (Cloudflare Worker URL), TURNSTILE_SITE_KEY, PRICE_UAH
 *
 * External deps (loaded via <script> tags in the template):
 *   - mapbox-gl 3.5.x, mapbox-gl-geocoder 5.0.x, jsPDF 2.5.x (UMD), Turnstile
 */

(function () {
  'use strict';

  // ==========================================================================
  //  Config & constants
  // ==========================================================================

  var config = window.SLIPMAT_CONFIG || {};
  var MAPBOX_TOKEN = config.MAPBOX_TOKEN;
  var SITWELL_STYLE_GL = config.MAPBOX_STYLE_GL;
  var SITWELL_STYLE_STATIC = config.MAPBOX_STYLE_STATIC;
  var startCenter = config.START_CENTER || [30.5234, 50.4501];
  var startZoom = typeof config.START_ZOOM === 'number' ? config.START_ZOOM : 12;
  var ORDER_ENDPOINT = config.ORDER_ENDPOINT || '';
  var TURNSTILE_SITE_KEY = config.TURNSTILE_SITE_KEY || '';
  var PRICE_UAH = typeof config.PRICE_UAH === 'number' ? config.PRICE_UAH : 1000;

  // Print geometry
  var TARGET_SIZE_MM = 310; // outer diameter, includes bleed
  var HOLE_DIAMETER_MM = 5; // pin hole
  var DPI = 300;
  var MM_TO_PX = DPI / 25.4;
  var TARGET_SIZE_PX = Math.round(TARGET_SIZE_MM * MM_TO_PX); // ≈ 3661
  var HOLE_RADIUS_PX = (HOLE_DIAMETER_MM / 2) * MM_TO_PX; // ≈ 29.5

  // Static Images API tile geometry (Mapbox uses a 512-logical-px world at zoom 0)
  var TILE_LOGICAL_SIZE = 1280; // logical px per tile side (matches @1280x1280)
  var TILE_PHYSICAL_SIZE = 2560; // physical px per tile side (@2x)
  var TILE_HALF = TILE_LOGICAL_SIZE / 2; // 640 — center offset for stitching
  var COMPOSITE_SIZE = TILE_PHYSICAL_SIZE * 2; // 5120

  // Preview geometry — see slipmat-generator for the derivation.
  var PREVIEW_SIZE = 600; // logical px per preview side
  var PREVIEW_ZOOM_OFFSET = Math.log2((TILE_LOGICAL_SIZE * 2) / PREVIEW_SIZE); // ≈ 2.0931

  // Boost the print/preview zoom relative to the interactive map. Set equal to
  // PREVIEW_ZOOM_OFFSET so that previewZoom === mapZoom — the preview (and the
  // printed slipmat) show exactly the map's current zoom: same scale on the map
  // and on the print.
  var PRINT_ZOOM_BOOST = PREVIEW_ZOOM_OFFSET;

  // Web Mercator (EPSG:3857)
  var EARTH_CIRCUMFERENCE = 40075016.686;
  var EARTH_RADIUS = 6378137;

  // ==========================================================================
  //  Sanity checks
  // ==========================================================================

  if (!window.mapboxgl) {
    console.error('[slipmat-order] mapbox-gl not loaded');
    return;
  }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    console.error('[slipmat-order] jsPDF not loaded');
    return;
  }
  if (!MAPBOX_TOKEN || !SITWELL_STYLE_GL || !SITWELL_STYLE_STATIC) {
    console.error(
      '[slipmat-order] missing SLIPMAT_CONFIG: MAPBOX_TOKEN / MAPBOX_STYLE_GL / MAPBOX_STYLE_STATIC'
    );
    return;
  }
  if (!ORDER_ENDPOINT) {
    console.warn('[slipmat-order] ORDER_ENDPOINT is empty — submit runs in DRY-RUN mode (no POST)');
  }

  mapboxgl.accessToken = MAPBOX_TOKEN;

  // ==========================================================================
  //  Map & on-map geocoder
  // ==========================================================================

  // The geocoder lives on the map. Selecting a result records the place name
  // (for the order) and flies the map there. The customer can then pan/zoom to
  // fine-tune the framing — the PDF is the source of truth for print.
  var currentLocation = '';

  var map = new mapboxgl.Map({
    container: 'so-map',
    style: SITWELL_STYLE_GL,
    center: startCenter,
    zoom: startZoom,
    preserveDrawingBuffer: true,
    attributionControl: false,
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');
  map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

  var geocoder = new MapboxGeocoder({
    accessToken: MAPBOX_TOKEN,
    mapboxgl: mapboxgl,
    marker: false,
    flyTo: false, // we fly manually below, with a print-friendly zoom
    language: 'uk',
    types: 'place,locality,region,district,neighborhood',
    placeholder: 'Знайти місто або вулицю',
  });
  document.getElementById('so-geocoder').appendChild(geocoder.onAdd(map));
  geocoder.on('result', function (e) {
    if (e && e.result) {
      currentLocation = e.result.text || e.result.place_name || '';
      if (e.result.center) {
        map.flyTo({ center: e.result.center, zoom: Math.max(map.getZoom(), 12) });
      }
    }
    updatePreview();
  });
  geocoder.on('clear', function () {
    currentLocation = '';
  });

  window.addEventListener('resize', function () {
    map.resize();
  });
  map.on('load', function () {
    map.resize();
    updatePreview();
  });
  map.on('moveend', updatePreview);
  map.on('zoomend', updatePreview);

  // ==========================================================================
  //  Live round preview
  // ==========================================================================

  function staticPreviewUrl() {
    var c = map.getCenter();
    var previewZoom = Math.max(0, map.getZoom() + PRINT_ZOOM_BOOST - PREVIEW_ZOOM_OFFSET);
    return (
      'https://api.mapbox.com/styles/v1/' +
      SITWELL_STYLE_STATIC +
      '/static/' +
      c.lng.toFixed(6) +
      ',' +
      c.lat.toFixed(6) +
      ',' +
      previewZoom.toFixed(2) +
      ',' +
      map.getBearing().toFixed(2) +
      ',' +
      map.getPitch().toFixed(2) +
      '/' +
      PREVIEW_SIZE +
      'x' +
      PREVIEW_SIZE +
      '?access_token=' +
      MAPBOX_TOKEN +
      '&attribution=false&logo=false'
    );
  }

  var previewImg = document.getElementById('so-preview-img');
  var previewTimer = null;
  function updatePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      previewImg.src = staticPreviewUrl();
    }, 150);
  }

  // ==========================================================================
  //  Geo utilities (Web Mercator ⇄ lng/lat, logical-pixel shifts)
  // ==========================================================================

  function lngLatToMercator(lng, lat) {
    var x = ((lng * Math.PI) / 180) * EARTH_RADIUS;
    var y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * EARTH_RADIUS;
    return [x, y];
  }
  function mercatorToLngLat(x, y) {
    var lng = ((x / EARTH_RADIUS) * 180) / Math.PI;
    var lat = ((2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180) / Math.PI;
    return [lng, lat];
  }
  function metersPerLogicalPixel(zoom) {
    return EARTH_CIRCUMFERENCE / (512 * Math.pow(2, zoom));
  }
  function shiftCenterByLogicalPixels(centerLngLat, zoom, dxPx, dyPx) {
    var merc = lngLatToMercator(centerLngLat[0], centerLngLat[1]);
    var mpp = metersPerLogicalPixel(zoom);
    return mercatorToLngLat(merc[0] + dxPx * mpp, merc[1] - dyPx * mpp);
  }

  // ==========================================================================
  //  Tile fetching (bearing=0, pitch=0 — required for stitching)
  // ==========================================================================

  function tileUrl(centerLngLat, zoom) {
    return (
      'https://api.mapbox.com/styles/v1/' +
      SITWELL_STYLE_STATIC +
      '/static/' +
      centerLngLat[0].toFixed(6) +
      ',' +
      centerLngLat[1].toFixed(6) +
      ',' +
      zoom.toFixed(2) +
      ',0,0' +
      '/1280x1280@2x?access_token=' +
      MAPBOX_TOKEN +
      '&attribution=false&logo=false'
    );
  }

  function fetchTile(centerLngLat, zoom) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error('tile load failed'));
      };
      img.src = tileUrl(centerLngLat, zoom);
    });
  }

  function fetchTileWithRetry(centerLngLat, zoom) {
    return fetchTile(centerLngLat, zoom).catch(function () {
      return new Promise(function (r) {
        setTimeout(r, 500);
      }).then(function () {
        return fetchTile(centerLngLat, zoom);
      });
    });
  }

  function fetchFourTiles(centerLngLat, zoom, onProgress) {
    var shifts = [
      [-TILE_HALF, -TILE_HALF],
      [TILE_HALF, -TILE_HALF],
      [-TILE_HALF, TILE_HALF],
      [TILE_HALF, TILE_HALF],
    ];
    var done = 0;
    return Promise.all(
      shifts.map(function (s) {
        var sub = shiftCenterByLogicalPixels(centerLngLat, zoom, s[0], s[1]);
        return fetchTileWithRetry(sub, zoom).then(function (img) {
          done++;
          if (onProgress) onProgress(done, shifts.length);
          return img;
        });
      })
    );
  }

  // ==========================================================================
  //  Compositing & circular clip
  // ==========================================================================

  function compositeTiles(tiles) {
    var canvas = document.createElement('canvas');
    canvas.width = COMPOSITE_SIZE;
    canvas.height = COMPOSITE_SIZE;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(tiles[0], 0, 0);
    ctx.drawImage(tiles[1], TILE_PHYSICAL_SIZE, 0);
    ctx.drawImage(tiles[2], 0, TILE_PHYSICAL_SIZE);
    ctx.drawImage(tiles[3], TILE_PHYSICAL_SIZE, TILE_PHYSICAL_SIZE);
    return canvas;
  }

  function clipAndAddMarker(sourceCanvas) {
    var out = document.createElement('canvas');
    out.width = TARGET_SIZE_PX;
    out.height = TARGET_SIZE_PX;
    var ctx = out.getContext('2d');

    var cx = TARGET_SIZE_PX / 2;
    var cy = TARGET_SIZE_PX / 2;

    // 1) Circular clip → outer 310 mm circle, everything else transparent
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, TARGET_SIZE_PX / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, TARGET_SIZE_PX, TARGET_SIZE_PX);
    ctx.restore();

    // 2) Punch the center pin hole (5 mm diameter → transparent)
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, HOLE_RADIUS_PX, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 3) Alignment marker: hairline circle on the hole boundary + 1 mm cross
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(1, 0.15 * MM_TO_PX);

    ctx.beginPath();
    ctx.arc(cx, cy, HOLE_RADIUS_PX, 0, Math.PI * 2);
    ctx.stroke();

    var arm = 1 * MM_TO_PX;
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy);
    ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm);
    ctx.lineTo(cx, cy + arm);
    ctx.stroke();

    return out;
  }

  // ==========================================================================
  //  PDF export → Blob (jsPDF, 310×310 mm, embedded PNG with alpha)
  // ==========================================================================

  function buildPdfBlob(canvas) {
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({
      unit: 'mm',
      format: [TARGET_SIZE_MM, TARGET_SIZE_MM],
      compress: true,
    });
    doc.addImage(canvas, 'PNG', 0, 0, TARGET_SIZE_MM, TARGET_SIZE_MM, undefined, 'FAST');
    return doc.output('blob');
  }

  // ==========================================================================
  //  Filename helpers
  // ==========================================================================

  function translit(s) {
    var m = {
      а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z',
      и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
      р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
      щ: 'shch', ь: '', ю: 'iu', я: 'ia',
      А: 'A', Б: 'B', В: 'V', Г: 'H', Ґ: 'G', Д: 'D', Е: 'E', Є: 'Ie', Ж: 'Zh', З: 'Z',
      И: 'Y', І: 'I', Ї: 'I', Й: 'I', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P',
      Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'Kh', Ц: 'Ts', Ч: 'Ch', Ш: 'Sh',
      Щ: 'Shch', Ь: '', Ю: 'Iu', Я: 'Ia',
    };
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      out += m[ch] != null ? m[ch] : ch;
    }
    return out;
  }
  function slugify(s) {
    if (!s) return '';
    return translit(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }
  // Fallback city name when the customer panned the map without using the
  // geocoder — reverse-geocode the map center for the order reference.
  function reverseGeocode(lng, lat) {
    var url =
      'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
      lng +
      ',' +
      lat +
      '.json?language=uk&types=place,locality,neighborhood,address&access_token=' +
      MAPBOX_TOKEN;
    return fetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.features && j.features.length) {
          return j.features[0].text || j.features[0].place_name || '';
        }
        return '';
      })
      .catch(function () {
        return '';
      });
  }

  // ==========================================================================
  //  Turnstile (explicit render — site key comes from config, not markup)
  // ==========================================================================

  var turnstileWidgetId = null;
  function renderTurnstile() {
    if (!TURNSTILE_SITE_KEY) return; // dev: no anti-spam widget
    if (!window.turnstile) {
      setTimeout(renderTurnstile, 300); // api.js still loading
      return;
    }
    var el = document.getElementById('so-turnstile');
    if (!el || turnstileWidgetId !== null) return;
    turnstileWidgetId = window.turnstile.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: 'dark',
    });
  }
  function getTurnstileToken() {
    if (!TURNSTILE_SITE_KEY) return '';
    if (window.turnstile && turnstileWidgetId !== null) {
      return window.turnstile.getResponse(turnstileWidgetId) || '';
    }
    return '';
  }
  function resetTurnstile() {
    if (window.turnstile && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
  }
  renderTurnstile();

  // ==========================================================================
  //  Quantity stepper (−/+ only — no manual entry) + price
  // ==========================================================================

  var QTY_MIN = 1;
  var QTY_MAX = 99;
  var qty = QTY_MIN;
  var qtyHidden = document.getElementById('so-qty');
  var qtyValueEl = document.getElementById('so-qty-value');
  var qtyMinus = document.getElementById('so-qty-minus');
  var qtyPlus = document.getElementById('so-qty-plus');
  var priceEl = document.getElementById('so-price');

  function currentQty() {
    return qty;
  }
  function renderQty() {
    qtyValueEl.textContent = String(qty);
    qtyHidden.value = String(qty);
    priceEl.textContent = qty * PRICE_UAH + ' грн';
    qtyMinus.disabled = qty <= QTY_MIN;
    qtyPlus.disabled = qty >= QTY_MAX;
  }
  qtyMinus.addEventListener('click', function () {
    if (qty > QTY_MIN) {
      qty--;
      renderQty();
    }
  });
  qtyPlus.addEventListener('click', function () {
    if (qty < QTY_MAX) {
      qty++;
      renderQty();
    }
  });
  renderQty();

  // ==========================================================================
  //  Nova Poshta delivery (city autocomplete → warehouse combobox)
  //  Calls the order Worker as a proxy (?action=np-*) so the NP key stays
  //  server-side. If no ORDER_ENDPOINT is set (dev dry-run) or the proxy errors,
  //  we fall back to a plain text delivery field.
  // ==========================================================================

  var npEnabled = !!ORDER_ENDPOINT;
  var npBox = document.getElementById('so-np');
  var npCityInput = document.getElementById('so-np-city');
  var npCityList = document.getElementById('so-np-city-list');
  var npCityRef = document.getElementById('so-np-city-ref');
  var npWhInput = document.getElementById('so-np-wh');
  var npWhList = document.getElementById('so-np-wh-list');
  var npWhRef = document.getElementById('so-np-wh-ref');
  var deliveryNote = document.getElementById('so-delivery-note');
  var npCityTimer = null;
  var npWarehouses = []; // {ref, description, number} loaded for the chosen city

  function showNpUnavailable() {
    npEnabled = false;
    if (npBox) npBox.hidden = true;
    if (deliveryNote) deliveryNote.hidden = false;
  }
  function npFetch(action, params) {
    var qs = Object.keys(params)
      .map(function (k) {
        return k + '=' + encodeURIComponent(params[k]);
      })
      .join('&');
    var sep = ORDER_ENDPOINT.indexOf('?') === -1 ? '?' : '&';
    return fetch(ORDER_ENDPOINT + sep + 'action=' + action + '&' + qs).then(function (r) {
      if (!r.ok) throw new Error('np ' + r.status);
      return r.json();
    });
  }

  // Shared dropdown renderer for both comboboxes.
  function hideList(ul) {
    ul.hidden = true;
    ul.innerHTML = '';
  }
  function renderList(ul, rows, emptyText) {
    ul.innerHTML = '';
    if (!rows.length) {
      var li = document.createElement('li');
      li.className = 'so-np-empty';
      li.textContent = emptyText;
      ul.appendChild(li);
      ul.hidden = false;
      return;
    }
    rows.forEach(function (row) {
      var item = document.createElement('li');
      item.textContent = row.label;
      // mousedown fires before the input blur / document click that hides the list
      item.addEventListener('mousedown', function (e) {
        e.preventDefault();
        row.onPick();
      });
      ul.appendChild(item);
    });
    ul.hidden = false;
  }

  // ---- City (async NP search) ----
  function searchCities(q) {
    npFetch('np-cities', { q: q })
      .then(function (items) {
        renderList(
          npCityList,
          (items || []).map(function (c) {
            return {
              label: c.name + (c.area ? ' (' + c.area + ')' : ''),
              onPick: function () {
                pickCity(c);
              },
            };
          }),
          'Нічого не знайдено'
        );
      })
      .catch(function () {
        showNpUnavailable();
      });
  }
  function pickCity(c) {
    npCityInput.value = c.name;
    npCityRef.value = c.ref;
    npCityInput.classList.remove('so-invalid');
    hideList(npCityList);
    resetWarehouse();
    loadWarehouses(c.ref);
  }

  // ---- Warehouse (loaded once per city, filtered client-side, typeable) ----
  function resetWarehouse() {
    npWarehouses = [];
    npWhRef.value = '';
    npWhInput.value = '';
    npWhInput.disabled = true;
    npWhInput.placeholder = 'Спочатку оберіть місто';
    hideList(npWhList);
  }
  function loadWarehouses(cityRef) {
    npWhInput.placeholder = 'Завантаження…';
    npFetch('np-warehouses', { ref: cityRef })
      .then(function (items) {
        npWarehouses = items || [];
        npWhInput.disabled = false;
        npWhInput.placeholder = 'Введіть № або назву відділення';
      })
      .catch(function () {
        showNpUnavailable();
      });
  }
  function filterWarehouses(q) {
    q = q.trim().toLowerCase();
    var rows = npWarehouses
      .filter(function (w) {
        if (!q) return true;
        return (
          (w.number && String(w.number).toLowerCase().indexOf(q) !== -1) ||
          (w.description && w.description.toLowerCase().indexOf(q) !== -1)
        );
      })
      .slice(0, 50)
      .map(function (w) {
        return {
          label: w.description,
          onPick: function () {
            pickWarehouse(w);
          },
        };
      });
    renderList(npWhList, rows, 'Нічого не знайдено');
  }
  function pickWarehouse(w) {
    npWhInput.value = w.description;
    npWhRef.value = w.ref;
    npWhInput.classList.remove('so-invalid');
    hideList(npWhList);
  }

  if (!npEnabled) {
    showNpUnavailable();
  } else {
    npCityInput.addEventListener('input', function () {
      npCityRef.value = '';
      resetWarehouse();
      var q = npCityInput.value.trim();
      clearTimeout(npCityTimer);
      if (q.length < 2) {
        hideList(npCityList);
        return;
      }
      npCityTimer = setTimeout(function () {
        searchCities(q);
      }, 250);
    });
    npWhInput.addEventListener('input', function () {
      npWhRef.value = ''; // typing invalidates the previous pick
      filterWarehouses(npWhInput.value);
    });
    npWhInput.addEventListener('focus', function () {
      if (npWarehouses.length) filterWarehouses(npWhInput.value);
    });
    document.addEventListener('click', function (e) {
      if (!npCityInput.contains(e.target) && !npCityList.contains(e.target)) hideList(npCityList);
      if (!npWhInput.contains(e.target) && !npWhList.contains(e.target)) hideList(npWhList);
    });
  }

  function getDeliveryPayload() {
    if (npEnabled) {
      var city = npCityInput.value.trim();
      var wh = npWhInput.value.trim();
      return {
        text: city + (wh ? ', ' + wh : ''),
        city: city,
        cityRef: npCityRef.value,
        wh: wh,
        whRef: npWhRef.value,
      };
    }
    return { text: '', city: '', cityRef: '', wh: '', whRef: '' };
  }
  function validateDelivery() {
    if (npEnabled) {
      var cityOk = !!npCityRef.value;
      var whOk = !!npWhRef.value;
      npCityInput.classList.toggle('so-invalid', !cityOk);
      npWhInput.classList.toggle('so-invalid', !whOk);
      if (!cityOk) return { ok: false, el: npCityInput, msg: 'Оберіть місто доставки зі списку.' };
      if (!whOk) return { ok: false, el: npWhInput, msg: 'Оберіть відділення зі списку.' };
      return { ok: true };
    }
    // NP unavailable → delivery is collected later by the manager; don't block.
    return { ok: true };
  }

  // ---- Optional order comment (toggle) ----
  var commentToggle = document.getElementById('so-comment-toggle');
  var commentField = document.getElementById('so-comment');
  commentToggle.addEventListener('change', function () {
    commentField.hidden = !commentToggle.checked;
    if (commentToggle.checked) commentField.focus();
    else commentField.value = '';
  });
  function getComment() {
    return commentToggle.checked ? commentField.value.trim() : '';
  }

  // ==========================================================================
  //  Form: validation + submit → generate PDF → POST to endpoint
  // ==========================================================================

  var form = document.getElementById('so-form');
  var thanks = document.getElementById('so-thanks');
  var errorEl = document.getElementById('so-error');
  var btn = document.getElementById('so-submit');
  var origBtnText = btn.textContent;

  var requiredFields = ['so-name', 'so-phone'];

  function setBtn(text, disabled) {
    btn.textContent = text;
    btn.disabled = !!disabled;
  }
  function nextFrame() {
    return new Promise(function (r) {
      requestAnimationFrame(r);
    });
  }
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
  function validate() {
    clearError();
    var firstInvalid = null;
    var msg = '';

    requiredFields.forEach(function (id) {
      var el = document.getElementById(id);
      var ok = el.value.trim().length > 0;
      el.classList.toggle('so-invalid', !ok);
      if (!ok && !firstInvalid) {
        firstInvalid = el;
        msg = 'Будь ласка, заповніть усі обовʼязкові поля.';
      }
    });

    var del = validateDelivery();
    if (!del.ok && !firstInvalid) {
      firstInvalid = del.el;
      msg = del.msg;
    }

    if (firstInvalid) {
      showError(msg);
      firstInvalid.focus();
      return false;
    }
    return true;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (btn.disabled) return;

    // Honeypot: a real user never fills this. Pretend success, do nothing.
    var honeypot = document.getElementById('so-website');
    if (honeypot && honeypot.value.trim() !== '') {
      form.hidden = true;
      thanks.hidden = false;
      return;
    }

    if (!validate()) return;

    var token = getTurnstileToken();
    if (TURNSTILE_SITE_KEY && !token) {
      showError('Підтвердіть, будь ласка, що ви не робот.');
      return;
    }

    setBtn('Готуємо…', true);

    var c = map.getCenter();
    var center = [c.lng, c.lat];
    var zoom = map.getZoom();
    var printZoom = Math.min(22, zoom + PRINT_ZOOM_BOOST);
    var delivery = getDeliveryPayload();

    // City for the order: geocoder pick, else reverse-geocode the map center.
    var namePromise = currentLocation
      ? Promise.resolve(currentLocation)
      : reverseGeocode(center[0].toFixed(6), center[1].toFixed(6));

    var tilesPromise = fetchFourTiles(center, printZoom, function (done, total) {
      setBtn('Генеруємо макет… ' + done + '/' + total, true);
    });

    Promise.all([tilesPromise, namePromise])
      .then(function (results) {
        var tiles = results[0];
        var cityValue = results[1] || '';
        setBtn('Обробляємо…', true);
        return nextFrame().then(function () {
          var composited = compositeTiles(tiles);
          var finalCanvas = clipAndAddMarker(composited);
          return nextFrame().then(function () {
            return { blob: buildPdfBlob(finalCanvas), city: cityValue };
          });
        });
      })
      .then(function (built) {
        var pdfBlob = built.blob;
        var cityValue = built.city;
        setBtn('Надсилаємо…', true);

        var slug = slugify(cityValue);
        var filename = 'slipmat-order' + (slug ? '-' + slug : '') + '.pdf';

        var fd = new FormData();
        fd.append('city', cityValue);
        fd.append('name', document.getElementById('so-name').value.trim());
        fd.append('phone', document.getElementById('so-phone').value.trim());
        fd.append('delivery', delivery.text);
        fd.append('delivery_city', delivery.city);
        fd.append('delivery_city_ref', delivery.cityRef);
        fd.append('delivery_warehouse', delivery.wh);
        fd.append('delivery_warehouse_ref', delivery.whRef);
        fd.append('comment', getComment());
        fd.append('qty', String(currentQty()));
        fd.append('price_uah', String(PRICE_UAH));
        fd.append('total_uah', String(currentQty() * PRICE_UAH));
        fd.append('map_center', center[0].toFixed(6) + ',' + center[1].toFixed(6));
        fd.append('map_zoom', printZoom.toFixed(2));
        fd.append('geocoder_location', currentLocation);
        fd.append('page_url', window.location.href);
        fd.append('website', ''); // honeypot (always empty here)
        fd.append('cf-turnstile-response', token);
        fd.append('pdf', pdfBlob, filename);

        if (!ORDER_ENDPOINT) {
          // DRY-RUN (dev without a Worker): log and simulate success.
          console.warn('[slipmat-order] DRY-RUN — would POST', filename, {
            city: cityValue,
            name: fd.get('name'),
            phone: fd.get('phone'),
            delivery: delivery.text,
            comment: fd.get('comment'),
            qty: fd.get('qty'),
            total_uah: fd.get('total_uah'),
            pdfBytes: pdfBlob.size,
          });
          return { ok: true, dryRun: true };
        }

        return fetch(ORDER_ENDPOINT, { method: 'POST', body: fd }).then(function (res) {
          if (!res.ok) {
            return res.text().then(function (t) {
              throw new Error('endpoint ' + res.status + ': ' + t.slice(0, 200));
            });
          }
          return res.json().catch(function () {
            return { ok: true };
          });
        });
      })
      .then(function () {
        form.hidden = true;
        thanks.hidden = false;
      })
      .catch(function (err) {
        console.error('[slipmat-order] order failed:', err);
        showError('Не вдалося надіслати замовлення. Спробуйте ще раз або звʼяжіться з нами.');
        resetTurnstile();
        setBtn(origBtnText, false);
      });
  });
})();
