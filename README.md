# Baron Sneakers frontend

Static frontend (HTML, CSS, vanilla JS, no build step) for the Baron Sneakers rebuild. It runs on mock data from `assets/api.js`. The backend work is replacing each mock function with a real API call, then enforcing the rules below on the server.

Run: copy `.env.example` to `.env`, then `npm install` and `npm start`, and open http://localhost:3000. Tests: `npm test`.

Data is in memory (`DEV_MEMORY_DB=true`) and resets on restart. `db/schema.sql` is the target Postgres schema; the server does not use it yet.

Production (`NODE_ENV=production`) refuses to start without `SESSION_SECRET`, `ADMIN_TOTP_SECRET`, `DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD`, `WHOLESALE_ACCESS_CODE` and `ALLOWED_ORIGIN`.

## Files
- `index.html` Retail shop: browse, size and fit check, bag, WhatsApp order.
- `wholesale.html` Wholesale side (inverted black theme), size grid, 10-pair minimum.
- `track.html` Order tracking (order number + last 4 phone digits).
- `admin.html` Admin: orders with status labels and actions, add sneaker. Separate subdomain in production.
- `assets/api.js` Mock data layer. Each function has a `BACKEND:` note with the endpoint to build.
- `assets/style.css` Strict black and white design system. Greys are tints for borders and disabled states only.

## Endpoints to build
| Mock | Endpoint | Notes |
|---|---|---|
| `Api.products` | `GET /api/products` | Retail price only. Never cost or wholesale price. |
| `Api.wholesale` | `GET /api/wholesale/products` | 403 unless approved wholesale session. Test this. |
| `Api.order` | `POST /api/orders` | Server recomputes prices, validates, saves order as pending, returns `{ref,total,wa_url}`. |
| `Api.track` | `POST /api/track` | Same generic error for wrong ref or digits. Rate limit. |
| admin login | `POST /api/admin/login` | Email, password, TOTP. Server session. |
| admin products | `POST /api/admin/products` | Multipart, image type and size checks, compress to WebP. |
| admin orders | `GET/PATCH /api/admin/orders` | Mark paid, send to warehouse, arrived, delivered, cancel. |

## Business rules (server is the source of truth)
- **Pricing:** `cost_ghs = cost_cfa / 1000 * rate` (rate 21.5, in settings). Retail = cost + 100, rounded UP to the next 10 (358 becomes 360). Wholesale = cost + 40, no rounding (298). Orders snapshot the unit price.
- **Wholesale:** minimum 10 pairs total per order, mixing models and sizes allowed. Approved accounts only.
- **Payment first:** MoMo or bank transfer, details sent in WhatsApp only, never stored or shown on the site. Admin marks paid with a transaction ID (unique, reject duplicates). Only paid orders can be sent to the warehouse.
- **Statuses:** Awaiting payment, Paid, Sent to warehouse, Arrived at Tudu, Delivered (plus Cancelled, Expired).
- **Dispatch from Lome:** Monday to Saturday. Cutoff 17:00 Africa/Accra applies to the time payment is confirmed. After cutoff, or Sunday, dispatch is the next dispatch day. Arrival in Accra (STC Tudu) = dispatch + 1 day, Sundays allowed. Skip dates in an admin-editable holiday list. See `Api.arrival` for the display-only version and tests to write: Mon-Fri before 5pm next day, Mon-Thu after 5pm day after next, Fri after 5pm Sunday, Sat before 5pm Sunday, Sat after 5pm Tuesday, Sunday Tuesday.
- **Delivery to the buyer's address:** not priced on the site. Arranged and quoted over WhatsApp after the order arrives in Accra (motor riders, distance based). Accra pickup is possible.
- **Fit notes:** products have `fit` text and `shift` (New Balance 9060: wear 41, order 43). The shop warns and the buyer must choose. Store the size ordered and the note shown. Never change a size automatically.
- **Stock holds:** unpaid orders hold stock 30 to 60 minutes. Only admin extends. Max 2 open unpaid orders per phone and IP.

## Security
The server enforces the checklist items that do not need Cloudflare or Postgres: httpOnly Strict session cookies, a per-session CSRF token on every change, login rate limits plus a 15-minute lockout after 5 failures, an admin IP allowlist (`ADMIN_IP_ALLOWLIST`), origin checks, security headers, honeypot rejection, and MFA that stays off until `ADMIN_TOTP_SECRET` is set. Turnstile is checked on checkout, tracking, and both sign-ins when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set, and both are required in production. Set `TRUST_PROXY=true` only when a reverse proxy is in front, or clients can spoof their address.

Still outside this app: row-level security needs Postgres, and the pages still use inline scripts, so the content security policy allows them. Text from customers is escaped before it is shown.

## Still mock or missing
- Logo: no vector available. Drop SVG or transparent PNG files into `assets/` and replace the text "BS" in each header. Use the monogram for the favicon.
- Product photos: add `img` URLs. Use consistent plain-background photos.
- Size chart (`SIZES` in api.js) is a placeholder. Verify per brand.
- WhatsApp number `WA` in api.js is a placeholder. It belongs in settings.
- The earlier file `baron-sneakers-rebuild-prompt.txt` is older than this README. Where they differ this README wins: no delivery fee setting, no payment details stored on the site, STC Tudu statuses, 30 to 60 minute holds, black and white UI.
