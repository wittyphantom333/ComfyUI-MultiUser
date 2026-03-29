/**
 * ComfyUI-MultiUser — User Profile Sidebar Tab
 *
 * Renders user info and actions inside ComfyUI's native sidebar tab.
 * Registered via app.extensionManager.registerSidebarTab() in multiuser.js.
 */

import { apiGet, apiPost, clearToken, authHeaders } from "./api.js";

const TOKEN_KEY = "multiuser_token";

/** Inline styles scoped to the sidebar tab content. */
const SIDEBAR_CSS = `
  .mu-sidebar {
    padding: 12px;
    font-family: Arial, sans-serif;
    color: var(--descrip-text, #bbb);
    font-size: 13px;
  }
  .mu-sidebar h3 {
    margin: 0 0 4px 0;
    font-size: 15px;
    color: var(--input-text, #ddd);
  }
  .mu-sidebar .mu-section {
    background: var(--comfy-menu-bg, #353535);
    border-radius: 8px;
    padding: 14px;
    margin-bottom: 12px;
  }
  .mu-sidebar .mu-section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--descrip-text, #999);
    margin: 0 0 10px 0;
  }
  .mu-sidebar .mu-user-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .mu-sidebar .mu-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--comfy-input-bg, #535353);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 700;
    color: var(--input-text, #ddd);
    flex-shrink: 0;
  }
  .mu-sidebar .mu-user-info {
    flex: 1;
    min-width: 0;
  }
  .mu-sidebar .mu-username {
    font-size: 16px;
    font-weight: 600;
    color: var(--input-text, #ddd);
    margin: 0;
    word-break: break-all;
  }
  .mu-sidebar .mu-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    margin-left: 6px;
    vertical-align: middle;
  }
  .mu-sidebar .mu-badge-admin {
    background: var(--comfy-input-bg, #535353);
    color: var(--input-text, #ddd);
  }
  .mu-sidebar .mu-groups {
    font-size: 12px;
    color: var(--descrip-text, #999);
    margin: 2px 0 0 0;
  }
  .mu-sidebar .mu-group-tag {
    display: inline-block;
    background: #293742;
    color: #5ba3d9;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    margin-right: 4px;
    margin-top: 4px;
  }
  .mu-sidebar .mu-action-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .mu-sidebar .mu-action-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--descrip-text, #bbb);
    transition: background 0.15s;
    font-size: 13px;
  }
  .mu-sidebar .mu-action-item:hover {
    background: var(--comfy-input-bg, #444);
    color: var(--input-text, #ddd);
  }
  .mu-sidebar .mu-action-item.danger {
    color: #ef5350;
  }
  .mu-sidebar .mu-action-item.danger:hover {
    background: #3d1f1f;
  }
  .mu-sidebar .mu-action-icon {
    font-size: 14px;
    width: 20px;
    text-align: center;
    flex-shrink: 0;
  }
  .mu-sidebar .mu-divider {
    height: 1px;
    background: var(--border-color, #4e4e4e);
    margin: 8px 0;
  }
  .mu-sidebar .mu-token-list {
    margin-top: 8px;
  }
  .mu-sidebar .mu-token-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    background: var(--comfy-input-bg, #222);
    border-radius: 4px;
    margin-bottom: 4px;
    font-size: 12px;
  }
  .mu-sidebar .mu-token-prefix {
    font-family: monospace;
    color: var(--descrip-text, #aaa);
  }
  .mu-sidebar .mu-token-del {
    background: none;
    border: none;
    color: #ef5350;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .mu-sidebar .mu-token-del:hover {
    background: #3d1f1f;
  }
  .mu-sidebar .mu-btn {
    padding: 6px 14px;
    border: none;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  .mu-sidebar .mu-btn-primary {
    background: var(--comfy-input-bg, #535353);
    color: var(--input-text, #ddd);
  }
  .mu-sidebar .mu-btn-primary:hover {
    background: #555;
  }
  .mu-sidebar .mu-btn-sm {
    padding: 4px 10px;
    font-size: 11px;
  }
  .mu-sidebar .mu-btn-outline {
    background: transparent;
    border: 1px solid var(--border-color, #4e4e4e);
    color: var(--descrip-text, #bbb);
  }
  .mu-sidebar .mu-btn-outline:hover {
    background: var(--comfy-input-bg, #444);
  }
  .mu-sidebar .mu-stat-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 12px;
  }
  .mu-sidebar .mu-stat-label {
    color: var(--descrip-text, #999);
  }
  .mu-sidebar .mu-stat-value {
    color: var(--input-text, #ddd);
    font-weight: 600;
  }
`;

let _stylesInjected = false;

function _injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.id = "mu-sidebar-styles";
  style.textContent = SIDEBAR_CSS;
  document.head.appendChild(style);
}

