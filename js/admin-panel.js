/**
 * ComfyUI-MultiUser — Admin Sidebar Tab
 *
 * Full admin management UI rendered inside ComfyUI's native sidebar tab.
 * Manages users, groups, permissions, external tokens, and generation stats.
 * Registered via app.extensionManager.registerSidebarTab() in multiuser.js.
 */

import { apiGet, apiPost, apiPut, apiDelete } from "./api.js";

const ADMIN_CSS = `
  .mu-admin {
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e0e0e0;
    font-size: 13px;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .mu-admin-tabs {
    display: flex;
    border-bottom: 1px solid #333;
    background: #1e1e30;
    flex-shrink: 0;
    overflow-x: auto;
  }
  .mu-admin-tab {
    padding: 8px 12px;
    cursor: pointer;
    color: #888;
    font-size: 11px;
    font-weight: 600;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .mu-admin-tab:hover { color: #ccc; }
  .mu-admin-tab.active { color: #7c6cff; border-bottom-color: #7c6cff; }
  .mu-admin-content {
    padding: 12px;
    flex: 1;
    overflow-y: auto;
  }
  .mu-admin-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
  }
  .mu-admin-table th {
    text-align: left;
    padding: 6px 8px;
    background: #222;
    color: #aaa;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .mu-admin-table td {
    padding: 6px 8px;
    border-bottom: 1px solid #2a2a3e;
    font-size: 12px;
  }
  .mu-admin-table tr:hover td { background: #222238; }
  .mu-admin .mu-btn {
    padding: 5px 12px;
    border: none;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  .mu-admin .mu-btn-primary { background: #7c6cff; color: white; }
  .mu-admin .mu-btn-primary:hover { background: #6a5aee; }
  .mu-admin .mu-btn-danger { background: #ff4444; color: white; }
  .mu-admin .mu-btn-danger:hover { background: #cc3333; }
  .mu-admin .mu-btn-sm { padding: 3px 8px; font-size: 10px; }
  .mu-admin .mu-btn-outline { background: transparent; border: 1px solid #555; color: #ccc; }
  .mu-admin .mu-btn-outline:hover { background: #2a2a3e; }
  .mu-admin .mu-form-group {
    margin-bottom: 10px;
  }
  .mu-admin .mu-form-group label {
    display: block;
    color: #aaa;
    font-size: 11px;
    margin-bottom: 3px;
    font-weight: 600;
  }
  .mu-admin .mu-form-group input,
  .mu-admin .mu-form-group select,
  .mu-admin .mu-form-group textarea {
    width: 100%;
    padding: 6px 8px;
    background: #2a2a3e;
    border: 1px solid #444;
    border-radius: 5px;
    color: #e0e0e0;
    font-size: 12px;
    box-sizing: border-box;
  }
  .mu-admin .mu-form-group input:focus,
  .mu-admin .mu-form-group select:focus {
    border-color: #7c6cff;
    outline: none;
  }
  .mu-admin .mu-form-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .mu-admin .mu-form-row > * { flex: 1; }
  .mu-admin .mu-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
  }
  .mu-admin .mu-badge-green { background: #1f3d2a; color: #6bff8b; }
  .mu-admin .mu-badge-red { background: #3d1f1f; color: #ff6b6b; }
  .mu-admin .mu-badge-blue { background: #1f2a3d; color: #6bb5ff; }
  .mu-admin .mu-badge-purple { background: #2a1f3d; color: #b56bff; }
  .mu-admin .mu-empty-state {
    text-align: center;
    padding: 30px 12px;
    color: #666;
    font-size: 12px;
  }
  .mu-admin .mu-stat-cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }
  .mu-admin .mu-stat-card {
    background: #222238;
    border-radius: 6px;
    padding: 10px;
    text-align: center;
  }
  .mu-admin .mu-stat-card .value {
    font-size: 20px;
    font-weight: 700;
    color: #7c6cff;
  }
  .mu-admin .mu-stat-card .label {
    font-size: 10px;
    color: #888;
    margin-top: 2px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .mu-admin .mu-inline-form {
    background: #222238;
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 12px;
    display: none;
  }
  .mu-admin .mu-inline-form.visible {
    display: block;
  }
  .mu-admin .mu-section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }
  .mu-admin .mu-section-header h3 {
    margin: 0;
    font-size: 14px;
  }
`;

