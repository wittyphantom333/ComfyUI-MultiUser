/**
 * ComfyUI-MultiUser — Admin Sidebar Panel
 * Full admin management UI integrated into ComfyUI as a sidebar/modal panel.
 * Manages users, groups, permissions, external tokens, and generation stats.
 */

import { apiGet, apiPost, apiPut, apiDelete } from "./api.js";

const ADMIN_STYLES = `
  .mu-admin-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    z-index: 99990;
    display: flex;
    justify-content: flex-end;
  }
  .mu-admin-panel {
    width: 520px;
    max-width: 90vw;
    height: 100vh;
    background: #1a1a2e;
    border-left: 1px solid #333;
    overflow-y: auto;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e0e0e0;
    font-size: 13px;
  }
  .mu-admin-header {
    position: sticky;
    top: 0;
    background: #1a1a2e;
    border-bottom: 1px solid #333;
    padding: 16px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 1;
  }
  .mu-admin-header h2 {
    margin: 0;
    font-size: 18px;
  }
  .mu-admin-close {
    background: none;
    border: none;
    color: #888;
    font-size: 24px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
  }
  .mu-admin-close:hover { color: #fff; background: #333; }
  
  .mu-admin-tabs {
    display: flex;
    border-bottom: 1px solid #333;
    background: #1e1e30;
    position: sticky;
    top: 56px;
    z-index: 1;
  }
  .mu-admin-tab {
    padding: 10px 16px;
    cursor: pointer;
    color: #888;
    font-size: 12px;
    font-weight: 600;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  }
  .mu-admin-tab:hover { color: #ccc; }
  .mu-admin-tab.active { color: #7c6cff; border-bottom-color: #7c6cff; }
  
  .mu-admin-content { padding: 20px; }
  
  .mu-admin-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
  }
  .mu-admin-table th {
    text-align: left;
    padding: 8px 10px;
    background: #222;
    color: #aaa;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .mu-admin-table td {
    padding: 8px 10px;
    border-bottom: 1px solid #2a2a3e;
  }
  .mu-admin-table tr:hover td { background: #222238; }
  
  .mu-btn {
    padding: 6px 14px;
    border: none;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  .mu-btn-primary { background: #7c6cff; color: white; }
  .mu-btn-primary:hover { background: #6a5aee; }
  .mu-btn-danger { background: #ff4444; color: white; }
  .mu-btn-danger:hover { background: #cc3333; }
  .mu-btn-sm { padding: 4px 10px; font-size: 11px; }
  .mu-btn-outline { background: transparent; border: 1px solid #555; color: #ccc; }
  .mu-btn-outline:hover { background: #2a2a3e; }
  
  .mu-form-group {
    margin-bottom: 14px;
  }
  .mu-form-group label {
    display: block;
    color: #aaa;
    font-size: 12px;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .mu-form-group input, .mu-form-group select, .mu-form-group textarea {
    width: 100%;
    padding: 8px 10px;
    background: #2a2a3e;
    border: 1px solid #444;
    border-radius: 5px;
    color: #e0e0e0;
    font-size: 13px;
    box-sizing: border-box;
  }
  .mu-form-group input:focus, .mu-form-group select:focus {
    border-color: #7c6cff;
    outline: none;
  }
  
  .mu-form-row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .mu-form-row > * { flex: 1; }
  
  .mu-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
  }
  .mu-badge-green { background: #1f3d2a; color: #6bff8b; }
  .mu-badge-red { background: #3d1f1f; color: #ff6b6b; }
  .mu-badge-blue { background: #1f2a3d; color: #6bb5ff; }
  .mu-badge-purple { background: #2a1f3d; color: #b56bff; }
  
  .mu-empty-state {
    text-align: center;
    padding: 40px 20px;
    color: #666;
  }
  
  .mu-stat-cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }
  .mu-stat-card {
    background: #222238;
    border-radius: 8px;
    padding: 14px;
    text-align: center;
  }
  .mu-stat-card .value {
    font-size: 24px;
    font-weight: 700;
    color: #7c6cff;
  }
  .mu-stat-card .label {
    font-size: 11px;
    color: #888;
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .mu-toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #2a2a3e;
    color: #e0e0e0;
    padding: 12px 20px;
    border-radius: 8px;
    border: 1px solid #444;
    z-index: 999999;
    font-size: 13px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.3);
    animation: mu-fade-in 0.2s;
  }
  @keyframes mu-fade-in {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
`;

