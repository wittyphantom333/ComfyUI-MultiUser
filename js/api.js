/**
 * ComfyUI-MultiUser — API client helpers
 * Centralized fetch utilities for the multiuser backend.
 */

const API_BASE = "/multiuser";

export async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  if (res.status === 401) {
    window.__multiuser_show_login?.();
    throw new Error("Not authenticated");
  }
  return res;
}

export async function apiPost(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.__multiuser_show_login?.();
    throw new Error("Not authenticated");
  }
  return res;
}

export async function apiPut(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res;
}

export async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  return res;
}

/**
 * Check if initial setup is needed (no users exist).
 */
export async function checkSetupStatus() {
  const res = await fetch(`${API_BASE}/setup-status`, {
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  return res.json();
}

/**
 * Get current user info.
 */
export async function getCurrentUser() {
  const res = await apiGet("/me");
  if (!res.ok) return null;
  return res.json();
}
