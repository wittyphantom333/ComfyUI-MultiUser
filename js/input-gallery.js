/**
 * ComfyUI-MultiUser — Input Gallery
 *
 * Native-looking input browser that matches ComfyUI's dark theme.
 * Features: thumbnail grid, upload, right-click context menu,
 * lightbox, keyboard navigation, multi-select, bulk delete.
 */

import { apiGet, apiPost, apiDelete } from "./api.js";

/* ────────────────────────────────────────────────────────────────────
   CSS — uses ComfyUI's CSS custom-properties with safe fallbacks
   ──────────────────────────────────────────────────────────────────── */
const CSS = `
/* === Container === */
.mu-inp-gallery{
  padding:8px; height:100%; display:flex; flex-direction:column;
  color:var(--fg-color,#ddd); font-size:12px; font-family:Arial,sans-serif;
}

/* === Toolbar === */
.mu-inp-toolbar{
  display:flex; flex-wrap:wrap; gap:4px; margin-bottom:6px; align-items:center;
}
.mu-inp-toolbar input,.mu-inp-toolbar select{
  padding:4px 6px; border:1px solid var(--border-color,#4e4e4e); border-radius:4px;
  background:var(--comfy-input-bg,#222); color:var(--input-text,var(--fg-color,#ddd));
  font-size:11px; outline:none;
}
.mu-inp-toolbar input:focus,.mu-inp-toolbar select:focus{border-color:#888}
.mu-inp-toolbar input[type="text"]{flex:1;min-width:60px}
.mu-inp-toolbar select{cursor:pointer}
.mu-inp-toolbar-btn{
  padding:4px 8px; border:1px solid var(--border-color,#4e4e4e); border-radius:4px;
  background:var(--comfy-input-bg,#222); color:var(--fg-color,#ddd);
  cursor:pointer; font-size:11px; display:flex; align-items:center; gap:3px;
}
.mu-inp-toolbar-btn:hover{background:#333}
.mu-inp-toolbar-btn.upload{background:#2e7d32;color:#fff;border-color:#388e3c}
.mu-inp-toolbar-btn.upload:hover{background:#388e3c}

/* === Grid === */
.mu-inp-grid{
  flex:1; overflow-y:auto; display:grid;
  grid-template-columns:repeat(auto-fill,minmax(110px,1fr));
  gap:4px; align-content:start;
}
.mu-inp-item{
  position:relative; aspect-ratio:1; border-radius:4px; overflow:hidden;
  cursor:pointer; background:var(--comfy-input-bg,#222);
  border:1px solid transparent; transition:border-color .15s;
}
.mu-inp-item:hover{border-color:var(--border-color,#4e4e4e)}
.mu-inp-item.selected{border-color:#236692;box-shadow:0 0 0 2px rgba(35,102,146,.5)}
.mu-inp-item.selected::after{
  content:'✓';position:absolute;top:4px;left:4px;z-index:2;
  background:#236692;color:#fff;width:18px;height:18px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;
  box-shadow:0 1px 3px rgba(0,0,0,.5);
}
.mu-inp-item img{width:100%;height:100%;object-fit:cover;display:block}

/* === Selection bar === */
.mu-inp-sel-bar{
  display:flex;align-items:center;gap:8px;padding:5px 8px;
  background:linear-gradient(135deg,rgba(35,102,146,.2),rgba(35,102,146,.1));
  border:1px solid rgba(35,102,146,.4);border-radius:4px;margin-bottom:6px;
  font-size:11px;color:#5ba3d9;
}
.mu-inp-sel-bar-count{font-weight:700}
.mu-inp-sel-bar-btn{
  padding:2px 8px;border:1px solid rgba(91,163,217,.3);border-radius:3px;
  background:transparent;color:#5ba3d9;cursor:pointer;font-size:10px;
}
.mu-inp-sel-bar-btn:hover{background:rgba(91,163,217,.15)}
.mu-inp-sel-bar-btn.danger{color:#ef5350;border-color:rgba(239,83,80,.3)}
.mu-inp-sel-bar-btn.danger:hover{background:rgba(239,83,80,.15)}

/* Hover overlay */
.mu-inp-item .mu-inp-ov{
  position:absolute;bottom:0;left:0;right:0;
  padding:14px 4px 3px;
  background:linear-gradient(transparent,rgba(0,0,0,.85));
  opacity:0;transition:opacity .15s;
  display:flex;justify-content:space-between;align-items:flex-end;
}
.mu-inp-item:hover .mu-inp-ov{opacity:1}
.mu-inp-ov-name{
  font-size:9px;color:#ccc;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;flex:1;min-width:0;
}

/* Badges */
.mu-inp-badge{
  position:absolute;border-radius:3px;
  padding:2px 5px;font-size:8px;font-weight:700;letter-spacing:.4px;
  line-height:1;
}
.mu-inp-badge-fmt{
  top:4px;right:4px;
  text-shadow:0 1px 2px rgba(0,0,0,.9);
  border:1px solid rgba(255,255,255,.12);
  background:rgba(0,0,0,.7);
  color:#aab;
}
.mu-inp-badge-fmt[data-fmt="PNG"]{color:#66bb6a;border-color:rgba(102,187,106,.3)}
.mu-inp-badge-fmt[data-fmt="JPG"],.mu-inp-badge-fmt[data-fmt="JPEG"]{color:#ffa726;border-color:rgba(255,167,38,.3)}
.mu-inp-badge-fmt[data-fmt="WEBP"]{color:#42a5f5;border-color:rgba(66,165,245,.3)}
.mu-inp-badge-fmt[data-fmt="GIF"]{color:#ab47bc;border-color:rgba(171,71,188,.3)}
.mu-inp-badge-fmt[data-fmt="MP4"]{color:#ef5350;border-color:rgba(239,83,80,.3)}
.mu-inp-badge-fmt[data-fmt="WEBM"]{color:#ec407a;border-color:rgba(236,64,122,.3)}
.mu-inp-badge-fmt[data-fmt="MOV"]{color:#ff7043;border-color:rgba(255,112,67,.3)}
.mu-inp-badge-fmt[data-fmt="MKV"]{color:#8d6e63;border-color:rgba(141,110,99,.3)}
.mu-inp-badge-fmt[data-fmt="AVI"]{color:#78909c;border-color:rgba(120,144,156,.3)}
.mu-inp-badge-fmt[data-fmt="BMP"]{color:#9e9e9e;border-color:rgba(158,158,158,.3)}
.mu-inp-badge-fmt[data-fmt="TIFF"]{color:#a1887f;border-color:rgba(161,136,127,.3)}

/* === Context menu === */
.mu-inp-ctx{
  position:fixed;z-index:100000;min-width:180px;
  background:var(--comfy-menu-bg,#353535);
  border:1px solid var(--border-color,#4e4e4e);
  border-radius:4px;padding:4px 0;
  box-shadow:0 4px 16px rgba(0,0,0,.5);font-size:12px;
}
.mu-inp-ctx-item{
  padding:5px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;
  color:var(--fg-color,#ddd);
}
.mu-inp-ctx-item:hover{background:#236692;color:#fff}
.mu-inp-ctx-sep{height:1px;background:var(--border-color,#4e4e4e);margin:3px 8px}
.mu-inp-ctx-item.danger{color:#ef5350}
.mu-inp-ctx-item.danger:hover{background:#c62828;color:#fff}

/* === Pagination === */
.mu-inp-pag{
  display:flex;align-items:center;justify-content:center;gap:6px;
  padding:6px 0 2px;font-size:11px;flex-shrink:0;color:var(--descrip-text,#999);
}
.mu-inp-pag button{
  padding:3px 8px;border:1px solid var(--border-color,#4e4e4e);border-radius:3px;
  background:var(--comfy-input-bg,#222);color:var(--fg-color,#ddd);
  cursor:pointer;font-size:11px;
}
.mu-inp-pag button:hover:not(:disabled){background:#333}
.mu-inp-pag button:disabled{opacity:.3;cursor:default}

/* === Empty / loading === */
.mu-inp-empty{text-align:center;color:var(--descrip-text,#999);padding:30px 10px;font-size:12px}
.mu-inp-loading{text-align:center;padding:20px;color:var(--descrip-text,#999);font-size:11px}

/* === Lightbox === */
.mu-inp-lb{
  position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);
  display:flex;flex-direction:column;
}
.mu-inp-lb-top{
  display:flex;justify-content:space-between;align-items:center;
  padding:8px 12px;background:rgba(0,0,0,.6);flex-shrink:0;
}
.mu-inp-lb-top-left{
  font-size:12px;font-weight:600;color:#ddd;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;
}
.mu-inp-lb-top-right{display:flex;gap:6px;flex-shrink:0}
.mu-inp-lb-top button{
  padding:4px 10px;border:none;border-radius:3px;font-size:11px;font-weight:600;
  cursor:pointer;color:#ddd;background:#444;
}
.mu-inp-lb-top button:hover{background:#555}
.mu-inp-lb-btn-dl{background:#2e7d32;color:#fff}
.mu-inp-lb-btn-dl:hover{background:#388e3c}
.mu-inp-lb-btn-del{background:#c62828;color:#fff}
.mu-inp-lb-btn-del:hover{background:#d32f2f}

/* Content area */
.mu-inp-lb-body{
  flex:1;display:flex;align-items:center;justify-content:center;
  overflow:hidden;position:relative;cursor:zoom-out;
}
.mu-inp-lb-body img,.mu-inp-lb-body video{max-width:95%;max-height:100%;object-fit:contain}

/* Nav */
.mu-inp-lb-nav{
  position:absolute;top:50%;transform:translateY(-50%);
  background:rgba(0,0,0,.4);border:none;color:#ccc;font-size:20px;
  cursor:pointer;padding:10px 6px;border-radius:3px;z-index:1;
}
.mu-inp-lb-nav:hover{background:rgba(0,0,0,.7);color:#fff}
.mu-inp-lb-nav-prev{left:6px}
.mu-inp-lb-nav-next{right:6px}

/* Bottom panel */
.mu-inp-lb-bottom{
  background:rgba(0,0,0,.7);padding:8px 12px;display:flex;flex-wrap:wrap;
  gap:8px;align-items:center;flex-shrink:0;
}
.mu-inp-lb-info{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:#999;flex:1}
.mu-inp-lb-actions{display:flex;gap:6px;align-items:center}

/* === Upload drop zone === */
.mu-inp-dropzone{
  border:2px dashed rgba(91,163,217,.4);border-radius:8px;
  padding:20px;text-align:center;color:#5ba3d9;font-size:12px;
  cursor:pointer;margin-bottom:6px;transition:all .2s;
  background:transparent;
}
.mu-inp-dropzone:hover,.mu-inp-dropzone.dragover{
  border-color:#5ba3d9;background:rgba(91,163,217,.08);
}
.mu-inp-dropzone.uploading{
  border-color:#ff9800;color:#ff9800;cursor:wait;
}
`;

