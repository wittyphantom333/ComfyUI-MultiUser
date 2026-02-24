/**
 * ComfyUI-MultiUser — Main Extension
 *
 * Registers the multiuser extension with ComfyUI using its native APIs:
 *   - Sidebar tabs (user profile + admin panel)
 *   - Bottom panel tabs (generation stats)
 *   - Canvas right-click menu items
 *   - Settings panel entries
 *   - Toast notifications
 *
 * Coordinates auth, permissions, and UI components.
 */

import { app } from "../../scripts/app.js";
import { getCurrentUser, clearToken, apiPost, authHeaders } from "./api.js";
import { showAuthOverlay } from "./auth-ui.js";
import { loadPermissions, isNodeAllowed } from "./permission-filter.js";
import { renderUserSidebar } from "./user-menu.js";
import { renderAdminSidebar } from "./admin-panel.js";
import { renderOutputGallery, renderAllOutputsGallery } from "./output-gallery.js";
import { initTabFilter, stopTabFilter } from "./tab-filter.js";

/** Shared auth state */
let _authenticated = false;
let _currentUser = null;
let _sidebarTabsRegistered = false;

/** Show a native ComfyUI toast (falls back to console if API unavailable). */
export function showToast(severity, summary, detail, life = 3000) {
  try {
    app.extensionManager.toast.add({ severity, summary, detail, life });
  } catch {
    console.log(`[MultiUser] ${severity}: ${summary} — ${detail}`);
  }
}

/**
 * Move a sidebar tab button to the bottom section of the sidebar
 * (next to the settings gear icon).
 */
function _moveTabToBottom(tabId) {
  const attempt = (retries = 0) => {
    if (retries > 30) return; // give up after ~3s

    // Find the sidebar nav container
    const nav = document.querySelector(".side-tool-bar-container");
    if (!nav) {
      setTimeout(() => attempt(retries + 1), 100);
      return;
    }

    // Bottom section is the last .sidebar-item-group with mt-auto
    const bottomSection = nav.querySelector(".sidebar-item-group.mt-auto");
    if (!bottomSection) {
      // Fallback: grab all sidebar-item-groups and use the last one
      const groups = nav.querySelectorAll(".sidebar-item-group");
      if (groups.length < 2) {
        setTimeout(() => attempt(retries + 1), 100);
        return;
      }
      var bottom = groups[groups.length - 1];
    } else {
      var bottom = bottomSection;
    }

    // ComfyUI adds a class "{id}-tab-button" to each registered tab button
    const tabBtn = nav.querySelector(`.${tabId}-tab-button`);
    if (!tabBtn) {
      setTimeout(() => attempt(retries + 1), 100);
      return;
    }

    // Move the button to the beginning of the bottom section
    bottom.insertBefore(tabBtn, bottom.firstChild);
    console.log(`[MultiUser] Moved "${tabId}" tab to bottom of sidebar`);
  };

  // Start attempting after a short delay to let the DOM settle
  setTimeout(() => attempt(), 300);
}

/**
 * Register sidebar tabs with ComfyUI's native sidebar.
 * Guarded so it only executes once.
 */
function _registerSidebarTabs() {
  if (_sidebarTabsRegistered || !_authenticated || !_currentUser) return;
  _sidebarTabsRegistered = true;

  // ── Register User Profile sidebar tab ──
  try {
    app.extensionManager.registerSidebarTab({
      id: "multiuser-profile",
      icon: "pi pi-user",
      title: "User",
      tooltip: `Signed in as ${_currentUser.username}`,
      type: "custom",
      render: (el) => renderUserSidebar(el, _currentUser),
    });
    // Move the User tab to the bottom of the sidebar (near settings)
    _moveTabToBottom("multiuser-profile");
  } catch (e) {
    console.warn("[MultiUser] Could not register user sidebar tab:", e.message);
  }

  // ── Register Output Gallery sidebar tab ──
  try {
    app.extensionManager.registerSidebarTab({
      id: "multiuser-gallery",
      icon: "pi pi-images",
      title: "My Outputs",
      tooltip: "Browse your generated outputs",
      type: "custom",
      render: (el) => renderOutputGallery(el),
    });
  } catch (e) {
    console.warn("[MultiUser] Could not register gallery sidebar tab:", e.message);
  }

  // ── Register Admin sidebar tab (admins only) ──
  if (_currentUser.is_admin) {
    try {
      app.extensionManager.registerSidebarTab({
        id: "multiuser-admin",
        icon: "pi pi-cog",
        title: "Admin",
        tooltip: "MultiUser Administration",
        type: "custom",
        render: (el) => renderAdminSidebar(el),
      });
    } catch (e) {
      console.warn("[MultiUser] Could not register admin sidebar tab:", e.message);
    }

    // ── Register All Outputs gallery (admin only) ──
    try {
      app.extensionManager.registerSidebarTab({
        id: "multiuser-all-outputs",
        icon: "pi pi-th-large",
        title: "All Outputs",
        tooltip: "Browse all users' outputs (admin)",
        type: "custom",
        render: (el) => renderAllOutputsGallery(el),
      });
    } catch (e) {
      console.warn("[MultiUser] Could not register all-outputs sidebar tab:", e.message);
    }
  }
}

