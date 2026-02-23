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
    const user = await getCurrentUser();
    console.log("[MultiUser] getCurrentUser result:", user);

    if (!user) {
      _authenticated = false;
      console.log("[MultiUser] Not authenticated, showing login overlay");
      showAuthOverlay();
      return;
    }

    // User is authenticated — load their permissions
    _authenticated = true;
    console.log("[MultiUser] Authenticated as:", user.username, "admin:", user.is_admin);
    window.__multiuser_current_user = user;
    await loadPermissions();
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
    // Skip entirely when not authenticated — the login overlay is showing
    // and will reload the page once the user logs in.
    if (!_authenticated) return;

    // Create user menu in top-right
    await createUserMenu();

    // Listen for custom events from menu/admin
    window.addEventListener("multiuser-open-admin", () => openAdminPanel());
    
    window.addEventListener("multiuser-open-tokens", () => {
      openAdminPanel();
      // Switch to tokens tab after a tick
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

      fetch("/multiuser/change-password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: newPw }),
      }).then(async res => {
        const data = await res.json();
        if (res.ok) alert("Password changed successfully!");
        else alert(data.error || "Error changing password");
      });
    });
  },
});
