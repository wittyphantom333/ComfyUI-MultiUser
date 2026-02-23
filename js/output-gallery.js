/**
 * ComfyUI-MultiUser — Output Gallery
 *
 * Native-looking output browser that matches ComfyUI's dark theme.
 * Features: thumbnail grid, right-click context menu, star ratings,
 * tagging, metadata viewer, lightbox, keyboard navigation.
 */

import { apiGet, apiPost, apiPut, apiDelete } from "./api.js";

/* ────────────────────────────────────────────────────────────────────
   CSS — uses ComfyUI's CSS custom-properties with safe fallbacks
   so the gallery adapts to custom themes automatically.
   ──────────────────────────────────────────────────────────────────── */
const CSS = `
/* === Container === */
.mu-gallery{
  padding:8px; height:100%; display:flex; flex-direction:column;
  color:var(--fg-color,#ddd); font-size:12px; font-family:Arial,sans-serif;
}

/* === Toolbar === */
.mu-toolbar{
  display:flex; flex-wrap:wrap; gap:4px; margin-bottom:6px; align-items:center;
}
.mu-toolbar input,.mu-toolbar select{
  padding:4px 6px; border:1px solid var(--border-color,#4e4e4e); border-radius:4px;
  background:var(--comfy-input-bg,#222); color:var(--input-text,var(--fg-color,#ddd));
  font-size:11px; outline:none;
}
.mu-toolbar input:focus,.mu-toolbar select:focus{border-color:#888}
.mu-toolbar input[type="text"]{flex:1;min-width:60px}
.mu-toolbar select{cursor:pointer}
.mu-toolbar-btn{
  padding:4px 8px; border:1px solid var(--border-color,#4e4e4e); border-radius:4px;
  background:var(--comfy-input-bg,#222); color:var(--fg-color,#ddd);
  cursor:pointer; font-size:11px; display:flex; align-items:center; gap:3px;
}
.mu-toolbar-btn:hover{background:#333}

/* === Filters row === */
.mu-filters{
  display:flex; flex-wrap:wrap; gap:4px; margin-bottom:6px; align-items:center;
}
.mu-filt-stars{display:inline-flex;gap:1px;cursor:pointer;font-size:13px;user-select:none}
.mu-filt-stars span{color:#555;transition:color .1s}
.mu-filt-stars span.on{color:#e8a317}
.mu-filt-tag{
  display:inline-block; padding:1px 6px; background:#293742; color:#5ba3d9;
  border-radius:3px; font-size:10px; cursor:pointer; border:1px solid transparent;
}
.mu-filt-tag:hover{border-color:#5ba3d9}
.mu-filt-tag.active{background:#236692;color:#fff}

/* === Grid === */
.mu-grid{
  flex:1; overflow-y:auto; display:grid;
  grid-template-columns:repeat(auto-fill,minmax(110px,1fr));
  gap:4px; align-content:start;
}
.mu-item{
  position:relative; aspect-ratio:1; border-radius:4px; overflow:hidden;
  cursor:pointer; background:var(--comfy-input-bg,#222);
  border:1px solid transparent; transition:border-color .15s;
}
.mu-item:hover{border-color:var(--border-color,#4e4e4e)}
.mu-item.selected{border-color:#236692}
.mu-item img{width:100%;height:100%;object-fit:cover;display:block}

/* Hover overlay (gradient at bottom) */
.mu-item .mu-ov{
  position:absolute;bottom:0;left:0;right:0;
  padding:14px 4px 3px;
  background:linear-gradient(transparent,rgba(0,0,0,.85));
  opacity:0;transition:opacity .15s;
  display:flex;justify-content:space-between;align-items:flex-end;
}
.mu-item:hover .mu-ov{opacity:1}
.mu-ov-name{
  font-size:9px;color:#ccc;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;flex:1;min-width:0;
}

/* Stars always visible on rated items */
.mu-item-stars{
  position:absolute;bottom:2px;right:3px;font-size:10px;
  text-shadow:0 1px 3px rgba(0,0,0,.9);pointer-events:none;
  letter-spacing:1px; color:#e8a317;
}

/* Badges */
.mu-badge{
  position:absolute;background:rgba(0,0,0,.65);border-radius:2px;
  padding:1px 4px;font-size:8px;font-weight:700;
}
.mu-badge-vid{top:3px;right:3px;color:#ffb86c}
.mu-badge-tag{top:3px;left:3px;color:#5ba3d9}

/* === Context menu === */
.mu-ctx{
  position:fixed;z-index:100000;min-width:180px;
  background:var(--comfy-menu-bg,#353535);
  border:1px solid var(--border-color,#4e4e4e);
  border-radius:4px;padding:4px 0;
  box-shadow:0 4px 16px rgba(0,0,0,.5);font-size:12px;
}
.mu-ctx-item{
  padding:5px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;
  color:var(--fg-color,#ddd);
}
.mu-ctx-item:hover{background:#236692;color:#fff}
.mu-ctx-sep{height:1px;background:var(--border-color,#4e4e4e);margin:3px 8px}
.mu-ctx-stars{
  display:flex;gap:3px;padding:5px 14px;align-items:center;
}
.mu-ctx-stars-label{font-size:11px;color:#999;margin-right:4px}
.mu-ctx-stars span{font-size:16px;color:#555;cursor:pointer;transition:color .1s}
.mu-ctx-stars span.on{color:#e8a317}
.mu-ctx-stars span:hover{color:#f0c040}
.mu-ctx-item.danger{color:#ef5350}
.mu-ctx-item.danger:hover{background:#c62828;color:#fff}

/* === Pagination === */
.mu-pag{
  display:flex;align-items:center;justify-content:center;gap:6px;
  padding:6px 0 2px;font-size:11px;flex-shrink:0;color:var(--descrip-text,#999);
}
.mu-pag button{
  padding:3px 8px;border:1px solid var(--border-color,#4e4e4e);border-radius:3px;
  background:var(--comfy-input-bg,#222);color:var(--fg-color,#ddd);
  cursor:pointer;font-size:11px;
}
.mu-pag button:hover:not(:disabled){background:#333}
.mu-pag button:disabled{opacity:.3;cursor:default}

/* === Empty / loading === */
.mu-empty{text-align:center;color:var(--descrip-text,#999);padding:30px 10px;font-size:12px}
.mu-loading{text-align:center;padding:20px;color:var(--descrip-text,#999);font-size:11px}

/* === Lightbox === */
.mu-lb{
  position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);
  display:flex;flex-direction:column;
}
.mu-lb-top{
  display:flex;justify-content:space-between;align-items:center;
  padding:8px 12px;background:rgba(0,0,0,.6);flex-shrink:0;
}
.mu-lb-top-left{
  font-size:12px;font-weight:600;color:#ddd;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;
}
.mu-lb-top-right{display:flex;gap:6px;flex-shrink:0}
.mu-lb-top button{
  padding:4px 10px;border:none;border-radius:3px;font-size:11px;font-weight:600;
  cursor:pointer;color:#ddd;background:#444;
}
.mu-lb-top button:hover{background:#555}
.mu-lb-btn-dl{background:#2e7d32;color:#fff}
.mu-lb-btn-dl:hover{background:#388e3c}
.mu-lb-btn-del{background:#c62828;color:#fff}
.mu-lb-btn-del:hover{background:#d32f2f}

/* Content area */
.mu-lb-body{
  flex:1;display:flex;align-items:center;justify-content:center;
  overflow:hidden;position:relative;cursor:zoom-out;
}
.mu-lb-body img,.mu-lb-body video{max-width:95%;max-height:100%;object-fit:contain}

/* Nav */
.mu-lb-nav{
  position:absolute;top:50%;transform:translateY(-50%);
  background:rgba(0,0,0,.4);border:none;color:#ccc;font-size:20px;
  cursor:pointer;padding:10px 6px;border-radius:3px;z-index:1;
}
.mu-lb-nav:hover{background:rgba(0,0,0,.7);color:#fff}
.mu-lb-nav-prev{left:6px}
.mu-lb-nav-next{right:6px}

/* Bottom panel */
.mu-lb-bottom{
  background:rgba(0,0,0,.7);padding:8px 12px;display:flex;flex-direction:column;
  gap:6px;max-height:35vh;overflow-y:auto;flex-shrink:0;
}
.mu-lb-info{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:#999}
.mu-lb-rating{display:flex;align-items:center;gap:6px}
.mu-lb-rating-lbl{font-size:11px;color:#999}
.mu-lb-stars{display:inline-flex;gap:2px;cursor:pointer;font-size:18px}
.mu-lb-stars span{color:#555;transition:color .1s;user-select:none}
.mu-lb-stars span.on{color:#e8a317}
.mu-lb-stars span:hover{color:#f0c040}
.mu-lb-tags{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.mu-lb-tags-lbl{font-size:11px;color:#999}
.mu-lb-tag{
  display:inline-flex;align-items:center;gap:3px;
  background:#293742;color:#5ba3d9;padding:1px 6px;border-radius:2px;font-size:10px;
}
.mu-lb-tag-rm{
  background:none;border:none;color:#ef5350;cursor:pointer;font-size:11px;
  padding:0 1px;line-height:1;
}
.mu-lb-tag-rm:hover{color:#ff1744}
.mu-lb-tag-input{
  padding:2px 5px;border:1px solid var(--border-color,#4e4e4e);border-radius:2px;
  background:var(--comfy-input-bg,#222);color:var(--fg-color,#ddd);
  font-size:10px;outline:none;width:80px;
}
.mu-lb-tag-input:focus{border-color:#888}

/* === Metadata side-panel === */
.mu-meta{
  position:fixed;right:0;top:0;bottom:0;width:360px;max-width:90vw;z-index:100002;
  background:var(--comfy-menu-bg,#353535);
  border-left:1px solid var(--border-color,#4e4e4e);
  overflow-y:auto;padding:12px;font-size:11px;color:var(--fg-color,#ddd);
  box-shadow:-4px 0 12px rgba(0,0,0,.4);
}
.mu-meta h3{margin:0 0 10px;font-size:13px;display:flex;justify-content:space-between;align-items:center}
.mu-meta-close{background:none;border:none;color:#999;cursor:pointer;font-size:16px;padding:2px 4px}
.mu-meta-close:hover{color:#fff}
.mu-meta-sec{margin-bottom:12px}
.mu-meta-sec h4{
  font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
  color:#888;margin:0 0 6px;border-bottom:1px solid #444;padding-bottom:3px;
}
.mu-meta-tbl{width:100%;border-collapse:collapse}
.mu-meta-tbl td{padding:2px 4px;border-bottom:1px solid #333;vertical-align:top}
.mu-meta-tbl td:first-child{color:#888;white-space:nowrap;width:80px}
.mu-meta-tbl td:last-child{word-break:break-all}
.mu-meta-json{
  background:#1a1a1a;border-radius:3px;padding:6px;max-height:180px;overflow:auto;
  font-family:monospace;font-size:10px;color:#aaa;white-space:pre-wrap;word-break:break-all;
}
.mu-meta-btn{
  background:none;border:1px solid #4e4e4e;border-radius:2px;
  color:#5ba3d9;cursor:pointer;padding:1px 6px;font-size:10px;margin-top:3px;
}
.mu-meta-btn:hover{background:#333}
`;

