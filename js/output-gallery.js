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
.mu-item.selected{border-color:#236692;box-shadow:0 0 0 2px rgba(35,102,146,.5)}
.mu-item.selected::after{
  content:'✓';position:absolute;top:4px;left:4px;z-index:2;
  background:#236692;color:#fff;width:18px;height:18px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;
  box-shadow:0 1px 3px rgba(0,0,0,.5);
}
.mu-item img{width:100%;height:100%;object-fit:cover;display:block}

/* === Selection bar === */
.mu-sel-bar{
  display:flex;align-items:center;gap:8px;padding:5px 8px;
  background:linear-gradient(135deg,rgba(35,102,146,.2),rgba(35,102,146,.1));
  border:1px solid rgba(35,102,146,.4);border-radius:4px;margin-bottom:6px;
  font-size:11px;color:#5ba3d9;
}
.mu-sel-bar-count{font-weight:700}
.mu-sel-bar-btn{
  padding:2px 8px;border:1px solid rgba(91,163,217,.3);border-radius:3px;
  background:transparent;color:#5ba3d9;cursor:pointer;font-size:10px;
}
.mu-sel-bar-btn:hover{background:rgba(91,163,217,.15)}
.mu-sel-bar-btn.danger{color:#ef5350;border-color:rgba(239,83,80,.3)}
.mu-sel-bar-btn.danger:hover{background:rgba(239,83,80,.15)}

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
  position:absolute;border-radius:3px;
  padding:2px 5px;font-size:8px;font-weight:700;letter-spacing:.4px;
  line-height:1;
}
.mu-badge-fmt{
  top:4px;right:4px;
  text-shadow:0 1px 2px rgba(0,0,0,.9);
  border:1px solid rgba(255,255,255,.12);
  background:rgba(0,0,0,.7);
  color:#aab;
}
/* Per-format colors — type-specific colored text on dark background */
.mu-badge-fmt[data-fmt="PNG"]{color:#66bb6a;border-color:rgba(102,187,106,.3)}
.mu-badge-fmt[data-fmt="JPG"],.mu-badge-fmt[data-fmt="JPEG"]{color:#ffa726;border-color:rgba(255,167,38,.3)}
.mu-badge-fmt[data-fmt="WEBP"]{color:#42a5f5;border-color:rgba(66,165,245,.3)}
.mu-badge-fmt[data-fmt="GIF"]{color:#ab47bc;border-color:rgba(171,71,188,.3)}
.mu-badge-fmt[data-fmt="MP4"]{color:#ef5350;border-color:rgba(239,83,80,.3)}
.mu-badge-fmt[data-fmt="WEBM"]{color:#ec407a;border-color:rgba(236,64,122,.3)}
.mu-badge-fmt[data-fmt="MOV"]{color:#ff7043;border-color:rgba(255,112,67,.3)}
.mu-badge-fmt[data-fmt="MKV"]{color:#8d6e63;border-color:rgba(141,110,99,.3)}
.mu-badge-fmt[data-fmt="AVI"]{color:#78909c;border-color:rgba(120,144,156,.3)}
.mu-badge-fmt[data-fmt="BMP"]{color:#9e9e9e;border-color:rgba(158,158,158,.3)}
.mu-badge-fmt[data-fmt="TIFF"]{color:#a1887f;border-color:rgba(161,136,127,.3)}
/* Collision "+" per-format — brighter/saturated variant of each format color */
.mu-badge-fmt.collision{background:rgba(40,40,40,.9);text-shadow:0 0 6px currentColor}
.mu-badge-fmt.collision[data-fmt="PNG"]{color:#a5d6a7;border-color:rgba(165,214,167,.6)}
.mu-badge-fmt.collision[data-fmt="JPG"],.mu-badge-fmt.collision[data-fmt="JPEG"]{color:#ffcc80;border-color:rgba(255,204,128,.6)}
.mu-badge-fmt.collision[data-fmt="WEBP"]{color:#90caf9;border-color:rgba(144,202,249,.6)}
.mu-badge-fmt.collision[data-fmt="GIF"]{color:#ce93d8;border-color:rgba(206,147,216,.6)}
.mu-badge-fmt.collision[data-fmt="MP4"]{color:#ef9a9a;border-color:rgba(239,154,154,.6)}
.mu-badge-fmt.collision[data-fmt="WEBM"]{color:#f48fb1;border-color:rgba(244,143,177,.6)}
.mu-badge-fmt.collision[data-fmt="MOV"]{color:#ffab91;border-color:rgba(255,171,145,.6)}
.mu-badge-fmt.collision[data-fmt="MKV"]{color:#bcaaa4;border-color:rgba(188,170,164,.6)}
.mu-badge-fmt.collision[data-fmt="AVI"]{color:#b0bec5;border-color:rgba(176,190,197,.6)}
.mu-badge-fmt.collision[data-fmt="BMP"]{color:#e0e0e0;border-color:rgba(224,224,224,.6)}
.mu-badge-fmt.collision[data-fmt="TIFF"]{color:#d7ccc8;border-color:rgba(215,204,200,.6)}
.mu-badge-tag{top:4px;left:4px;color:#5ba3d9;background:rgba(0,0,0,.7);border:1px solid rgba(91,163,217,.25)}

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
.mu-ctx-tags{display:flex;flex-wrap:wrap;gap:4px;padding:5px 14px;align-items:center}
.mu-ctx-tag{
  display:inline-flex;align-items:center;gap:3px;
  background:#293742;color:#5ba3d9;padding:2px 6px;border-radius:3px;font-size:10px;
}
.mu-ctx-tag-rm{
  background:none;border:none;color:#ef5350;cursor:pointer;font-size:12px;
  padding:0 1px;line-height:1;
}
.mu-ctx-tag-rm:hover{color:#ff1744}
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

/* === Main content area (image + metadata side by side) === */
.mu-lb-main{
  flex:1;display:flex;overflow:hidden;min-height:0;
}

/* === Metadata side-panel (always visible on right) === */
.mu-meta{
  width:420px;min-width:280px;flex-shrink:0;
  background:rgba(0,0,0,.88);backdrop-filter:blur(10px);
  border-left:1px solid rgba(255,255,255,.12);
  overflow-y:auto;padding:16px;font-size:11px;color:var(--fg-color,#ddd);
}
.mu-meta h3{margin:0 0 14px;font-size:14px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
.mu-meta-close{background:none;border:none;color:#999;cursor:pointer;font-size:16px;padding:2px 4px}
.mu-meta-close:hover{color:#fff}

/* Actions row in bottom panel */
.mu-lb-actions-row{
  display:flex;flex-wrap:wrap;gap:8px;align-items:center;
}
.mu-lb-actions{display:flex;gap:6px;align-items:center;margin-left:auto}

/* Generation time display */
.mu-meta-gentime{
  border-radius:6px;padding:10px 14px;margin-bottom:10px;
  display:flex;align-items:center;gap:10px;
  background:linear-gradient(135deg, rgba(33,150,243,.14) 0%, rgba(33,150,243,.06) 100%);
  border:1px solid rgba(33,150,243,.35);
  border-left:3px solid #2196F3;
}
.mu-meta-gentime-lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#2196F3}
.mu-meta-gentime-val{font-size:16px;font-weight:700;color:#fff;font-family:'Consolas','Monaco','Courier New',monospace}

/* Section boxes */
.mu-meta-box{
  background:var(--comfy-menu-bg,rgba(0,0,0,.3));
  border-radius:6px;padding:12px;margin-bottom:10px;
  border:1px solid rgba(255,255,255,.08);
}
.mu-meta-box.emphasis{
  border:1px solid rgba(255,255,255,.15);
}
.mu-meta-box-hdr{
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;
  margin-bottom:10px;
}

/* 2-column grid for key-value pairs */
.mu-meta-grid{
  display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:start;
}
.mu-meta-grid-lbl{font-size:11px;color:rgba(127,127,127,.9);font-weight:500}
.mu-meta-grid-val{
  font-size:12px;color:rgba(255,255,255,.95);word-break:break-word;
  white-space:pre-wrap;cursor:pointer;
}
.mu-meta-grid-val:hover{color:#fff}
.mu-meta-grid-val.copied{color:#4CAF50!important;transition:color .2s}

/* Prompt boxes */
.mu-meta-prompt{
  border-radius:6px;padding:12px;margin-bottom:10px;position:relative;
}
.mu-meta-prompt-hdr{
  display:flex;justify-content:space-between;align-items:center;
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;
  margin-bottom:8px;
}
.mu-meta-prompt-txt{
  font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;
  color:rgba(255,255,255,.9);cursor:pointer;
}

/* Seed hero */
.mu-meta-seed{
  border-radius:8px;padding:12px 16px;margin-bottom:10px;
  display:flex;align-items:center;justify-content:space-between;
}
.mu-meta-seed-lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px}
.mu-meta-seed-val{
  font-size:18px;font-weight:700;color:#fff;
  font-family:'Consolas','Monaco','Courier New',monospace;letter-spacing:1px;cursor:pointer;
}
.mu-meta-seed-val:hover{color:#ffd54f}

/* Copy button */
.mu-meta-copy{
  background:none;border:none;cursor:pointer;opacity:.5;transition:opacity .15s;
  padding:2px;display:flex;align-items:center;
}
.mu-meta-copy:hover{opacity:1}
.mu-meta-copy svg{width:14px;height:14px;fill:currentColor}

/* Collapsible raw JSON */
.mu-meta-raw{margin-bottom:10px}
.mu-meta-raw summary{
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;
  color:#607D8B;cursor:pointer;padding:8px 0 4px;
}
.mu-meta-raw pre{
  background:#111;border-radius:4px;padding:8px;max-height:280px;overflow:auto;
  font-family:monospace;font-size:10px;color:#aaa;white-space:pre-wrap;word-break:break-all;
  margin:6px 0 0;
}
.mu-meta-raw-btn{
  background:none;border:1px solid #4e4e4e;border-radius:2px;
  color:#5ba3d9;cursor:pointer;padding:1px 6px;font-size:10px;margin-top:4px;
}
.mu-meta-raw-btn:hover{background:#333}
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
let _selected = new Set();  // relative_paths of selected items
let _lastClickIdx = -1;     // for shift-click range selection

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
  _selected = new Set(); _lastClickIdx = -1;

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

  /* selection bar (hidden until items selected) */
  const selBar = _mk("div","mu-sel-bar"); selBar.id = "mu-sel-bar"; selBar.style.display = "none";
  root.appendChild(selBar);

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
  return `/multiuser/outputs/thumbnail?${new URLSearchParams({filename: f.filename, subfolder: f.subfolder||"", size:"256", t: String(Math.floor(f.modified||0))})}`;
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
   In-place item UI refresh (no full reload)
   ──────────────────────────────────────────────────────────────────── */
function _refreshItemUI(f) {
  const grid = _el_?.querySelector("#mu-grid");
  if (!grid) return;
  const idx = _files.indexOf(f);
  if (idx < 0) return;
  const item = grid.children[idx];
  if (!item) return;
  // Update tag badge
  item.querySelector(".mu-badge-tag")?.remove();
  if (f.tags?.length) {
    const b = _mk("div","mu-badge mu-badge-tag"); b.textContent = "⏵ "+f.tags.length;
    item.insertBefore(b, item.querySelector(".mu-ov"));
  }
  // Update star badge
  item.querySelector(".mu-item-stars")?.remove();
  if (f.rating > 0) {
    const st = _mk("div","mu-item-stars"); st.textContent = _stars(f.rating);
    item.appendChild(st);
  }
}

function _refreshAllItemsUI() {
  for (const f of _files) _refreshItemUI(f);
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

    // format badge (PNG, MP4, JPG, etc.) with "+" for high-res (>= 1024x720)
    {
      const fmt = f.format || f.filename.split(".").pop().toUpperCase();
      const isHiRes = (f.width >= 1024 && f.height >= 720) || (f.width >= 720 && f.height >= 1024);
      const b = _mk("div","mu-badge mu-badge-fmt" + (isHiRes ? " collision" : ""));
      b.setAttribute("data-fmt", fmt);
      b.textContent = fmt + (isHiRes ? "+" : "");
      if (isHiRes) b.title = `High resolution: ${f.width}×${f.height}`;
      else if (f.width && f.height) b.title = `${f.width}×${f.height}`;
      item.appendChild(b);
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

    // Mark selected state from _selected set
    if (_selected.has(f.relative_path)) item.classList.add("selected");

    // click = lightbox or selection
    item.addEventListener("click", (e) => {
      const idx = _files.indexOf(f);
      if (e.ctrlKey || e.metaKey) {
        // Toggle individual selection
        if (_selected.has(f.relative_path)) { _selected.delete(f.relative_path); item.classList.remove("selected"); }
        else { _selected.add(f.relative_path); item.classList.add("selected"); }
        _lastClickIdx = idx;
        _renderSelBar();
        return;
      }
      if (e.shiftKey && _lastClickIdx >= 0) {
        // Range selection
        const lo = Math.min(_lastClickIdx, idx), hi = Math.max(_lastClickIdx, idx);
        for (let k = lo; k <= hi; k++) _selected.add(_files[k].relative_path);
        _syncSelVisuals();
        _renderSelBar();
        return;
      }
      // Normal click: if items are selected, clear selection instead of opening lightbox
      if (_selected.size > 0) { _selected.clear(); _syncSelVisuals(); _renderSelBar(); return; }
      _openLB(f);
    });
    // right-click = context menu (bulk if selected)
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
      _closeCtx(); _refreshItemUI(f);
    };
    sr.appendChild(s);
  }
  m.appendChild(sr);
  if (f.rating > 0) { _ctxItem(m, "Clear rating", async () => { try{await apiPut("/outputs/rating",{file_path:f.relative_path,rating:0});f.rating=0;}catch{}_closeCtx();_refreshItemUI(f); }); }

  _ctxSep(m);
  _ctxItem(m, "Add tag…", () => { _closeCtx(); _promptTag(f); });
  if (f.tags?.length) {
    const tagRow = _mk("div","mu-ctx-tags");
    for (const t of f.tags) {
      const chip = _mk("span","mu-ctx-tag"); chip.textContent = t;
      const rm = _mk("button","mu-ctx-tag-rm"); rm.textContent = "×";
      rm.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          const r = await apiDelete(`/outputs/tags?${new URLSearchParams({file_path:f.relative_path,tag:t})}`);
          if (r.ok) { f.tags = f.tags.filter(x=>x!==t); _loadTags(); _refreshItemUI(f); _toast("Tag removed"); }
        } catch{}
        _closeCtx();
      };
      chip.appendChild(rm);
      tagRow.appendChild(chip);
    }
    m.appendChild(tagRow);
  }
  _ctxSep(m);
  _ctxItem(m, "Gen Info", () => { _closeCtx(); _openLB(f); });
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
   Multi-select helpers
   ──────────────────────────────────────────────────────────────────── */
function _syncSelVisuals() {
  const grid = _el_?.querySelector("#mu-grid");
  if (!grid) return;
  const items = grid.querySelectorAll(".mu-item");
  items.forEach((el, i) => {
    if (i < _files.length && _selected.has(_files[i].relative_path)) el.classList.add("selected");
    else el.classList.remove("selected");
  });
}

function _renderSelBar() {
  const bar = _el_?.querySelector("#mu-sel-bar");
  if (!bar) return;
  if (_selected.size === 0) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  bar.innerHTML = "";
  const cnt = _mk("span","mu-sel-bar-count"); cnt.textContent = `${_selected.size} selected`; bar.appendChild(cnt);
  const selAll = _mk("button","mu-sel-bar-btn"); selAll.textContent = "Select All";
  selAll.onclick = () => { _files.forEach(f => _selected.add(f.relative_path)); _syncSelVisuals(); _renderSelBar(); };
  bar.appendChild(selAll);
  const clr = _mk("button","mu-sel-bar-btn"); clr.textContent = "Clear";
  clr.onclick = () => { _selected.clear(); _syncSelVisuals(); _renderSelBar(); };
  bar.appendChild(clr);
}

function _getSelectedFiles() {
  return _files.filter(f => _selected.has(f.relative_path));
}

/* ────────────────────────────────────────────────────────────────────
   Bulk context menu  (right-click when multiple items selected)
   ──────────────────────────────────────────────────────────────────── */
function _openBulkCtx(e) {
  e.preventDefault();
  e.stopPropagation();
  _closeCtx();

  const sel = _getSelectedFiles();
  const n = sel.length;
  const m = _mk("div","mu-ctx");

  // Header
  const hdr = _mk("div","mu-ctx-item"); hdr.style.opacity = "0.6"; hdr.style.fontWeight = "600";
  hdr.textContent = `${n} items selected`; m.appendChild(hdr);
  _ctxSep(m);

  // Bulk download
  _ctxItem(m, `⬇ Download ${n} files`, () => {
    for (const f of sel) {
      const a = _mk("a"); a.href = _viewUrl(f); a.download = f.filename; a.click();
    }
    _toast(`Downloading ${n} files`);
  });
  _ctxSep(m);

  // Bulk rate
  const sr = _mk("div","mu-ctx-stars");
  const sl = _mk("span","mu-ctx-stars-label"); sl.textContent = "Rate all:"; sr.appendChild(sl);
  for (let i = 1; i <= 5; i++) {
    const s = _mk("span"); s.textContent = "★"; s.className = "";
    s.onmouseenter = () => { sr.querySelectorAll("span:not(.mu-ctx-stars-label)").forEach((x,j) => x.className = j < i ? "on" : ""); };
    s.onmouseleave = () => { sr.querySelectorAll("span:not(.mu-ctx-stars-label)").forEach((x,j) => x.className = ""); };
    s.onclick = async () => { _closeCtx(); await _bulkRate(sel, i); };
    sr.appendChild(s);
  }
  m.appendChild(sr);
  _ctxItem(m, "Clear all ratings", async () => { _closeCtx(); await _bulkRate(sel, 0); });
  _ctxSep(m);

  // Bulk tag
  _ctxItem(m, `Add tag to ${n} files…`, () => { _closeCtx(); _bulkPromptTag(sel); });
  // Bulk remove tag
  const allTags = [...new Set(sel.flatMap(f => f.tags || []))];
  if (allTags.length) {
    _ctxItem(m, `Remove tag from ${n} files…`, () => { _closeCtx(); _bulkPromptRemoveTag(sel, allTags); });
  }
  _ctxSep(m);

  // Bulk delete
  _ctxItem(m, `Delete ${n} files`, () => { _closeCtx(); _bulkDelete(sel); }, true);

  // Position
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
   Bulk operations
   ──────────────────────────────────────────────────────────────────── */
async function _bulkRate(files, rating) {
  try {
    const paths = files.map(f => f.relative_path);
    const r = await apiPut("/outputs/bulk/rating", {file_paths: paths, rating});
    if (r.ok) {
      files.forEach(f => f.rating = rating);
      _toast(`Rated ${files.length} files`);
      _selected.clear(); _refreshAllItemsUI(); _syncSelVisuals(); _renderSelBar();
    } else { const e = await r.json().catch(()=>({})); _toast(e.error||"Bulk rate failed","error"); }
  } catch(e) { _toast(e.message,"error"); }
}

async function _bulkPromptTag(files) {
  const tag = prompt(`Add tag to ${files.length} files:`);
  if (!tag?.trim()) return;
  try {
    const paths = files.map(f => f.relative_path);
    const r = await apiPost("/outputs/bulk/tags", {file_paths: paths, tags: [_titleCase(tag.trim())]});
    if (r.ok) {
      const clean = _titleCase(tag.trim());
      files.forEach(f => { if (!f.tags) f.tags = []; if (!f.tags.includes(clean)) f.tags.push(clean); });
      _toast(`Tagged ${files.length} files`); _selected.clear(); _loadTags(); _refreshAllItemsUI(); _syncSelVisuals(); _renderSelBar();
    }
    else { const e = await r.json().catch(()=>({})); _toast(e.error||"Bulk tag failed","error"); }
  } catch(e) { _toast(e.message,"error"); }
}

async function _bulkPromptRemoveTag(files, allTags) {
  const tag = prompt(`Remove which tag? Available: ${allTags.join(", ")}`);
  if (!tag?.trim()) return;
  try {
    const paths = files.map(f => f.relative_path);
    const r = await apiPost("/outputs/bulk/tags/remove", {file_paths: paths, tag: _titleCase(tag.trim())});
    if (r.ok) {
      const clean = _titleCase(tag.trim());
      files.forEach(f => { if (f.tags) f.tags = f.tags.filter(x => x !== clean); });
      _toast(`Removed tag from files`); _selected.clear(); _loadTags(); _refreshAllItemsUI(); _syncSelVisuals(); _renderSelBar();
    }
    else { const e = await r.json().catch(()=>({})); _toast(e.error||"Remove tag failed","error"); }
  } catch(e) { _toast(e.message,"error"); }
}

async function _bulkDelete(files) {
  if (!confirm(`Delete ${files.length} files? This cannot be undone.`)) return;
  try {
    const items = files.map(f => ({filename: f.filename, subfolder: f.subfolder || ""}));
    const r = await apiPost("/outputs/bulk/delete", {files: items});
    if (r.ok) {
      const d = await r.json();
      _toast(`Deleted ${d.deleted||files.length} files`);
      _selected.clear(); _load();
    } else { const e = await r.json().catch(()=>({})); _toast(e.error||"Bulk delete failed","error"); }
  } catch(e) { _toast(e.message,"error"); }
}

/* ────────────────────────────────────────────────────────────────────
   Prompt tag input (dialog-style)
   ──────────────────────────────────────────────────────────────────── */
function _promptTag(f) {
  const tag = prompt("Enter tag name:");
  if (!tag?.trim()) return;
  const clean = _titleCase(tag.trim());
  apiPost("/outputs/tags", {file_path: f.relative_path, tags: [clean]})
    .then(r => { if (r.ok) { if (!f.tags) f.tags = []; if (!f.tags.includes(clean)) f.tags.push(clean); _loadTags(); _refreshItemUI(f); _toast("Tag added"); } })
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
  /* main area: image + metadata side by side */
  const main = _mk("div","mu-lb-main");
  main.appendChild(body);

  const metaPanel = _mk("div","mu-meta"); metaPanel.id = "mu-meta-panel";
  metaPanel.onclick = e => e.stopPropagation();
  metaPanel.appendChild(Object.assign(_mk("div","mu-loading"),{textContent:"Loading metadata…"}));
  main.appendChild(metaPanel);
  wrap.appendChild(main);

  /* bottom panel */
  const bot = _mk("div","mu-lb-bottom");
  bot.onclick = e => e.stopPropagation();

  // file info
  const info = _mk("div","mu-lb-info");
  info.innerHTML = `<span>${_bytes(f.size)}</span><span>${_date(f.modified)}</span><span>${_esc(f.relative_path)}</span>`;
  bot.appendChild(info);

  // actions row: rating + tags + download/delete
  const actRow = _mk("div","mu-lb-actions-row");

  const rr = _mk("div","mu-lb-rating");
  rr.appendChild(Object.assign(_mk("span","mu-lb-rating-lbl"),{textContent:"Rating:"}));
  const sd = _mk("div","mu-lb-stars"); sd.id = "mu-lb-stars";
  _renderLBStars(sd, f);
  rr.appendChild(sd);
  actRow.appendChild(rr);

  const trow = _mk("div","mu-lb-tags"); trow.id = "mu-lb-tags";
  _renderLBTags(trow, f);
  actRow.appendChild(trow);

  const acts = _mk("div","mu-lb-actions");
  const btnDl = _mk("button","mu-lb-btn-dl"); btnDl.textContent = "⬇ Download";
  btnDl.onclick = () => { const a = _mk("a"); a.href = _viewUrl(f); a.download = f.filename; a.click(); };
  acts.appendChild(btnDl);
  const btnDel = _mk("button","mu-lb-btn-del"); btnDel.textContent = "🗑 Delete";
  btnDel.onclick = () => _deletefile(f);
  acts.appendChild(btnDel);
  actRow.appendChild(acts);

  bot.appendChild(actRow);
  wrap.appendChild(bot);
  document.body.appendChild(wrap);
  document.addEventListener("keydown", _lbKey);

  // Auto-load metadata into the side panel
  _loadMetaInto(f, metaPanel);
}

function _closeLB() {
  document.removeEventListener("keydown", _lbKey);
  document.getElementById("mu-lb")?.remove();
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
   Metadata side-panel  (Majoor-inspired color-coded sections)
   ──────────────────────────────────────────────────────────────────── */

// Color palette for section accents
const _C = {
  blue:   "#2196F3",
  green:  "#4CAF50",
  red:    "#F44336",
  purple: "#9C27B0",
  orange: "#FF9800",
  pink:   "#E91E63",
  teal:   "#607D8B",
};

function _hexRgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Copy-to-clipboard with green flash feedback on the element */
function _copyFlash(el, text) {
  navigator.clipboard.writeText(text).catch(()=>{});
  const orig = el.style.color;
  el.style.color = "#4CAF50";
  el.classList.add("copied");
  setTimeout(() => { el.style.color = orig; el.classList.remove("copied"); }, 600);
}

/** Small SVG copy icon button */
function _copyBtn(text) {
  const btn = _mk("button","mu-meta-copy");
  btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
  btn.onclick = (e) => { e.stopPropagation(); _copyFlash(btn, text); };
  return btn;
}

/** Create a colored section box with a title header */
function _metaBox(title, color, opts = {}) {
  const box = _mk("div","mu-meta-box");
  if (opts.emphasis) {
    box.classList.add("emphasis");
    box.style.background = `linear-gradient(135deg, ${_hexRgba(color,.16)} 0%, ${_hexRgba(color,.08)} 100%)`;
    box.style.borderColor = _hexRgba(color,.45);
    box.style.boxShadow = `0 0 0 1px ${_hexRgba(color,.15)} inset`;
  }
  box.style.borderLeft = `3px solid ${color}`;
  const hdr = _mk("div","mu-meta-box-hdr");
  hdr.style.color = color;
  hdr.textContent = title;
  box.appendChild(hdr);
  return box;
}

/** Create a 2-column grid of label:value pairs inside a section box */
function _paramBox(title, fields, color, opts = {}) {
  if (!fields.length) return null;
  const box = _metaBox(title, color, opts);
  const grid = _mk("div","mu-meta-grid");
  for (const {label, value} of fields) {
    const lbl = _mk("span","mu-meta-grid-lbl"); lbl.textContent = label;
    const val = _mk("span","mu-meta-grid-val"); val.textContent = String(value);
    val.onclick = () => _copyFlash(val, String(value));
    grid.appendChild(lbl);
    grid.appendChild(val);
  }
  box.appendChild(grid);
  return box;
}

/** Create a prompt display box (positive/negative) */
function _promptBox(title, text, color) {
  if (!text) return null;
  const box = _mk("div","mu-meta-prompt");
  box.style.background = `linear-gradient(135deg, ${_hexRgba(color,.16)} 0%, ${_hexRgba(color,.10)} 100%)`;
  box.style.borderLeft = `3px solid ${color}`;
  box.style.border = `1px solid ${_hexRgba(color,.45)}`;
  box.style.boxShadow = `0 0 0 1px ${_hexRgba(color,.15)} inset`;

  const hdr = _mk("div","mu-meta-prompt-hdr");
  hdr.style.color = color;
  const span = _mk("span"); span.textContent = title;
  hdr.appendChild(span);
  hdr.appendChild(_copyBtn(text));
  box.appendChild(hdr);

  const txt = _mk("div","mu-meta-prompt-txt");
  txt.textContent = text;
  txt.onclick = () => _copyFlash(txt, text);
  box.appendChild(txt);
  return box;
}

/** Create the hero seed display */
function _seedBox(seed) {
  if (!seed) return null;
  const box = _mk("div","mu-meta-seed");
  box.style.background = `linear-gradient(135deg, ${_hexRgba(_C.pink,.15)} 0%, ${_hexRgba(_C.purple,.15)} 100%)`;
  box.style.border = `2px solid ${_C.pink}`;
  const lbl = _mk("span","mu-meta-seed-lbl"); lbl.textContent = "Seed"; lbl.style.color = _C.pink;
  const val = _mk("span","mu-meta-seed-val"); val.textContent = seed;
  val.onclick = () => _copyFlash(val, seed);
  box.appendChild(lbl);
  box.appendChild(val);
  box.appendChild(_copyBtn(seed));
  return box;
}

async function _toggleMeta(f) {
  const panel = document.getElementById("mu-meta-panel");
  if (panel) _loadMetaInto(f, panel);
}

async function _loadMetaInto(f, panel) {
  panel.innerHTML = "";

  const h = _mk("h3"); h.textContent = "Generation Info";
  panel.appendChild(h);

  panel.appendChild(Object.assign(_mk("div","mu-loading"),{textContent:"Loading…"}));

  try {
    const r = await apiGet(`/outputs/metadata?${new URLSearchParams({filename:f.filename,subfolder:f.subfolder||""})}`);
    if (!r.ok) { panel.querySelector(".mu-loading").textContent = "Failed to load metadata."; return; }
    const m = await r.json();
    panel.querySelector(".mu-loading")?.remove();

    const gi = m.geninfo || {};
    const emb = m.embedded || {};
    const hasGeninfo = Object.keys(gi).length > 0;

    // ── File Info (always shown) ──
    const fileFields = [
      {label:"Name", value:m.filename},
      {label:"Size", value:_bytes(m.size)},
      {label:"Modified", value:_date(m.modified)},
      {label:"Type", value:(m.extension||"").toUpperCase().replace(".", "")},
    ];
    if (emb._dimensions) fileFields.push({label:"Dimensions", value:emb._dimensions});
    if (emb._mode) fileFields.push({label:"Color Mode", value:emb._mode});
    if (emb._duration) fileFields.push({label:"Duration", value:parseFloat(emb._duration).toFixed(1) + "s"});
    if (emb._codec) fileFields.push({label:"Codec", value:emb._codec});
    if (emb._fps) fileFields.push({label:"FPS", value:emb._fps});
    panel.appendChild(_paramBox("File Info", fileFields, _C.teal, {emphasis:true}));

    // Generation time (from execution tracking)
    if (m.execution_time_ms != null) {
      const gt = _mk("div","mu-meta-gentime");
      const gtl = _mk("span","mu-meta-gentime-lbl"); gtl.textContent = "Gen Time";
      const secs = m.execution_time_ms / 1000;
      const gtv = _mk("span","mu-meta-gentime-val");
      gtv.textContent = secs >= 60 ? `${Math.floor(secs/60)}m ${(secs%60).toFixed(1)}s` : `${secs.toFixed(1)}s`;
      gtv.onclick = () => _copyFlash(gtv, String(m.execution_time_ms) + "ms");
      gt.appendChild(gtl); gt.appendChild(gtv);
      panel.appendChild(gt);
    }

    if (hasGeninfo) {
      // ── Positive Prompt ──
      const ppBox = _promptBox("Positive Prompt", gi.positive_prompt, _C.green);
      if (ppBox) panel.appendChild(ppBox);

      // ── Negative Prompt ──
      const npBox = _promptBox("Negative Prompt", gi.negative_prompt, _C.red);
      if (npBox) panel.appendChild(npBox);

      // ── Model & LoRA ──
      const modelFields = [];
      if (gi.checkpoint) modelFields.push({label:"Checkpoint", value:gi.checkpoint});
      if (gi.unet)       modelFields.push({label:"UNET", value:gi.unet});
      if (gi.vae)        modelFields.push({label:"VAE", value:gi.vae});
      if (gi.upscale_model) modelFields.push({label:"Upscale", value:gi.upscale_model});
      if (gi.loras && gi.loras.length) {
        const loraText = gi.loras.map(l => {
          let s = l.name;
          const parts = [];
          if (l.strength_model != null) parts.push(`m=${l.strength_model}`);
          if (l.strength_clip != null)  parts.push(`c=${l.strength_clip}`);
          if (parts.length) s += ` (${parts.join(", ")})`;
          return s;
        }).join("\n");
        modelFields.push({label:"LoRA", value:loraText});
      }
      const mBox = _paramBox("Model & LoRA", modelFields, _C.purple, {emphasis:true});
      if (mBox) panel.appendChild(mBox);

      // ── Sampling ──
      const samplingFields = [];
      if (gi.sampler)   samplingFields.push({label:"Sampler", value:gi.sampler});
      if (gi.steps)     samplingFields.push({label:"Steps", value:gi.steps});
      if (gi.cfg)       samplingFields.push({label:"CFG Scale", value:gi.cfg});
      if (gi.scheduler) samplingFields.push({label:"Scheduler", value:gi.scheduler});
      if (gi.denoise != null && gi.denoise !== 1) samplingFields.push({label:"Denoise", value:gi.denoise});
      const sBox = _paramBox("Sampling", samplingFields, _C.orange, {emphasis:true});
      if (sBox) panel.appendChild(sBox);

      // ── Seed (hero) ──
      const seedEl = _seedBox(gi.seed);
      if (seedEl) panel.appendChild(seedEl);

      // ── Image ──
      const imgFields = [];
      if (gi.width && gi.height) imgFields.push({label:"Resolution", value:`${gi.width} × ${gi.height}`});
      if (gi.batch_size && gi.batch_size > 1) imgFields.push({label:"Batch Size", value:gi.batch_size});
      const iBox = _paramBox("Image", imgFields, _C.blue, {emphasis:true});
      if (iBox) panel.appendChild(iBox);
    }

    // ── Raw embedded metadata (collapsible) ──
    const jsonKeys = Object.entries(emb).filter(([k,v]) => typeof v === "object" && v !== null);
    if (jsonKeys.length) {
      for (const [k,v] of jsonKeys) {
        const details = _mk("details","mu-meta-raw");
        const summary = _mk("summary");
        summary.textContent = k === "prompt" ? "Raw Workflow (prompt)" : k === "workflow" ? "Raw Workflow (UI)" : k;
        details.appendChild(summary);

        const js = JSON.stringify(v, null, 2);
        const pre = _mk("pre"); pre.textContent = js;
        details.appendChild(pre);

        const btnRow = _mk("div"); btnRow.style.cssText = "display:flex;gap:4px;margin-top:4px";
        const cp = _mk("button","mu-meta-raw-btn"); cp.textContent = "Copy JSON";
        cp.onclick = () => { navigator.clipboard.writeText(js); cp.textContent = "Copied!"; setTimeout(()=>cp.textContent="Copy JSON",1500); };
        btnRow.appendChild(cp);
        details.appendChild(btnRow);

        panel.appendChild(details);
      }
    }

    // Simple embedded properties (non-JSON)
    const simpleKeys = Object.entries(emb).filter(([k,v]) => typeof v !== "object" || v === null);
    const displaySimple = simpleKeys.filter(([k]) => !k.startsWith("_")); // skip _dimensions etc
    if (displaySimple.length) {
      const propFields = displaySimple.map(([k,v]) => ({label: k, value: String(v)}));
      const pBox = _paramBox("Properties", propFields, _C.teal);
      if (pBox) panel.appendChild(pBox);
    }

    if (!hasGeninfo && !Object.keys(emb).length) {
      const empty = _mk("div","mu-meta-box");
      empty.style.textAlign = "center";
      empty.style.color = "#888";
      empty.style.padding = "20px";
      empty.textContent = "No embedded metadata found.";
      panel.appendChild(empty);
    }

  } catch(e) {
    const ld = panel.querySelector(".mu-loading");
    if (ld) ld.textContent = "Error: " + e.message;
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
