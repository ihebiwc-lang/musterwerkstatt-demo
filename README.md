# Musterwerkstatt — Demo Car Workshop Website

Live demo: **https://autowerkstatt-demmin.ihebiwc.workers.dev**

Portfolio demo of a complete small-business website for a car workshop (German): landing page,
vehicle marketplace with photo galleries, and online appointment booking with live availability.
All branding, addresses and contacts are placeholders (`Musterstadt`).

## Features

- **Landing page** — services, fixed-price list, contact cards, custom date picker + hourly booking slots
- **Fahrzeuge** — vehicle listings with search, filters, sorting, detail dialog with animated photo viewer (zoom, pan, prev/next)
- **Online-Terminbuchung** — 8–18h hourly slots, busy times shown live, double-booking protection, one appointment per phone number per day
- **Hidden admin panel** — vehicle CRUD with photo upload, booking requests inbox (opens via double-Shift, password protected)
- **Legal pages** — Impressum + Datenschutz templates, cookie-free, self-hosted fonts, alt texts

## Stack

- Frontend: plain HTML + CSS + vanilla JS (no frameworks, no build step)
- Backend: Cloudflare Workers (single `src/worker.js`, zero dependencies)
- Database: Cloudflare D1 (SQLite) — vehicles + bookings
- Uploads: Cloudflare KV (images served via `/uploads/:key`)
- Deploy: `wrangler deploy`

## Project structure

```
public/            static frontend (index, fahrzeuge, admin, impressum, datenschutz)
  fonts/           self-hosted woff2 (latin + latin-ext)
  uploads/         legacy dir (production uploads live in KV)
src/worker.js      API: /api/cars, /api/termine, /api/slots, /api/login + static assets
schema.sql         cars table (D1)
termine.sql        bookings table (D1)
seed.sql           demo vehicles
wrangler.jsonc    Worker + D1 + KV + assets config
```

## Run your own

```sh
npx wrangler d1 create werkstatt-db          # put id into wrangler.jsonc
npx wrangler kv namespace create UPLOADS    # put id into wrangler.jsonc
npx wrangler d1 execute werkstatt-db --remote --file schema.sql
npx wrangler d1 execute werkstatt-db --remote --file termine.sql
npx wrangler d1 execute werkstatt-db --remote --file seed.sql
echo "YOUR-PASSWORD" | npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

Admin login: `/admin.html` (password set via secret, not included here).
