# Blue Mobile — Sales Ledger

A single-shop sales ledger: **Frontend → Backend API → PostgreSQL**, with **exactly one account**.

Everything that matters (sales, product names, daily notes, day open/closed status,
summaries, profit, settings) lives in PostgreSQL. Two phones signed into the same
account see identical data. The browser stores nothing but a session token and a
tiny UI cache.

---

## 1. Architecture

```
Blue-Mobile.html      one-file frontend (Glass UI, Arabic-first, RTL/LTR, dark/light)
        │  fetch() + Bearer/cookie session
        ▼
server/index.js       Express API  (also serves the HTML and acts as SPA fallback)
        │  pg Pool
        ▼
PostgreSQL            single database — all ledger data
```

| Path | What it is |
|---|---|
| `Blue-Mobile.html` | the whole frontend, no build step |
| `server/index.js` | app wiring, security headers/CSP, auth gate, error handler |
| `server/config.js` | reads the environment, no hard-coded secrets |
| `server/db.js` | `pg` pool, `query()` and `tx()` helpers |
| `server/migrate.js` | migration runner (tracked in `schema_migrations`) |
| `server/migrations/001_init.sql` | the schema |
| `server/middleware/auth.js` | session cookie + `Authorization: Bearer` fallback |
| `server/routes/` | `auth, days, sales, products, notes, data` |
| `server/lib/` | `http` (errors/validation), `names` (autocomplete ranking), `map` (row → API shape) |
| `tests/api.test.js` | 89 backend assertions |
| `tests/e2e.test.js` | 42 assertions in two real browsers = two phones |
| `tests/screens.js` | screenshot pass → `screens/` |

## 2. Setup

```bash
cp .env.example .env      # then edit it — DATABASE_URL and SESSION_SECRET are required
npm install
npm run migrate           # creates/updates the schema, safe to re-run
npm start                 # http://localhost:3000
```

Generate a real secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`.env` is git-ignored; `.env.example` holds placeholders only. No secret, password,
connection string or token is written in the source.

**First run:** open the app and the *Initial Setup* screen asks for a username, an
e-mail and a password — this creates the one and only account. From then on the
app only ever shows *Sign in*: there is no sign-up link, and the API refuses a
second account with `409 account_exists` (the `users` table also carries a
`singleton` unique constraint, so a second row is impossible even from psql).

## 3. Database

| Table | Purpose |
|---|---|
| `users` | the single account: `username`, `email`, `password_hash` (bcrypt), `singleton BOOLEAN UNIQUE CHECK (singleton)` |
| `sessions` | login sessions: SHA-256/HMAC of the token, `expires_at`, `user_agent` |
| `settings` | account-wide `lang` (default `ar`) and `theme` |
| `payment_methods` | seeded `cash`, `card` — sales reference it, so a third method is one INSERT away |
| `days` | one row per business day: `day_date UNIQUE`, `status open\|closed`, `closed_at`; a partial unique index allows only one open day |
| `product_names` | autocomplete dictionary: `name`, `normalized_name UNIQUE`, `usage_count` — **names only, not inventory** |
| `sales` | `invoice_no`, `product_name`, `quantity`, `wholesale_price`, `selling_price`, `payment_method`, `sale_date`, `sale_time`, `created_at` and **generated** `total`, `wholesale_total`, `profit` |
| `notes` | daily notes: `note_text`, `note_date`, `note_time`, `created_at` — never part of any total |

`total`, `wholesale_total` and `profit` are `GENERATED ALWAYS AS ... STORED`
columns, so the arithmetic cannot drift from what the UI shows: 2 × 15/20 gives
40 / 30 / 10 in the database itself. Nothing is deducted from stock — there is no
stock.

Migrations are additive and idempotent (`CREATE TABLE IF NOT EXISTS`, guarded
`ALTER`s); `npm run migrate` records what it applied and drops nothing.

## 4. API

All routes are under `/api`. Everything except `/api/health` and `/api/auth/*`
requires a valid session and answers `401 unauthenticated` without one.

**Auth** — `GET /auth/status` · `POST /auth/setup` · `POST /auth/login` ·
`POST /auth/logout` · `GET /auth/me` · `POST /auth/password`
Passwords are bcrypt-hashed (cost from `BCRYPT_ROUNDS`), never stored or logged in
clear. Login is rate-limited to 10 attempts per 15 minutes per IP+identifier
(`429 too_many_attempts`) and compares against a dummy hash when the user is
unknown, so a wrong username costs the same time as a wrong password.

**Days** — `GET /days` (`?status=`) · `GET /days/current` · `POST /days` ·
`GET /days/:id` · `POST /days/:id/close`
**Sales** — `GET /sales` (`?date`, `?dayId`, `?q`, `?limit`) · `GET /sales/summary` ·
`POST /sales` · `PUT /sales/:id` · `DELETE /sales/:id`
**Products** — `GET /products?q=` (ranked suggestions) · `GET /products/all` · `POST /products`
**Notes** — `GET /notes` (`?dayId`/`?date`) · `POST /notes` · `DELETE /notes/:id`
**Account data** — `GET /bootstrap` · `GET|PUT /settings` · `POST /import` ·
`DELETE /data` (needs `{"confirm":"DELETE"}`)

Writes are refused on a closed day (`409 day_closed`) and when no day is open
(`409 no_open_day`), while every read of a closed day keeps working — closing
locks, it never deletes.

## 5. Tests

```bash
npm run test:api     # 89 assertions — server + database
npm run test:e2e     # 42 assertions — two browser contexts, i.e. two phones
npm test             # both
```

`test:e2e` needs Playwright + Chromium (`npm i -D playwright && npx playwright install chromium`).
Both suites create the account if it is missing and reset the ledger through the
API before running, so they are safe to repeat.

What they cover: setup-once and second-account rejection · login, logout, invalid
credentials, session survival across reloads · 401 on every sales/products/notes/
summary/day route while signed out · sale creation, persistence and arithmetic ·
autocomplete narrowing per character, including from a second session · multiple
notes per day and their absence from every total · closing a day, the lock, and
the day staying viewable · and a full two-device simulation where phone B logs
into the same account and sees phone A's sale, suggestion, note, day status and
totals — then phone A picks up phone B's work after a reload.

## 6. Notes for operators

- Reset to a fresh first-run setup (removes the account and everything it owns):
  `psql "$DATABASE_URL" -c "TRUNCATE users CASCADE;"`
- Wipe the ledger but keep the account: the *Delete all data* button in Settings,
  or `DELETE /api/data` with `{"confirm":"DELETE"}`.
- Sessions last `SESSION_TTL_DAYS` days; *Sign out* deletes the server-side
  session, so a stolen token dies with it.
- The frontend keeps only `bm_token` (session token) and `bm_ui` (last language and
  theme, for a flash-free first paint) in `localStorage`. No sale, product, note,
  day or total is ever written to the device.
