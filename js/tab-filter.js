/**
 * ComfyUI-MultiUser — Dynamic Sidebar Tab Filter
 *
 * Whitelist-based visibility: built-in ComfyUI tabs and MultiUser tabs are
 * always allowed.  Any NEW extension tab is hidden by default until an admin
 * explicitly approves it (via a sidebar "allow" permission rule).
 *
 * The filter fetches the user's approved/denied lists from the backend and
 * continuously monitors for newly registered tabs, removing unapproved ones.
 */

import { app } from "../../scripts/app.js";
import { apiGet } from "./api.js";

/**
 * Tabs that are always approved regardless of permission rules.
 * These are core ComfyUI built-in tabs and our own MultiUser tabs.
 */
const BUILTIN_TABS = new Set([
  "assets",
  "node-library",
  "model-library",
  "workflows",
  "job-history",
  "multiuser-profile",
  "multiuser-gallery",
  "multiuser-admin",
  "multiuser-all-outputs",
]);

/** State */
let _approvedPatterns = [];   // explicit allow rules from backend
let _deniedPatterns = [];     // explicit deny rules from backend
let _defaultHidden = true;    // hide unknown tabs by default
let _isAdmin = false;
let _filterActive = false;
let _pollTimer = null;

/** Tab IDs we've already removed (avoid redundant calls). */
const _removedTabs = new Set();

/**
 * Convert a simple wildcard pattern (with * and ?) to a RegExp.
 */
function _wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${withWildcards}$`, "i");
}

function _matchesAny(tabId, patterns) {
  for (const pat of patterns) {
    if (pat === tabId) return true;
    if ((pat.includes("*") || pat.includes("?")) && _wildcardToRegex(pat).test(tabId)) return true;
  }
  return false;
}

/**
 * Determine whether a tab should be visible.
 *
 * Order of precedence:
 * 1. Explicit deny → always hidden
 * 2. Built-in tab  → always visible (unless denied)
 * 3. Explicit allow → visible
 * 4. default_hidden → hidden if true
 */
function _isTabAllowed(tabId) {
  // Explicit deny always wins
  if (_matchesAny(tabId, _deniedPatterns)) return false;
  // Built-in tabs are inherently approved
  if (BUILTIN_TABS.has(tabId)) return true;
  // Explicit allow rule
  if (_matchesAny(tabId, _approvedPatterns)) return true;
  // Fall through to default
  return !_defaultHidden;
}

/**
 * Scan registered sidebar tabs and remove any that aren't allowed.
 */
function _enforceFilter() {
  if (!_filterActive || _isAdmin) return 0;

  let removed = 0;
  try {
    const tabs = app.extensionManager.getSidebarTabs();
    for (const tab of tabs) {
      if (_removedTabs.has(tab.id)) continue;
      if (!_isTabAllowed(tab.id)) {
        try {
          app.extensionManager.unregisterSidebarTab(tab.id);
          _removedTabs.add(tab.id);
          removed++;
          console.log(`[MultiUser] Removed unapproved sidebar tab: ${tab.id}`);
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
 * Fetch the user's sidebar rules from the backend and start filtering.
 */
export async function initTabFilter() {
  try {
    const res = await apiGet("/my-sidebar");
    const data = await res.json();
    if (!data) return;

    _isAdmin = !!data.is_admin;
    if (_isAdmin) {
      console.log("[MultiUser] Tab filter: admin — all tabs visible");
      return;
    }

    _approvedPatterns = data.approved_tabs || [];
    _deniedPatterns = data.denied_tabs || [];
    _defaultHidden = data.default_hidden !== false; // default true

    console.log("[MultiUser] Tab filter: default_hidden=%s, approved=%o, denied=%o",
      _defaultHidden, _approvedPatterns, _deniedPatterns);

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
  _approvedPatterns = [];
  _deniedPatterns = [];
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

/** Expose BUILTIN_TABS for the admin panel. */
export { BUILTIN_TABS };
