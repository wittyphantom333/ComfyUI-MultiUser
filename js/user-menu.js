/**
 * ComfyUI-MultiUser — User menu widget
 * Integrates into the ComfyUI bottom-left sidebar area next to settings.
 */

import { apiPost, getCurrentUser, clearToken } from "./api.js";

const USER_MENU_STYLES = `
  /* ── Bottom-left user button (next to ComfyUI sidebar controls) ── */
  .mu-user-menu-container {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 9998;
    pointer-events: none;
  }
  .mu-user-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: rgba(30, 30, 46, 0.95);
    border-top: 1px solid #333;
    pointer-events: auto;
    backdrop-filter: blur(8px);
  }
  .mu-user-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mu-user-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    background: transparent;
    border: 1px solid #444;
    border-radius: 6px;
    color: #ccc;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
    font-family: inherit;
  }
  .mu-user-btn:hover {
    background: #2a2a3e;
    border-color: #666;
    color: #fff;
  }
  .mu-user-avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #7c6cff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    color: white;
    flex-shrink: 0;
  }
  .mu-user-badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    background: #7c6cff;
    color: white;
    font-weight: 600;
  }
  .mu-user-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mu-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: #888;
    font-size: 14px;
    cursor: pointer;
    transition: all 0.15s;
    padding: 0;
  }
  .mu-icon-btn:hover {
    background: #2a2a3e;
    border-color: #555;
    color: #fff;
  }
  .mu-icon-btn.danger:hover {
    background: #3d1f1f;
    color: #ff6b6b;
  }
  .mu-icon-btn[title]::after { content: none; }
  /* ── Dropdown (pops up above the bar) ── */
  .mu-dropdown {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 12px;
    background: #1e1e2e;
    border: 1px solid #444;
    border-radius: 8px;
    min-width: 220px;
    box-shadow: 0 -8px 30px rgba(0,0,0,0.4);
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
    font-size: 13px;
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

  // Prefer the cached user from login — avoids an extra round-trip
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
  const adminBadge = user.is_admin ? ' <span class="mu-user-badge">Admin</span>' : '';

  menuContainer.innerHTML = `
    <div class="mu-user-bar">
      <div class="mu-user-left">
        <button class="mu-user-btn" id="mu-user-trigger">
          <span class="mu-user-avatar">${initial}</span>
          <span>${user.username}</span>${adminBadge}
          <span style="font-size: 9px; opacity: 0.5;">▲</span>
        </button>
      </div>
      <div class="mu-user-right">
        ${user.is_admin ? '<button class="mu-icon-btn" id="mu-menu-admin" title="Admin Panel">⚙️</button>' : ''}
        <button class="mu-icon-btn" id="mu-menu-tokens" title="API Tokens">🔑</button>
        <button class="mu-icon-btn" id="mu-menu-history" title="My Generations">📋</button>
        <button class="mu-icon-btn" id="mu-menu-password" title="Change Password">🔒</button>
        <button class="mu-icon-btn danger" id="mu-menu-logout" title="Sign Out">🚪</button>
      </div>
    </div>
    <div class="mu-dropdown" id="mu-user-dropdown">
      <div class="mu-dropdown-header">
        <strong>${user.username}</strong>
        ${user.groups?.map(g => g.name).join(", ") || "No groups"}
      </div>
      ${user.is_admin ? `
        <div class="mu-dropdown-item" id="mu-dd-admin">
          ⚙️ Admin Panel
        </div>
      ` : ""}
      <div class="mu-dropdown-item" id="mu-dd-tokens">
        🔑 API Tokens
      </div>
      <div class="mu-dropdown-item" id="mu-dd-history">
        📋 My Generations
      </div>
      <div class="mu-dropdown-item" id="mu-dd-password">
        🔒 Change Password
      </div>
      <div class="mu-dropdown-divider"></div>
      <div class="mu-dropdown-item danger" id="mu-dd-logout">
        🚪 Sign Out
      </div>
    </div>
  `;

  document.body.appendChild(menuContainer);

  // Toggle dropdown from user button
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

  // Prevent dropdown clicks from closing it
  dropdown.addEventListener("click", (e) => e.stopPropagation());

  // ── Actions (bar icons + dropdown items) ──

  const logoutAction = async () => {
    try { await apiPost("/logout"); } catch {}
    clearToken();
    location.reload();
  };

  const adminAction = () => window.dispatchEvent(new CustomEvent("multiuser-open-admin"));
  const tokensAction = () => window.dispatchEvent(new CustomEvent("multiuser-open-tokens"));
  const historyAction = () => window.dispatchEvent(new CustomEvent("multiuser-open-history"));
  const passwordAction = () => window.dispatchEvent(new CustomEvent("multiuser-open-password"));

  // Bar icon buttons
  menuContainer.querySelector("#mu-menu-logout")?.addEventListener("click", logoutAction);
  menuContainer.querySelector("#mu-menu-admin")?.addEventListener("click", adminAction);
  menuContainer.querySelector("#mu-menu-tokens")?.addEventListener("click", tokensAction);
  menuContainer.querySelector("#mu-menu-history")?.addEventListener("click", historyAction);
  menuContainer.querySelector("#mu-menu-password")?.addEventListener("click", passwordAction);

  // Dropdown items
  menuContainer.querySelector("#mu-dd-logout")?.addEventListener("click", logoutAction);
  menuContainer.querySelector("#mu-dd-admin")?.addEventListener("click", adminAction);
  menuContainer.querySelector("#mu-dd-tokens")?.addEventListener("click", tokensAction);
  menuContainer.querySelector("#mu-dd-history")?.addEventListener("click", historyAction);
  menuContainer.querySelector("#mu-dd-password")?.addEventListener("click", passwordAction);
}
