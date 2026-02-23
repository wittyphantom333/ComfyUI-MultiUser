/**
 * ComfyUI-MultiUser — Dynamic Sidebar Tab Filter
 *
 * Manages visibility of ComfyUI sidebar tabs based on per-group permissions.
 * Works with built-in tabs (Assets, Workflows, Node Library, Model Library,
 * Job History) and any tabs registered by third-party extensions.
 *
 * The filter fetches denied tab patterns from the backend and continuously
 * monitors for new tab registrations, removing forbidden tabs as they appear.
 */

import { app } from "../../scripts/app.js";
import { apiGet } from "./api.js";

/** Cached deny patterns from the backend. */
let _denyPatterns = [];
let _isAdmin = false;
let _filterActive = false;
let _pollTimer = null;

/** Known tab IDs we've already processed (avoid redundant unregister calls). */
const _removedTabs = new Set();

/**
 * Convert a simple wildcard pattern (with * and ?) to a RegExp.
 * Used to match sidebar permission patterns against tab IDs.
 */
function _wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${withWildcards}$`, "i");
}

/**
 * Check if a tab ID matches any deny pattern.
 */
function _isDenied(tabId) {
  for (const pattern of _denyPatterns) {
    if (pattern === tabId) return true;
    if (pattern.includes("*") || pattern.includes("?")) {
      if (_wildcardToRegex(pattern).test(tabId)) return true;
    }
  }
  return false;
}

/**
 * Scan all registered sidebar tabs and remove any that match deny patterns.
 * Returns the number of tabs removed in this pass.
 */
function _enforceFilter() {
  if (!_filterActive || _isAdmin || _denyPatterns.length === 0) return 0;

  let removed = 0;
  try {
    const tabs = app.extensionManager.getSidebarTabs();
    for (const tab of tabs) {
      if (_removedTabs.has(tab.id)) continue;
      if (_isDenied(tab.id)) {
        try {
          app.extensionManager.unregisterSidebarTab(tab.id);
          _removedTabs.add(tab.id);
          removed++;
          console.log(`[MultiUser] Removed sidebar tab: ${tab.id}`);
        } catch (e) {
          console.warn(`[MultiUser] Failed to remove tab ${tab.id}:`, e.message);
        }
      }
    }
  } catch (e) {
    // extensionManager may not be ready yet
  }
  return removed;
}

/**
 * Fetch the user's sidebar deny list from the backend and start filtering.
 */
export async function initTabFilter() {
  try {
    const res = await apiGet("/my-sidebar");
    const data = await res.json();
    if (!data) return;

    _isAdmin = !!data.is_admin;
    _denyPatterns = data.hidden_tabs || [];

    if (_isAdmin || _denyPatterns.length === 0) {
      console.log("[MultiUser] Tab filter: no restrictions (admin or no deny rules)");
      return;
    }

    console.log("[MultiUser] Tab filter: will hide tabs matching:", _denyPatterns);
    _filterActive = true;

    // Run immediately
    _enforceFilter();

    // Poll periodically to catch tabs registered by slow-loading extensions.
    // Aggressive at first (every 500ms for 15s), then relaxes to every 5s.
    let elapsed = 0;
    const fastInterval = 500;
    const slowInterval = 5000;
    const fastDuration = 15000;

    _pollTimer = setInterval(() => {
      elapsed += (elapsed < fastDuration ? fastInterval : slowInterval);
      _enforceFilter();

      // After initial fast phase, switch to slow polling
      if (elapsed === fastDuration) {
        clearInterval(_pollTimer);
        _pollTimer = setInterval(() => _enforceFilter(), slowInterval);
      }
    }, fastInterval);

  } catch (e) {
    console.warn("[MultiUser] Tab filter init failed:", e.message);
  }
}

/**
 * Stop the tab filter polling (e.g., on logout).
 */
export function stopTabFilter() {
  _filterActive = false;
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _removedTabs.clear();
  _denyPatterns = [];
}

/**
 * Get the list of all currently registered sidebar tabs.
 * Used by the admin UI to display available tabs for management.
 */
export function getRegisteredTabs() {
  try {
    return app.extensionManager.getSidebarTabs().map(t => ({
      id: t.id,
      title: t.title || t.id,
      icon: typeof t.icon === "string" ? t.icon : null,
    }));
  } catch {
    return [];
  }
}
