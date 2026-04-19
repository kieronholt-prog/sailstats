# SailStats Setup Guide

## Overview

SailStats has three components:
1. **Frontend** (`index.html`) — React app hosted on GitHub Pages
2. **Auth Worker** (`worker.js`) — Cloudflare Worker for secure Strava token exchange
3. **Database** — Supabase for persistent user sessions and analysis history

## Step 1: Supabase (Database)

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project (name it `sailstats`, choose EU West region)
3. Wait for the project to provision (~2 minutes)
4. Go to **SQL Editor** and run this SQL to create the tables:

```sql
-- Users table — stores Strava credentials
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  strava_id BIGINT UNIQUE NOT NULL,
  firstname TEXT,
  lastname TEXT,
  profile_pic TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Analyses table — stores analysis results per activity
CREATE TABLE analyses (
  id BIGSERIAL PRIMARY KEY,
  strava_id BIGINT NOT NULL REFERENCES users(strava_id),
  activity_id TEXT NOT NULL,
  activity_name TEXT,
  activity_date TIMESTAMPTZ,
  course_letter TEXT,
  laps INTEGER DEFAULT 1,
  wind_direction REAL,
  mark_overrides JSONB DEFAULT '{}',
  stats JSONB DEFAULT '{}',
  tack_scores JSONB DEFAULT '[]',
  gybe_scores JSONB DEFAULT '[]',
  leg_summary JSONB DEFAULT '[]',
  course_setup JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(strava_id, activity_id)
);

-- If `analyses` already existed without this column, run once (safe if column exists):
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS course_setup JSONB DEFAULT '{}'::jsonb;

-- Enable Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;

-- Allow anonymous access (the anon key is public, data is protected by Strava OAuth)
-- For a production app you'd use Supabase Auth, but for a club app this is fine
CREATE POLICY "Allow all on users" ON users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on analyses" ON analyses FOR ALL USING (true) WITH CHECK (true);
```

5. Go to **Settings → API** and note down:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon/public key** — the long `eyJ...` string

## Step 2: Strava API App

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api)
2. Create a new API application:
   - **Application Name**: SailStats
   - **Category**: Training Analysis
   - **Website**: `https://YOUR_USERNAME.github.io/sailstats`
   - **Authorization Callback Domain**: `YOUR_USERNAME.github.io`
3. Note down:
   - **Client ID** — a number like `12345`
   - **Client Secret** — a long hex string

## Step 3: Mapbox Token

