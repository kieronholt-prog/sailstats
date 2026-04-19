# SailStats auth & Worker — step-by-step

Follow these after updating `index.html` and `worker.js` for email login + HttpOnly session + Strava proxy.

---

## Part 1 — Supabase: add `auth_user_id` to `users`

### 1.1 Open the SQL Editor

1. Go to [https://supabase.com/dashboard](https://supabase.com/dashboard) and sign in.
2. Open your **SailStats** project (the one whose URL matches `CONFIG.SUPABASE_URL` in `index.html`, e.g. `https://xxxxx.supabase.co`).
3. In the left sidebar, click **SQL Editor**.
4. Click **New query** (or a blank query tab).

### 1.2 Run the migration SQL

**Only the next fenced block is SQL** for the Supabase SQL Editor. Do **not** paste markdown tables, shell commands (`openssl …`), or Cloudflare origin examples from Part 2 here — those are not SQL.

Paste **exactly** this (you can run it more than once; `IF NOT EXISTS` keeps it safe):

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE;
CREATE INDEX IF NOT EXISTS idx_users_auth_user_id ON users(auth_user_id);
```

5. Click **Run** (or press the shortcut shown in the editor, e.g. `Ctrl+Enter` / `Cmd+Enter`).
6. You should see **Success** with no errors.  
   - If you see `relation "users" does not exist`, create the `users` table first using the original `SETUP.md` SQL, then run this again.
   - If `auth_user_id` already exists, the `IF NOT EXISTS` lines are harmless.

### 1.3 Confirm the column exists (optional)

Pick **one** of these — both are optional checks after §1.2.

**Option A — Table Editor (not SQL):** Left sidebar → **Table Editor** → table **`users`** → you should see column **`auth_user_id`** (type `uuid`, nullable until someone links Strava after login).

**Option B — verify in SQL Editor:** If you prefer a query in the same **SQL Editor**, run this (it is valid SQL):

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'users'
  AND column_name = 'auth_user_id';
```

You want **one row** back with `data_type` = `uuid`. If you get **zero rows**, the column was not created (re-run §1.2 or check you are in the right project/schema).

### 1.4 Enable email auth (if not already)

1. Left sidebar → **Authentication** → **Providers**.
2. Under **Email**, ensure it is **enabled** (and configure “Confirm email” vs instant sign-in to match how you want signups to behave).

### 1.5 Copy keys you will need for the Worker

1. Left sidebar → **Settings** (gear) → **API**.
2. Copy and keep handy (you will paste into Cloudflare in Part 2):
   - **Project URL** → use as `SUPABASE_URL` (e.g. `https://abcdefgh.supabase.co`).
   - **anon public** key → use as `SUPABASE_ANON_KEY` (same value as in `index.html` `CONFIG.SUPABASE_ANON_KEY`).
   - **service_role** key → use as `SUPABASE_SERVICE_ROLE_KEY` (**secret** — never put this in `index.html` or commit it to a public repo).

---

## Part 2 — Cloudflare Worker: environment variables

### 2.1 Open your Worker

1. Go to [https://dash.cloudflare.com](https://dash.cloudflare.com) and select your account.
2. **Workers & Pages** → find your Worker (e.g. `sailstats-auth`) → click it.
3. Open the **Settings** tab (top), then **Variables and Secrets** in the left menu (or scroll to **Environment Variables**).

You will add **plain text** and **encrypted (secret)** variables as below.

### 2.2 `ALLOWED_ORIGIN` (plain text, must be exact)

This is the **browser origin** of the page that runs SailStats — the part of the URL **before** the path.

| You open this URL in the browser | `ALLOWED_ORIGIN` value |
|-----------------------------------|-------------------------|
| `https://myuser.github.io/sailstats/` | `https://myuser.github.io` |
| `https://myuser.github.io/sailstats/index.html` | `https://myuser.github.io` |
| Custom domain `https://sailstats.example.com/` | `https://sailstats.example.com` |
| Local test `http://localhost:8080/index.html` | `http://localhost:8080` |

Rules:

- Include **`https://`** (or **`http://`** only for local dev).
- **Do not** append `/sailstats` or any path.
- **Do not** add a trailing slash (use `https://myuser.github.io` not `https://myuser.github.io/`).
- Scheme and host must match what the address bar shows (including `www` if you use it).

**To add in Cloudflare:**

1. **Add variable** → Name: `ALLOWED_ORIGIN` → Value: your origin from the table above → type **Text** (not secret) → Save.

### 2.3 `SUPABASE_URL` (plain text)

1. **Add variable** → Name: `SUPABASE_URL` → Value: your Supabase project URL, e.g. `https://kqabecigvwvlnuyvpokc.supabase.co` → **Text** → Save.

### 2.4 `SUPABASE_ANON_KEY` (secret recommended)

Same value as `CONFIG.SUPABASE_ANON_KEY` in `index.html` (publishable or legacy anon JWT, whichever works for Auth in your project).

1. **Add variable** → Name: `SUPABASE_ANON_KEY` → paste the key → mark as **Encrypt** (secret) if offered → Save.

### 2.5 `SUPABASE_SERVICE_ROLE_KEY` (secret — required)

From Supabase **Settings → API → service_role** (reveal/copy once).

1. **Add variable** → Name: `SUPABASE_SERVICE_ROLE_KEY` → paste → **Encrypt** → Save.  
   Never expose this in the frontend or GitHub.

### 2.6 `SESSION_SECRET` (secret — required)

Any long random string (at least 32 characters). Example generation on your Mac/Linux terminal:

```bash
openssl rand -hex 32
```

1. **Add variable** → Name: `SESSION_SECRET` → paste the output → **Encrypt** → Save.

### 2.7 Strava variables (if not already set)

- `STRAVA_CLIENT_ID` — text or secret.
- `STRAVA_CLIENT_SECRET` — **Encrypt**.

These should match your Strava API application and what you use in `index.html` for `STRAVA_CLIENT_ID`.

---

## Part 3 — Redeploy the Worker

Cloudflare usually applies new variables to **new** requests quickly, but a redeploy guarantees the latest `worker.js` is live.

### 3.1 If you edit code in the dashboard

1. **Workers & Pages** → your worker → **Edit code**.
2. Paste/update from your repo’s `worker.js`.
3. **Save and deploy** (or **Deploy**).

### 3.2 If you use Wrangler from your machine

```bash
cd /path/to/sailstats
npx wrangler deploy
```

(Use your project’s Wrangler config if you have one; many setups paste the worker manually in the dashboard instead.)

### 3.3 Smoke test (browser)

1. Open your **exact** GitHub Pages URL (same origin you put in `ALLOWED_ORIGIN`).
2. Open **DevTools → Network**.
3. Sign in with email/password.
4. Find a request to your Worker (e.g. `/auth/signin` or `/session`).  
   - Status should be **200** (not blocked by CORS).  
5. **Application → Cookies** → look under your **Worker’s hostname** (e.g. `sailstats-auth.xxx.workers.dev`) for **`ss_session`** after sign-in.  
   - If cookies never appear, `ALLOWED_ORIGIN` almost certainly does not match the page origin.

---

## Quick checklist

- [ ] SQL run in Supabase: `auth_user_id` on `users`
- [ ] `ALLOWED_ORIGIN` = origin only, no path, no trailing slash
- [ ] `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET` set on Worker
- [ ] Strava ID + secret set on Worker
- [ ] Worker saved/deployed
- [ ] `CONFIG.WORKER_URL` in `index.html` points to this Worker’s URL

If anything fails, note the **exact** URL in the address bar and compare it character-for-character to `ALLOWED_ORIGIN`.
