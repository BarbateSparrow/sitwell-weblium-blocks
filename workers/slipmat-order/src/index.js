/**
 * Slipmat Order Worker (Cloudflare)
 *
 * Receives a multipart/form-data POST from the slipmat-order block:
 *   fields: city, name, phone, delivery, qty, price_uah, total_uah,
 *           map_center, map_zoom, geocoder_location, page_url,
 *           website (honeypot), cf-turnstile-response
 *   file:   pdf  (the print-ready 310×310 mm slipmat artwork)
 *
 * Flow:
 *   1. CORS preflight handling (restricted to ALLOWED_ORIGIN).
 *   2. Honeypot check — if the hidden `website` field is filled, silently accept.
 *   3. Cloudflare Turnstile verification.
 *   4. Notify shop via Telegram (sendDocument) AND email (Resend), both with the
 *      PDF attached. If at least one channel succeeds the order is accepted.
 *
 * Secrets (wrangler secret put):
 *   TURNSTILE_SECRET, RESEND_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Vars (wrangler.toml [vars]):
 *   ALLOWED_ORIGIN, RESEND_FROM, ORDER_EMAIL_TO
 */

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    // Nova Poshta proxy (GET ?action=np-cities|np-warehouses) — keeps the NP key
    // server-side. Responses are cached (Cache API) for a day since NP data is
    // near-static.
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    if (request.method === 'GET' && action) {
      const cache = caches.default;
      const cached = await cache.match(request);
      if (cached) return cached;
      const resp = await handleNovaPoshta(action, url, env, cors);
      if (resp.status === 200) await cache.put(request, resp.clone());
      return resp;
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    }

    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return json({ ok: false, error: 'bad_request' }, 400, cors);
    }

    // 1) Honeypot — a real user never fills `website`. Silently accept & drop.
    if (str(form.get('website'))) {
      return json({ ok: true }, 200, cors);
    }

    // 2) Turnstile
    if (env.TURNSTILE_SECRET) {
      const passed = await verifyTurnstile(str(form.get('cf-turnstile-response')), request, env);
      if (!passed) {
        return json({ ok: false, error: 'turnstile_failed' }, 403, cors);
      }
    }

    // 3) Collect fields
    const order = {
      city: str(form.get('city')),
      name: str(form.get('name')),
      phone: str(form.get('phone')),
      delivery: str(form.get('delivery')),
      qty: str(form.get('qty')) || '1',
      comment: str(form.get('comment')),
      priceUah: str(form.get('price_uah')),
      totalUah: str(form.get('total_uah')),
      mapCenter: str(form.get('map_center')),
      mapZoom: str(form.get('map_zoom')),
      location: str(form.get('geocoder_location')),
      pageUrl: str(form.get('page_url')),
    };
    if (!order.name || !order.phone) {
      return json({ ok: false, error: 'missing_fields' }, 422, cors);
    }

    // 4) PDF
    const pdf = form.get('pdf');
    if (!pdf || typeof pdf.arrayBuffer !== 'function') {
      return json({ ok: false, error: 'missing_pdf' }, 422, cors);
    }
    const pdfBuf = await pdf.arrayBuffer();
    const filename = safeFilename(pdf.name || 'slipmat-order.pdf');

    // 5) Notify both channels. Don't punish the customer if one is misconfigured.
    const results = await Promise.allSettled([
      sendTelegram(env, order, pdfBuf, filename),
      sendEmail(env, order, pdfBuf, filename),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error('[slipmat-order] channel', i === 0 ? 'telegram' : 'email', 'failed:', r.reason);
      }
    });
    const anyOk = results.some((r) => r.status === 'fulfilled' && r.value === true);
    if (!anyOk) {
      return json({ ok: false, error: 'notify_failed' }, 502, cors);
    }

    return json({ ok: true }, 200, cors);
  },
};

// ============================================================================
//  CORS
// ============================================================================

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || '';
  // Allow the configured origin; fall back to echoing origin only if none set.
  const allowOrigin = allowed ? (originAllowed(origin, allowed) ? origin : allowed) : origin || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function originAllowed(origin, allowed) {
  // ALLOWED_ORIGIN may be a comma-separated list.
  return allowed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin);
}

// ============================================================================
//  Turnstile
// ============================================================================

async function verifyTurnstile(token, request, env) {
  if (!token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.append('remoteip', ip);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  });
  const data = await res.json().catch(() => ({ success: false }));
  return data.success === true;
}

// ============================================================================
//  Nova Poshta proxy
// ============================================================================