let _cssInjected = false;
function _injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ────────────────────────────────────────────────────────────────────
   State
   ──────────────────────────────────────────────────────────────────── */
let _el = null;
let _page = 1;
const PER = 60;
let _sort = "newest";
let _search = "";
let _type = "all";
let _userF = "";
let _files = [];
let _total = 0;
let _pages = 0;
let _mode = "personal"; // "personal" | "admin"
let _endpoint = "/inputs";
let _selected = new Set();
let _lastClickIdx = -1;
let _debounce = null;
let _admin = false;

/* ────────────────────────────────────────────────────────────────────
   Public entry points
   ──────────────────────────────────────────────────────────────────── */
function _renderInto(el, mode) {
  _injectCSS();
  el.innerHTML = "";
  const user = window.__multiuser_current_user;
  if (!user) {
    el.innerHTML = '<div class="mu-inp-empty">Sign in to view your inputs.</div>';
    return;
  }
  _admin = !!user.is_admin;
  _mode = mode || "personal";
  _endpoint = _mode === "admin" ? "/inputs/all" : "/inputs";
  _page = 1; _search = ""; _type = "all"; _userF = "";
  _selected = new Set(); _lastClickIdx = -1;

  const root = _mk("div", "mu-inp-gallery");
  _el = root;

  /* toolbar */
  const tb = _mk("div", "mu-inp-toolbar");
  const inp = _mk("input"); inp.type = "text"; inp.placeholder = "Search\u2026";
  inp.oninput = () => { clearTimeout(_debounce); _debounce = setTimeout(() => { _search = inp.value; _page = 1; _load(); }, 300); };
  tb.appendChild(inp);
  tb.appendChild(_sel([["newest","Newest"],["oldest","Oldest"],["name","Name"]], _sort, v => { _sort = v; _page = 1; _load(); }));
  tb.appendChild(_sel([["all","All Types"],["image","Images"],["video","Videos"]], _type, v => { _type = v; _page = 1; _load(); }));
  if (_mode === "admin") {
    const us = _sel([["","All Users"]], "", v => { _userF = v; _page = 1; _load(); });
    us.id = "mu-inp-uf"; tb.appendChild(us); _loadUsers(us);
  }
  const uploadBtn = _mk("button","mu-inp-toolbar-btn upload"); uploadBtn.textContent = "\u2b06 Upload";
  uploadBtn.onclick = () => _triggerUpload();
  tb.appendChild(uploadBtn);
  const rbtn = _mk("button","mu-inp-toolbar-btn"); rbtn.textContent = "\u21bb"; rbtn.title = "Refresh";
  rbtn.onclick = () => _load();
  tb.appendChild(rbtn);
  root.appendChild(tb);

  /* drop zone */
  const dz = _mk("div","mu-inp-dropzone"); dz.id = "mu-inp-dz";
  dz.textContent = "Drag & drop files here, or click Upload above";
  dz.onclick = () => _triggerUpload();
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("dragover"); _handleDrop(e.dataTransfer.files); });
  root.appendChild(dz);

  /* selection bar */
  const selBar = _mk("div","mu-inp-sel-bar"); selBar.id = "mu-inp-sel-bar"; selBar.style.display = "none";
  root.appendChild(selBar);

  /* grid */
  const grid = _mk("div","mu-inp-grid"); grid.id = "mu-inp-grid"; root.appendChild(grid);

  /* pagination */
  const pag = _mk("div","mu-inp-pag"); pag.id = "mu-inp-pag"; root.appendChild(pag);

  el.appendChild(root);
  _load();
}