/**
 * Render the user profile sidebar tab content.
 * Called by ComfyUI's sidebar tab system with a DOM element to populate.
 */
export function renderUserSidebar(el, user) {
  // Guard: if no token or user data, show sign-in prompt
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token || !user) {
    el.innerHTML = `
      <div style="padding:24px;color:#888;text-align:center;font-family:sans-serif;">
        <div style="font-size:32px;margin-bottom:12px;">👤</div>
        <div style="font-size:14px;margin-bottom:8px;">Not signed in</div>
        <div style="font-size:12px;">Please sign in to view your profile.</div>
      </div>
    `;
    return;
  }

  _injectStyles();

  // Clear any previous content (ComfyUI may re-invoke render without clearing)
  el.innerHTML = "";

  const container = document.createElement("div");
  container.className = "mu-sidebar";

  const initial = user.username.charAt(0).toUpperCase();
  const adminBadge = user.is_admin
    ? '<span class="mu-badge mu-badge-admin">Admin</span>'
    : '';
  const groupTags = (user.groups || [])
    .map(g => `<span class="mu-group-tag">${g.name}</span>`)
    .join("");

  container.innerHTML = `
    <!-- User Info -->
    <div class="mu-section">
      <div class="mu-user-header">
        <div class="mu-avatar">${initial}</div>
        <div class="mu-user-info">
          <p class="mu-username">${user.username}${adminBadge}</p>
          <div class="mu-groups">${groupTags || '<span style="color:#666">No groups</span>'}</div>
        </div>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="mu-section">
      <p class="mu-section-title">Actions</p>
      <ul class="mu-action-list">
        <li class="mu-action-item" data-action="password">
          <span class="mu-action-icon">🔒</span> Change Password
        </li>
        <li class="mu-action-item" data-action="tokens">
          <span class="mu-action-icon">🔑</span> API Tokens
        </li>
        <li class="mu-action-item" data-action="stats">
          <span class="mu-action-icon">📊</span> My Stats
        </li>
        <li class="mu-action-item" data-action="clearcache">
          <span class="mu-action-icon">🗑️</span> Clear Thumbnail Cache
        </li>
        <li class="mu-divider"></li>
        <li class="mu-action-item danger" data-action="logout">
          <span class="mu-action-icon">🚪</span> Sign Out
        </li>
      </ul>
    </div>

    <!-- API Tokens (hidden by default) -->
    <div class="mu-section" id="mu-tokens-section" style="display:none;">
      <p class="mu-section-title">API Tokens</p>
      <div id="mu-tokens-list" class="mu-token-list">Loading...</div>
      <div style="margin-top:8px;">
        <button class="mu-btn mu-btn-sm mu-btn-primary" id="mu-create-token-btn">+ New Token</button>
      </div>
    </div>

    <!-- Stats (hidden by default) -->
    <div class="mu-section" id="mu-stats-section" style="display:none;">
      <p class="mu-section-title">My Generation Stats</p>
      <div id="mu-stats-content">Loading...</div>
    </div>
  `;

  el.appendChild(container);

  // ── Bind actions ──

  container.querySelectorAll(".mu-action-item[data-action]").forEach(item => {
    item.addEventListener("click", () => {
      const action = item.dataset.action;
      switch (action) {
        case "password":    _handleChangePassword(); break;
        case "tokens":      _toggleTokensSection(container); break;
        case "stats":       _toggleStatsSection(container); break;
        case "clearcache":  _handleClearCache(item); break;
        case "logout":      _handleLogout(); break;
      }
    });
  });

  container.querySelector("#mu-create-token-btn")?.addEventListener("click", () => {
    _createApiToken(container);
  });
}

// ── Action Implementations ──

async function _handleChangePassword() {
  const { showToast } = await import("./multiuser.js");
  const current = prompt("Current password:");
  if (!current) return;
  const newPw = prompt("New password (min 8 characters):");
  if (!newPw) return;
  const confirmPw = prompt("Confirm new password:");
  if (newPw !== confirmPw) {
    showToast("warn", "Password", "Passwords don't match");
    return;
  }
  try {
    const res = await fetch("/multiuser/change-password", {
      method: "POST",
      credentials: "include",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: newPw }),
    });
    const data = await res.json();
    if (res.ok) showToast("success", "Password", "Changed successfully");
    else showToast("error", "Password", data.error || "Error");
  } catch (e) {
    showToast("error", "Password", e.message);
  }
}

