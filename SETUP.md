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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(strava_id, activity_id)
);

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

## Step 4: Cloudflare Worker (Auth)

This keeps your Strava client secret secure on the server side.

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
   - `ALLOWED_ORIGIN` — `https://YOUR_USERNAME.github.io`
9. Note your worker URL — looks like `https://sailstats-auth.YOUR_SUBDOMAIN.workers.dev`

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

Replace each value with your actual credentials from steps 1-4.

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
  → Taps "Connect with Strava"
  → Redirected to Strava OAuth page
  → Authorises the app
  → Strava redirects back with a code
  → App sends code to Cloudflare Worker (/token)
  → Worker exchanges code for tokens using client_secret (kept safe server-side)
  → Worker returns tokens to the app
  → App saves user + tokens to Supabase (users table)
  → App fetches activities from Strava API
  → Sailor picks an activity, sets up course, analyses
  → Analysis results saved to Supabase (analyses table)
  → Next visit: app checks Supabase for existing session
  → If token expired: Worker refreshes it
  → Sailor sees their past analyses and can add new ones
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
3. **Strava** — test by clicking "Connect with Strava" and authorising
4. **Supabase** — check the tables in the Supabase dashboard after signing in

## Troubleshooting

**Strava says "invalid redirect"**
→ Check the callback domain in Strava API settings matches exactly (no https://, no trailing slash)

**Map doesn't load**
→ Check the Mapbox token is correct and not expired

**Login doesn't persist between visits**
→ Check Supabase URL and anon key are correct. Check browser console for errors.

**Worker returns CORS errors**
→ Check ALLOWED_ORIGIN in worker environment variables matches your GitHub Pages URL exactly (including https://)

**Analysis results not saving**
→ Check Supabase tables were created correctly. Check the RLS policies are in place.
