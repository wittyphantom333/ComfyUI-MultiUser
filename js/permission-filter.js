/**
 * ComfyUI-MultiUser — Permission-based node filtering
 * Uses beforeRegisterNodeDef hook to hide nodes the user doesn't have access to.
 */

import { apiGet } from "./api.js";

let allowedNodes = null;
let isAdmin = false;

/**
 * Fetch the user's allowed node list from the server.
 */
export async function loadPermissions() {
  try {
    const res = await apiGet("/my-permissions");
    if (res.ok) {
      const data = await res.json();
      allowedNodes = new Set(data.allowed_nodes);
      isAdmin = data.is_admin;
      return data;
    }
  } catch (e) {
    console.warn("[MultiUser] Failed to load permissions:", e);
  }
  return null;
}

/**
 * Check if a node class is allowed for the current user.
 */
export function isNodeAllowed(nodeClassName) {
  // If permissions haven't loaded yet, or user is admin, allow everything
  if (allowedNodes === null || isAdmin) return true;
  return allowedNodes.has(nodeClassName);
}

/**
 * Get the set of allowed nodes (for admin panel display).
 */
export function getAllowedNodes() {
  return allowedNodes;
}
