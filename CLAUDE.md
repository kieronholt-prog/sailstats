# CLAUDE.md — SailStats Project Context

## What This Is

SailStats is a GPS track analysis app for dinghy sailors at Warsash Sailing Club (WSC) and beyond. It analyses sailing activity GPS tracks to provide performance insights including tack/gybe detection and quality scoring, VMG analysis, speed statistics, and leg-by-leg breakdowns based on actual course marks.

## Architecture

```
┌─────────────┐     OAuth code     ┌──────────────────┐
│  Browser     │ ──────────────► │ Cloudflare Worker │
│  (index.html)│ ◄────────────── │ (worker.js)       │
│              │    tokens         │ Holds: CLIENT_SEC │
│              │                   └──────────────────┘
│              │                          │
│              │    REST API              │ Strava token
│              │ ◄──────────────► ┌──────┴──────┐
│              │                   │   Supabase   │
│              │                   │  users table │
│              │                   │ analyses tbl │
│              │                   └─────────────┘
│              │
│              │    GPS streams    ┌─────────────┐
│              │ ◄──────────────  │  Strava API  │
└─────────────┘                   └─────────────┘
```

### Components

1. **Frontend** (`index.html`) — Single HTML file, React 18 via CDN, Babel for JSX, Recharts for charts, Mapbox GL for maps. Hosted on GitHub Pages.

2. **Auth Worker** (`worker.js`) — Cloudflare Worker that handles Strava OAuth token exchange. Keeps client_secret server-side. Single endpoint: `POST /token`.

3. **Database** (Supabase) — Two tables:
   - `users` — Strava ID, name, profile pic, access/refresh tokens, token expiry
   - `analyses` — Per-activity analysis results: stats, tack/gybe scores, leg summaries, course setup, mark overrides

### Data Flow
```
Strava OAuth → Worker exchanges code → Tokens stored in Supabase
  → App fetches activities from Strava API using stored token
  → User selects activity → GPS stream fetched from Strava
  → Course setup (WSC course letter, laps, drag marks)
  → Analysis engine runs in browser
  → Results displayed AND saved to Supabase
  → Next visit: session restored from Supabase, past analyses shown
```

## Tech Stack

- **React 18** via CDN (UMD build, no build step)
- **Babel Standalone** for in-browser JSX
- **Recharts** for charts (line, bar, area, radar)
- **Mapbox GL JS** for satellite map with draggable markers
- **Supabase** (REST API, no SDK — lightweight fetch wrapper in code)
- **Cloudflare Workers** for auth
- **Strava API** for activity data
- Hosted on **GitHub Pages**

## Key Configuration (top of index.html)

```javascript
const CONFIG = {
  MAPBOX_TOKEN: "...",           // from account.mapbox.com
  STRAVA_CLIENT_ID: "...",       // from strava.com/settings/api
  WORKER_URL: "https://...",     // Cloudflare Worker URL
  SUPABASE_URL: "https://...",   // from Supabase dashboard
  SUPABASE_ANON_KEY: "...",      // from Supabase Settings → API
};
```

## Supabase Schema

```sql
users (
  strava_id BIGINT UNIQUE,    -- primary identifier
  firstname, lastname TEXT,
  profile_pic TEXT,
  access_token, refresh_token TEXT,
  token_expires BIGINT         -- unix timestamp
)

analyses (
  strava_id BIGINT,            -- FK to users
  activity_id TEXT,            -- Strava activity ID or "file_xxx"
  activity_name TEXT,
  activity_date TIMESTAMPTZ,
  course_letter TEXT,          -- WSC course letter or null
  laps INTEGER,
  wind_direction REAL,
  mark_overrides JSONB,        -- {markName: {lat, lon}}
  stats JSONB,                 -- {totalDist, duration, maxSpeed, ...}
  tack_scores JSONB,           -- [{q, ch, preS, minS, rt}, ...]
  gybe_scores JSONB,
  leg_summary JSONB,           -- [{from, to, type, avgSpeed, ...}]
  UNIQUE(strava_id, activity_id)
)
```

## Cloudflare Worker