export function renderInputGallery(el) { _renderInto(el, "personal"); }
export function renderAllInputsGallery(el) { _renderInto(el, "admin"); }

/* ────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────── */
function _mk(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function _sel(opts, val, fn) {
  const s = document.createElement("select");
  s.innerHTML = opts.map(([v,l]) => `<option value="${v}">${l}</option>`).join("");
  s.value = val;
  s.onchange = () => fn(s.value);
  return s;
}

function _viewUrl(f) {
  const p = new URLSearchParams({filename: f.filename, type: "input"});
  if (f.subfolder) p.set("subfolder", f.subfolder);
  return `/view?${p}`;
}
function _thumbUrl(f) {
  return `/multiuser/inputs/thumbnail?${new URLSearchParams({filename: f.filename, subfolder: f.subfolder||"", size:"256", t: String(Math.floor(f.modified||0))})}`;
}
function _bytes(b) { return b < 1024 ? b+" B" : b < 1048576 ? (b/1024).toFixed(1)+" KB" : (b/1048576).toFixed(1)+" MB"; }
function _date(ts) { return new Date(ts*1000).toLocaleString(); }
function _esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

/* ────────────────────────────────────────────────────────────────────
   Data loading
   ──────────────────────────────────────────────────────────────────── */
async function _load() {
  const grid = _el?.querySelector("#mu-inp-grid");
  if (!grid) return;
  grid.innerHTML = '<div class="mu-inp-loading">Loading\u2026</div>';
  try {
    const p = new URLSearchParams({page:_page, per_page:PER, sort:_sort});
    if (_search) p.set("search",_search);
    if (_type !== "all") p.set("type",_type);
    if (_userF) p.set("user",_userF);
    const r = await apiGet(`${_endpoint}?${p}`);
    if (!r.ok) { const e = await r.json().catch(()=>({})); grid.innerHTML = `<div class="mu-inp-empty">${e.error||"Failed to load"}</div>`; return; }
    const d = await r.json();
    _files = d.files||[]; _total = d.total||0; _pages = d.pages||0;
    _renderGrid(grid);
    _renderPag();
    // Hide dropzone if we have files
    const dz = _el?.querySelector("#mu-inp-dz");
    if (dz) dz.style.display = _files.length ? "none" : "";
  } catch(e) { grid.innerHTML = `<div class="mu-inp-empty">${e.message}</div>`; }
}

async function _loadUsers(sel) {
  try {
    const r = await apiGet("/inputs/users");
    if (!r.ok) return;
    const d = await r.json();
    for (const u of (d.users||[])) {
      const o = document.createElement("option");
      o.value = u.username === "(shared)" ? "" : u.username;
      o.textContent = `${u.username} (${u.file_count})`;
      sel.appendChild(o);
    }
  } catch {}
}

/* ────────────────────────────────────────────────────────────────────
   Grid rendering
   ──────────────────────────────────────────────────────────────────── */
function _renderGrid(grid) {
  grid.innerHTML = "";
  if (!_files.length) {
    grid.innerHTML = '<div class="mu-inp-empty" style="grid-column:1/-1">No input files found. Upload some!</div>';
    return;
  }
  for (const f of _files) {
    const item = _mk("div","mu-inp-item");
    item.title = f.relative_path;

    const img = _mk("img");
    img.loading = "lazy";
    img.alt = f.filename;
    img.src = _thumbUrl(f);
    img.onerror = () => { if (f.type === "image") img.src = _viewUrl(f); };
    item.appendChild(img);

    // format badge
    {
      const fmt = f.format || f.filename.split(".").pop().toUpperCase();
      const b = _mk("div","mu-inp-badge mu-inp-badge-fmt");
      b.setAttribute("data-fmt", fmt);
      b.textContent = fmt;
      item.appendChild(b);
    }

    // hover overlay
    const ov = _mk("div","mu-inp-ov");
    const nm = _mk("span","mu-inp-ov-name"); nm.textContent = f.filename;
    ov.appendChild(nm);
    item.appendChild(ov);

    // Mark selected
    if (_selected.has(f.relative_path)) item.classList.add("selected");

    // click
    item.addEventListener("click", (e) => {
      const idx = _files.indexOf(f);
      if (e.ctrlKey || e.metaKey) {
        if (_selected.has(f.relative_path)) { _selected.delete(f.relative_path); item.classList.remove("selected"); }
        else { _selected.add(f.relative_path); item.classList.add("selected"); }
        _lastClickIdx = idx;
        _renderSelBar();
        return;
      }
      if (e.shiftKey && _lastClickIdx >= 0) {
        const lo = Math.min(_lastClickIdx, idx), hi = Math.max(_lastClickIdx, idx);
        for (let k = lo; k <= hi; k++) _selected.add(_files[k].relative_path);
        _syncSelVisuals();
        _renderSelBar();
        return;
      }
      if (_selected.size > 0) { _selected.clear(); _syncSelVisuals(); _renderSelBar(); return; }
      _openLB(f);
    });

    // right-click
    item.addEventListener("contextmenu", e => {
      if (_selected.size > 1 && _selected.has(f.relative_path)) { _openBulkCtx(e); return; }
      if (_selected.size > 0 && !_selected.has(f.relative_path)) { _selected.clear(); _syncSelVisuals(); _renderSelBar(); }
      _openCtx(e, f);
    });

    grid.appendChild(item);
  }
}

/* ────────────────────────────────────────────────────────────────────
   Pagination
   ──────────────────────────────────────────────────────────────────── */
function _renderPag() {
  const el = _el?.querySelector("#mu-inp-pag");
  if (!el) return;
  el.innerHTML = "";
  if (_pages <= 1) { if (_total) el.textContent = `${_total} file${_total!==1?"s":""}`; return; }
  const prev = _mk("button"); prev.textContent = "\u25c0 Prev"; prev.disabled = _page <= 1;
  prev.onclick = () => { _page--; _load(); };
  el.appendChild(prev);
  el.appendChild(Object.assign(_mk("span"),{textContent:`${_page} / ${_pages}  (${_total})`}));
  const next = _mk("button"); next.textContent = "Next \u25b6"; next.disabled = _page >= _pages;
  next.onclick = () => { _page++; _load(); };
  el.appendChild(next);
}

/* ────────────────────────────────────────────────────────────────────
   Context menu
   ──────────────────────────────────────────────────────────────────── */
function _closeCtx() { document.querySelectorAll(".mu-inp-ctx").forEach(e => e.remove()); }

function _openCtx(e, f) {
  e.preventDefault();
  e.stopPropagation();
  _closeCtx();

  const m = _mk("div","mu-inp-ctx");

  _ctxItem(m, "Open", () => _openLB(f));
  _ctxItem(m, "Download", () => { const a = _mk("a"); a.href = _viewUrl(f); a.download = f.filename; a.click(); });
  _ctxItem(m, "Copy filename", () => { navigator.clipboard.writeText(f.filename); _toast("Copied filename"); });
  _ctxItem(m, "Copy path", () => { navigator.clipboard.writeText(f.relative_path); _toast("Copied path"); });
  _ctxSep(m);
  _ctxItem(m, "Delete", () => { _closeCtx(); _deleteFile(f); }, true);

  m.style.left = e.clientX + "px";
  m.style.top = e.clientY + "px";
  document.body.appendChild(m);

  requestAnimationFrame(() => {
    const r = m.getBoundingClientRect();
    if (r.right > window.innerWidth) m.style.left = (window.innerWidth - r.width - 4) + "px";
    if (r.bottom > window.innerHeight) m.style.top = (window.innerHeight - r.height - 4) + "px";
  });

  const closer = (ev) => {
    if (!m.contains(ev.target)) { _closeCtx(); document.removeEventListener("click", closer, true); }
  };
  setTimeout(() => document.addEventListener("click", closer, true), 0);
}

function _ctxItem(menu, label, fn, danger) {
  const d = _mk("div","mu-inp-ctx-item" + (danger ? " danger" : ""));
  d.textContent = label;
  if (fn) d.onclick = () => { _closeCtx(); fn(); };
  else d.style.opacity = "0.6";
  menu.appendChild(d);
}
function _ctxSep(menu) { menu.appendChild(_mk("div","mu-inp-ctx-sep")); }

/* ────────────────────────────────────────────────────────────────────
   Multi-select helpers
   ──────────────────────────────────────────────────────────────────── */
function _syncSelVisuals() {
  const grid = _el?.querySelector("#mu-inp-grid");
  if (!grid) return;
  const items = grid.querySelectorAll(".mu-inp-item");
  items.forEach((el, i) => {
    if (i < _files.length && _selected.has(_files[i].relative_path)) el.classList.add("selected");
    else el.classList.remove("selected");
  });
}

function _renderSelBar() {
  const bar = _el?.querySelector("#mu-inp-sel-bar");
  if (!bar) return;
  if (_selected.size === 0) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  bar.innerHTML = "";
  const cnt = _mk("span","mu-inp-sel-bar-count"); cnt.textContent = `${_selected.size} selected`; bar.appendChild(cnt);
  const selAll = _mk("button","mu-inp-sel-bar-btn"); selAll.textContent = "Select All";
  selAll.onclick = () => { _files.forEach(f => _selected.add(f.relative_path)); _syncSelVisuals(); _renderSelBar(); };
  bar.appendChild(selAll);
  const clr = _mk("button","mu-inp-sel-bar-btn"); clr.textContent = "Clear";
  clr.onclick = () => { _selected.clear(); _syncSelVisuals(); _renderSelBar(); };
  bar.appendChild(clr);
  // Bulk delete
  const del = _mk("button","mu-inp-sel-bar-btn danger"); del.textContent = `Delete ${_selected.size}`;
  del.onclick = () => _bulkDelete(_getSelectedFiles());
  bar.appendChild(del);
}

function _getSelectedFiles() {
  return _files.filter(f => _selected.has(f.relative_path));
}

/* ────────────────────────────────────────────────────────────────────
   Bulk context menu
   ──────────────────────────────────────────────────────────────────── */
function _openBulkCtx(e) {
  e.preventDefault();
  e.stopPropagation();
  _closeCtx();

  const sel = _getSelectedFiles();
  const n = sel.length;
  const m = _mk("div","mu-inp-ctx");

  const hdr = _mk("div","mu-inp-ctx-item"); hdr.style.opacity = "0.6"; hdr.style.fontWeight = "600";
  hdr.textContent = `${n} items selected`; m.appendChild(hdr);
  _ctxSep(m);

  _ctxItem(m, `\u2b07 Download ${n} files`, () => {
    for (const f of sel) {
      const a = _mk("a"); a.href = _viewUrl(f); a.download = f.filename; a.click();
    }
    _toast(`Downloading ${n} files`);
  });
  _ctxSep(m);
  _ctxItem(m, `Delete ${n} files`, () => { _closeCtx(); _bulkDelete(sel); }, true);

  m.style.left = e.clientX + "px";
  m.style.top = e.clientY + "px";
  document.body.appendChild(m);
  requestAnimationFrame(() => {
    const r = m.getBoundingClientRect();
    if (r.right > window.innerWidth) m.style.left = (window.innerWidth - r.width - 4) + "px";
    if (r.bottom > window.innerHeight) m.style.top = (window.innerHeight - r.height - 4) + "px";
  });
  const closer = (ev) => { if (!m.contains(ev.target)) { _closeCtx(); document.removeEventListener("click", closer, true); } };
  setTimeout(() => document.addEventListener("click", closer, true), 0);
}

/* ────────────────────────────────────────────────────────────────────
   Bulk delete
   ──────────────────────────────────────────────────────────────────── */
async function _bulkDelete(files) {
  if (!confirm(`Delete ${files.length} input files? This cannot be undone.`)) return;
  try {
    const items = files.map(f => ({filename: f.filename, subfolder: f.subfolder || ""}));
    const r = await apiPost("/inputs/bulk/delete", {files: items});
    if (r.ok) {
      const d = await r.json();
      _toast(`Deleted ${d.deleted||files.length} files`);
      _selected.clear(); _load();
    } else { const e = await r.json().catch(()=>({})); _toast(e.error||"Bulk delete failed","error"); }
  } catch(e) { _toast(e.message,"error"); }
}

/* ────────────────────────────────────────────────────────────────────
   Upload
   ──────────────────────────────────────────────────────────────────── */
function _triggerUpload() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.accept = "image/*,video/*";
  inp.onchange = () => { if (inp.files.length) _uploadFiles(inp.files); };
  inp.click();
}