async function handleNovaPoshta(action, url, env, cors) {
  if (!env.NP_API_KEY) return json({ ok: false, error: 'np_not_configured' }, 501, cors);
  try {
    if (action === 'np-cities') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json([], 200, cors);
      const data = await npCall(env, 'Address', 'getCities', {
        FindByString: q,
        Limit: '20',
        Page: '1',
      });
      const cities = (data || []).map((c) => ({
        ref: c.Ref,
        name: c.Description,
        area: c.AreaDescription || '',
      }));
      return json(cities, 200, cors, 86400);
    }
    if (action === 'np-warehouses') {
      const ref = url.searchParams.get('ref') || '';
      if (!ref) return json([], 200, cors);
      const data = await npCall(env, 'AddressGeneral', 'getWarehouses', {
        CityRef: ref,
        Limit: '1000',
        Page: '1',
      });
      const whs = (data || []).map((w) => ({
        ref: w.Ref,
        description: w.Description,
        number: w.Number,
      }));
      return json(whs, 200, cors, 86400);
    }
    return json({ ok: false, error: 'unknown_action' }, 400, cors);
  } catch (e) {
    return json({ ok: false, error: 'np_failed', detail: String(e).slice(0, 200) }, 502, cors);
  }
}

async function npCall(env, modelName, calledMethod, methodProperties) {
  const res = await fetch('https://api.novaposhta.ua/v2.0/json/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: env.NP_API_KEY, modelName, calledMethod, methodProperties }),
  });
  const j = await res.json();
  if (!j.success) throw new Error((j.errors || []).join('; ') || 'nova poshta error');
  return j.data;
}

// ============================================================================
//  Telegram
// ============================================================================

async function sendTelegram(env, order, pdfBuf, filename) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;

  const fd = new FormData();
  fd.append('chat_id', env.TELEGRAM_CHAT_ID);
  fd.append('caption', telegramCaption(order));
  fd.append('parse_mode', 'HTML');
  fd.append('document', new Blob([pdfBuf], { type: 'application/pdf' }), filename);

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`;
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('telegram ' + res.status + ': ' + t.slice(0, 200));
  }
  return true;
}

function telegramCaption(o) {
  // Telegram caption limit is 1024 chars; our fields stay well under.
  const lines = [
    '🎧 <b>Нове замовлення слипмата</b>',
    '',
    `<b>Місто (для друку):</b> ${esc(o.city) || '—'}`,
    `<b>Отримувач:</b> ${esc(o.name)}`,
    `<b>Телефон:</b> ${esc(o.phone)}`,
    `<b>Доставка:</b> ${esc(o.delivery)}`,
    `<b>Кількість:</b> ${esc(o.qty)}`,
    `<b>Сума:</b> ${esc(o.totalUah)} грн`,
    '',
    `<b>Мапа:</b> center ${esc(o.mapCenter)}, zoom ${esc(o.mapZoom)}`,
  ];
  if (o.location) lines.push(`<b>Геокодер:</b> ${esc(o.location)}`);
  if (o.comment) lines.push('', `💬 <b>Коментар:</b> ${esc(o.comment)}`);
  return lines.join('\n');
}

// ============================================================================
//  Email (Resend)
// ============================================================================

async function sendEmail(env, order, pdfBuf, filename) {
  if (!env.RESEND_API_KEY || !env.ORDER_EMAIL_TO || !env.RESEND_FROM) return false;

  const payload = {
    from: env.RESEND_FROM,
    to: env.ORDER_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean),
    subject: `Нове замовлення слипмата${order.city ? ' — ' + order.city : ''}`,
    html: emailHtml(order),
    attachments: [{ filename, content: base64FromArrayBuffer(pdfBuf) }],
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('resend ' + res.status + ': ' + t.slice(0, 200));
  }
  return true;
}

function emailHtml(o) {
  const row = (k, v) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;">${esc(k)}</td><td style="padding:4px 0;font-weight:600;">${esc(v) || '—'}</td></tr>`;
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">
    <h2 style="margin:0 0 12px;">🎧 Нове замовлення слипмата</h2>
    <table style="border-collapse:collapse;font-size:14px;">
      ${row('Місто (для друку)', o.city)}
      ${row('Отримувач', o.name)}
      ${row('Телефон', o.phone)}
      ${row('Доставка', o.delivery)}
      ${row('Кількість', o.qty)}
      ${row('Сума, грн', o.totalUah)}
      ${o.comment ? row('Коментар', o.comment) : ''}
      ${row('Мапа center', o.mapCenter)}
      ${row('Мапа zoom', o.mapZoom)}
      ${row('Геокодер', o.location)}
      ${row('Сторінка', o.pageUrl)}
    </table>
    <p style="margin:14px 0 0;color:#666;font-size:13px;">Макет для друку — у вкладенні (PDF).</p>
  </div>`;
}

// ============================================================================
//  Helpers
// ============================================================================

function str(v) {
  return v == null ? '' : String(v).trim();
}

function esc(v) {
  return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeFilename(name) {
  return String(name).replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'slipmat-order.pdf';
}

function json(obj, status, headers, maxAge) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (maxAge) h['Cache-Control'] = 'public, max-age=' + maxAge;
  return new Response(JSON.stringify(obj), { status, headers: h });
}

// Base64-encode an ArrayBuffer in chunks (avoids call-stack limits on big PDFs).
function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
