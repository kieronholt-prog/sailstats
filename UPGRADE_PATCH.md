# Upgrading sailstats.html to v2 (Supabase + Worker Auth)

The full v2 app is too large to generate in one pass. Here's how to upgrade the v1 (`sailstats.html`) in Cursor:

## 1. Replace the CONFIG block

Find this at the top of the `<script>` section:

```javascript
// OLD (v1)
const MAPBOX_TOKEN="YOUR_MAPBOX_TOKEN";
const STRAVA_CLIENT_ID="YOUR_CLIENT_ID";
const STRAVA_CLIENT_SECRET="YOUR_CLIENT_SECRET";
const STRAVA_REDIRECT=window.location.origin+window.location.pathname;
```

Replace with:

```javascript
const CONFIG = {
  MAPBOX_TOKEN: "YOUR_MAPBOX_TOKEN",
  STRAVA_CLIENT_ID: "YOUR_STRAVA_CLIENT_ID",
  WORKER_URL: "https://sailstats-auth.YOUR_SUBDOMAIN.workers.dev",
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_ANON_KEY",
};
const STRAVA_REDIRECT = window.location.origin + window.location.pathname;
```

## 2. Add the Supabase client (after CONFIG)

```javascript
const supabase = {
  headers() {
    return {
      "apikey": CONFIG.SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    };
  },
  async select(table, query = "") {
    const r = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: this.headers() });
    return r.json();
  },
  async upsert(table, data) {
    const r = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...this.headers(), "Prefer": "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify(data),
    });
    return r.json();
  },
};
```

## 3. Replace the token exchange functions

Replace the old `exchToken` and `refToken` that called Strava directly:

```javascript
async function exchangeToken(code) {
  const r = await fetch(`${CONFIG.WORKER_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, grant_type: "authorization_code" }),
  });
  return r.json();
}

async function refreshToken(refreshTok) {
  const r = await fetch(`${CONFIG.WORKER_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshTok, grant_type: "refresh_token" }),
  });
  return r.json();
}
```

## 4. Add user persistence functions (after token functions)

```javascript
async function saveUser(athlete, tokens) {
  return supabase.upsert("users", {
    strava_id: athlete.id,
    firstname: athlete.firstname,
    lastname: athlete.lastname,
    profile_pic: athlete.profile_medium || athlete.profile,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires: tokens.expires_at,
    updated_at: new Date().toISOString(),
  });
}

async function loadUser(stravaId) {
  const rows = await supabase.select("users", `strava_id=eq.${stravaId}&limit=1`);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function saveAnalysis(stravaId, activityId, activityName, activityDate, results, courseSetup) {
  return supabase.upsert("analyses", {
    strava_id: stravaId,
    activity_id: String(activityId),
    activity_name: activityName,
    activity_date: activityDate,
    course_letter: courseSetup.courseLetter || null,
    laps: courseSetup.laps || 1,
    wind_direction: results.windDir,
    mark_overrides: courseSetup.markOverrides || {},
    stats: results.stats,
    tack_scores: results.tacks.map(t => ({ q: t.q, ch: t.ch, preS: t.preS, minS: t.minS, rt: t.rt })),
    gybe_scores: results.gybes.map(g => ({ q: g.q, ch: g.ch, preS: g.preS, minS: g.minS, rt: g.rt })),
    leg_summary: results.legs.map(l => ({ from: l.from, to: l.to, type: l.type, avgSpeed: l.avgSpeed, avgVMG: l.avgVMG, efficiency: l.efficiency, duration: l.duration })),
    updated_at: new Date().toISOString(),
  });
}

async function loadAnalyses(stravaId) {
  return supabase.select("analyses", `strava_id=eq.${stravaId}&order=activity_date.desc&limit=50`);
}
```

## 5. Update the OAuth callback in App component

Replace the `sessionStorage`-based OAuth handling with Supabase persistence:

```javascript
// In the OAuth callback useEffect, replace with:
useEffect(() => {
  const p = new URLSearchParams(window.location.search);
  const code = p.get("code");
  if (code) {
    window.history.replaceState({}, "", window.location.pathname);
    exchangeToken(code).then(async d => {
      if (d.access_token) {
        setSTok(d.access_token);
        setSAth(d.athlete);
        localStorage.setItem("ss_strava_id", String(d.athlete.id));
        await saveUser(d.athlete, d);
        setView("activities");
      }
    }).catch(console.error);
  }
}, []);

// Replace session restore with Supabase lookup:
useEffect(() => {
  (async () => {
    try {
      const sid = localStorage.getItem("ss_strava_id");
      if (!sid) return;
      const user = await loadUser(parseInt(sid));
      if (!user) return;
      if (user.token_expires * 1000 > Date.now()) {
        setSTok(user.access_token);
        setSAth({ id: user.strava_id, firstname: user.firstname, lastname: user.lastname });
      } else if (user.refresh_token) {
        const d = await refreshToken(user.refresh_token);
        if (d.access_token) {
          setSTok(d.access_token);
          setSAth({ id: user.strava_id, firstname: user.firstname, lastname: user.lastname });
          await saveUser({ id: user.strava_id, firstname: user.firstname, lastname: user.lastname }, d);
        }
      }
    } catch (e) { console.error("Session restore:", e); }
  })();
}, []);
```

## 6. Save analysis results after running

In the `doAnalysis` function, after `setView("analysis")`, add:

```javascript
if (sAth?.id && result) {
  try {
    await saveAnalysis(sAth.id, actId, actName, actDate, result, { courseLetter, laps, markOverrides });
  } catch (e) { console.warn("Save failed:", e); }
}
```

## 7. Add Sign Out button

In the activities view header, replace the back button with:

```javascript
<button onClick={() => {
  setSTok(null); setSAth(null);
  localStorage.removeItem("ss_strava_id");
  setView("home");
}} style={{background:"none",border:"none",color:C.txM,fontSize:12}}>Sign Out</button>
```

## Summary

These changes mean:
- Strava client_secret never appears in the browser
- Users stay logged in between visits (tokens in Supabase)
- Analysis results are saved and shown on return visits
- Sign out clears local state and returns to home

Open the project in Cursor and ask Claude to apply these patches — it has the full context in CLAUDE.md.