async function _handleClearCache(actionItem) {
  const origText = actionItem.textContent;
  actionItem.textContent = "⏳ Clearing...";

  try {
    let cleared = 0;

    // 1. Clear browser Cache API entries for /api/view
    if ("caches" in window) {
      const names = await caches.keys();
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        for (const req of keys) {
          if (req.url.includes("/api/view")) {
            await cache.delete(req);
            cleared++;
          }
        }
      }
    }

    // 2. Force ComfyUI to refetch node definitions (clears /object_info cache)
    try {
      await fetch("/api/object_info", { cache: "reload" });
    } catch {}

    // 3. Force refetch internal file lists
    try {
      await fetch("/internal/files/input", { cache: "reload" });
      await fetch("/internal/files/output", { cache: "reload" });
    } catch {}

    showToast("success", "Cache", `Cleared ${cleared} cached thumbnails. Reloading...`);

    // Reload after a brief delay so the toast is visible
    setTimeout(() => location.reload(), 1000);
  } catch (e) {
    showToast("error", "Cache", e.message);
    actionItem.innerHTML = `<span class="mu-action-icon">🗑️</span> Clear Thumbnail Cache`;
  }
}

async function _handleLogout() {
  try { await apiPost("/logout"); } catch {}
  clearToken();
  window.__multiuser_current_user = null;
  location.reload();
}

async function _toggleTokensSection(container) {
  const section = container.querySelector("#mu-tokens-section");
  if (!section) return;
  const isVisible = section.style.display !== "none";
  section.style.display = isVisible ? "none" : "block";
  if (!isVisible) await _loadTokens(container);
}

async function _toggleStatsSection(container) {
  const section = container.querySelector("#mu-stats-section");
  if (!section) return;
  const isVisible = section.style.display !== "none";
  section.style.display = isVisible ? "none" : "block";
  if (!isVisible) await _loadStats(container);
}

async function _loadTokens(container) {
  const list = container.querySelector("#mu-tokens-list");
  if (!list) return;
  try {
    const res = await apiGet("/api-tokens");
    const data = await res.json();
    const tokens = data.tokens || [];
    if (tokens.length === 0) {
      list.innerHTML = '<div style="color:#666;font-size:12px;">No API tokens yet.</div>';
      return;
    }
    list.innerHTML = tokens.map(t => `
      <div class="mu-token-item">
        <span>
          <span class="mu-token-prefix">${t.prefix}...</span>
          <span style="color:#666;margin-left:6px;">${t.name || "Unnamed"}</span>
        </span>
        <button class="mu-token-del" data-token-id="${t.id}" title="Revoke">×</button>
      </div>
    `).join("");
    // Bind delete buttons
    list.querySelectorAll(".mu-token-del").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { apiDelete } = await import("./api.js");
        const { showToast } = await import("./multiuser.js");
        try {
          await apiDelete(`/api-tokens/${btn.dataset.tokenId}`);
          showToast("success", "Token", "Token revoked");
          _loadTokens(container);
        } catch (e) {
          showToast("error", "Token", e.message);
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<div style="color:#ff6b6b;font-size:12px;">Error: ${e.message}</div>`;
  }
}

async function _loadStats(container) {
  const content = container.querySelector("#mu-stats-content");
  if (!content) return;
  try {
    const res = await apiGet("/generations/my-stats");
    if (!res.ok) {
      // Fallback to global stats if personal stats endpoint doesn't exist
      const res2 = await apiGet("/generations/stats");
      const stats = await res2.json();
      content.innerHTML = _renderStatsHtml(stats);
      return;
    }
    const stats = await res.json();
    content.innerHTML = _renderStatsHtml(stats);
  } catch (e) {
    content.innerHTML = `<div style="color:#ff6b6b;font-size:12px;">Error: ${e.message}</div>`;
  }
}

function _renderStatsHtml(stats) {
  return `
    <div class="mu-stat-row">
      <span class="mu-stat-label">Total Generations</span>
      <span class="mu-stat-value">${stats.total || 0}</span>
    </div>
    <div class="mu-stat-row">
      <span class="mu-stat-label">Completed</span>
      <span class="mu-stat-value">${stats.completed || 0}</span>
    </div>
    <div class="mu-stat-row">
      <span class="mu-stat-label">Errors</span>
      <span class="mu-stat-value">${stats.errors || 0}</span>
    </div>
    <div class="mu-stat-row">
      <span class="mu-stat-label">Avg Time</span>
      <span class="mu-stat-value">${stats.avg_time_ms ? (stats.avg_time_ms / 1000).toFixed(1) + "s" : "—"}</span>
    </div>
  `;
}

async function _createApiToken(container) {
  const { showToast } = await import("./multiuser.js");
  const name = prompt("Token name (optional):");
  try {
    const res = await apiPost("/api-tokens", { name: name || "API Token" });
    const data = await res.json();
    if (res.ok && data.token) {
      // Show the token once — it can't be retrieved again
      prompt("Copy this token now (it won't be shown again):", data.token);
      showToast("success", "Token", "API token created");
      _loadTokens(container);
    } else {
      showToast("error", "Token", data.error || "Error creating token");
    }
  } catch (e) {
    showToast("error", "Token", e.message);
  }
}