let _cssOk = false;
function _css() {
  if (_cssOk) return;
  _cssOk = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ────────────────────────────────────────────────────────────────────
   State
   ──────────────────────────────────────────────────────────────────── */
let _el_ = null;      // root gallery element
let _page = 1;
const PER = 60;
let _sort = "newest";
let _search = "";
let _type = "all";
let _userF = "";       // admin user filter
let _tagF = "";        // tag filter
let _minR = 0;         // min rating
let _files = [];
let _total = 0;
let _pages = 0;
let _admin = false;
let _tags = [];        // user's known tags
let _debounce = null;
let _mode = "personal"; // "personal" | "admin"
let _endpoint = "/outputs"; // API endpoint for list

/* ────────────────────────────────────────────────────────────────────
   Public entry point (called by multiuser.js sidebar tab)
   ──────────────────────────────────────────────────────────────────── */
function _renderGalleryInto(el, mode) {
  _css();
  el.innerHTML = "";
  const user = window.__multiuser_current_user;
  if (!user) {
    el.innerHTML = '<div class="mu-empty">Sign in to view your outputs.</div>';
    return;
  }
  _admin = !!user.is_admin;
  _mode = mode || "personal";
  _endpoint = _mode === "admin" ? "/outputs/all" : "/outputs";
  _page = 1; _search = ""; _type = "all"; _userF = ""; _tagF = ""; _minR = 0;

  const root = _mk("div", "mu-gallery");
  _el_ = root;

  /* toolbar */
  const tb = _mk("div", "mu-toolbar");
  const inp = _mk("input"); inp.type = "text"; inp.placeholder = "Search…";
  inp.oninput = () => { clearTimeout(_debounce); _debounce = setTimeout(() => { _search = inp.value; _page = 1; _load(); }, 300); };
  tb.appendChild(inp);
  tb.appendChild(_sel([["newest","Newest"],["oldest","Oldest"],["name","Name"],["rating","Top Rated"]], _sort, v => { _sort = v; _page = 1; _load(); }));
  tb.appendChild(_sel([["all","All Types"],["image","Images"],["video","Videos"]], _type, v => { _type = v; _page = 1; _load(); }));
  if (_mode === "admin") { const us = _sel([["","All Users"]], "", v => { _userF = v; _page = 1; _load(); }); us.id = "mu-uf"; tb.appendChild(us); _loadUsers(us); }
  const rbtn = _mk("button","mu-toolbar-btn"); rbtn.textContent = "↻"; rbtn.title = "Refresh";
  rbtn.onclick = () => _load();
  tb.appendChild(rbtn);
  root.appendChild(tb);

  /* filters */
  const filt = _mk("div","mu-filters"); filt.id = "mu-filt"; root.appendChild(filt);

  /* grid */
  const grid = _mk("div","mu-grid"); grid.id = "mu-grid"; root.appendChild(grid);

  /* pagination */
  const pag = _mk("div","mu-pag"); pag.id = "mu-pag"; root.appendChild(pag);

  el.appendChild(root);
  _loadTags();
  _load();
}

export function renderOutputGallery(el) { _renderGalleryInto(el, "personal"); }
export function renderAllOutputsGallery(el) { _renderGalleryInto(el, "admin"); }

/* ────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────── */
function _mk(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function _titleCase(s) { return s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()); }

function _sel(opts, val, fn) {
  const s = document.createElement("select");
  s.innerHTML = opts.map(([v,l]) => `<option value="${v}">${l}</option>`).join("");
  s.value = val;
  s.onchange = () => fn(s.value);
  return s;
}

function _viewUrl(f) {
  const p = new URLSearchParams({filename: f.filename, type: "output"});
  if (f.subfolder) p.set("subfolder", f.subfolder);
  return `/view?${p}`;
}
function _thumbUrl(f) {
  return `/multiuser/outputs/thumbnail?${new URLSearchParams({filename: f.filename, subfolder: f.subfolder||"", size:"256"})}`;
}
function _stars(n) { return Array.from({length:5},(_,i) => i < n ? "★" : "").join(""); }
function _bytes(b) { return b < 1024 ? b+" B" : b < 1048576 ? (b/1024).toFixed(1)+" KB" : (b/1048576).toFixed(1)+" MB"; }
function _date(ts) { return new Date(ts*1000).toLocaleString(); }
function _esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

/* ────────────────────────────────────────────────────────────────────
   Data loading
   ──────────────────────────────────────────────────────────────────── */
async function _load() {
  const grid = _el_?.querySelector("#mu-grid");
  if (!grid) return;
  grid.innerHTML = '<div class="mu-loading">Loading…</div>';
  try {
    const p = new URLSearchParams({page:_page, per_page:PER, sort:_sort});
    if (_search) p.set("search",_search);
    if (_type !== "all") p.set("type",_type);
    if (_userF) p.set("user",_userF);
    if (_tagF) p.set("tag",_tagF);
    if (_minR > 0) p.set("min_rating",_minR);
    const r = await apiGet(`${_endpoint}?${p}`);
    if (!r.ok) { const e = await r.json().catch(()=>({})); grid.innerHTML = `<div class="mu-empty">${e.error||"Failed to load"}</div>`; return; }
    const d = await r.json();
    _files = d.files||[]; _total = d.total||0; _pages = d.pages||0;
    _renderGrid(grid);
    _renderPag();
  } catch(e) { grid.innerHTML = `<div class="mu-empty">${e.message}</div>`; }
}

async function _loadUsers(sel) {
  try {
    const r = await apiGet("/outputs/users");
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

async function _loadTags() {
  try { const r = await apiGet("/outputs/tags"); if (r.ok) { _tags = (await r.json()).tags||[]; } } catch {}
  _renderFilters();
}

/* ────────────────────────────────────────────────────────────────────
   Filter bar (rating stars + tag chips)
   ──────────────────────────────────────────────────────────────────── */
function _renderFilters() {
  const el = _el_?.querySelector("#mu-filt");
  if (!el) return;
  el.innerHTML = "";
  // stars
  const sd = _mk("div","mu-filt-stars"); sd.title = "Min rating filter";
  for (let i = 1; i <= 5; i++) {
    const s = _mk("span"); s.textContent = "★"; s.className = i <= _minR ? "on" : "";
    s.onclick = () => { _minR = _minR === i ? 0 : i; _page = 1; _load(); _renderFilters(); };
    sd.appendChild(s);
  }
  el.appendChild(sd);
  // tags
  for (const t of _tags.slice(0,25)) {
    const c = _mk("span","mu-filt-tag" + (_tagF === t ? " active" : ""));
    c.textContent = t;
    c.onclick = () => { _tagF = _tagF === t ? "" : t; _page = 1; _load(); _renderFilters(); };
    el.appendChild(c);
  }
}

/* ────────────────────────────────────────────────────────────────────
   Grid rendering
   ──────────────────────────────────────────────────────────────────── */
function _renderGrid(grid) {
  grid.innerHTML = "";
  if (!_files.length) {
    grid.innerHTML = '<div class="mu-empty" style="grid-column:1/-1">No outputs found.</div>';
    return;
  }
  for (const f of _files) {
    const item = _mk("div","mu-item");
    item.title = f.relative_path;

    const img = _mk("img");
    img.loading = "lazy";
    img.alt = f.filename;
    img.src = _thumbUrl(f);
    img.onerror = () => { if (f.type === "image") img.src = _viewUrl(f); };
    item.appendChild(img);

    // video badge
    if (f.type === "video") {
      const b = _mk("div","mu-badge mu-badge-vid"); b.textContent = "▶ VID"; item.appendChild(b);
    }
    // tag count badge
    if (f.tags?.length) {
      const b = _mk("div","mu-badge mu-badge-tag"); b.textContent = "⏵ "+f.tags.length; item.appendChild(b);
    }
    // stars (always visible when rated)
    if (f.rating > 0) {
      const st = _mk("div","mu-item-stars"); st.textContent = _stars(f.rating); item.appendChild(st);
    }
    // hover overlay
    const ov = _mk("div","mu-ov");
    const nm = _mk("span","mu-ov-name"); nm.textContent = f.filename;
    ov.appendChild(nm);
    item.appendChild(ov);

    // click = lightbox
    item.addEventListener("click", () => _openLB(f));
    // right-click = context menu
    item.addEventListener("contextmenu", e => _openCtx(e, f));

    grid.appendChild(item);
  }
}

/* ────────────────────────────────────────────────────────────────────
   Pagination
   ──────────────────────────────────────────────────────────────────── */
function _renderPag() {
  const el = _el_?.querySelector("#mu-pag");
  if (!el) return;
  el.innerHTML = "";
  if (_pages <= 1) { if (_total) el.textContent = `${_total} file${_total!==1?"s":""}`; return; }
  const prev = _mk("button"); prev.textContent = "◀ Prev"; prev.disabled = _page <= 1;
  prev.onclick = () => { _page--; _load(); };
  el.appendChild(prev);
  el.appendChild(Object.assign(_mk("span"),{textContent:`${_page} / ${_pages}  (${_total})`}));
  const next = _mk("button"); next.textContent = "Next ▶"; next.disabled = _page >= _pages;
  next.onclick = () => { _page++; _load(); };
  el.appendChild(next);
}

/* ────────────────────────────────────────────────────────────────────
   Context menu (right-click)
   ──────────────────────────────────────────────────────────────────── */
function _closeCtx() { document.querySelectorAll(".mu-ctx").forEach(e => e.remove()); }

function _openCtx(e, f) {
  e.preventDefault();
  e.stopPropagation();
  _closeCtx();

  const m = _mk("div","mu-ctx");

  // Open
  _ctxItem(m, "Open", () => _openLB(f));
  _ctxItem(m, "Download", () => { const a = _mk("a"); a.href = _viewUrl(f); a.download = f.filename; a.click(); });
  _ctxItem(m, "Copy path", () => { navigator.clipboard.writeText(f.relative_path); _toast("Copied path"); });
  _ctxSep(m);

  // Inline stars rating
  const sr = _mk("div","mu-ctx-stars");
  const sl = _mk("span","mu-ctx-stars-label"); sl.textContent = "Rate:"; sr.appendChild(sl);
  for (let i = 1; i <= 5; i++) {
    const s = _mk("span"); s.textContent = "★"; s.className = i <= f.rating ? "on" : "";
    s.onmouseenter = () => { sr.querySelectorAll("span:not(.mu-ctx-stars-label)").forEach((x,j) => x.className = j < i ? "on" : ""); };
    s.onmouseleave = () => { sr.querySelectorAll("span:not(.mu-ctx-stars-label)").forEach((x,j) => x.className = j < f.rating ? "on" : ""); };
    s.onclick = async () => {
      const nr = f.rating === i ? 0 : i;
      try { const r = await apiPut("/outputs/rating",{file_path:f.relative_path,rating:nr}); if(r.ok){f.rating=nr;} } catch{}
      _closeCtx(); _load();
    };
    sr.appendChild(s);
  }
  m.appendChild(sr);
  if (f.rating > 0) { _ctxItem(m, "Clear rating", async () => { try{await apiPut("/outputs/rating",{file_path:f.relative_path,rating:0});f.rating=0;}catch{}_closeCtx();_load(); }); }

  _ctxSep(m);
  _ctxItem(m, "Add tag…", () => { _closeCtx(); _promptTag(f); });
  if (f.tags?.length) {
    _ctxItem(m, `Tags: ${f.tags.join(", ")}`, null);
  }
  _ctxSep(m);
  _ctxItem(m, "Metadata", () => { _closeCtx(); _openLB(f); setTimeout(() => _toggleMeta(f), 100); });
  _ctxItem(m, "Delete", () => { _closeCtx(); _deletefile(f); }, true);

  // Position
  m.style.left = e.clientX + "px";
  m.style.top = e.clientY + "px";
  document.body.appendChild(m);

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const r = m.getBoundingClientRect();
    if (r.right > window.innerWidth) m.style.left = (window.innerWidth - r.width - 4) + "px";
    if (r.bottom > window.innerHeight) m.style.top = (window.innerHeight - r.height - 4) + "px";
  });

  // Close on any click elsewhere
  const closer = (ev) => {
    if (!m.contains(ev.target)) { _closeCtx(); document.removeEventListener("click", closer, true); }
  };
  setTimeout(() => document.addEventListener("click", closer, true), 0);
}

function _ctxItem(menu, label, fn, danger) {
  const d = _mk("div","mu-ctx-item" + (danger ? " danger" : ""));
  d.textContent = label;
  if (fn) d.onclick = () => { _closeCtx(); fn(); };
  else d.style.opacity = "0.6";
  menu.appendChild(d);
}
function _ctxSep(menu) { menu.appendChild(_mk("div","mu-ctx-sep")); }

/* ────────────────────────────────────────────────────────────────────
   Prompt tag input (dialog-style)
   ──────────────────────────────────────────────────────────────────── */
function _promptTag(f) {
  const tag = prompt("Enter tag name:");
  if (!tag?.trim()) return;
  apiPost("/outputs/tags", {file_path: f.relative_path, tags: [_titleCase(tag.trim())]})
    .then(r => { if (r.ok) { _loadTags(); _load(); _toast("Tag added"); } })
    .catch(() => {});
}

/* ────────────────────────────────────────────────────────────────────
   Lightbox
   ──────────────────────────────────────────────────────────────────── */
let _lbFile = null;

function _openLB(f) {
  _closeLB();
  _lbFile = f;

  const wrap = _mk("div","mu-lb"); wrap.id = "mu-lb";

  /* top bar */
  const top = _mk("div","mu-lb-top");
  top.onclick = e => e.stopPropagation();
  const tl = _mk("div","mu-lb-top-left"); tl.textContent = f.filename;
  top.appendChild(tl);
  const tr = _mk("div","mu-lb-top-right");

  const btnDl = _mk("button","mu-lb-btn-dl"); btnDl.textContent = "Download";
  btnDl.onclick = () => { const a = _mk("a"); a.href = _viewUrl(f); a.download = f.filename; a.click(); };
  tr.appendChild(btnDl);

  const btnMeta = _mk("button"); btnMeta.textContent = "Metadata";
  btnMeta.onclick = () => _toggleMeta(f);
  tr.appendChild(btnMeta);

  const btnDel = _mk("button","mu-lb-btn-del"); btnDel.textContent = "Delete";
  btnDel.onclick = () => _deletefile(f);
  tr.appendChild(btnDel);

  const btnX = _mk("button"); btnX.textContent = "✕";
  btnX.onclick = () => _closeLB();
  tr.appendChild(btnX);

  top.appendChild(tr);
  wrap.appendChild(top);

  /* content area */
  const body = _mk("div","mu-lb-body");
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
    const p = _mk("button","mu-lb-nav mu-lb-nav-prev"); p.innerHTML = "&#9664;";
    p.onclick = e => { e.stopPropagation(); _openLB(_files[idx-1]); };
    body.appendChild(p);
  }
  if (idx < _files.length - 1) {
    const n = _mk("button","mu-lb-nav mu-lb-nav-next"); n.innerHTML = "&#9654;";
    n.onclick = e => { e.stopPropagation(); _openLB(_files[idx+1]); };
    body.appendChild(n);
  }
  wrap.appendChild(body);

  /* bottom panel */
  const bot = _mk("div","mu-lb-bottom");
  bot.onclick = e => e.stopPropagation();

  // file info
  const info = _mk("div","mu-lb-info");
  info.innerHTML = `<span>${_bytes(f.size)}</span><span>${_date(f.modified)}</span><span>${_esc(f.relative_path)}</span>`;
  bot.appendChild(info);

  // rating
  const rr = _mk("div","mu-lb-rating");
  rr.appendChild(Object.assign(_mk("span","mu-lb-rating-lbl"),{textContent:"Rating:"}));
  const sd = _mk("div","mu-lb-stars"); sd.id = "mu-lb-stars";
  _renderLBStars(sd, f);
  rr.appendChild(sd);
  bot.appendChild(rr);

  // tags
  const trow = _mk("div","mu-lb-tags"); trow.id = "mu-lb-tags";
  _renderLBTags(trow, f);
  bot.appendChild(trow);

  wrap.appendChild(bot);
  document.body.appendChild(wrap);
  document.addEventListener("keydown", _lbKey);
}

