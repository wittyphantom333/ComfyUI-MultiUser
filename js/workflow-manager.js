/**
 * ComfyUI-MultiUser — Per-user Workflow Manager
 *
 * Adds "My Workflows" to the user sidebar tab.
 * Users can save the current graph, list saved workflows, and load/delete them.
 */

import { apiGet, apiPost, apiPut, apiDelete, authHeaders } from "./api.js";

/** CSS — injected once into the document head. */
const WF_CSS = `
  .mu-wf-list { margin-top: 8px; }
  .mu-wf-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 8px; background: #1a1a2e; border-radius: 4px;
    margin-bottom: 4px; font-size: 12px;
  }
  .mu-wf-name {
    cursor: pointer; color: #6bb5ff; flex: 1; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .mu-wf-name:hover { text-decoration: underline; }
  .mu-wf-meta { color: #666; font-size: 10px; margin-left: 8px; flex-shrink: 0; }
  .mu-wf-del {
    background: none; border: none; color: #ff6b6b; cursor: pointer;
    font-size: 14px; padding: 2px 6px; border-radius: 3px; flex-shrink: 0;
  }
  .mu-wf-del:hover { background: #3d1f1f; }
`;
let _cssInjected = false;
function _injectCss() {
  if (_cssInjected) return;
  _cssInjected = true;
  const s = document.createElement("style");
  s.id = "mu-wf-styles";
  s.textContent = WF_CSS;
  document.head.appendChild(s);
}

function _toast(severity, msg) {
  import("./multiuser.js").then(m => m.showToast(severity, "Workflows", msg)).catch(() => {
    console.log(`[MultiUser Workflows] ${severity}: ${msg}`);
  });
}

/**
 * Build the workflow manager DOM fragment and return it.
 * Called from user-menu.js to embed inside the sidebar.
 */
export function buildWorkflowSection() {
  _injectCss();

  const section = document.createElement("div");
  section.className = "mu-section";
  section.id = "mu-workflows-section";
  section.innerHTML = `
    <p class="mu-section-title">My Workflows</p>
    <div style="display:flex;gap:6px;margin-bottom:8px;">
      <button class="mu-btn mu-btn-sm mu-btn-primary" id="mu-wf-save-btn">Save Current</button>
      <button class="mu-btn mu-btn-sm mu-btn-outline" id="mu-wf-refresh-btn">Refresh</button>
    </div>
    <div id="mu-wf-list" class="mu-wf-list">Loading…</div>
  `;

  // Bind events after a tick (DOM needs to be attached)
  setTimeout(() => {
    section.querySelector("#mu-wf-save-btn")?.addEventListener("click", _saveCurrentWorkflow);
    section.querySelector("#mu-wf-refresh-btn")?.addEventListener("click", () => _loadList(section));
    _loadList(section);
  }, 0);

  return section;
}

// ── List ──
async function _loadList(section) {
  const container = section?.querySelector("#mu-wf-list") || document.querySelector("#mu-wf-list");
  if (!container) return;
  try {
    const res = await apiGet("/workflows");
    const data = await res.json();
    const workflows = data.workflows || [];
    if (workflows.length === 0) {
      container.innerHTML = '<div style="color:#666;font-size:12px;">No saved workflows yet.</div>';
      return;
    }
    container.innerHTML = workflows.map(w => `
      <div class="mu-wf-item" data-wf-id="${w.id}">
        <span class="mu-wf-name" title="${_esc(w.description || w.name)}">${_esc(w.name)}</span>
        <span class="mu-wf-meta">${_relTime(w.updated_at)}</span>
        <button class="mu-wf-del" data-wf-id="${w.id}" title="Delete">×</button>
      </div>
    `).join("");

    container.querySelectorAll(".mu-wf-name").forEach(el => {
      el.addEventListener("click", () => _loadWorkflow(el.closest(".mu-wf-item").dataset.wfId));
    });
    container.querySelectorAll(".mu-wf-del").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.wfId;
        if (!confirm("Delete this workflow?")) return;
        try {
          await apiDelete(`/workflows/${id}`);
          _toast("success", "Deleted");
          _loadList(section);
        } catch (e) { _toast("error", e.message); }
      });
    });
  } catch (e) {
    container.innerHTML = `<div style="color:#ff6b6b;font-size:12px;">Error: ${e.message}</div>`;
  }
}

