/**
 * SailStats — Cloudflare Worker
 *
 * - Supabase Auth (email/password) with HttpOnly encrypted session cookie
 * - Strava OAuth exchange + token storage (service role), linked to auth user
 * - Proxied Strava API (activities, streams) so Strava access tokens stay server-side
 *
 * Secrets / vars (Dashboard → Settings → Variables):
 *   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *   SESSION_SECRET        — long random string (encrypts cookie; required for auth)
 *   ALLOWED_ORIGIN        — exact site origin, e.g. https://YOURUSER.github.io (no path)
 *
 * Optional: bind KV namespace as SESSIONS for future server-side session store;
 *           cookie-only mode works without KV.
 */

const COOKIE = "ss_session";
const SESS_MAX = 60 * 60 * 24 * 30;

function parseCookies(h) {
  const o = {};
  const c = h.get("cookie");
  if (!c) return o;
  for (const p of c.split(";")) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    const k = p.slice(0, i).trim();
    o[k] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return o;
}

async function sha256raw(str) {
  const b = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", b);
  return new Uint8Array(buf);
}

async function getAesKey(sessionSecret) {
  const raw = await sha256raw(sessionSecret);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(secret, payload) {
  const key = await getAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const u = new Uint8Array(iv.length + ct.length);
  u.set(iv, 0);
  u.set(ct, iv.length);
  let bin = "";
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function unseal(secret, b64) {
  try {
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const iv = u.slice(0, 12);
    const ct = u.slice(12);
    const key = await getAesKey(secret);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

function cors(env, extra = {}) {
  const origin = env.ALLOWED_ORIGIN || "*";
  const h = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
  if (origin !== "*") h["Access-Control-Allow-Credentials"] = "true";
  return h;
}

function json(data, status = 200, env, cookies = []) {
  const headers = new Headers({ ...cors(env), "Content-Type": "application/json" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(data), { status, headers });
}

async function supabaseAuth(env, path, body) {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function readSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookies = parseCookies(request.headers);
  const raw = cookies[COOKIE];
  if (!raw) return null;
  return unseal(env.SESSION_SECRET, raw);
}

function cookieSet(value) {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESS_MAX}`;
}
function cookieClear() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`;
}

async function refreshSupabaseSession(env, supabaseRefresh) {
  const { ok, data } = await supabaseAuth(env, "token?grant_type=refresh_token", {
    refresh_token: supabaseRefresh,
    grant_type: "refresh_token",
  });
  if (!ok) return { error: data };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || supabaseRefresh,
    user: data.user,
  };
}

async function restServiceGet(env, path) {
  const r = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

async function restServiceUpsertUsers(env, row) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/users?on_conflict=strava_id`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify([row]),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

async function getUserRowByAuthId(env, authUserId) {
  const q = `/rest/v1/users?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=*&limit=1`;
  const { ok, data } = await restServiceGet(env, q);
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function exchangeStrava(env, code) {
  const body = {
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
  };
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function refreshStrava(env, refreshToken) {
  const body = {
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

async function persistStravaTokensFromRow(env, row, tokens) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt =
    tokens.expires_at != null
      ? Number(tokens.expires_at)
      : tokens.expires_in != null
      ? nowSec + Number(tokens.expires_in)
      : null;
  const merge = {
    strava_id: row.strava_id,
    auth_user_id: row.auth_user_id,
    firstname: row.firstname,
    lastname: row.lastname,
    profile_pic: row.profile_pic,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || row.refresh_token,
    token_expires: expiresAt,
    updated_at: new Date().toISOString(),
  };
  return restServiceUpsertUsers(env, merge);
}

async function ensureStravaAccessToken(env, row) {
  if (!row?.refresh_token) return null;
  const expMs = row.token_expires ? Number(row.token_expires) * 1000 : 0;
  if (row.access_token && expMs > Date.now() + 60_000) return row.access_token;
  const { ok, data } = await refreshStrava(env, row.refresh_token);
  if (!ok || !data.access_token) return null;
  await persistStravaTokensFromRow(env, row, data);
  return data.access_token;
}

async function buildSessionJson(request, env) {
  const sess = await readSession(request, env);
  if (!sess?.supabase_refresh) return json({ ok: false, error: "no_session" }, 401, env);

  const sb = await refreshSupabaseSession(env, sess.supabase_refresh);
  if (sb.error) return json({ ok: false, error: "supabase_refresh", detail: sb.error }, 401, env);

  const newCookie = await seal(env.SESSION_SECRET, {
    supabase_refresh: sb.refresh_token,
    uid: sb.user.id,
  });

  const uid = sb.user.id;
  const row = await getUserRowByAuthId(env, uid);
  const stravaLinked = !!(row && row.strava_id && row.refresh_token);
  let athlete = null;
  if (stravaLinked) {
    athlete = {
      id: row.strava_id,
      firstname: row.firstname,
      lastname: row.lastname,
    };
  }

  return json(
    {
      ok: true,
      user: { id: uid, email: sb.user.email },
      strava: { linked: stravaLinked, athlete },
      supabase_access_token: sb.access_token,
    },
    200,
    env,
    [cookieSet(newCookie)]
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(env) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Lets you confirm the real SailStats bundle is deployed (open Worker URL in a browser).
    if (path === "/" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "sailstats-auth",
          message: "Worker script is live. Configure secrets and use routes from the app (/auth/*, /session, /strava/*).",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!env.ALLOWED_ORIGIN || env.ALLOWED_ORIGIN === "*") {
      const h = new Headers({
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      return new Response(
        JSON.stringify({
          error: "ALLOWED_ORIGIN must be set to your exact frontend origin (required for cookie auth).",
        }),
        { status: 500, headers: h }
      );
    }

    try {
      /* -------- Auth: sign up -------- */
      if (path === "/auth/signup" && request.method === "POST") {
        if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET not configured" }, 500, env);
        const body = await request.json().catch(() => ({}));
        const { email, password } = body;
        if (!email || !password) return json({ error: "email_and_password_required" }, 400, env);
        const { ok, data } = await supabaseAuth(env, "signup", { email, password });
        if (!ok) return json({ error: "signup_failed", detail: data }, 400, env);
        if (!data.access_token || !data.refresh_token) {
          return json(
            {
              ok: true,
              needs_confirmation: true,
              message: "Check your email to confirm your account, then sign in.",
            },
            200,
            env
          );
        }
        const sealed = await seal(env.SESSION_SECRET, {
          supabase_refresh: data.refresh_token,
          uid: data.user.id,
        });
        return json(
          {
            ok: true,
            user: { id: data.user.id, email: data.user.email },
            strava: { linked: false, athlete: null },
            supabase_access_token: data.access_token,
          },
          200,
          env,
          [cookieSet(sealed)]
        );
      }

      /* -------- Auth: sign in -------- */
      if (path === "/auth/signin" && request.method === "POST") {
        if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET not configured" }, 500, env);
        const body = await request.json().catch(() => ({}));
        const { email, password } = body;
        if (!email || !password) return json({ error: "email_and_password_required" }, 400, env);
        const { ok, data } = await supabaseAuth(env, "token?grant_type=password", {
          email,
          password,
          grant_type: "password",
        });
        if (!ok) return json({ error: "invalid_credentials", detail: data }, 401, env);
        const sealed = await seal(env.SESSION_SECRET, {
          supabase_refresh: data.refresh_token,
          uid: data.user.id,
        });
        const row = await getUserRowByAuthId(env, data.user.id);
        const stravaLinked = !!(row && row.strava_id && row.refresh_token);
        const athlete =
          stravaLinked && row
            ? { id: row.strava_id, firstname: row.firstname, lastname: row.lastname }
            : null;
        return json(
          {
            ok: true,
            user: { id: data.user.id, email: data.user.email },
            strava: { linked: stravaLinked, athlete },
            supabase_access_token: data.access_token,
          },
          200,
          env,
          [cookieSet(sealed)]
        );
      }

      /* -------- Auth: sign out -------- */
      if (path === "/auth/logout" && request.method === "POST") {
        return json({ ok: true }, 200, env, [cookieClear()]);
      }

      /* -------- Session (refresh cookie + return tokens / flags) -------- */
      if (path === "/session" && request.method === "GET") {
        if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET not configured" }, 500, env);
        return buildSessionJson(request, env);
      }

      /* -------- Strava: link account (after OAuth redirect) -------- */
      if (path === "/strava/exchange" && request.method === "POST") {
        if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET not configured" }, 500, env);
        const sess = await readSession(request, env);
        if (!sess?.supabase_refresh) return json({ error: "sign_in_first" }, 401, env);
        const sb = await refreshSupabaseSession(env, sess.supabase_refresh);
        if (sb.error) return json({ error: "supabase_refresh" }, 401, env);
        const authUserId = sb.user.id;

        const body = await request.json().catch(() => ({}));
        const { code, redirect_uri } = body;
        if (!code) return json({ error: "code_required" }, 400, env);

        const ex = await exchangeStrava(env, code);
        if (!ex.ok || !ex.data.access_token) {
          return json({ error: "strava_exchange_failed", detail: ex.data }, ex.status || 400, env);
        }
        const d = ex.data;
        const athlete = d.athlete;
        if (!athlete || !athlete.id) return json({ error: "no_athlete_in_token_response", detail: d }, 400, env);

        const nowSec = Math.floor(Date.now() / 1000);
        const expiresAt =
          d.expires_at != null
            ? Number(d.expires_at)
            : d.expires_in != null
            ? nowSec + Number(d.expires_in)
            : null;

        const row = {
          strava_id: athlete.id,
          auth_user_id: authUserId,
          firstname: athlete.firstname,
          lastname: athlete.lastname,
          profile_pic: athlete.profile_medium || athlete.profile,
          access_token: d.access_token,
          refresh_token: d.refresh_token,
          token_expires: expiresAt,
          updated_at: new Date().toISOString(),
        };
        const up = await restServiceUpsertUsers(env, row);
        if (!up.ok) return json({ error: "save_user_failed", detail: up.data }, 500, env);

        const sealed = await seal(env.SESSION_SECRET, {
          supabase_refresh: sb.refresh_token,
          uid: authUserId,
        });

        return json(
          {
            ok: true,
            user: { id: authUserId, email: sb.user.email },
            strava: {
              linked: true,
              athlete: { id: athlete.id, firstname: athlete.firstname, lastname: athlete.lastname },
            },
            supabase_access_token: sb.access_token,
          },
          200,
          env,
          [cookieSet(sealed)]
        );
      }

      /* -------- Strava: list activities (proxy) -------- */
      if (path === "/strava/activities" && request.method === "GET") {
        const sess = await readSession(request, env);
        if (!sess?.supabase_refresh) return json({ error: "sign_in_first" }, 401, env);
        const sb = await refreshSupabaseSession(env, sess.supabase_refresh);
        if (sb.error) return json({ error: "supabase_refresh" }, 401, env);
        const row = await getUserRowByAuthId(env, sb.user.id);
        const tok = await ensureStravaAccessToken(env, row);
        if (!tok) return json({ error: "strava_not_linked_or_tokens" }, 400, env);
        const page = url.searchParams.get("page") || "1";
        const sr = await fetch(
          `https://www.strava.com/api/v3/athlete/activities?per_page=30&page=${encodeURIComponent(page)}`,
          { headers: { Authorization: `Bearer ${tok}` } }
        );
        const data = await sr.json();
        const sealed = await seal(env.SESSION_SECRET, {
          supabase_refresh: sb.refresh_token,
          uid: sb.user.id,
        });
        return new Response(JSON.stringify(data), {
          status: sr.status,
          headers: { ...cors(env), "Content-Type": "application/json", "Set-Cookie": cookieSet(sealed) },
        });
      }

      /* -------- Strava: activity streams (proxy) -------- */
      if (path.startsWith("/strava/streams/") && request.method === "GET") {
        const id = path.replace("/strava/streams/", "").split("/")[0];
        if (!id) return json({ error: "id_required" }, 400, env);
        const sess = await readSession(request, env);
        if (!sess?.supabase_refresh) return json({ error: "sign_in_first" }, 401, env);
        const sb = await refreshSupabaseSession(env, sess.supabase_refresh);
        if (sb.error) return json({ error: "supabase_refresh" }, 401, env);
        const row = await getUserRowByAuthId(env, sb.user.id);
        const tok = await ensureStravaAccessToken(env, row);
        if (!tok) return json({ error: "strava_not_linked_or_tokens" }, 400, env);
        const sr = await fetch(
          `https://www.strava.com/api/v3/activities/${encodeURIComponent(id)}/streams?keys=time,latlng,velocity_smooth,heartrate,altitude&key_by_type=true`,
          { headers: { Authorization: `Bearer ${tok}` } }
        );
        const data = await sr.json();
        const sealed = await seal(env.SESSION_SECRET, {
          supabase_refresh: sb.refresh_token,
          uid: sb.user.id,
        });
        return new Response(JSON.stringify(data), {
          status: sr.status,
          headers: { ...cors(env), "Content-Type": "application/json", "Set-Cookie": cookieSet(sealed) },
        });
      }

      /* -------- Legacy: POST /token (Strava only, for tools — prefer /strava/*) -------- */
      if (path === "/token" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const stravaBody = {
          client_id: env.STRAVA_CLIENT_ID,
          client_secret: env.STRAVA_CLIENT_SECRET,
          grant_type: body.grant_type || "authorization_code",
        };
        if (body.grant_type === "refresh_token") stravaBody.refresh_token = body.refresh_token;
        else stravaBody.code = body.code;
        const stravaResp = await fetch("https://www.strava.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(stravaBody),
        });
        const data = await stravaResp.json();
        return new Response(JSON.stringify(data), {
          status: stravaResp.status,
          headers: { ...cors(env), "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404, headers: cors(env) });
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, env);
    }
  },
};