let panelEl = null;
let currentTab = "users";

function injectStyles() {
  if (document.getElementById("mu-admin-styles")) return;
  const style = document.createElement("style");
  style.id = "mu-admin-styles";
  style.textContent = ADMIN_STYLES;
  document.head.appendChild(style);
}

function toast(msg, duration = 3000) {
  const el = document.createElement("div");
  el.className = "mu-toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ─── Tab Renderers ───

async function renderUsers() {
  const res = await apiGet("/users");
  const data = await res.json();
  const users = data.users || [];

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
      <h3 style="margin:0;">Users (${users.length})</h3>
      <button class="mu-btn mu-btn-primary" onclick="window.__mu_admin_add_user()">+ Add User</button>
    </div>
    <table class="mu-admin-table">
      <thead>
        <tr><th>User</th><th>Groups</th><th>Status</th><th>Last Login</th><th></th></tr>
      </thead>
      <tbody>
        ${users.map(u => `
          <tr>
            <td>
              <strong>${u.username}</strong>
              ${u.is_admin ? '<span class="mu-badge mu-badge-purple">Admin</span>' : ''}
              ${u.email ? `<br><span style="color:#666;font-size:11px;">${u.email}</span>` : ''}
            </td>
            <td>${(u.groups || []).map(g => `<span class="mu-badge mu-badge-blue">${g.name}</span>`).join(' ')}</td>
            <td>
              ${u.is_active ? '<span class="mu-badge mu-badge-green">Active</span>' : '<span class="mu-badge mu-badge-red">Disabled</span>'}
              ${u.failed_login_attempts > 0 ? `<br><span style="color:#ff6b6b;font-size:11px;">${u.failed_login_attempts} failed</span>` : ''}
            </td>
            <td style="font-size:11px; color:#888;">${u.last_login || 'Never'}</td>
            <td>
              <button class="mu-btn mu-btn-sm mu-btn-outline" onclick="window.__mu_admin_edit_user(${u.id})">Edit</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function renderGroups() {
  const res = await apiGet("/groups");
  const data = await res.json();
  const groups = data.groups || [];

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
      <h3 style="margin:0;">Groups (${groups.length})</h3>
      <button class="mu-btn mu-btn-primary" onclick="window.__mu_admin_add_group()">+ Add Group</button>
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
            <td>
              <button class="mu-btn mu-btn-sm mu-btn-outline" onclick="window.__mu_admin_edit_group(${g.id})">Manage</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function renderPermissions() {
  const res = await apiGet("/permissions");
  const data = await res.json();
  const perms = data.permissions || [];

  const groupsRes = await apiGet("/groups");
  const groupsData = await groupsRes.json();
  const groups = groupsData.groups || [];

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
      <h3 style="margin:0;">Permissions (${perms.length})</h3>
      <button class="mu-btn mu-btn-primary" onclick="window.__mu_admin_add_perm()">+ Add Rule</button>
    </div>
    <div id="mu-perm-form" style="display:none; background:#222238; border-radius:8px; padding:16px; margin-bottom:16px;">
      <div class="mu-form-row">
        <div class="mu-form-group">
          <label>Group</label>
          <select id="mu-perm-group">
            ${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
          </select>
        </div>
        <div class="mu-form-group">
          <label>Type</label>
          <select id="mu-perm-type">
            <option value="node">Node</option>
            <option value="model">Model</option>
            <option value="feature">Feature</option>
          </select>
        </div>
      </div>
      <div class="mu-form-row">
        <div class="mu-form-group">
          <label>Pattern (supports * wildcard)</label>
          <input type="text" id="mu-perm-pattern" placeholder="e.g. KSampler or ComfyUI-*" />
        </div>
        <div class="mu-form-group">
          <label>Action</label>
          <select id="mu-perm-action">
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
        </div>
        <div class="mu-form-group">
          <label>Priority</label>
          <input type="number" id="mu-perm-priority" value="0" style="width:80px;" />
        </div>
      </div>
      <button class="mu-btn mu-btn-primary" onclick="window.__mu_admin_save_perm()">Save Rule</button>
      <button class="mu-btn mu-btn-outline" onclick="document.getElementById('mu-perm-form').style.display='none'">Cancel</button>
    </div>
    <table class="mu-admin-table">
      <thead>
        <tr><th>Group</th><th>Type</th><th>Pattern</th><th>Action</th><th>Priority</th><th></th></tr>
      </thead>
      <tbody>
        ${perms.map(p => `
          <tr>
            <td><span class="mu-badge mu-badge-blue">${p.group_name}</span></td>
            <td>${p.resource_type}</td>
            <td><code style="background:#2a2a3e;padding:2px 6px;border-radius:3px;">${p.resource_pattern}</code></td>
            <td>${p.action === 'allow' 
              ? '<span class="mu-badge mu-badge-green">Allow</span>' 
              : '<span class="mu-badge mu-badge-red">Deny</span>'}</td>
            <td>${p.priority}</td>
            <td>
              <button class="mu-btn mu-btn-sm mu-btn-danger" onclick="window.__mu_admin_del_perm(${p.id})">×</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${perms.length === 0 ? '<div class="mu-empty-state">No permission rules defined yet.</div>' : ''}
  `;
}

async function renderExtTokens() {
  const res = await apiGet("/ext-tokens");
  const data = await res.json();
  const tokens = data.tokens || [];

  const groupsRes = await apiGet("/groups");
  const groupsData = await groupsRes.json();
  const groups = groupsData.groups || [];

  return `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
      <h3 style="margin:0;">Extension Tokens (${tokens.length})</h3>
      <button class="mu-btn mu-btn-primary" onclick="window.__mu_admin_add_ext_token()">+ Add Token</button>
    </div>
    <p style="color:#888;font-size:12px;margin-bottom:16px;">
      Shared API keys for external services (e.g., ComfyUI-Majoor-AssetsManager). Assigned at the group level.
    </p>
    <div id="mu-ext-token-form" style="display:none; background:#222238; border-radius:8px; padding:16px; margin-bottom:16px;">
      <div class="mu-form-row">
        <div class="mu-form-group">
          <label>Group</label>
          <select id="mu-ext-group">
            ${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
          </select>
        </div>
        <div class="mu-form-group">
          <label>Service Name</label>
          <input type="text" id="mu-ext-service" placeholder="e.g. majoor-assets" />
        </div>
      </div>
      <div class="mu-form-group">
        <label>API Token / Key</label>
        <input type="password" id="mu-ext-value" placeholder="Paste the API key here" />
      </div>
      <div class="mu-form-group">
        <label>Description (optional)</label>
        <input type="text" id="mu-ext-desc" placeholder="What is this token for?" />
      </div>
      <button class="mu-btn mu-btn-primary" onclick="window.__mu_admin_save_ext_token()">Save Token</button>
      <button class="mu-btn mu-btn-outline" onclick="document.getElementById('mu-ext-token-form').style.display='none'">Cancel</button>
    </div>
    <table class="mu-admin-table">
      <thead>
        <tr><th>Service</th><th>Group</th><th>Description</th><th>Updated</th><th></th></tr>
      </thead>
      <tbody>
        ${tokens.map(t => `
          <tr>
            <td><strong>${t.service_name}</strong></td>
            <td><span class="mu-badge mu-badge-blue">${t.group_name}</span></td>
            <td style="color:#888;">${t.description || '—'}</td>
            <td style="font-size:11px;color:#888;">${t.updated_at || t.created_at}</td>
            <td>
              <button class="mu-btn mu-btn-sm mu-btn-danger" onclick="window.__mu_admin_del_ext_token(${t.id})">×</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${tokens.length === 0 ? '<div class="mu-empty-state">No external tokens configured yet.</div>' : ''}
  `;
}

async function renderStats() {
  const res = await apiGet("/generations/stats");
  const stats = await res.json();

  return `
    <h3 style="margin:0 0 16px 0;">Generation Statistics</h3>
    <div class="mu-stat-cards">
      <div class="mu-stat-card">
        <div class="value">${stats.total || 0}</div>
        <div class="label">Total</div>
      </div>
      <div class="mu-stat-card">
        <div class="value">${stats.completed || 0}</div>
        <div class="label">Completed</div>
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
}

// ─── Tab Switching & Panel ───

async function renderTab(tab) {
  const content = panelEl?.querySelector(".mu-admin-content");
  if (!content) return;
  
  content.innerHTML = '<div style="text-align:center;padding:40px;color:#666;">Loading...</div>';
  
  try {
    switch (tab) {
      case "users": content.innerHTML = await renderUsers(); break;
      case "groups": content.innerHTML = await renderGroups(); break;
      case "permissions": content.innerHTML = await renderPermissions(); break;
      case "tokens": content.innerHTML = await renderExtTokens(); break;
      case "stats": content.innerHTML = await renderStats(); break;
    }
  } catch (err) {
    content.innerHTML = `<div class="mu-empty-state" style="color:#ff6b6b;">Error loading: ${err.message}</div>`;
  }

  // Update active tab
  panelEl?.querySelectorAll(".mu-admin-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  currentTab = tab;
}

export function openAdminPanel() {
  if (panelEl) { closeAdminPanel(); return; }
  injectStyles();

  panelEl = document.createElement("div");
  panelEl.className = "mu-admin-overlay";
  panelEl.innerHTML = `
    <div class="mu-admin-panel">
      <div class="mu-admin-header">
        <h2>⚙️ MultiUser Admin</h2>
        <button class="mu-admin-close" id="mu-admin-close-btn">×</button>
      </div>
      <div class="mu-admin-tabs">
        <div class="mu-admin-tab active" data-tab="users">Users</div>
        <div class="mu-admin-tab" data-tab="groups">Groups</div>
        <div class="mu-admin-tab" data-tab="permissions">Permissions</div>
        <div class="mu-admin-tab" data-tab="tokens">Ext Tokens</div>
        <div class="mu-admin-tab" data-tab="stats">Stats</div>
      </div>
      <div class="mu-admin-content"></div>
    </div>
  `;

  document.body.appendChild(panelEl);

  // Close button
  panelEl.querySelector("#mu-admin-close-btn").addEventListener("click", closeAdminPanel);
  
  // Close on overlay click
  panelEl.addEventListener("click", (e) => {
    if (e.target === panelEl) closeAdminPanel();
  });

  // Tab clicks
  panelEl.querySelectorAll(".mu-admin-tab").forEach(tab => {
    tab.addEventListener("click", () => renderTab(tab.dataset.tab));
  });

  renderTab("users");
}

export function closeAdminPanel() {
  panelEl?.remove();
  panelEl = null;
}

// ─── Global Action Handlers ───

window.__mu_admin_add_user = () => {
  const username = prompt("Username:");
  if (!username) return;
  const password = prompt("Password (min 8 chars):");
  if (!password) return;
  const isAdmin = confirm("Make this user an admin?");

  apiPost("/users", { username, password, is_admin: isAdmin }).then(async res => {
    const data = await res.json();
    if (res.ok) { toast(`User '${username}' created`); renderTab("users"); }
    else toast(data.error || "Error creating user");
  });
};

window.__mu_admin_edit_user = async (userId) => {
  const res = await apiGet(`/users/${userId}`);
  const user = await res.json();
  
  const action = prompt(
    `Editing: ${user.username}\n\nOptions:\n1. Toggle active (currently: ${user.is_active ? 'Active' : 'Disabled'})\n2. Toggle admin (currently: ${user.is_admin ? 'Admin' : 'Regular'})\n3. Reset password\n4. Delete user\n\nEnter choice (1-4):`,
    "1"
  );
  
  if (action === "1") {
    await apiPut(`/users/${userId}`, { is_active: !user.is_active });
    toast(`User ${user.is_active ? 'disabled' : 'enabled'}`);
  } else if (action === "2") {
    await apiPut(`/users/${userId}`, { is_admin: !user.is_admin });
    toast(`Admin status ${user.is_admin ? 'removed' : 'granted'}`);
  } else if (action === "3") {
    const pw = prompt("New password (min 8 chars):");
    if (pw) {
      await apiPut(`/users/${userId}`, { password: pw });
      toast("Password reset");
    }
  } else if (action === "4") {
    if (confirm(`Really delete user '${user.username}'? This cannot be undone.`)) {
      await apiDelete(`/users/${userId}`);
      toast(`User '${user.username}' deleted`);
    }
  }
  renderTab("users");
};

window.__mu_admin_add_group = () => {
  const name = prompt("Group name:");
  if (!name) return;
  const desc = prompt("Description (optional):");
  apiPost("/groups", { name, description: desc }).then(async res => {
    const data = await res.json();
    if (res.ok) { toast(`Group '${name}' created`); renderTab("groups"); }
    else toast(data.error || "Error");
  });
};

window.__mu_admin_edit_group = async (groupId) => {
  const res = await apiGet(`/groups/${groupId}`);
  const group = await res.json();
  
  let info = `Group: ${group.name}\nMembers: ${(group.members||[]).map(m=>m.username).join(', ')||'none'}\n\nOptions:\n1. Add member\n2. Remove member\n3. Edit description\n`;
  if (!group.is_system) info += "4. Delete group\n";
  
  const action = prompt(info + "\nEnter choice:", "1");
  
  if (action === "1") {
    const uname = prompt("Username to add:");
    if (!uname) return;
    // Find user ID by fetching all users
    const usersRes = await apiGet("/users");
    const usersData = await usersRes.json();
    const user = usersData.users?.find(u => u.username === uname);
    if (!user) { toast("User not found"); return; }
    await apiPost(`/groups/${groupId}/members`, { user_id: user.id });
    toast(`Added '${uname}' to '${group.name}'`);
  } else if (action === "2") {
    const uname = prompt(`Remove who? Members: ${(group.members||[]).map(m=>m.username).join(', ')}`);
    if (!uname) return;
    const member = group.members?.find(m => m.username === uname);
    if (!member) { toast("Member not found"); return; }
    await apiDelete(`/groups/${groupId}/members/${member.id}`);
    toast(`Removed '${uname}' from '${group.name}'`);
  } else if (action === "3") {
    const desc = prompt("New description:", group.description || "");
    await apiPut(`/groups/${groupId}`, { description: desc });
    toast("Description updated");
  } else if (action === "4" && !group.is_system) {
    if (confirm(`Delete group '${group.name}'?`)) {
      await apiDelete(`/groups/${groupId}`);
      toast(`Group deleted`);
    }
  }
  renderTab("groups");
};

window.__mu_admin_add_perm = () => {
  document.getElementById("mu-perm-form").style.display = "block";
};

window.__mu_admin_save_perm = async () => {
  const group_id = document.getElementById("mu-perm-group").value;
  const resource_type = document.getElementById("mu-perm-type").value;
  const resource_pattern = document.getElementById("mu-perm-pattern").value;
  const action = document.getElementById("mu-perm-action").value;
  const priority = parseInt(document.getElementById("mu-perm-priority").value) || 0;

  if (!resource_pattern) { toast("Pattern is required"); return; }

  const res = await apiPost("/permissions", { group_id, resource_type, resource_pattern, action, priority });
  const data = await res.json();
  if (res.ok) {
    toast("Permission rule added");
    document.getElementById("mu-perm-form").style.display = "none";
    renderTab("permissions");
  } else {
    toast(data.error || "Error");
  }
};

window.__mu_admin_del_perm = async (permId) => {
  if (!confirm("Delete this permission rule?")) return;
  await apiDelete(`/permissions/${permId}`);
  toast("Rule deleted");
  renderTab("permissions");
};

window.__mu_admin_add_ext_token = () => {
  document.getElementById("mu-ext-token-form").style.display = "block";
};

window.__mu_admin_save_ext_token = async () => {
  const group_id = document.getElementById("mu-ext-group").value;
  const service_name = document.getElementById("mu-ext-service").value;
  const token = document.getElementById("mu-ext-value").value;
  const description = document.getElementById("mu-ext-desc").value;

  if (!service_name || !token) { toast("Service name and token are required"); return; }

  const res = await apiPost("/ext-tokens", { group_id, service_name, token, description });
  if (res.ok) {
    toast("Token saved");
    document.getElementById("mu-ext-token-form").style.display = "none";
    renderTab("tokens");
  } else {
    const data = await res.json();
    toast(data.error || "Error");
  }
};

window.__mu_admin_del_ext_token = async (tokenId) => {
  if (!confirm("Delete this external token?")) return;
  await apiDelete(`/ext-tokens/${tokenId}`);
  toast("Token deleted");
  renderTab("tokens");
};
