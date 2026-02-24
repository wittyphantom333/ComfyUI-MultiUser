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
  "multiuser-workflows",
]);

/**
 * Sidebar icons that may not be registered as extension-manager tabs
 * (e.g. ComfyUI built-in bottom-bar buttons).  We match them in the DOM
 * by dedicated class, button aria-label, or Iconify icon class.
 *
 * `matchClass`  — a direct CSS selector for the button / wrapper element.
 * `matchLabel`   — regex tested against aria-label / title attributes.
 * `matchIconCSS` — CSS selector for the Iconify icon <i> element inside the button.
 * `isWrapper`     — true when the target is a wrapper <div> rather than a <button>.
 */
const SIDEBAR_ICONS = [
  {
    id: "logo-menu",
    label: "Logo Menu",
    matchClass: ".comfy-menu-button-wrapper",
    matchLabel: null,
    matchIconCSS: null,
    isWrapper: true,
  },
  {
    id: "settings",
    label: "Settings",
    matchClass: null,
    matchLabel: /^settings$/i,
    matchIconCSS: ".icon-\\[lucide--settings\\]",
  },
  {
    id: "templates",
    label: "Templates",
    matchClass: ".templates-tab-button",
    matchLabel: /templates?/i,
    matchIconCSS: ".icon-\\[comfy--template\\]",
  },
  {
    id: "console",
    label: "Console",
    matchClass: null,
    matchLabel: /^(console|toggle bottom panel|logs?)$/i,
    matchIconCSS: ".icon-\\[ph--terminal-bold\\]",
  },
];

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

  // Also enforce visibility of special sidebar icons (settings, templates, console)
  _enforceSidebarIconFilter();

  return removed;
}

/**
 * Find the DOM element for a given sidebar icon definition.
 * Returns the <button> (or wrapper <div> for the logo) to hide/show.
 */
function _findSidebarElement(icon) {
  const sidebar = document.querySelector(".side-tool-bar-container");
  if (!sidebar) return null;

  // Strategy 1: Dedicated class selector (e.g. ".templates-tab-button", ".comfy-menu-button-wrapper")
  if (icon.matchClass) {
    const el = sidebar.querySelector(icon.matchClass);
    if (el) return el;
  }

  // Strategy 2: Match by aria-label / title on buttons
  if (icon.matchLabel) {
    for (const btn of sidebar.querySelectorAll("button")) {
      const label = (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").trim();
      if (label && icon.matchLabel.test(label)) return btn;
    }
  }

  // Strategy 3: Match by Iconify icon CSS selector on a child <i>, then climb to button
  if (icon.matchIconCSS) {
    try {
      const iconEl = sidebar.querySelector(icon.matchIconCSS);
      if (iconEl) {
        const btn = iconEl.closest("button");
        if (btn) return btn;
      }
    } catch { /* selector may not be supported in older browsers */ }
  }

  return null;
}

/**
 * Hide or show sidebar icon buttons (and the logo wrapper) based on deny rules.
 * This handles elements that aren't registered as extension-manager tabs.
 */
function _enforceSidebarIconFilter() {
  if (!_filterActive || _isAdmin) return;

  for (const icon of SIDEBAR_ICONS) {
    const el = _findSidebarElement(icon);
    if (!el) continue;

    const shouldHide = _matchesAny(icon.id, _deniedPatterns);
    if (shouldHide) {
      if (el.style.display !== "none") {
        el.style.display = "none";
        console.log(`[MultiUser] Hidden sidebar icon: ${icon.id}`);
      }
    } else {
      if (el.style.display === "none") {
        el.style.display = "";
      }
    }
  }
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

/** Expose BUILTIN_TABS and SIDEBAR_ICONS for the admin panel. */
export { BUILTIN_TABS, SIDEBAR_ICONS };