async function _handleDrop(fileList) {
  if (!fileList.length) return;
  await _uploadFiles(fileList);
}

async function _uploadFiles(fileList) {
  const dz = _el?.querySelector("#mu-inp-dz");
  if (dz) { dz.classList.add("uploading"); dz.textContent = `Uploading ${fileList.length} file(s)\u2026`; }

  let uploaded = 0;
  let errors = 0;

  for (const file of fileList) {
    try {
      const form = new FormData();
      form.append("file", file);

      const token = localStorage.getItem("multiuser_token");
      const headers = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
        headers["X-MultiUser-Token"] = token;
      }

      const r = await fetch("/multiuser/inputs/upload", {
        method: "POST",
        credentials: "include",
        headers,
        body: form,
      });
      if (r.ok) uploaded++;
      else errors++;
    } catch {
      errors++;
    }
  }

  if (dz) { dz.classList.remove("uploading"); dz.textContent = "Drag & drop files here, or click Upload above"; }

  if (uploaded > 0) _toast(`Uploaded ${uploaded} file(s)`);
  if (errors > 0) _toast(`${errors} file(s) failed`, "error");
  _load();
}

/* ────────────────────────────────────────────────────────────────────
   Lightbox
   ──────────────────────────────────────────────────────────────────── */
let _lbFile = null;

