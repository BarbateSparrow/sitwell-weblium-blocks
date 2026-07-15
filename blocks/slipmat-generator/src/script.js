/**
 * Slipmat Map Generator
 *
 * Behavior:
 *   - Interactive map (mapbox-gl) with drag/zoom/rotate/tilt on the left.
 *   - Round live preview via Mapbox Static Images API (reflects live map, incl. bearing/pitch).
 *   - Geocoder search field.
 *   - Generate button: builds a print-ready PDF.
 *
 * Print target:
 *   - 310 mm outer diameter (incl. bleed).
 *   - 5 mm centered pin hole (transparent).
 *   - Alignment marker at center (fine circle at hole boundary + 1 mm cross).
 *   - Transparent background outside the outer circle (to save ink).
 *   - Map raster is stitched from 4 Mapbox Static tiles @ zoom Z, bearing=0, pitch=0,
 *     composited to 5120×5120, downscaled to 3661×3661 (≈300 DPI on 310 mm).
 *
 * Config sources (priority order):
 *   1. window.SLIPMAT_CONFIG — injected by build.js (prod) or local-config.js (dev)
 *   2. hard-coded defaults (only for map start position)
 *
 * External deps loaded via <script> tags in the template:
 *   - mapbox-gl 3.5.x
 *   - mapbox-gl-geocoder 5.0.x
 *   - jsPDF 2.5.x (UMD)
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

  // Web Mercator (EPSG:3857)
  var EARTH_CIRCUMFERENCE = 40075016.686;
  var EARTH_RADIUS = 6378137;

  // ==========================================================================
  //  Sanity checks
  // ==========================================================================

  if (!window.mapboxgl) {
    console.error('[slipmat] mapbox-gl not loaded');
    return;
  }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    console.error('[slipmat] jsPDF not loaded');
    return;
  }
  if (!MAPBOX_TOKEN || !SITWELL_STYLE_GL || !SITWELL_STYLE_STATIC) {
    console.error(
      '[slipmat] missing SLIPMAT_CONFIG: MAPBOX_TOKEN / MAPBOX_STYLE_GL / MAPBOX_STYLE_STATIC'
    );
    return;
  }

  mapboxgl.accessToken = MAPBOX_TOKEN;

  // ==========================================================================
  //  Map & geocoder
  // ==========================================================================

  var currentLocation = '';

  var map = new mapboxgl.Map({
    container: 'sm-map',
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
    language: 'uk',
    placeholder: 'Знайти місто або вулицю',
  });
  document.getElementById('sm-geocoder').appendChild(geocoder.onAdd(map));
  geocoder.on('result', function (e) {
    if (e && e.result) {
      currentLocation = e.result.text || e.result.place_name || '';
      if (e.result.center) {
        map.flyTo({ center: e.result.center, zoom: Math.max(map.getZoom(), 14) });
      }
    }
    updatePreview();
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
  //  Live round preview (reflects the interactive map exactly, incl. bearing/pitch)
  // ==========================================================================

  function staticPreviewUrl() {
    var c = map.getCenter();
    return (
      'https://api.mapbox.com/styles/v1/' +
      SITWELL_STYLE_STATIC +
      '/static/' +
      c.lng.toFixed(6) +
      ',' +
      c.lat.toFixed(6) +
      ',' +
      map.getZoom().toFixed(2) +
      ',' +
      map.getBearing().toFixed(2) +
      ',' +
      map.getPitch().toFixed(2) +
      '/600x600?access_token=' +
      MAPBOX_TOKEN +
      '&attribution=false&logo=false'
    );
  }

  var previewImg = document.getElementById('sm-preview-img');
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
  // Mapbox uses a 512-logical-px world at zoom 0
  function metersPerLogicalPixel(zoom) {
    return EARTH_CIRCUMFERENCE / (512 * Math.pow(2, zoom));
  }
  function shiftCenterByLogicalPixels(centerLngLat, zoom, dxPx, dyPx) {
    var merc = lngLatToMercator(centerLngLat[0], centerLngLat[1]);
    var mpp = metersPerLogicalPixel(zoom);
    return mercatorToLngLat(
      merc[0] + dxPx * mpp,
      merc[1] - dyPx * mpp // Mercator Y is northward; screen Y is downward
    );
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

  /**
   * Fetch 4 tiles arranged 2×2, all at the same zoom and bearing=pitch=0.
   * Grid layout (destination on 5120×5120 canvas):
   *
   *   [TL, TR]     center shifts (logical px):
   *   [BL, BR]       TL: (-640, -640)   TR: (+640, -640)
   *                  BL: (-640, +640)   BR: (+640, +640)
   */
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
    // Tile order matches shifts array: TL, TR, BL, BR
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

    // 3) Alignment marker for the printer:
    //    - hairline circle exactly on the hole boundary
    //    - 1 mm cross at the exact center (inside the transparent hole)
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(1, 0.15 * MM_TO_PX); // ≈ 0.15 mm hairline

    ctx.beginPath();
    ctx.arc(cx, cy, HOLE_RADIUS_PX, 0, Math.PI * 2);
    ctx.stroke();

    var arm = 1 * MM_TO_PX; // 1 mm arms → 2 mm cross
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy);
    ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm);
    ctx.lineTo(cx, cy + arm);
    ctx.stroke();

    return out;
  }

  // ==========================================================================
  //  PDF export (jsPDF, 310×310 mm, embedded PNG with alpha)
  // ==========================================================================

  function buildPdf(canvas) {
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({
      unit: 'mm',
      format: [TARGET_SIZE_MM, TARGET_SIZE_MM],
      compress: true,
    });
    // jsPDF handles PNG alpha via an SMask. 'FAST' picks a reasonable Flate level.
    doc.addImage(canvas, 'PNG', 0, 0, TARGET_SIZE_MM, TARGET_SIZE_MM, undefined, 'FAST');
    return doc;
  }

  // ==========================================================================
  //  Filename helpers
  // ==========================================================================

  function translit(s) {
    var m = {
      а: 'a',
      б: 'b',
      в: 'v',
      г: 'h',
      ґ: 'g',
      д: 'd',
      е: 'e',
      є: 'ie',
      ж: 'zh',
      з: 'z',
      и: 'y',
      і: 'i',
      ї: 'i',
      й: 'i',
      к: 'k',
      л: 'l',
      м: 'm',
      н: 'n',
      о: 'o',
      п: 'p',
      р: 'r',
      с: 's',
      т: 't',
      у: 'u',
      ф: 'f',
      х: 'kh',
      ц: 'ts',
      ч: 'ch',
      ш: 'sh',
      щ: 'shch',
      ь: '',
      ю: 'iu',
      я: 'ia',
      А: 'A',
      Б: 'B',
      В: 'V',
      Г: 'H',
      Ґ: 'G',
      Д: 'D',
      Е: 'E',
      Є: 'Ie',
      Ж: 'Zh',
      З: 'Z',
      И: 'Y',
      І: 'I',
      Ї: 'I',
      Й: 'I',
      К: 'K',
      Л: 'L',
      М: 'M',
      Н: 'N',
      О: 'O',
      П: 'P',
      Р: 'R',
      С: 'S',
      Т: 'T',
      У: 'U',
      Ф: 'F',
      Х: 'Kh',
      Ц: 'Ts',
      Ч: 'Ch',
      Ш: 'Sh',
      Щ: 'Shch',
      Ь: '',
      Ю: 'Iu',
      Я: 'Ia',
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
  //  Main: generate PDF (with progress on the button)
  // ==========================================================================

  var btn = document.getElementById('sm-generate');
  var origBtnText = btn.textContent;

  function setBtn(text, disabled) {
    btn.textContent = text;
    btn.disabled = !!disabled;
  }
  // yield to the browser between heavy sync steps so button text repaints
  function nextFrame() {
    return new Promise(function (r) {
      requestAnimationFrame(r);
    });
  }

  btn.addEventListener('click', function () {
    setBtn('Завантажую…', true);

    var c = map.getCenter();
    var center = [c.lng, c.lat];
    var zoom = map.getZoom();

    var namePromise = currentLocation
      ? Promise.resolve(currentLocation)
      : reverseGeocode(center[0].toFixed(6), center[1].toFixed(6));

    var tilesPromise = fetchFourTiles(center, zoom, function (done, total) {
      setBtn('Генерую… ' + done + '/' + total, true);
    });

    Promise.all([tilesPromise, namePromise])
      .then(function (results) {
        var tiles = results[0];
        var name = results[1];

        setBtn('Обробляю…', true);
        return nextFrame().then(function () {
          var composited = compositeTiles(tiles);
          var final = clipAndAddMarker(composited);

          setBtn('Пакую PDF…', true);
          return nextFrame().then(function () {
            var pdf = buildPdf(final);
            var slug = slugify(name);
            var filename = 'slipmat-map' + (slug ? '-' + slug : '') + '.pdf';
            pdf.save(filename);
          });
        });
      })
      .catch(function (err) {
        console.error('[slipmat] generation failed:', err);
        alert('Не вдалось згенерувати макет. Спробуйте ще раз.');
      })
      .finally(function () {
        setBtn(origBtnText, false);
      });
  });
})();