app.registerExtension({
  name: "comfyui.multiuser",

  /**
   * Settings shown in ComfyUI's Settings panel under "MultiUser".
   */
  settings: [
    {
      id: "multiuser.notifications",
      name: "Show generation notifications",
      type: "boolean",
      defaultValue: true,
      category: ["MultiUser", "General", "Notifications"],
      tooltip: "Show toast notifications when generations complete or fail",
    },
  ],

  /**
   * Called early during init — before nodes are registered.
   * We check auth state here and show login if needed.
   */
  async init() {
    let user = await getCurrentUser();

    if (!user) {
      user = await showAuthOverlay();
    }

    if (!user) {
      _authenticated = false;
      return;
    }

    _authenticated = true;
    _currentUser = user;
    window.__multiuser_current_user = user;
    console.log("[MultiUser] Authenticated as:", user.username);

    await loadPermissions();
    _registerSidebarTabs();
  },

  /**
   * Called for each node type during registration.
   * Filter out nodes the user doesn't have permission to use.
   */
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!_authenticated) return;
    const className = nodeData.name || nodeType.comfyClass;
    if (!className) return;
    if (!isNodeAllowed(className)) {
      nodeData.category = "__hidden__";
    }
  },

  /**
   * Called after ComfyUI is fully set up.
   * Attempt registration again in case init() ran before the sidebar was ready.
   * Then activate the dynamic sidebar tab filter.
   */
  async setup() {
    _registerSidebarTabs();

    // Start the tab filter after a short delay so all extensions have
    // had a chance to register their sidebar tabs.
    if (_authenticated) {
      setTimeout(() => initTabFilter(), 1000);
    }
  },

  /**
   * Canvas right-click menu items for quick user actions.
   */
  getCanvasMenuItems() {
    if (!_authenticated || !_currentUser) return [];

    const items = [];

    // Separator + header
    items.push(null); // separator in LiteGraph
    items.push({
      content: `MultiUser: ${_currentUser.username}${_currentUser.is_admin ? " (Admin)" : ""}`,
      disabled: true,
    });

    items.push({
      content: "Change Password",
      callback: _changePassword,
    });

    items.push({
      content: "Sign Out",
      callback: _logout,
    });

    return items;
  },
});

// ── Action handlers ──

async function _changePassword() {
  try {
    const current = prompt("Current password:");
    if (!current) return;
    const newPw = prompt("New password (min 8 characters):");
    if (!newPw) return;
    const confirmPw = prompt("Confirm new password:");
    if (newPw !== confirmPw) {
      showToast("warn", "Password", "Passwords don't match");
      return;
    }

    const res = await fetch("/multiuser/change-password", {
      method: "POST",
      credentials: "include",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: newPw }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast("success", "Password", "Password changed successfully");
    } else {
      showToast("error", "Password", data.error || "Error changing password");
    }
  } catch (e) {
    showToast("error", "Password", "Network error: " + e.message);
  }
}

async function _logout() {
  try { await apiPost("/logout"); } catch {}
  clearToken();
  stopTabFilter();
  window.__multiuser_current_user = null;
  location.reload();
}

// Export for other modules
export { _currentUser, _authenticated, _logout, _changePassword };