// ── Save ──
async function _saveCurrentWorkflow() {
  // Access ComfyUI's app to export the graph
  let graphJson;
  try {
    const { app } = await import("../../scripts/app.js");
    graphJson = app.graph.serialize();
  } catch (e) {
    _toast("error", "Cannot access current graph: " + e.message);
    return;
  }

  const name = prompt("Workflow name:", "My Workflow");
  if (!name) return;

  try {
    const res = await apiPost("/workflows", {
      name,
      workflow_json: graphJson,
    });
    const data = await res.json();
    if (data.created || data.updated) {
      _toast("success", data.updated ? "Workflow updated" : "Workflow saved");
      // Refresh list if section exists
      const section = document.querySelector("#mu-workflows-section");
      if (section) _loadList(section);
    } else {
      _toast("error", data.error || "Unknown error");
    }
  } catch (e) {
    _toast("error", e.message);
  }
}

// ── Load ──
async function _loadWorkflow(wfId) {
  try {
    const res = await apiGet(`/workflows/${wfId}`);
    const data = await res.json();
    if (!data.workflow_json) {
      _toast("error", "Workflow data is empty");
      return;
    }
    const { app } = await import("../../scripts/app.js");
    const wfJson = typeof data.workflow_json === "string"
      ? JSON.parse(data.workflow_json)
      : data.workflow_json;
    app.loadGraphData(wfJson);
    _toast("success", `Loaded "${data.name}"`);
  } catch (e) {
    _toast("error", e.message);
  }
}

/**
 * Render the workflows sidebar tab as a standalone panel.
 * Called by ComfyUI's sidebar tab system with a DOM element to populate.
 */
export function renderWorkflowSidebar(el) {
  _injectCss();
  el.innerHTML = "";

  const container = document.createElement("div");
  container.style.cssText = "padding:12px;font-family:Arial,sans-serif;color:var(--descrip-text,#bbb);font-size:13px;";

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h3 style="margin:0;font-size:15px;color:var(--input-text,#ddd);">My Workflows</h3>
      <button class="mu-btn mu-btn-sm mu-btn-outline" id="mu-wf-sidebar-refresh"
              style="padding:4px 10px;font-size:11px;border:1px solid var(--border-color,#4e4e4e);
                     background:transparent;color:var(--descrip-text,#bbb);border-radius:5px;cursor:pointer;">Refresh</button>
    </div>
    <button id="mu-wf-sidebar-save"
            style="width:100%;padding:8px;margin-bottom:12px;border:none;border-radius:6px;
                   background:var(--comfy-input-bg,#535353);color:var(--input-text,#ddd);
                   font-size:12px;font-weight:600;cursor:pointer;">Save Current Workflow</button>
    <div id="mu-wf-sidebar-list" class="mu-wf-list">Loading…</div>
  `;

  el.appendChild(container);

  // Use a thin wrapper so _loadList can find #mu-wf-list inside it
  const listDiv = container.querySelector("#mu-wf-sidebar-list");
  listDiv.id = "mu-wf-list";
  const fakeSection = container;
  fakeSection.querySelector = (sel) => {
    if (sel === "#mu-wf-list") return listDiv;
    return container.querySelector(sel);
  };

  setTimeout(() => {
    container.querySelector("#mu-wf-sidebar-save")?.addEventListener("click", _saveCurrentWorkflow);
    container.querySelector("#mu-wf-sidebar-refresh")?.addEventListener("click", () => _loadList(fakeSection));
    _loadList(fakeSection);
  }, 0);
}

// ── Helpers ──
function _esc(s) {
  const el = document.createElement("span");
  el.textContent = s || "";
  return el.innerHTML;
}

function _relTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  } catch { return ""; }
}