Single file `worker.js` with one endpoint:
- `POST /token` — receives `{code, grant_type}` or `{refresh_token, grant_type}`, adds client_id and client_secret from env vars, proxies to Strava, returns response

Environment variables (set in Cloudflare dashboard):
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET` (encrypted)
- `ALLOWED_ORIGIN` (GitHub Pages URL for CORS)

## User Flow

1. **Home** — Sign in with Strava or upload GPX/FIT file
2. **Activities** — Browse Strava activities + see past analyses with results summary
3. **Course Setup** — Select WSC course letter + laps, view track on satellite map, drag laid marks
4. **Analysis** — Four tabs: Overview, Manoeuvres, Legs, Speed

## Session Persistence

- On login: Strava athlete ID stored in `localStorage` as `ss_strava_id`
- Tokens stored in Supabase `users` table (not in browser)
- On return visit: app reads strava_id from localStorage, fetches user from Supabase, checks token expiry, refreshes via Worker if needed
- Sign out: clears localStorage, returns to home

## Analysis Engine — Key Functions

All analysis logic lives in `index.html` (Babel/React bundle). Important pieces:

- `parseGPX(text)` / `parseFIT(buffer)` — File parsers → track points
- `enrich(points)` — SOG, COG, distance; optional smoothing
- `detectMans(points)` — Stable segments + coarse manoeuvres from segment COG changes
- `deriveWindAndClassify(manoeuvres, stableSegments, userWind, pts)` — Wind direction, tack vs gybe, crossing (P→S / S→P)
- `applyDetectionSettings(manoeuvres, pts, detSettings)` — Per-type thresholds (tack vs gybe), before/after point windows
- `scoreTackManoeuvre(m, pts, baselines, windTrace, windDir)` — Per-tack quality (speed recovery, COG to baseline, VMG cost, exit bias)
- `runAnalysis(...)` — Full pipeline: wind trace, legs/VMG, tacks/gybes arrays, stats

**Not implemented:** tack grouping (`buildTackGroups`) and intent labels (reactive / proactive / tactical). Each tack is scored on its own. See `TACK_ALGORITHM_SPEC.md` for the original spec and “deferred” sections.

**Mark roundings:** `detectLegsFromMarks` returns sequential mark hits plus `analyzeMarkRoundingDetails` builds a time/distance zone around each closest approach. Integrated |ΔCOG| in the zone is split vs each overlapping tack/gybe detection window (`manoeuvrePortionDeg` vs `markArcResidualDeg`) and timing vs closest approach (`splitRole`: before / at / after). Exposed as `analysis.markRoundingDetails` and per-manoeuvre `markRounding`.

- `detectLegsFromMarks(points, markPositions, laps, ...)` — Legs including START/FINISH when line defined

## WSC Data

### Marks
Fixed marks (known chart positions, not draggable): Hamble, Castle, Coronation, BP, Reach, Esso, NE Netley, Calshot, Hill Head, Hook, N/S Sturbridge, Browndown, DZ, Jordan

Laid marks (approximate defaults, user drags): W, L, G1, G2, X, Y

**Note**: All mark positions are APPROXIMATE and need verifying against chart data.

### Courses
A through W plus CUSTOM — each maps to an ordered mark sequence. Need updating to match WSC actual course cards.

## Future Plans

### Phase 1 (current)
- Refine WSC marks from chart data
- Complete course definitions
- Strava webhook for auto-sync (rather than manual fetch)
- Polish UI, mobile optimisation

### Phase 2 — Compass Hardware
- nRF52840 DK + magnetometer broadcasting heading via ANT
- Connect IQ Data Field for Garmin watches
- True heading in FIT files → dramatically better analysis

### Phase 3 — Race Management
- BLE boat ID broadcast for automated finish recording
- Camera AI for line crossing detection
- Integration with Race Officer app and Halsail

### Phase 4 — Social
- Fleet comparison across sailors
- Season tracking in Supabase
- Training recommendations

## Development Workflow

Edit in Cursor → preview locally (`open index.html`) → commit & push → live on GitHub Pages in ~30 seconds. Worker changes: edit in Cloudflare dashboard or push via Wrangler CLI.