let _stylesInjected = false;
let _adminRoot = null;
let _currentTab = "users";

function _injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.id = "mu-admin-styles";
  style.textContent = ADMIN_CSS;
  document.head.appendChild(style);
}

/** Show a native ComfyUI toast. */
function _toast(severity, msg) {
  try {
    const { app } = window.comfyAPI?.app || {};
    if (app?.extensionManager?.toast) {
      app.extensionManager.toast.add({ severity, summary: "MultiUser Admin", detail: msg, life: 3000 });
      return;
    }
  } catch {}
  // Fallback: try importing showToast
  import("./multiuser.js").then(m => m.showToast(severity, "Admin", msg)).catch(() => {
    console.log(`[MultiUser Admin] ${severity}: ${msg}`);
  });
}

// ── Tab Renderers ──

async function _renderUsers(content) {
  content.innerHTML = '<div class="mu-empty-state">Loading...</div>';
  try {
    const res = await apiGet("/users");
    const data = await res.json();
    const users = data.users || [];

    content.innerHTML = `
      <div class="mu-section-header">
        <h3>Users (${users.length})</h3>
        <button class="mu-btn mu-btn-primary mu-btn-sm" id="mu-add-user-btn">+ Add User</button>
      </div>
      <table class="mu-admin-table">
        <thead>
          <tr><th>User</th><th>Groups</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>
                <strong>${u.username}</strong>
                ${u.is_admin ? '<span class="mu-badge mu-badge-purple">Admin</span>' : ''}
              </td>
              <td>${(u.groups || []).map(g => `<span class="mu-badge mu-badge-blue">${g.name}</span>`).join(' ')}</td>
              <td>${u.is_active
                ? '<span class="mu-badge mu-badge-green">Active</span>'
                : '<span class="mu-badge mu-badge-red">Disabled</span>'}</td>
              <td><button class="mu-btn mu-btn-sm mu-btn-outline mu-edit-user" data-uid="${u.id}">Edit</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    content.querySelector("#mu-add-user-btn")?.addEventListener("click", async () => {
      const username = prompt("Username:");
      if (!username) return;
      const password = prompt("Password (min 8 chars):");
      if (!password) return;
      const isAdmin = confirm("Make this user an admin?");
      const res = await apiPost("/users", { username, password, is_admin: isAdmin });
      const d = await res.json();
      if (res.ok) { _toast("success", `User '${username}' created`); _renderUsers(content); }
      else _toast("error", d.error || "Error creating user");
    });

    content.querySelectorAll(".mu-edit-user").forEach(btn => {
      btn.addEventListener("click", () => _editUser(btn.dataset.uid, content));
    });
  } catch (e) {
    content.innerHTML = `<div class="mu-empty-state" style="color:#ff6b6b;">Error: ${e.message}</div>`;
  }
}

async function _editUser(userId, content) {
  const res = await apiGet(`/users/${userId}`);
  const user = await res.json();
  const action = prompt(
    `Editing: ${user.username}\n\n1. Toggle active (${user.is_active ? 'Active' : 'Disabled'})\n2. Toggle admin (${user.is_admin ? 'Admin' : 'Regular'})\n3. Reset password\n4. Delete user\n\nChoice (1-4):`, "1"
  );
  if (action === "1") {
    await apiPut(`/users/${userId}`, { is_active: !user.is_active });
    _toast("success", `User ${user.is_active ? 'disabled' : 'enabled'}`);
  } else if (action === "2") {
    await apiPut(`/users/${userId}`, { is_admin: !user.is_admin });
    _toast("success", `Admin ${user.is_admin ? 'removed' : 'granted'}`);
  } else if (action === "3") {
    const pw = prompt("New password (min 8 chars):");
    if (pw) { await apiPut(`/users/${userId}`, { password: pw }); _toast("success", "Password reset"); }
  } else if (action === "4") {
    if (confirm(`Delete '${user.username}'? This cannot be undone.`)) {
      await apiDelete(`/users/${userId}`);
      _toast("success", `User deleted`);
    }
  }
  _renderUsers(content);
}

async function _renderGroups(content) {
  content.innerHTML = '<div class="mu-empty-state">Loading...</div>';
  try {
    const res = await apiGet("/groups");
    const data = await res.json();
    const groups = data.groups || [];

    content.innerHTML = `
      <div class="mu-section-header">
        <h3>Groups (${groups.length})</h3>
        <button class="mu-btn mu-btn-primary mu-btn-sm" id="mu-add-group-btn">+ Add Group</button>
      </div>
      <table class="mu-admin-table">
        <thead>
          <tr><th>Name</th><th>Description</th><th>Members</th><th>Type</th><th></th></tr>
        </thead>
        <tbody>
          ${groups.map(g => `
            <tr>
              <td><strong>${g.name}</strong></td>
              <td style="color:#888;">${g.description || '—'}</td>
              <td>${g.member_count || 0}</td>
              <td>${g.is_system ? '<span class="mu-badge mu-badge-purple">System</span>' : '<span class="mu-badge mu-badge-blue">Custom</span>'}</td>
              <td><button class="mu-btn mu-btn-sm mu-btn-outline mu-edit-group" data-gid="${g.id}">Manage</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    content.querySelector("#mu-add-group-btn")?.addEventListener("click", async () => {
      const name = prompt("Group name:");
      if (!name) return;
      const desc = prompt("Description (optional):");
      const res = await apiPost("/groups", { name, description: desc });
      const d = await res.json();
      if (res.ok) { _toast("success", `Group '${name}' created`); _renderGroups(content); }
      else _toast("error", d.error || "Error");
    });

    content.querySelectorAll(".mu-edit-group").forEach(btn => {
      btn.addEventListener("click", () => _editGroup(btn.dataset.gid, content));
    });
  } catch (e) {
    content.innerHTML = `<div class="mu-empty-state" style="color:#ff6b6b;">Error: ${e.message}</div>`;
  }
}

async function _editGroup(groupId, content) {
  const res = await apiGet(`/groups/${groupId}`);
  const group = await res.json();
  let info = `Group: ${group.name}\nMembers: ${(group.members || []).map(m => m.username).join(', ') || 'none'}\n\n1. Add member\n2. Remove member\n3. Edit description\n`;
  if (!group.is_system) info += "4. Delete group\n";
  const action = prompt(info + "\nChoice:", "1");
  if (action === "1") {
    const uname = prompt("Username to add:");
    if (!uname) return;
    const usersRes = await apiGet("/users");
    const usersData = await usersRes.json();
    const user = usersData.users?.find(u => u.username === uname);
    if (!user) { _toast("warn", "User not found"); return; }
    await apiPost(`/groups/${groupId}/members`, { user_id: user.id });
    _toast("success", `Added '${uname}'`);
  } else if (action === "2") {
    const uname = prompt(`Remove who? ${(group.members || []).map(m => m.username).join(', ')}`);
    if (!uname) return;
    const member = group.members?.find(m => m.username === uname);
    if (!member) { _toast("warn", "Member not found"); return; }
    await apiDelete(`/groups/${groupId}/members/${member.id}`);
    _toast("success", `Removed '${uname}'`);
  } else if (action === "3") {
    const desc = prompt("New description:", group.description || "");
    await apiPut(`/groups/${groupId}`, { description: desc });
    _toast("success", "Updated");
  } else if (action === "4" && !group.is_system) {
    if (confirm(`Delete group '${group.name}'?`)) {
      await apiDelete(`/groups/${groupId}`);
      _toast("success", "Group deleted");
    }
  }
  _renderGroups(content);
}

async function _renderPermissions(content) {
  content.innerHTML = '<div class="mu-empty-state">Loading...</div>';
  try {
    const [permRes, groupsRes] = await Promise.all([apiGet("/permissions"), apiGet("/groups")]);
    const perms = (await permRes.json()).permissions || [];
    const groups = (await groupsRes.json()).groups || [];

    content.innerHTML = `
      <div class="mu-section-header">
        <h3>Permissions (${perms.length})</h3>
        <button class="mu-btn mu-btn-primary mu-btn-sm" id="mu-add-perm-btn">+ Add Rule</button>
      </div>
      <div class="mu-inline-form" id="mu-perm-form">
        <div class="mu-form-row">
          <div class="mu-form-group">
            <label>Group</label>
            <select id="mu-perm-group">${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}</select>
          </div>
          <div class="mu-form-group">
            <label>Type</label>
            <select id="mu-perm-type"><option value="node">Node</option><option value="model">Model</option><option value="feature">Feature</option></select>
          </div>
        </div>
        <div class="mu-form-row">
          <div class="mu-form-group">
            <label>Pattern (* wildcard)</label>
            <input type="text" id="mu-perm-pattern" placeholder="e.g. KSampler" />
          </div>
          <div class="mu-form-group">
            <label>Action</label>
            <select id="mu-perm-action"><option value="allow">Allow</option><option value="deny">Deny</option></select>
          </div>
          <div class="mu-form-group">
            <label>Priority</label>
            <input type="number" id="mu-perm-priority" value="0" style="width:60px;" />
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button class="mu-btn mu-btn-primary mu-btn-sm" id="mu-save-perm-btn">Save</button>
          <button class="mu-btn mu-btn-outline mu-btn-sm" id="mu-cancel-perm-btn">Cancel</button>
        </div>
      </div>
      <table class="mu-admin-table">
        <thead>
          <tr><th>Group</th><th>Type</th><th>Pattern</th><th>Action</th><th>Pri</th><th></th></tr>
        </thead>
        <tbody>
          ${perms.map(p => `
            <tr>
              <td><span class="mu-badge mu-badge-blue">${p.group_name}</span></td>
              <td>${p.resource_type}</td>
              <td><code style="background:#2a2a3e;padding:1px 4px;border-radius:3px;font-size:11px;">${p.resource_pattern}</code></td>
              <td>${p.action === 'allow'
                ? '<span class="mu-badge mu-badge-green">Allow</span>'
                : '<span class="mu-badge mu-badge-red">Deny</span>'}</td>
              <td>${p.priority}</td>
              <td><button class="mu-btn mu-btn-sm mu-btn-danger mu-del-perm" data-pid="${p.id}">×</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${perms.length === 0 ? '<div class="mu-empty-state">No permission rules yet.</div>' : ''}
    `;

    content.querySelector("#mu-add-perm-btn")?.addEventListener("click", () => {
      content.querySelector("#mu-perm-form")?.classList.add("visible");
    });
    content.querySelector("#mu-cancel-perm-btn")?.addEventListener("click", () => {
      content.querySelector("#mu-perm-form")?.classList.remove("visible");
    });
    content.querySelector("#mu-save-perm-btn")?.addEventListener("click", async () => {
      const group_id = content.querySelector("#mu-perm-group").value;
      const resource_type = content.querySelector("#mu-perm-type").value;
      const resource_pattern = content.querySelector("#mu-perm-pattern").value;
      const action = content.querySelector("#mu-perm-action").value;
      const priority = parseInt(content.querySelector("#mu-perm-priority").value) || 0;
      if (!resource_pattern) { _toast("warn", "Pattern required"); return; }
      const res = await apiPost("/permissions", { group_id, resource_type, resource_pattern, action, priority });
      if (res.ok) { _toast("success", "Rule added"); _renderPermissions(content); }
      else { const d = await res.json(); _toast("error", d.error || "Error"); }
    });
    content.querySelectorAll(".mu-del-perm").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this rule?")) return;
        await apiDelete(`/permissions/${btn.dataset.pid}`);
        _toast("success", "Rule deleted");
        _renderPermissions(content);
      });
    });
  } catch (e) {
    content.innerHTML = `<div class="mu-empty-state" style="color:#ff6b6b;">Error: ${e.message}</div>`;
  }
}