function _closeLB() {
  document.removeEventListener("keydown", _lbKey);
  document.getElementById("mu-lb")?.remove();
  document.querySelectorAll(".mu-meta").forEach(e => e.remove());
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
   Lightbox — stars
   ──────────────────────────────────────────────────────────────────── */
function _renderLBStars(el, f) {
  el.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const s = _mk("span"); s.textContent = "★"; s.className = i <= f.rating ? "on" : "";
    s.onclick = async () => {
      const nr = f.rating === i ? 0 : i;
      try { const r = await apiPut("/outputs/rating",{file_path:f.relative_path,rating:nr}); if(r.ok) f.rating=nr; } catch{}
      _renderLBStars(el, f);
    };
    el.appendChild(s);
  }
}

/* ────────────────────────────────────────────────────────────────────
   Lightbox — tags
   ──────────────────────────────────────────────────────────────────── */
function _renderLBTags(el, f) {
  el.innerHTML = "";
  el.appendChild(Object.assign(_mk("span","mu-lb-tags-lbl"),{textContent:"Tags:"}));
  for (const t of (f.tags||[])) {
    const c = _mk("span","mu-lb-tag"); c.textContent = t;
    const rm = _mk("button","mu-lb-tag-rm"); rm.textContent = "×";
    rm.onclick = async () => {
      try {
        const r = await apiDelete(`/outputs/tags?${new URLSearchParams({file_path:f.relative_path,tag:t})}`);
        if (r.ok) { f.tags = f.tags.filter(x=>x!==t); _renderLBTags(el,f); _loadTags(); }
      } catch{}
    };
    c.appendChild(rm);
    el.appendChild(c);
  }
  // add input
  const inp = _mk("input","mu-lb-tag-input"); inp.type = "text"; inp.placeholder = "Add tag…";
  inp.onkeydown = async (e) => {
    if (e.key !== "Enter") return;
    const v = _titleCase(inp.value.trim()); if (!v) return;
    try {
      const r = await apiPost("/outputs/tags",{file_path:f.relative_path,tags:[v]});
      if (r.ok) { if (!f.tags) f.tags = []; if (!f.tags.includes(v)) f.tags.push(v); inp.value = ""; _renderLBTags(el,f); _loadTags(); }
    } catch{}
  };
  el.appendChild(inp);
}

