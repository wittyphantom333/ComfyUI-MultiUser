/**
 * ComfyUI-MultiUser — API client helpers
 * Centralized fetch utilities for the multiuser backend.
 *
 * Token transport strategy (triple fallback):
 *   1. Authorization: Bearer header  — standard, but some proxies strip it
 *   2. JS-set cookie (multiuser_token) — set via document.cookie, bypasses
 *      proxy Set-Cookie header issues; browser sends automatically
 *   3. localStorage — persistent backup so we can re-set the cookie on load
 */

const API_BASE = "/multiuser";
const TOKEN_KEY = "multiuser_token";
const COOKIE_NAME = "multiuser_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/** Store the JWT in localStorage AND as a JS cookie. */
export function storeToken(token) {
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Lax; max-age=${COOKIE_MAX_AGE}`;
  console.log("[MultiUser] Token stored in localStorage + cookie");
}

/** Remove stored token everywhere (logout). */
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  document.cookie = `${COOKIE_NAME}=; path=/; SameSite=Lax; max-age=0`;
}

// On module load: if we have a token in localStorage but no cookie, re-set it.
(function _ensureCookie() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    const hasCookie = document.cookie.split(";").some(c => c.trim().startsWith(COOKIE_NAME + "="));
    if (!hasCookie) {
      document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Lax; max-age=${COOKIE_MAX_AGE}`;
      console.log("[MultiUser] Re-set cookie from localStorage on page load");
    }
  }
})();

/** Build headers, injecting Bearer token if one is stored. */
export function authHeaders(extra = {}) {
  const headers = { "Accept": "application/json", ...extra };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Check if a response is an HTML page (proxy/WAF interception) instead of JSON.
 * Throws a descriptive error if so.
 */
async function _assertJsonResponse(res, path) {
  if (res.status === 401) {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) {
      throw new Error(
        `Authentication required for ${path} — server returned non-JSON (proxy issue?)`
      );
    }
    let detail = "";
    try {
      const body = await res.clone().json();
      detail = body.error || body.reason || "";
    } catch {}
    throw new Error(`Not authenticated${detail ? ": " + detail : ""}`);
  }
}

export async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: authHeaders(),
  });
  await _assertJsonResponse(res, path);
  return res;
}

export async function apiPost(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  await _assertJsonResponse(res, path);
  return res;
}

export async function apiPut(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    credentials: "include",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return res;
}

export async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
    headers: authHeaders(),
  });
  return res;
}

/**
 * Check if initial setup is needed (no users exist).
 */
export async function checkSetupStatus() {
  const res = await fetch(`${API_BASE}/setup-status`, {
    credentials: "include",
    headers: authHeaders(),
  });
  return res.json();
}

/**
 * Sleep helper for retry delays.
 */
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get current user info.  Returns null when not authenticated.
 *
 * Uses POST /token-verify with the token in the request body.
 * This is the most reliable method behind reverse proxies because POST
 * bodies are never stripped (unlike Authorization headers or cookies).
 *
 * Retries up to 3 times with exponential back-off to handle transient
 * errors (e.g., DB not yet initialized on cold start).
 */
export async function getCurrentUser() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    console.log("[MultiUser] getCurrentUser: no token in localStorage");
    return null;
  }

  // Quick sanity check: a JWT has 3 dot-separated parts
  const parts = token.split(".");
  if (parts.length !== 3) {
    console.warn("[MultiUser] getCurrentUser: token is not a valid JWT format, clearing");
    clearToken();
    return null;
  }

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[MultiUser] getCurrentUser: attempt ${attempt}/${MAX_RETRIES}`);
      const res = await fetch(`${API_BASE}/token-verify`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.username) {
          console.log("[MultiUser] getCurrentUser: verified as", data.username);
          return data;
        }
        console.warn("[MultiUser] getCurrentUser: response OK but missing username", data);
        return null;
      }

      // 401 = token genuinely invalid/expired — clear it (no retry)
      if (res.status === 401) {
        let detail = "", reason = "";
        try {
          const body = await res.json();
          detail = body.error || "";
          reason = body.reason || "";
        } catch {}
        console.warn("[MultiUser] getCurrentUser: 401 —", detail, reason ? `(${reason})` : "");
        clearToken();
        return null;
      }

      // 5xx = server error (DB not ready, etc.) — retry
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        console.warn(`[MultiUser] getCurrentUser: ${res.status}, retrying in ${attempt}s...`);
        await _sleep(attempt * 1000);
        continue;
      }

      // Other non-OK response — log and give up
      console.warn("[MultiUser] getCurrentUser: unexpected status", res.status);
      return null;

    } catch (e) {
      // Network error — retry with back-off
      console.warn(`[MultiUser] getCurrentUser: fetch error (attempt ${attempt}):`, e.message);
      if (attempt < MAX_RETRIES) {
        await _sleep(attempt * 1000);
        continue;
      }
      return null;
    }
  }

  return null;
}
