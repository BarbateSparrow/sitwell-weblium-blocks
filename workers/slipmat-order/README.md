# slipmat-order Worker

Cloudflare Worker that receives slipmat orders from the `slipmat-order` block,
verifies them (Turnstile + honeypot) and notifies the shop via **Telegram** and
**email (Resend)** with the print-ready PDF attached.

## Endpoint contract

`POST <worker-url>` — `multipart/form-data`:

| field | notes |
|-------|-------|
| `city` | city name for print (reference) |
| `name`, `phone`, `delivery` | required |
| `qty`, `price_uah`, `total_uah` | pricing |
| `map_center`, `map_zoom`, `geocoder_location`, `page_url` | context |
| `website` | honeypot — must be empty |
| `cf-turnstile-response` | Turnstile token |
| `pdf` | the 310×310 mm artwork (application/pdf) |

Response: `{ "ok": true }` on success; `{ "ok": false, "error": "..." }` otherwise.

### Nova Poshta proxy

The same Worker also proxies Nova Poshta address lookups so the NP key stays
server-side (responses cached ~1 day):

- `GET <worker-url>?action=np-cities&q=<query>` → `[{ ref, name, area }]`
- `GET <worker-url>?action=np-warehouses&ref=<cityRef>` → `[{ ref, description, number }]`

If `NP_API_KEY` is not set the block degrades to a plain text delivery field.

## Config

`wrangler.toml [vars]` (non-secret): `ALLOWED_ORIGIN`, `RESEND_FROM`, `ORDER_EMAIL_TO`.

Secrets (never committed):

```bash
cd workers/slipmat-order
wrangler secret put TURNSTILE_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put NP_API_KEY          # Nova Poshta (optional; enables delivery lookups)
```

## Local dev

```bash
cd workers/slipmat-order
cp .dev.vars.example .dev.vars   # fill in real values (git-ignored)
npx wrangler dev                 # http://localhost:8787
```

Point the block at it during dev by setting `ORDER_ENDPOINT` in
`dev-server/local-config.js` to `http://localhost:8787`.

## Deploy

```bash
cd workers/slipmat-order
npx wrangler deploy
```

Then put the deployed URL into `blocks/slipmat-order/config.json`
(`order_endpoint`) and the Turnstile **site** key into `turnstile_site_key`,
rebuild the block (`npm run build:order`) and paste the three `dist/weblium.*`
tabs into Weblium.

## Provider notes

- **Resend**: verify the `sitwell.com.ua` domain for good deliverability, or use
  `onboarding@resend.dev` as `RESEND_FROM` while testing.
- **Turnstile**: create a widget in the Cloudflare dashboard → the *site key* is
  public (goes in the block config), the *secret key* is a Worker secret.
- **Telegram**: message the bot once (or add it to the target group) so it is
  allowed to post; get the chat id from `getUpdates` or a bot like @userinfobot.
