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
  // Set as a JS cookie — more reliable behind reverse proxies because it
  // bypasses any proxy mangling of Set-Cookie response headers.
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Lax; max-age=${COOKIE_MAX_AGE}`;
  console.log("[MultiUser] Token stored in localStorage + cookie");
}

/** Remove stored token everywhere (logout). */
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  document.cookie = `${COOKIE_NAME}=; path=/; SameSite=Lax; max-age=0`;
}

// On module load: if we have a token in localStorage but no cookie, re-set it.
// This covers page refreshes where the cookie might have been lost.
(function _ensureCookie() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    // Check if cookie already present
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

export async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: authHeaders(),
  });
  if (res.status === 401) {
    // Don't clear token or show login here — let the caller handle 401.
    // The init() flow in multiuser.js handles unauthenticated state.
    throw new Error("Not authenticated");
  }
  return res;
}

export async function apiPost(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    throw new Error("Not authenticated");
  }
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
 * Get current user info.  Returns null when not authenticated.
 */
export async function getCurrentUser() {
  try {
    const res = await apiGet("/me");
    if (!res.ok) return null;
    return res.json();
  } catch {
    // apiGet throws on 401 — that's fine, just means not logged in
    return null;
  }
}
