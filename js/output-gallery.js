/**
 * ComfyUI-MultiUser — Output Gallery
 *
 * Per-user-scoped output browser with:
 *   - Thumbnail grid (images + video first-frame previews)
 *   - Tagging system with autocomplete
 *   - 0–5 star rating system
 *   - Metadata viewer (PNG workflow, EXIF, video info)
 *   - Lightbox with keyboard navigation
 *   - Admin user filter
 */

import { apiGet, apiPost, apiPut, apiDelete, authHeaders } from "./api.js";

// ─── CSS ─────────────────────────────────────────────────────────────
const GALLERY_CSS = `
  /* Container */
  .mu-gallery {
    padding: 10px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e0e0e0;
    font-size: 13px;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  /* ── Toolbar ────────────────────────── */
  .mu-gallery-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
    align-items: center;
  }
  .mu-gallery-toolbar input[type="text"],
  .mu-gallery-toolbar select {
    padding: 5px 8px;
    border: 1px solid #444;
    border-radius: 5px;
    background: #1a1a2e;
    color: #e0e0e0;
    font-size: 12px;
    outline: none;
  }
  .mu-gallery-toolbar input[type="text"] {
    flex: 1;
    min-width: 80px;
  }
  .mu-gallery-toolbar input[type="text"]:focus,
  .mu-gallery-toolbar select:focus {
    border-color: #7c6cff;
  }
  .mu-gallery-toolbar select { cursor: pointer; }

  /* Filter row (second row) */
  .mu-gallery-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
    align-items: center;
    font-size: 12px;
  }
  .mu-filter-tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: #1f2a3d;
    color: #6bb5ff;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
  }
  .mu-filter-tag:hover { background: #2a3a52; }
  .mu-filter-tag.active { background: #7c6cff; color: #fff; }
  .mu-filter-stars {
    display: inline-flex;
    gap: 1px;
    cursor: pointer;
    font-size: 14px;
  }
  .mu-filter-stars span { color: #555; transition: color 0.1s; }
  .mu-filter-stars span.on { color: #ffc107; }
  .mu-filter-stars span:hover { color: #ffdb4d; }

  /* ── Grid ───────────────────────────── */
  .mu-gallery-grid {
    flex: 1;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 6px;
    align-content: start;
  }
  .mu-gallery-item {
    position: relative;
    aspect-ratio: 1;
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    background: #1a1a2e;
    border: 2px solid transparent;
    transition: border-color 0.15s, transform 0.1s;
  }
  .mu-gallery-item:hover {
    border-color: #7c6cff;
    transform: scale(1.02);
  }
  .mu-gallery-item img {
    width: 100%; height: 100%;
    object-fit: cover; display: block;
  }
  .mu-gallery-item .mu-item-overlay {
    position: absolute; bottom: 0; left: 0; right: 0;
    padding: 3px 5px;
    background: rgba(0,0,0,0.75);
    display: flex;
    justify-content: space-between;
    align-items: center;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .mu-gallery-item:hover .mu-item-overlay { opacity: 1; }
  .mu-item-name {
    font-size: 10px; color: #ccc;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    flex: 1; min-width: 0;
  }
  .mu-item-stars {
    font-size: 9px; color: #ffc107;
    flex-shrink: 0; margin-left: 4px;
  }
  .mu-gallery-item .mu-item-badge {
    position: absolute; top: 4px; right: 4px;
    background: rgba(0,0,0,0.7);
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 9px; font-weight: 600;
  }
  .mu-item-badge-video { color: #ffb86c; }
  .mu-item-badge-tags {
    position: absolute; top: 4px; left: 4px;
    background: rgba(0,0,0,0.7);
    border-radius: 3px; padding: 1px 5px;
    font-size: 9px; color: #6bb5ff;
  }

  /* ── Pagination ─────────────────────── */
  .mu-gallery-pagination {
    display: flex; align-items: center; justify-content: center;
    gap: 8px; padding: 8px 0 4px; font-size: 12px; flex-shrink: 0;
  }
  .mu-gallery-pagination button {
    padding: 4px 10px;
    border: 1px solid #444; border-radius: 5px;
    background: #1a1a2e; color: #ccc;
    cursor: pointer; font-size: 12px;
  }
  .mu-gallery-pagination button:hover:not(:disabled) { background: #2a2a3e; color: #fff; }
  .mu-gallery-pagination button:disabled { opacity: 0.4; cursor: default; }

  /* ── Empty ──────────────────────────── */
  .mu-gallery-empty {
    text-align: center; color: #666; padding: 40px 12px; font-size: 13px;
  }
  .mu-gallery-empty .mu-empty-icon { font-size: 36px; margin-bottom: 10px; }
  .mu-gallery-loading { text-align: center; padding: 24px; color: #888; font-size: 12px; }

  /* ── Lightbox ───────────────────────── */
  .mu-lightbox-overlay {
    position: fixed; inset: 0; z-index: 99999;
    background: rgba(0,0,0,0.92);
    display: flex; align-items: center; justify-content: center;
    cursor: zoom-out;
  }
  .mu-lightbox-overlay img,
  .mu-lightbox-overlay video {
    max-width: 90vw; max-height: 80vh;
    object-fit: contain; border-radius: 4px;
    box-shadow: 0 4px 32px rgba(0,0,0,0.6);
  }

  /* Lightbox top bar */
  .mu-lightbox-topbar {
    position: fixed; top: 0; left: 0; right: 0;
    z-index: 100001;
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 16px;
    background: rgba(0,0,0,0.6);
  }
  .mu-lightbox-topbar-left { display: flex; align-items: center; gap: 12px; }
  .mu-lightbox-topbar-right { display: flex; gap: 8px; }
  .mu-lightbox-topbar button {
    padding: 6px 12px; border: none; border-radius: 5px;
    font-size: 12px; font-weight: 600; cursor: pointer;
    transition: background 0.15s;
  }
  .mu-lb-btn-download { background: #2e7d32; color: #fff; }
  .mu-lb-btn-download:hover { background: #388e3c; }
  .mu-lb-btn-delete { background: #d32f2f; color: #fff; }
  .mu-lb-btn-delete:hover { background: #e53935; }
  .mu-lb-btn-info { background: #1565c0; color: #fff; }
  .mu-lb-btn-info:hover { background: #1976d2; }
  .mu-lb-btn-close { background: #444; color: #fff; }
  .mu-lb-btn-close:hover { background: #666; }

  /* Lightbox bottom panel */
  .mu-lightbox-bottom {
    position: fixed; bottom: 0; left: 0; right: 0;
    z-index: 100001;
    background: rgba(0,0,0,0.75);
    padding: 10px 16px;
    display: flex; flex-direction: column; gap: 8px;
    max-height: 40vh; overflow-y: auto;
  }
  .mu-lb-file-info {
    font-size: 12px; color: #aaa;
    display: flex; flex-wrap: wrap; gap: 16px;
  }
  .mu-lb-file-info span { white-space: nowrap; }

  /* Rating in lightbox */
  .mu-lb-rating {
    display: flex; align-items: center; gap: 6px;
  }
  .mu-lb-rating-label { font-size: 12px; color: #888; }
  .mu-lb-stars {
    display: inline-flex; gap: 2px; cursor: pointer; font-size: 20px;
  }
  .mu-lb-stars span { color: #555; transition: color 0.1s; user-select: none; }
  .mu-lb-stars span.on { color: #ffc107; }
  .mu-lb-stars span:hover { color: #ffdb4d; }

  /* Tags in lightbox */
  .mu-lb-tags {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  }
  .mu-lb-tags-label { font-size: 12px; color: #888; }
  .mu-lb-tag {
    display: inline-flex; align-items: center; gap: 3px;
    background: #1f2a3d; color: #6bb5ff;
    padding: 2px 8px; border-radius: 3px; font-size: 11px;
  }
  .mu-lb-tag-remove {
    background: none; border: none; color: #ff6b6b;
    cursor: pointer; font-size: 12px; padding: 0 2px; line-height: 1;
  }
  .mu-lb-tag-remove:hover { color: #ff4444; }
  .mu-lb-tag-input {
    padding: 3px 6px; border: 1px solid #444; border-radius: 3px;
    background: #1a1a2e; color: #e0e0e0; font-size: 11px;
    outline: none; width: 90px;
  }
  .mu-lb-tag-input:focus { border-color: #7c6cff; }

  /* Metadata panel */
  .mu-metadata-panel {
    position: fixed; right: 0; top: 0; bottom: 0;
    width: 380px; max-width: 90vw;
    z-index: 100002;
    background: #1a1a2e; color: #e0e0e0;
    overflow-y: auto;
    border-left: 1px solid #333;
    padding: 16px;
    font-size: 12px;
    box-shadow: -4px 0 16px rgba(0,0,0,0.4);
  }
  .mu-metadata-panel h3 {
    margin: 0 0 12px; font-size: 14px; color: #fff;
    display: flex; justify-content: space-between; align-items: center;
  }
  .mu-metadata-panel .mu-meta-close {
    background: none; border: none; color: #888; cursor: pointer;
    font-size: 18px; padding: 2px 6px;
  }
  .mu-metadata-panel .mu-meta-close:hover { color: #fff; }
  .mu-metadata-section {
    margin-bottom: 16px;
  }
  .mu-metadata-section h4 {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: #888; margin: 0 0 8px;
  }
  .mu-meta-table {
    width: 100%; border-collapse: collapse;
  }
  .mu-meta-table td {
    padding: 3px 6px; border-bottom: 1px solid #222; vertical-align: top;
  }
  .mu-meta-table td:first-child {
    color: #888; white-space: nowrap; width: 100px;
  }
  .mu-meta-table td:last-child {
    word-break: break-all;
  }
  .mu-meta-json {
    background: #111; border-radius: 4px; padding: 8px;
    max-height: 200px; overflow: auto;
    font-family: monospace; font-size: 11px; color: #aaa;
    white-space: pre-wrap; word-break: break-all;
  }
  .mu-meta-json-toggle {
    background: none; border: 1px solid #444; border-radius: 3px;
    color: #6bb5ff; cursor: pointer; padding: 2px 8px; font-size: 11px;
    margin-top: 4px;
  }
  .mu-meta-json-toggle:hover { background: #222; }

  /* Nav arrows in lightbox */
  .mu-lb-nav {
    position: fixed; top: 50%; z-index: 100001;
    transform: translateY(-50%);
    background: rgba(0,0,0,0.5); border: none;
    color: #fff; font-size: 24px; cursor: pointer;
    padding: 12px 8px; border-radius: 4px;
    transition: background 0.15s;
  }
  .mu-lb-nav:hover { background: rgba(0,0,0,0.8); }
  .mu-lb-nav-prev { left: 8px; }
  .mu-lb-nav-next { right: 8px; }
`;

