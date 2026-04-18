/**
 * SailStats — Strava OAuth Token Exchange Worker
 * 
 * Deploy to Cloudflare Workers. This keeps the Strava client_secret
 * server-side so it's never exposed in the browser.
 * 
 * Environment variables (set in Cloudflare dashboard):
 *   STRAVA_CLIENT_ID     — from strava.com/settings/api
 *   STRAVA_CLIENT_SECRET — from strava.com/settings/api
 *   ALLOWED_ORIGIN       — your GitHub Pages URL (e.g. https://username.github.io)
 */

export default {
  async fetch(request, env) {
    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // POST /token — exchange code for tokens or refresh tokens
    if (url.pathname === "/token" && request.method === "POST") {
      try {
        const body = await request.json();
        const { code, refresh_token, grant_type } = body;

        // Build Strava token request
        const stravaBody = {
          client_id: env.STRAVA_CLIENT_ID,
          client_secret: env.STRAVA_CLIENT_SECRET,
          grant_type: grant_type || "authorization_code",
        };

        if (grant_type === "refresh_token") {
          stravaBody.refresh_token = refresh_token;
        } else {
          stravaBody.code = code;
        }

        const stravaResp = await fetch("https://www.strava.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(stravaBody),
        });

        const data = await stravaResp.json();

        return new Response(JSON.stringify(data), {
          status: stravaResp.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
