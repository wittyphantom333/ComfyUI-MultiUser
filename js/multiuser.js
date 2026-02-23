/**
 * ComfyUI-MultiUser — Main Extension
 * 
 * Registers the multiuser extension with ComfyUI, hooks into the lifecycle,
 * and coordinates auth, permissions, and UI components.
 */

import { app } from "../../scripts/app.js";
import { getCurrentUser } from "./api.js";
import { showAuthOverlay } from "./auth-ui.js";
import { loadPermissions, isNodeAllowed } from "./permission-filter.js";
import { createUserMenu } from "./user-menu.js";
import { openAdminPanel } from "./admin-panel.js";

// Shared auth state — set during init(), read during setup()
let _authenticated = false;

app.registerExtension({
  name: "comfyui.multiuser",

  /**
   * Called early during init — before nodes are registered.
   * We check auth state here and show login if needed.
   */
  async init() {
    console.log("[MultiUser] init() — checking auth state");
    console.log("[MultiUser] localStorage token exists:", !!localStorage.getItem("multiuser_token"));
    let user = await getCurrentUser();
    console.log("[MultiUser] getCurrentUser result:", user);

    if (!user) {
      console.log("[MultiUser] Not authenticated, showing login overlay (blocking)");
      // showAuthOverlay returns a Promise that resolves once the user
      // has successfully logged in — no page reload needed.
      user = await showAuthOverlay();
      console.log("[MultiUser] Auth overlay resolved with user:", user?.username);
    }

    if (!user) {
      // Shouldn't happen, but guard anyway
      console.error("[MultiUser] Auth flow completed but no user — aborting");
      _authenticated = false;
      return;
    }

    // User is authenticated — load their permissions
    _authenticated = true;
    console.log("[MultiUser] Authenticated as:", user.username, "admin:", user.is_admin);
    window.__multiuser_current_user = user;
    await loadPermissions();
    console.log("[MultiUser] Permissions loaded, setting up UI");

    // Set up the menu and event listeners now (since setup() may have
    // already fired while the overlay was showing)
    await _setupUI();
  },

  /**
   * Called for each node type during registration.
   * We filter out nodes the user doesn't have permission to use.
   */
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (!_authenticated) return; // not logged in yet — skip filtering

    const className = nodeData.name || nodeType.comfyClass;
    if (!className) return;

    if (!isNodeAllowed(className)) {
      // Hide this node by removing it from the category
      // This prevents it from appearing in the Add Node menu
      nodeData.category = "__hidden__";
    }
  },

  /**
   * Called after ComfyUI is fully set up.
   * We add the user menu and bind event listeners.
   */
  async setup() {
    // If already authenticated (user was logged in from the start),
    // set up UI now. Otherwise init() will call _setupUI after overlay resolves.
    if (_authenticated) {
      await _setupUI();
    }
  },
});

// ── Shared UI bootstrap — called from init() or setup() ──

let _uiReady = false;

async function _setupUI() {
  if (_uiReady) return; // idempotent guard
  _uiReady = true;
  console.log("[MultiUser] _setupUI — creating user menu");

  await createUserMenu();

  window.addEventListener("multiuser-open-admin", () => openAdminPanel());

  window.addEventListener("multiuser-open-tokens", () => {
    openAdminPanel();
    setTimeout(() => {
      document.querySelector('.mu-admin-tab[data-tab="tokens"]')?.click();
    }, 100);
  });

  window.addEventListener("multiuser-open-history", () => {
    openAdminPanel();
    setTimeout(() => {
      document.querySelector('.mu-admin-tab[data-tab="stats"]')?.click();
    }, 100);
  });

  window.addEventListener("multiuser-open-password", () => {
    const current = prompt("Current password:");
    if (!current) return;
    const newPw = prompt("New password (min 8 characters):");
    if (!newPw) return;
    const confirm = prompt("Confirm new password:");
    if (newPw !== confirm) { alert("Passwords don't match"); return; }

    import("./api.js").then(({ authHeaders }) => {
      fetch("/multiuser/change-password", {
        method: "POST",
        credentials: "include",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: newPw }),
      }).then(async res => {
        const data = await res.json();
        if (res.ok) alert("Password changed successfully!");
        else alert(data.error || "Error changing password");
      });
    });
  });

  console.log("[MultiUser] UI setup complete");
}