/**
 * ComfyUI-MultiUser — API client helpers
 * Centralized fetch utilities for the multiuser backend.
 *
 * Supports dual auth: HttpOnly cookies (preferred) OR localStorage JWT
 * fallback for environments where cookies are unreliable (reverse proxies).
 */

const API_BASE = "/multiuser";
const TOKEN_KEY = "multiuser_token";

/** Store the JWT for Bearer-header fallback. */
export function storeToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

/** Remove stored token (logout). */
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/** Build headers, injecting Bearer token if one is stored. */
function authHeaders(extra = {}) {
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
    clearToken();
    window.__multiuser_show_login?.();
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
    clearToken();
    window.__multiuser_show_login?.();
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