1. Go to [account.mapbox.com](https://account.mapbox.com)
2. Create a free account if you don't have one
3. Your default public token is on the main page — copy it
   - Looks like `pk.eyJ1Ijoi...`

**Detailed click-by-click steps** (Supabase SQL, Cloudflare variables, `ALLOWED_ORIGIN`, redeploy): see **[AUTH_WORKER_SETUP.md](./AUTH_WORKER_SETUP.md)** in this repo.

## Step 3b: Supabase Auth + `users.auth_user_id` (required for email login)

1. In Supabase go to **Authentication → Providers** and ensure **Email** is enabled (default).
2. In **SQL Editor**, run **only** the block below (lines starting with `--` are **SQL comments**, not separate instructions — the whole block is valid PostgreSQL):

```sql
-- Link Strava row to Supabase Auth user (one Strava account per login)
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE;
CREATE INDEX IF NOT EXISTS idx_users_auth_user_id ON users(auth_user_id);

-- Optional: tighten RLS later so only the signed-in user can read/write their analyses.
-- For a first deploy you can keep the existing permissive policies until sessions work.
```

   Optional: confirm the column with another query or the Table Editor — see **[AUTH_WORKER_SETUP.md](./AUTH_WORKER_SETUP.md)** §1.3.

3. Create a **service role** key (**Settings → API → service_role**). Put it **only** in the Worker (never in `index.html`). The Worker uses it to read/write `users` (Strava tokens) by `auth_user_id`.

## Step 3c: Saved course setup column (if “Save course setup” errors)

The app can store crop + course choices per activity in **`analyses.course_setup`**. New installs get this from the main `CREATE TABLE analyses` block above. **Existing** projects should run once in **SQL Editor**:

```sql
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS course_setup JSONB DEFAULT '{}'::jsonb;
```

## Step 4: Cloudflare Worker (Auth)

This keeps your Strava client secret secure on the server side and implements **email/password sessions** (HttpOnly cookie) plus **Strava API proxying**.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to **Workers & Pages → Create**
3. Click **Create Worker**
4. Name it `sailstats-auth`
5. Click **Deploy** (deploys the default hello world)
6. Click **Edit Code** and paste the contents of `worker.js`
7. Click **Deploy**
8. Go to **Settings → Variables and Secrets** and add:
   - `STRAVA_CLIENT_ID` — your Strava client ID
   - `STRAVA_CLIENT_SECRET` — your Strava client secret (click **Encrypt**)
   - `SUPABASE_URL` — same as in the app (e.g. `https://abcdefgh.supabase.co`)
   - `SUPABASE_ANON_KEY` — same **anon** / publishable key as in the app (for Auth `signUp` / `signIn` from the Worker)
   - `SUPABASE_SERVICE_ROLE_KEY` — **service_role** JWT (secret) — for `users` upserts and lookups by `auth_user_id`
   - `SESSION_SECRET` — long random string (e.g. 32+ bytes from `openssl rand -hex 32`) — encrypts the session cookie
   - `ALLOWED_ORIGIN` — **exact** frontend origin, **no path**: `https://YOUR_USERNAME.github.io`  
     If the app is served from a project page, use that origin (e.g. `https://YOUR_USERNAME.github.io/sailstats` is **wrong** — the origin is still `https://YOUR_USERNAME.github.io`).
9. Note your worker URL — looks like `https://sailstats-auth.YOUR_SUBDOMAIN.workers.dev`

**CORS + cookies:** the browser only sends the `ss_session` cookie on `fetch(..., { credentials: "include" })` when `ALLOWED_ORIGIN` matches the page origin exactly.

## Step 5: Configure the App

Open `index.html` and find the CONFIG block near the top:

```javascript
const CONFIG = {
  MAPBOX_TOKEN: "YOUR_MAPBOX_TOKEN",
  STRAVA_CLIENT_ID: "YOUR_STRAVA_CLIENT_ID",
  WORKER_URL: "https://sailstats-auth.YOUR_SUBDOMAIN.workers.dev",
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_ANON_KEY",
};
```

Replace each value with your actual credentials from the steps above.

## Step 6: Deploy to GitHub Pages

```bash
cd ~/Projects/sailstats
git add -A
git commit -m "SailStats with Supabase and Worker auth"
git push
```

In the GitHub repo settings, enable Pages from the `main` branch.

Your app is now live at `https://YOUR_USERNAME.github.io/sailstats/`

## How It All Fits Together

```
Sailor opens app
  → Creates a SailStats account (email/password) or signs in
  → Worker sets HttpOnly session cookie (encrypted Supabase refresh)
  → Taps “Link Strava” → Strava OAuth → redirect with ?code=
  → App POSTs code to Worker /strava/exchange (with cookie)
  → Worker exchanges code, saves tokens in Supabase users row (service role), keyed by auth_user_id
  → Activities & streams are fetched via Worker proxy (/strava/activities, /strava/streams/…)
  → Short-lived Supabase JWT returned to the app for saving analyses (RLS-ready)
  → Next visit: GET /session refreshes cookie + returns Supabase JWT + Strava linked flag
```

## File Structure

```
sailstats/
├── CLAUDE.md      — AI context for Cursor development
├── index.html     — The complete app (single file)
├── worker.js      — Cloudflare Worker source (deploy separately)
└── README.md      — Optional, for the GitHub repo
```

## Testing

1. **File upload** works immediately — no API keys needed for GPX/FIT upload
2. **Mapbox** — test by selecting a course in the course setup screen
3. **Strava** — sign in, then “Link Strava”, then open activities
4. **Supabase** — check `users` (with `auth_user_id`) and `analyses` in the dashboard after signing in

## Troubleshooting

**Strava says "invalid redirect"**
→ Check the callback domain in Strava API settings matches exactly (no https://, no trailing slash)

**Map doesn't load**
→ Check the Mapbox token is correct and not expired

**Login doesn't persist between visits**
→ Confirm `ALLOWED_ORIGIN` matches the browser address **origin** exactly. Cookies are `Secure; SameSite=None` and only sent to the Worker when `fetch(..., { credentials: "include" })` is used (the app does this). Check **Application → Cookies** for `ss_session` on the Worker host.

**Worker returns CORS errors**
→ `ALLOWED_ORIGIN` must be the **exact** frontend origin (scheme + host + optional port), not `*`, and must match the page you open. After changing env vars, **redeploy** the Worker.

**Analysis results not saving**
→ Check Supabase tables were created correctly. Check the RLS policies are in place.