function _openLB(f) {
  _closeLB();
  _lbFile = f;

  const wrap = _mk("div","mu-inp-lb"); wrap.id = "mu-inp-lb";

  /* top bar */
  const top = _mk("div","mu-inp-lb-top");
  top.onclick = e => e.stopPropagation();
  const tl = _mk("div","mu-inp-lb-top-left"); tl.textContent = f.filename;
  top.appendChild(tl);
  const tr = _mk("div","mu-inp-lb-top-right");

  const btnX = _mk("button"); btnX.textContent = "\u2715";
  btnX.onclick = () => _closeLB();
  tr.appendChild(btnX);

  top.appendChild(tr);
  wrap.appendChild(top);

  /* body */
  const body = _mk("div","mu-inp-lb-body");
  body.onclick = () => _closeLB();

  if (f.type === "video") {
    const v = _mk("video"); v.src = _viewUrl(f); v.controls = true; v.autoplay = true;
    v.style.cursor = "default"; v.onclick = e => e.stopPropagation();
    body.appendChild(v);
  } else {
    const img = _mk("img"); img.src = _viewUrl(f); img.alt = f.filename;
    img.onclick = e => e.stopPropagation();
    body.appendChild(img);
  }

  // nav arrows
  const idx = _files.findIndex(x => x.relative_path === f.relative_path);
  if (idx > 0) {
    const p = _mk("button","mu-inp-lb-nav mu-inp-lb-nav-prev"); p.innerHTML = "&#9664;";
    p.onclick = e => { e.stopPropagation(); _openLB(_files[idx-1]); };
    body.appendChild(p);
  }
  if (idx < _files.length - 1) {
    const n = _mk("button","mu-inp-lb-nav mu-inp-lb-nav-next"); n.innerHTML = "&#9654;";
    n.onclick = e => { e.stopPropagation(); _openLB(_files[idx+1]); };
    body.appendChild(n);
  }

  wrap.appendChild(body);

  /* bottom panel */
  const bot = _mk("div","mu-inp-lb-bottom");
  bot.onclick = e => e.stopPropagation();

  const info = _mk("div","mu-inp-lb-info");
  info.innerHTML = `<span>${_bytes(f.size)}</span><span>${_date(f.modified)}</span><span>${_esc(f.relative_path)}</span>`;
  bot.appendChild(info);

  const acts = _mk("div","mu-inp-lb-actions");
  const btnDl = _mk("button","mu-inp-lb-btn-dl"); btnDl.textContent = "\u2b07 Download";
  btnDl.onclick = () => { const a = _mk("a"); a.href = _viewUrl(f); a.download = f.filename; a.click(); };
  acts.appendChild(btnDl);
  const btnDel = _mk("button","mu-inp-lb-btn-del"); btnDel.textContent = "\ud83d\uddd1 Delete";
  btnDel.onclick = () => _deleteFile(f);
  acts.appendChild(btnDel);
  bot.appendChild(acts);

  wrap.appendChild(bot);
  document.body.appendChild(wrap);
  document.addEventListener("keydown", _lbKey);
}

