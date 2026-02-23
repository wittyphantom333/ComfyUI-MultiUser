/**
 * ComfyUI-MultiUser — User menu widget
 * Adds a user profile dropdown to the ComfyUI top bar area.
 */

import { apiPost, getCurrentUser, clearToken } from "./api.js";

const USER_MENU_STYLES = `
  .mu-user-menu-container {
    position: fixed;
    top: 8px;
    right: 16px;
    z-index: 9999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .mu-user-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    background: #2a2a3e;
    border: 1px solid #444;
    border-radius: 8px;
    color: #e0e0e0;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .mu-user-btn:hover {
    background: #353550;
  }
  .mu-user-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #7c6cff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    color: white;
  }
  .mu-user-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    background: #7c6cff;
    color: white;
    font-weight: 600;
  }
  .mu-dropdown {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    background: #1e1e2e;
    border: 1px solid #444;
    border-radius: 8px;
    min-width: 200px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    display: none;
    overflow: hidden;
  }
  .mu-dropdown.open {
    display: block;
  }
  .mu-dropdown-header {
    padding: 12px 16px;
    border-bottom: 1px solid #333;
    color: #aaa;
    font-size: 12px;
  }
  .mu-dropdown-header strong {
    color: #e0e0e0;
    font-size: 14px;
    display: block;
    margin-bottom: 2px;
  }
  .mu-dropdown-item {
    padding: 10px 16px;
    color: #ccc;
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: background 0.15s;
  }
  .mu-dropdown-item:hover {
    background: #2a2a3e;
    color: #fff;
  }
  .mu-dropdown-divider {
    height: 1px;
    background: #333;
    margin: 0;
  }
  .mu-dropdown-item.danger {
    color: #ff6b6b;
  }
  .mu-dropdown-item.danger:hover {
    background: #3d1f1f;
  }
`;

let menuContainer = null;
let dropdownOpen = false;

function injectStyles() {
  if (document.getElementById("mu-usermenu-styles")) return;
  const style = document.createElement("style");
  style.id = "mu-usermenu-styles";
  style.textContent = USER_MENU_STYLES;
  document.head.appendChild(style);
}

export async function createUserMenu() {
  injectStyles();

  // Prefer the cached user from login — avoids an extra /me round-trip
  // that can fail behind reverse proxies.
  const user = window.__multiuser_current_user || await getCurrentUser();
  if (!user) {
    console.warn("[MultiUser] createUserMenu: no user available, skipping");
    return;
  }

  window.__multiuser_current_user = user;

  // Remove existing menu if any
  menuContainer?.remove();

  menuContainer = document.createElement("div");
  menuContainer.className = "mu-user-menu-container";

  const initial = user.username.charAt(0).toUpperCase();
  const adminBadge = user.is_admin ? '<span class="mu-user-badge">Admin</span>' : '';

  menuContainer.innerHTML = `
    <button class="mu-user-btn" id="mu-user-trigger">
      <span class="mu-user-avatar">${initial}</span>
      <span>${user.username}</span>
      ${adminBadge}
      <span style="font-size: 10px; opacity: 0.6;">▼</span>
    </button>
    <div class="mu-dropdown" id="mu-user-dropdown">
      <div class="mu-dropdown-header">
        <strong>${user.username}</strong>
        ${user.groups?.map(g => g.name).join(", ") || "No groups"}
      </div>
      ${user.is_admin ? `
        <div class="mu-dropdown-item" id="mu-menu-admin">
          ⚙️ Admin Panel
        </div>
      ` : ""}
      <div class="mu-dropdown-item" id="mu-menu-tokens">
        🔑 API Tokens
      </div>
      <div class="mu-dropdown-item" id="mu-menu-history">
        📋 My Generations
      </div>
      <div class="mu-dropdown-item" id="mu-menu-password">
        🔒 Change Password
      </div>
      <div class="mu-dropdown-divider"></div>
      <div class="mu-dropdown-item danger" id="mu-menu-logout">
        🚪 Sign Out
      </div>
    </div>
  `;

  document.body.appendChild(menuContainer);

  // Toggle dropdown
  const trigger = menuContainer.querySelector("#mu-user-trigger");
  const dropdown = menuContainer.querySelector("#mu-user-dropdown");

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdownOpen = !dropdownOpen;
    dropdown.classList.toggle("open", dropdownOpen);
  });

  // Close on outside click
  document.addEventListener("click", () => {
    dropdownOpen = false;
    dropdown.classList.remove("open");
  });

  // Menu actions
  menuContainer.querySelector("#mu-menu-logout")?.addEventListener("click", async () => {
    await apiPost("/logout");
    clearToken();
    location.reload();
  });

  menuContainer.querySelector("#mu-menu-admin")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("multiuser-open-admin"));
  });

  menuContainer.querySelector("#mu-menu-tokens")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("multiuser-open-tokens"));
  });

  menuContainer.querySelector("#mu-menu-history")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("multiuser-open-history"));
  });

  menuContainer.querySelector("#mu-menu-password")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("multiuser-open-password"));
  });
}