let _cssInjected = false;
function _injectCss() {
  if (_cssInjected) return;
  _cssInjected = true;
  const s = document.createElement("style");
  s.id = "mu-gallery-styles";
  s.textContent = GALLERY_CSS;
  document.head.appendChild(s);
}

// ─── State ───────────────────────────────────────────────────────────
let _page = 1;
const PER_PAGE = 50;
let _sort = "newest";
let _search = "";
let _typeFilter = "all";
let _userFilter = "";
let _tagFilter = "";
let _minRating = 0;
let _currentFiles = [];
let _totalFiles = 0;
let _totalPages = 0;
let _isAdmin = false;
let _galleryEl = null;
let _searchTimer = null;
let _allTags = [];       // user's tag palette

// ─── Public entry ────────────────────────────────────────────────────

export function renderOutputGallery(el) {
  _injectCss();
  el.innerHTML = "";

  const user = window.__multiuser_current_user;
  if (!user) {
    el.innerHTML = `<div class="mu-gallery-empty"><div class="mu-empty-icon">🖼️</div><div>Sign in to view your outputs.</div></div>`;
    return;
  }

  _isAdmin = !!user.is_admin;
  _page = 1;
  _search = "";
  _typeFilter = "all";
  _userFilter = "";
  _tagFilter = "";
  _minRating = 0;

  const container = document.createElement("div");
  container.className = "mu-gallery";
  _galleryEl = container;

  // ── Toolbar row 1 ──
  const toolbar = document.createElement("div");
  toolbar.className = "mu-gallery-toolbar";

  const searchInput = _el("input", { type: "text", placeholder: "Search files…" });
  searchInput.addEventListener("input", () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { _search = searchInput.value; _page = 1; _loadGallery(); }, 300);
  });
  toolbar.appendChild(searchInput);

  toolbar.appendChild(_select([
    ["newest", "Newest"], ["oldest", "Oldest"], ["name", "Name"], ["rating", "Rating"]
  ], _sort, v => { _sort = v; _page = 1; _loadGallery(); }));

  toolbar.appendChild(_select([
    ["all", "All"], ["image", "Images"], ["video", "Videos"]
  ], _typeFilter, v => { _typeFilter = v; _page = 1; _loadGallery(); }));

  if (_isAdmin) {
    const userSel = _select([["", "All Users"]], "", v => { _userFilter = v; _page = 1; _loadGallery(); });
    userSel.id = "mu-gallery-user-filter";
    toolbar.appendChild(userSel);
    _loadUserFilter(userSel);
  }

  container.appendChild(toolbar);

  // ── Toolbar row 2: tag + rating filters ──
  const filters = document.createElement("div");
  filters.className = "mu-gallery-filters";
  filters.id = "mu-gallery-filters";
  container.appendChild(filters);

  // Grid
  const grid = document.createElement("div");
  grid.className = "mu-gallery-grid";
  grid.id = "mu-gallery-grid";
  container.appendChild(grid);

  // Pagination
  const pag = document.createElement("div");
  pag.className = "mu-gallery-pagination";
  pag.id = "mu-gallery-pagination";
  container.appendChild(pag);

  el.appendChild(container);

  // Load data
  _loadTagPalette();
  _loadGallery();
}