function _closeLB() {
  document.removeEventListener("keydown", _lbKey);
  document.getElementById("mu-inp-lb")?.remove();
  _lbFile = null;
}

function _lbKey(e) {
  if (e.key === "Escape") { _closeLB(); return; }
  if (!_lbFile) return;
  const i = _files.findIndex(x => x.relative_path === _lbFile.relative_path);
  if (e.key === "ArrowRight" && i < _files.length - 1) _openLB(_files[i+1]);
  if (e.key === "ArrowLeft" && i > 0) _openLB(_files[i-1]);
}

/* ────────────────────────────────────────────────────────────────────
   Delete
   ──────────────────────────────────────────────────────────────────── */
async function _deleteFile(f) {
  if (!confirm(`Delete ${f.filename}?`)) return;
  try {
    const p = new URLSearchParams({filename:f.filename});
    if (f.subfolder) p.set("subfolder",f.subfolder);
    const r = await apiDelete(`/inputs/file?${p}`);
    if (r.ok) { _closeLB(); _load(); _toast("Deleted"); }
    else { const e = await r.json().catch(()=>({})); _toast(e.error||"Delete failed","error"); }
  } catch(e) { _toast(e.message,"error"); }
}

/* ────────────────────────────────────────────────────────────────────
   Toast
   ──────────────────────────────────────────────────────────────────── */
async function _toast(msg, type) {
  try {
    const {showToast} = await import("./multiuser.js");
    showToast(type||"success", type==="error"?"Error":"Inputs", msg);
  } catch {
    console.log("[Input Gallery]", msg);
  }
}