/* ────────────────────────────────────────────────────────────────────
   Metadata side-panel
   ──────────────────────────────────────────────────────────────────── */
async function _toggleMeta(f) {
  const ex = document.querySelector(".mu-meta");
  if (ex) { ex.remove(); return; }

  const panel = _mk("div","mu-meta");
  panel.onclick = e => e.stopPropagation();

  const h = _mk("h3"); h.textContent = "Metadata";
  const cb = _mk("button","mu-meta-close"); cb.textContent = "✕"; cb.onclick = () => panel.remove();
  h.appendChild(cb);
  panel.appendChild(h);

  panel.appendChild(Object.assign(_mk("div","mu-loading"),{textContent:"Loading…"}));
  document.body.appendChild(panel);

  try {
    const r = await apiGet(`/outputs/metadata?${new URLSearchParams({filename:f.filename,subfolder:f.subfolder||""})}`);
    if (!r.ok) { panel.querySelector(".mu-loading").textContent = "Failed"; return; }
    const m = await r.json();
    panel.querySelector(".mu-loading")?.remove();

    // basic info
    const sec1 = _mk("div","mu-meta-sec");
    sec1.appendChild(Object.assign(_mk("h4"),{textContent:"File Info"}));
    const t1 = _mk("table","mu-meta-tbl");
    t1.innerHTML = `
      <tr><td>Name</td><td>${_esc(m.filename)}</td></tr>
      <tr><td>Size</td><td>${_bytes(m.size)}</td></tr>
      <tr><td>Modified</td><td>${_date(m.modified)}</td></tr>
      <tr><td>Type</td><td>${m.extension}</td></tr>`;
    sec1.appendChild(t1);
    panel.appendChild(sec1);

    // embedded metadata
    const emb = m.embedded || {};
    const simpleF = {}, jsonF = {};
    for (const [k,v] of Object.entries(emb)) {
      if (typeof v === "object" && v !== null) jsonF[k] = v; else simpleF[k] = v;
    }

    if (Object.keys(simpleF).length) {
      const sec = _mk("div","mu-meta-sec");
      sec.appendChild(Object.assign(_mk("h4"),{textContent:"Properties"}));
      const tbl = _mk("table","mu-meta-tbl");
      for (const [k,v] of Object.entries(simpleF)) {
        const lbl = k.startsWith("_") ? k.slice(1) : k;
        const tr = _mk("tr"); tr.innerHTML = `<td>${_esc(lbl)}</td><td>${_esc(String(v))}</td>`;
        tbl.appendChild(tr);
      }
      sec.appendChild(tbl);
      panel.appendChild(sec);
    }

    for (const [k,v] of Object.entries(jsonF)) {
      const sec = _mk("div","mu-meta-sec");
      const lbl = k.startsWith("_") ? k.slice(1) : k;
      sec.appendChild(Object.assign(_mk("h4"),{textContent:lbl}));
      const js = JSON.stringify(v,null,2);
      const pre = _mk("div","mu-meta-json");
      pre.textContent = js.length > 500 ? js.slice(0,500)+"…" : js;
      sec.appendChild(pre);
      if (js.length > 500) {
        let exp = false;
        const tb = _mk("button","mu-meta-btn"); tb.textContent = "Show full";
        tb.onclick = () => { exp = !exp; pre.textContent = exp ? js : js.slice(0,500)+"…"; tb.textContent = exp ? "Collapse" : "Show full"; };
        sec.appendChild(tb);
      }
      const cp = _mk("button","mu-meta-btn"); cp.textContent = "Copy"; cp.style.marginLeft = "4px";
      cp.onclick = () => { navigator.clipboard.writeText(js); cp.textContent = "Copied!"; setTimeout(()=>cp.textContent="Copy",1500); };
      sec.appendChild(cp);
      panel.appendChild(sec);
    }

    if (!Object.keys(emb).length) {
      panel.appendChild(Object.assign(_mk("div","mu-meta-sec"),{textContent:"No embedded metadata."}));
    }
  } catch(e) {
    const ld = panel.querySelector(".mu-loading");
    if (ld) ld.textContent = "Error: "+e.message;
  }
}

/* ────────────────────────────────────────────────────────────────────
   Delete
   ──────────────────────────────────────────────────────────────────── */
async function _deletefile(f) {
  if (!confirm(`Delete ${f.filename}?`)) return;
  try {
    const p = new URLSearchParams({filename:f.filename});
    if (f.subfolder) p.set("subfolder",f.subfolder);
    const r = await apiDelete(`/outputs/file?${p}`);
    if (r.ok) { _closeLB(); _load(); _toast("Deleted"); }
    else { const e = await r.json().catch(()=>({})); _toast(e.error||"Delete failed","error"); }
  } catch(e) { _toast(e.message,"error"); }
}

/* ────────────────────────────────────────────────────────────────────
   Toast (minimal)
   ──────────────────────────────────────────────────────────────────── */
async function _toast(msg, type) {
  try {
    const {showToast} = await import("./multiuser.js");
    showToast(type||"success", type==="error"?"Error":"Gallery", msg);
  } catch {
    console.log("[Gallery]", msg);
  }
}
