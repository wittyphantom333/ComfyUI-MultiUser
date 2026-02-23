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
      title: "MultiUser",
      tooltip: `Signed in as ${_currentUser.username}`,
      type: "custom",
      render: (el) => renderUserSidebar(el, _currentUser),
    });
  } catch (e) {
    console.warn("[MultiUser] Could not register user sidebar tab:", e.message);
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
   */
  async setup() {
    _registerSidebarTabs();
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
  window.__multiuser_current_user = null;
  location.reload();
}

// Export for other modules
export { _currentUser, _authenticated, _logout, _changePassword };