async function _renderExtTokens(content) {
  content.innerHTML = '<div class="mu-empty-state">Loading...</div>';
  try {
    const [tokRes, groupsRes] = await Promise.all([apiGet("/ext-tokens"), apiGet("/groups")]);
    const tokens = (await tokRes.json()).tokens || [];
    const groups = (await groupsRes.json()).groups || [];

    content.innerHTML = `
      <div class="mu-section-header">
        <h3>Ext Tokens (${tokens.length})</h3>
        <button class="mu-btn mu-btn-primary mu-btn-sm" id="mu-add-ext-btn">+ Add Token</button>
      </div>
      <p style="color:#888;font-size:11px;margin:0 0 10px 0;">Shared API keys for external services.</p>
      <div class="mu-inline-form" id="mu-ext-form">
        <div class="mu-form-row">
          <div class="mu-form-group">
            <label>Group</label>
            <select id="mu-ext-group">${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}</select>
          </div>
          <div class="mu-form-group">
            <label>Service Name</label>
            <input type="text" id="mu-ext-service" placeholder="e.g. majoor-assets" />
          </div>
        </div>
        <div class="mu-form-group">
          <label>API Token / Key</label>
          <input type="password" id="mu-ext-value" placeholder="Paste the API key" />
        </div>
        <div class="mu-form-group">
          <label>Description</label>
          <input type="text" id="mu-ext-desc" />
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button class="mu-btn mu-btn-primary mu-btn-sm" id="mu-save-ext-btn">Save</button>
          <button class="mu-btn mu-btn-outline mu-btn-sm" id="mu-cancel-ext-btn">Cancel</button>
        </div>
      </div>
      <table class="mu-admin-table">
        <thead>
          <tr><th>Service</th><th>Group</th><th>Description</th><th></th></tr>
        </thead>
        <tbody>
          ${tokens.map(t => `
            <tr>
              <td><strong>${t.service_name}</strong></td>
              <td><span class="mu-badge mu-badge-blue">${t.group_name}</span></td>
              <td style="color:#888;">${t.description || '—'}</td>
              <td><button class="mu-btn mu-btn-sm mu-btn-danger mu-del-ext" data-tid="${t.id}">×</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${tokens.length === 0 ? '<div class="mu-empty-state">No external tokens yet.</div>' : ''}
    `;

    content.querySelector("#mu-add-ext-btn")?.addEventListener("click", () => {
      content.querySelector("#mu-ext-form")?.classList.add("visible");
    });
    content.querySelector("#mu-cancel-ext-btn")?.addEventListener("click", () => {
      content.querySelector("#mu-ext-form")?.classList.remove("visible");
    });
    content.querySelector("#mu-save-ext-btn")?.addEventListener("click", async () => {
      const group_id = content.querySelector("#mu-ext-group").value;
      const service_name = content.querySelector("#mu-ext-service").value;
      const token = content.querySelector("#mu-ext-value").value;
      const description = content.querySelector("#mu-ext-desc").value;
      if (!service_name || !token) { _toast("warn", "Service and token required"); return; }
      const res = await apiPost("/ext-tokens", { group_id, service_name, token, description });
      if (res.ok) { _toast("success", "Token saved"); _renderExtTokens(content); }
      else { const d = await res.json(); _toast("error", d.error || "Error"); }
    });
    content.querySelectorAll(".mu-del-ext").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this token?")) return;
        await apiDelete(`/ext-tokens/${btn.dataset.tid}`);
        _toast("success", "Token deleted");
        _renderExtTokens(content);
      });
    });
  } catch (e) {
    content.innerHTML = `<div class="mu-empty-state" style="color:#ff6b6b;">Error: ${e.message}</div>`;
  }
}

async function _renderStats(content) {
  content.innerHTML = '<div class="mu-empty-state">Loading...</div>';
  try {
    const res = await apiGet("/generations/stats");
    const stats = await res.json();

    content.innerHTML = `
      <h3 style="margin:0 0 12px 0;font-size:14px;">Generation Statistics</h3>
      <div class="mu-stat-cards">
        <div class="mu-stat-card">
          <div class="value">${stats.total || 0}</div>
          <div class="label">Total</div>
        </div>
        <div class="mu-stat-card">
          <div class="value">${stats.completed || 0}</div>
          <div class="label">Done</div>
        </div>
        <div class="mu-stat-card">
          <div class="value">${stats.errors || 0}</div>
          <div class="label">Errors</div>
        </div>
        <div class="mu-stat-card">
          <div class="value">${stats.running || 0}</div>
          <div class="label">Running</div>
        </div>
        <div class="mu-stat-card">
          <div class="value">${stats.queued || 0}</div>
          <div class="label">Queued</div>
        </div>
        <div class="mu-stat-card">
          <div class="value">${stats.avg_time_ms ? (stats.avg_time_ms / 1000).toFixed(1) + 's' : '—'}</div>
          <div class="label">Avg Time</div>
        </div>
      </div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="mu-empty-state" style="color:#ff6b6b;">Error: ${e.message}</div>`;
  }
}

// ── Tab Switching ──

function _switchTab(container, tab) {
  _currentTab = tab;
  const content = container.querySelector(".mu-admin-content");
  if (!content) return;

  container.querySelectorAll(".mu-admin-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });

  switch (tab) {
    case "users":       _renderUsers(content); break;
    case "groups":      _renderGroups(content); break;
    case "permissions": _renderPermissions(content); break;
    case "tokens":      _renderExtTokens(content); break;
    case "stats":       _renderStats(content); break;
  }
}

/**
 * Render the admin sidebar tab content.
 * Called by ComfyUI's sidebar tab system with a DOM element to populate.
 */
export function renderAdminSidebar(el) {
  _injectStyles();

  const container = document.createElement("div");
  container.className = "mu-admin";

  container.innerHTML = `
    <div class="mu-admin-tabs">
      <div class="mu-admin-tab active" data-tab="users">Users</div>
      <div class="mu-admin-tab" data-tab="groups">Groups</div>
      <div class="mu-admin-tab" data-tab="permissions">Perms</div>
      <div class="mu-admin-tab" data-tab="tokens">Tokens</div>
      <div class="mu-admin-tab" data-tab="stats">Stats</div>
    </div>
    <div class="mu-admin-content"></div>
  `;

  el.appendChild(container);
  _adminRoot = container;

  // Bind tab clicks
  container.querySelectorAll(".mu-admin-tab").forEach(tab => {
    tab.addEventListener("click", () => _switchTab(container, tab.dataset.tab));
  });

  // Load initial tab
  _switchTab(container, "users");
}

// Legacy export for backward compatibility
export function openAdminPanel() {
  // In the new native UI, opening the sidebar tab is handled by ComfyUI.
  // This function is kept as a no-op for any code that still references it.
  console.log("[MultiUser] openAdminPanel: use the Admin sidebar tab instead");
}

export function closeAdminPanel() {
  // No-op in native UI mode
}