// ─── Helpers ─────────────────────────────────────────────────────────

function _el(tag, attrs = {}) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e[k] = v;
  return e;
}

function _select(options, value, onChange) {
  const sel = document.createElement("select");
  sel.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function _viewUrl(file) {
  const p = new URLSearchParams({ filename: file.filename, type: "output" });
  if (file.subfolder) p.set("subfolder", file.subfolder);
  return `/view?${p}`;
}

function _thumbUrl(file) {
  const p = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", size: "256" });
  return `/multiuser/outputs/thumbnail?${p}`;
}

function _starsHtml(rating, max = 5) {
  return Array.from({ length: max }, (_, i) => i < rating ? "★" : "☆").join("");
}

function _formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function _formatDate(ts) {
  return new Date(ts * 1000).toLocaleString();
}

// ─── Data fetching ───────────────────────────────────────────────────

async function _loadGallery() {
  const grid = _galleryEl?.querySelector("#mu-gallery-grid");
  if (!grid) return;
  grid.innerHTML = '<div class="mu-gallery-loading">Loading…</div>';

  try {
    const p = new URLSearchParams({ page: _page, per_page: PER_PAGE, sort: _sort });
    if (_search) p.set("search", _search);
    if (_typeFilter !== "all") p.set("type", _typeFilter);
    if (_userFilter) p.set("user", _userFilter);
    if (_tagFilter) p.set("tag", _tagFilter);
    if (_minRating > 0) p.set("min_rating", _minRating);

    const res = await apiGet(`/outputs?${p}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      grid.innerHTML = `<div class="mu-gallery-empty"><div class="mu-empty-icon">⚠️</div><div>${err.error || "Failed to load"}</div></div>`;
      return;
    }
    const data = await res.json();
    _currentFiles = data.files || [];
    _totalFiles = data.total || 0;
    _totalPages = data.pages || 0;
    _renderGrid(grid);
    _renderPagination();
  } catch (e) {
    grid.innerHTML = `<div class="mu-gallery-empty"><div class="mu-empty-icon">⚠️</div><div>${e.message}</div></div>`;
  }
}

async function _loadUserFilter(sel) {
  try {
    const res = await apiGet("/outputs/users");
    if (!res.ok) return;
    const data = await res.json();
    for (const u of data.users || []) {
      const opt = document.createElement("option");
      opt.value = u.username === "(shared)" ? "" : u.username;
      opt.textContent = `${u.username} (${u.file_count})`;
      sel.appendChild(opt);
    }
  } catch {}
}

async function _loadTagPalette() {
  try {
    const res = await apiGet("/outputs/tags");
    if (res.ok) {
      const data = await res.json();
      _allTags = data.tags || [];
    }
  } catch {}
  _renderFilterRow();
}

// ─── Filter row ──────────────────────────────────────────────────────

function _renderFilterRow() {
  const filters = _galleryEl?.querySelector("#mu-gallery-filters");
  if (!filters) return;
  filters.innerHTML = "";

  // Rating filter
  const ratingDiv = document.createElement("div");
  ratingDiv.className = "mu-filter-stars";
  ratingDiv.title = "Min rating filter (click to toggle)";
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("span");
    star.textContent = "★";
    star.className = i <= _minRating ? "on" : "";
    star.addEventListener("click", () => {
      _minRating = _minRating === i ? 0 : i;
      _page = 1;
      _loadGallery();
      _renderFilterRow();
    });
    ratingDiv.appendChild(star);
  }
  filters.appendChild(ratingDiv);

  // Tag chips
  if (_allTags.length > 0) {
    for (const tag of _allTags.slice(0, 20)) {
      const chip = document.createElement("span");
      chip.className = "mu-filter-tag" + (_tagFilter === tag ? " active" : "");
      chip.textContent = tag;
      chip.addEventListener("click", () => {
        _tagFilter = _tagFilter === tag ? "" : tag;
        _page = 1;
        _loadGallery();
        _renderFilterRow();
      });
      filters.appendChild(chip);
    }
  }
}

// ─── Grid ────────────────────────────────────────────────────────────

function _renderGrid(grid) {
  grid.innerHTML = "";
  if (_currentFiles.length === 0) {
    grid.innerHTML = `<div class="mu-gallery-empty" style="grid-column:1/-1"><div class="mu-empty-icon">🖼️</div><div>No outputs found.</div></div>`;
    return;
  }

  for (const file of _currentFiles) {
    const item = document.createElement("div");
    item.className = "mu-gallery-item";
    item.title = file.relative_path;

    // Thumbnail image (works for both images and videos now)
    const img = _el("img", { loading: "lazy", alt: file.filename });
    img.src = _thumbUrl(file);
    img.onerror = () => {
      if (file.type === "image") img.src = _viewUrl(file);
    };
    item.appendChild(img);

    // Video badge
    if (file.type === "video") {
      const badge = _el("div");
      badge.className = "mu-item-badge mu-item-badge-video";
      badge.textContent = "▶ VIDEO";
      item.appendChild(badge);
    }

    // Tag indicator
    if (file.tags && file.tags.length > 0) {
      const tb = _el("div");
      tb.className = "mu-item-badge-tags";
      tb.textContent = `🏷 ${file.tags.length}`;
      item.appendChild(tb);
    }

    // Bottom overlay: name + stars
    const overlay = document.createElement("div");
    overlay.className = "mu-item-overlay";
    const nameSpan = _el("span");
    nameSpan.className = "mu-item-name";
    nameSpan.textContent = file.filename;
    overlay.appendChild(nameSpan);
    if (file.rating > 0) {
      const stars = _el("span");
      stars.className = "mu-item-stars";
      stars.textContent = _starsHtml(file.rating);
      overlay.appendChild(stars);
    }
    item.appendChild(overlay);

    item.addEventListener("click", () => _openLightbox(file));
    grid.appendChild(item);
  }
}

// ─── Pagination ──────────────────────────────────────────────────────

function _renderPagination() {
  const pag = _galleryEl?.querySelector("#mu-gallery-pagination");
  if (!pag) return;
  pag.innerHTML = "";
  if (_totalPages <= 1) {
    if (_totalFiles > 0) pag.textContent = `${_totalFiles} file${_totalFiles !== 1 ? "s" : ""}`;
    return;
  }
  const prev = _el("button"); prev.textContent = "◀ Prev"; prev.disabled = _page <= 1;
  prev.addEventListener("click", () => { _page--; _loadGallery(); });
  pag.appendChild(prev);
  pag.appendChild(_el("span", { textContent: `${_page} / ${_totalPages}  (${_totalFiles})` }));
  const next = _el("button"); next.textContent = "Next ▶"; next.disabled = _page >= _totalPages;
  next.addEventListener("click", () => { _page++; _loadGallery(); });
  pag.appendChild(next);
}

// ─── Lightbox ────────────────────────────────────────────────────────

let _currentLightboxFile = null;
let _metadataPanelOpen = false;

function _openLightbox(file) {
  _closeLightbox();
  _currentLightboxFile = file;
  _metadataPanelOpen = false;

  // Overlay
  const overlay = document.createElement("div");
  overlay.className = "mu-lightbox-overlay";
  overlay.id = "mu-lightbox-overlay";

  if (file.type === "video") {
    const v = _el("video");
    v.src = _viewUrl(file);
    v.controls = true;
    v.autoplay = true;
    v.style.cursor = "default";
    v.addEventListener("click", e => e.stopPropagation());
    overlay.appendChild(v);
  } else {
    const img = _el("img", { alt: file.filename });
    img.src = _viewUrl(file);
    overlay.appendChild(img);
  }
  overlay.addEventListener("click", () => _closeLightbox());

  // Nav arrows
  const idx = _currentFiles.findIndex(f => f.relative_path === file.relative_path);
  if (idx > 0) {
    const navPrev = _el("button");
    navPrev.className = "mu-lb-nav mu-lb-nav-prev";
    navPrev.innerHTML = "&#9664;";
    navPrev.addEventListener("click", e => { e.stopPropagation(); _openLightbox(_currentFiles[idx - 1]); });
    overlay.appendChild(navPrev);
  }
  if (idx < _currentFiles.length - 1) {
    const navNext = _el("button");
    navNext.className = "mu-lb-nav mu-lb-nav-next";
    navNext.innerHTML = "&#9654;";
    navNext.addEventListener("click", e => { e.stopPropagation(); _openLightbox(_currentFiles[idx + 1]); });
    overlay.appendChild(navNext);
  }

  // Top bar
  const topbar = document.createElement("div");
  topbar.className = "mu-lightbox-topbar";
  topbar.addEventListener("click", e => e.stopPropagation());
  const tbLeft = _el("div"); tbLeft.className = "mu-lightbox-topbar-left";
  tbLeft.innerHTML = `<span style="color:#fff;font-size:13px;font-weight:600;">${_escHtml(file.filename)}</span>`;
  topbar.appendChild(tbLeft);
  const tbRight = _el("div"); tbRight.className = "mu-lightbox-topbar-right";

  const dlBtn = _el("button"); dlBtn.className = "mu-lb-btn-download"; dlBtn.textContent = "Download";
  dlBtn.addEventListener("click", () => { const a = _el("a"); a.href = _viewUrl(file); a.download = file.filename; a.click(); });
  tbRight.appendChild(dlBtn);

  const infoBtn = _el("button"); infoBtn.className = "mu-lb-btn-info"; infoBtn.textContent = "Metadata";
  infoBtn.addEventListener("click", () => _toggleMetadataPanel(file));
  tbRight.appendChild(infoBtn);

  const delBtn = _el("button"); delBtn.className = "mu-lb-btn-delete"; delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => _handleDelete(file));
  tbRight.appendChild(delBtn);

  const closeBtn = _el("button"); closeBtn.className = "mu-lb-btn-close"; closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => _closeLightbox());
  tbRight.appendChild(closeBtn);

  topbar.appendChild(tbRight);

  // Bottom panel: file info + rating + tags
  const bottom = document.createElement("div");
  bottom.className = "mu-lightbox-bottom";
  bottom.id = "mu-lightbox-bottom";
  bottom.addEventListener("click", e => e.stopPropagation());

  // File info row
  const infoRow = _el("div"); infoRow.className = "mu-lb-file-info";
  infoRow.innerHTML = `
    <span>${_formatBytes(file.size)}</span>
    <span>${_formatDate(file.modified)}</span>
    <span>${file.relative_path}</span>
  `;
  bottom.appendChild(infoRow);

  // Rating row
  const ratingRow = _el("div"); ratingRow.className = "mu-lb-rating";
  ratingRow.appendChild(_el("span", { textContent: "Rating:", className: "mu-lb-rating-label" }));
  const starsDiv = _el("div"); starsDiv.className = "mu-lb-stars"; starsDiv.id = "mu-lb-stars";
  _renderLightboxStars(starsDiv, file);
  ratingRow.appendChild(starsDiv);
  bottom.appendChild(ratingRow);

  // Tags row
  const tagsRow = _el("div"); tagsRow.className = "mu-lb-tags"; tagsRow.id = "mu-lb-tags";
  _renderLightboxTags(tagsRow, file);
  bottom.appendChild(tagsRow);

  document.body.appendChild(overlay);
  document.body.appendChild(topbar);
  document.body.appendChild(bottom);

  // Keyboard
  document.addEventListener("keydown", _lightboxKeyHandler);
}

function _closeLightbox() {
  document.removeEventListener("keydown", _lightboxKeyHandler);
  for (const cls of ["mu-lightbox-overlay", "mu-lightbox-topbar", "mu-lightbox-bottom", "mu-metadata-panel"]) {
    document.querySelectorAll(`.${cls}`).forEach(e => e.remove());
  }
  // Also remove by ID
  for (const id of ["mu-lightbox-overlay", "mu-lightbox-bottom"]) {
    document.getElementById(id)?.remove();
  }
  _currentLightboxFile = null;
  _metadataPanelOpen = false;
}

function _lightboxKeyHandler(e) {
  if (e.key === "Escape") { _closeLightbox(); return; }
  if (!_currentLightboxFile) return;
  const idx = _currentFiles.findIndex(f => f.relative_path === _currentLightboxFile.relative_path);
  if (e.key === "ArrowRight" && idx < _currentFiles.length - 1) _openLightbox(_currentFiles[idx + 1]);
  if (e.key === "ArrowLeft" && idx > 0) _openLightbox(_currentFiles[idx - 1]);
}

// ─── Lightbox: Stars ─────────────────────────────────────────────────

function _renderLightboxStars(container, file) {
  container.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const star = _el("span");
    star.textContent = "★";
    star.className = i <= file.rating ? "on" : "";
    star.addEventListener("click", async () => {
      const newRating = file.rating === i ? 0 : i;
      try {
        const res = await apiPut("/outputs/rating", { file_path: file.relative_path, rating: newRating });
        if (res.ok) {
          file.rating = newRating;
          _renderLightboxStars(container, file);
        }
      } catch {}
    });
    container.appendChild(star);
  }
}

// ─── Lightbox: Tags ──────────────────────────────────────────────────

function _renderLightboxTags(container, file) {
  container.innerHTML = "";
  container.appendChild(_el("span", { textContent: "Tags:", className: "mu-lb-tags-label" }));

  for (const tag of (file.tags || [])) {
    const chip = _el("span"); chip.className = "mu-lb-tag";
    chip.textContent = tag;
    const rm = _el("button"); rm.className = "mu-lb-tag-remove"; rm.textContent = "×";
    rm.addEventListener("click", async () => {
      try {
        const p = new URLSearchParams({ file_path: file.relative_path, tag });
        const res = await apiDelete(`/outputs/tags?${p}`);
        if (res.ok) {
          file.tags = file.tags.filter(t => t !== tag);
          _renderLightboxTags(container, file);
          _loadTagPalette();
        }
      } catch {}
    });
    chip.appendChild(rm);
    container.appendChild(chip);
  }

  // Add tag input
  const input = _el("input", { type: "text", placeholder: "Add tag…", className: "mu-lb-tag-input" });
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const val = input.value.trim().toLowerCase();
    if (!val) return;
    try {
      const res = await apiPost("/outputs/tags", { file_path: file.relative_path, tags: [val] });
      if (res.ok) {
        if (!file.tags) file.tags = [];
        if (!file.tags.includes(val)) file.tags.push(val);
        input.value = "";
        _renderLightboxTags(container, file);
        _loadTagPalette();
      }
    } catch {}
  });
  container.appendChild(input);
}

// ─── Metadata panel ──────────────────────────────────────────────────

async function _toggleMetadataPanel(file) {
  const existing = document.querySelector(".mu-metadata-panel");
  if (existing) {
    existing.remove();
    _metadataPanelOpen = false;
    return;
  }

  const panel = document.createElement("div");
  panel.className = "mu-metadata-panel";
  panel.addEventListener("click", e => e.stopPropagation());

  const header = _el("h3");
  header.textContent = "Metadata";
  const closeBtn = _el("button"); closeBtn.className = "mu-meta-close"; closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => { panel.remove(); _metadataPanelOpen = false; });
  header.appendChild(closeBtn);
  panel.appendChild(header);

  panel.appendChild(_el("div", { textContent: "Loading…", className: "mu-gallery-loading" }));
  document.body.appendChild(panel);
  _metadataPanelOpen = true;

  try {
    const p = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "" });
    const res = await apiGet(`/outputs/metadata?${p}`);
    if (!res.ok) {
      panel.querySelector(".mu-gallery-loading").textContent = "Failed to load metadata";
      return;
    }
    const meta = await res.json();

    // Remove loading
    panel.querySelector(".mu-gallery-loading")?.remove();

    // Basic info section
    const basicSec = _el("div"); basicSec.className = "mu-metadata-section";
    basicSec.appendChild(_el("h4", { textContent: "File Info" }));
    const basicTable = _el("table"); basicTable.className = "mu-meta-table";
    basicTable.innerHTML = `
      <tr><td>Name</td><td>${_escHtml(meta.filename)}</td></tr>
      <tr><td>Size</td><td>${_formatBytes(meta.size)}</td></tr>
      <tr><td>Modified</td><td>${_formatDate(meta.modified)}</td></tr>
      <tr><td>Type</td><td>${meta.extension}</td></tr>
    `;
    basicSec.appendChild(basicTable);
    panel.appendChild(basicSec);

    // Embedded metadata
    const emb = meta.embedded || {};
    const embKeys = Object.keys(emb);

    if (embKeys.length > 0) {
      // Separate structured (JSON) fields from simple fields
      const simpleFields = {};
      const jsonFields = {};

      for (const [k, v] of Object.entries(emb)) {
        if (typeof v === "object" && v !== null) {
          jsonFields[k] = v;
        } else {
          simpleFields[k] = v;
        }
      }

      // Simple fields table
      if (Object.keys(simpleFields).length > 0) {
        const sec = _el("div"); sec.className = "mu-metadata-section";
        sec.appendChild(_el("h4", { textContent: "Properties" }));
        const tbl = _el("table"); tbl.className = "mu-meta-table";
        for (const [k, v] of Object.entries(simpleFields)) {
          const label = k.startsWith("_") ? k.slice(1) : k;
          const tr = _el("tr");
          tr.innerHTML = `<td>${_escHtml(label)}</td><td>${_escHtml(String(v))}</td>`;
          tbl.appendChild(tr);
        }
        sec.appendChild(tbl);
        panel.appendChild(sec);
      }

      // JSON fields (prompt, workflow, etc)
      for (const [k, v] of Object.entries(jsonFields)) {
        const sec = _el("div"); sec.className = "mu-metadata-section";
        const label = k.startsWith("_") ? k.slice(1) : k;
        sec.appendChild(_el("h4", { textContent: label }));

        const jsonStr = JSON.stringify(v, null, 2);
        const pre = _el("div"); pre.className = "mu-meta-json";
        pre.textContent = jsonStr.length > 500 ? jsonStr.slice(0, 500) + "…" : jsonStr;

        if (jsonStr.length > 500) {
          const toggle = _el("button"); toggle.className = "mu-meta-json-toggle"; toggle.textContent = "Show full";
          let expanded = false;
          toggle.addEventListener("click", () => {
            expanded = !expanded;
            pre.textContent = expanded ? jsonStr : jsonStr.slice(0, 500) + "…";
            toggle.textContent = expanded ? "Collapse" : "Show full";
          });
          sec.appendChild(pre);
          sec.appendChild(toggle);
        } else {
          sec.appendChild(pre);
        }

        // Copy button
        const copyBtn = _el("button"); copyBtn.className = "mu-meta-json-toggle"; copyBtn.textContent = "Copy";
        copyBtn.style.marginLeft = "4px";
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(jsonStr);
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
        });
        sec.appendChild(copyBtn);

        panel.appendChild(sec);
      }
    } else {
      const sec = _el("div"); sec.className = "mu-metadata-section";
      sec.textContent = "No embedded metadata found.";
      panel.appendChild(sec);
    }

  } catch (e) {
    const loading = panel.querySelector(".mu-gallery-loading");
    if (loading) loading.textContent = `Error: ${e.message}`;
  }
}

// ─── Delete handler ──────────────────────────────────────────────────

async function _handleDelete(file) {
  if (!confirm(`Delete ${file.filename}?`)) return;
  try {
    const p = new URLSearchParams({ filename: file.filename });
    if (file.subfolder) p.set("subfolder", file.subfolder);
    const res = await apiDelete(`/outputs/file?${p}`);
    if (res.ok) {
      _closeLightbox();
      _loadGallery();
      const { showToast } = await import("./multiuser.js");
      showToast("success", "Deleted", file.filename);
    } else {
      const err = await res.json().catch(() => ({}));
      const { showToast } = await import("./multiuser.js");
      showToast("error", "Delete", err.error || "Failed");
    }
  } catch (e) {
    const { showToast } = await import("./multiuser.js");
    showToast("error", "Delete", e.message);
  }
}

// ─── Escape HTML ─────────────────────────────────────────────────────

function _escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
