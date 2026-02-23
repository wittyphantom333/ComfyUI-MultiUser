/**
 * ComfyUI-MultiUser — Output Gallery
 *
 * Renders a per-user-scoped output browser inside a ComfyUI sidebar tab.
 * Admins see all outputs with a user filter; regular users see only their own.
 */

import { apiGet, apiDelete, authHeaders } from "./api.js";

// ─── CSS ─────────────────────────────────────────────────────────────
const GALLERY_CSS = `
  .mu-gallery {
    padding: 10px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e0e0e0;
    font-size: 13px;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  /* ── Toolbar ── */
  .mu-gallery-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
    align-items: center;
  }
  .mu-gallery-toolbar input[type="text"] {
    flex: 1;
    min-width: 100px;
    padding: 5px 8px;
    border: 1px solid #444;
    border-radius: 5px;
    background: #1a1a2e;
    color: #e0e0e0;
    font-size: 12px;
    outline: none;
  }
  .mu-gallery-toolbar input[type="text"]:focus {
    border-color: #7c6cff;
  }
  .mu-gallery-toolbar select {
    padding: 5px 6px;
    border: 1px solid #444;
    border-radius: 5px;
    background: #1a1a2e;
    color: #e0e0e0;
    font-size: 12px;
    outline: none;
    cursor: pointer;
  }
  .mu-gallery-toolbar select:focus {
    border-color: #7c6cff;
  }

  /* ── Grid ── */
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
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .mu-gallery-item .mu-item-label {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 3px 5px;
    background: rgba(0,0,0,0.7);
    font-size: 10px;
    color: #ccc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .mu-gallery-item:hover .mu-item-label {
    opacity: 1;
  }
  .mu-gallery-item .mu-item-video-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    background: rgba(0,0,0,0.7);
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 9px;
    color: #ffb86c;
    font-weight: 600;
  }

  /* ── Pagination ── */
  .mu-gallery-pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 0 4px;
    font-size: 12px;
    flex-shrink: 0;
  }
  .mu-gallery-pagination button {
    padding: 4px 10px;
    border: 1px solid #444;
    border-radius: 5px;
    background: #1a1a2e;
    color: #ccc;
    cursor: pointer;
    font-size: 12px;
  }
  .mu-gallery-pagination button:hover:not(:disabled) {
    background: #2a2a3e;
    color: #fff;
  }
  .mu-gallery-pagination button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* ── Empty state ── */
  .mu-gallery-empty {
    text-align: center;
    color: #666;
    padding: 40px 12px;
    font-size: 13px;
  }
  .mu-gallery-empty .mu-empty-icon {
    font-size: 36px;
    margin-bottom: 10px;
  }

  /* ── Lightbox ── */
  .mu-lightbox-overlay {
    position: fixed;
    inset: 0;
    z-index: 99999;
    background: rgba(0,0,0,0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: zoom-out;
  }
  .mu-lightbox-overlay img,
  .mu-lightbox-overlay video {
    max-width: 92vw;
    max-height: 92vh;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 4px 32px rgba(0,0,0,0.6);
  }
  .mu-lightbox-info {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.7);
    color: #ccc;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    z-index: 100000;
    text-align: center;
    max-width: 80vw;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mu-lightbox-actions {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 100000;
    display: flex;
    gap: 8px;
  }
  .mu-lightbox-actions button {
    padding: 6px 12px;
    border: none;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  .mu-lightbox-btn-close {
    background: #444;
    color: #fff;
  }
  .mu-lightbox-btn-close:hover {
    background: #666;
  }
  .mu-lightbox-btn-delete {
    background: #d32f2f;
    color: #fff;
  }
  .mu-lightbox-btn-delete:hover {
    background: #e53935;
  }
  .mu-lightbox-btn-download {
    background: #2e7d32;
    color: #fff;
  }
  .mu-lightbox-btn-download:hover {
    background: #388e3c;
  }

  /* ── Loading / spinner ── */
  .mu-gallery-loading {
    text-align: center;
    padding: 24px;
    color: #888;
    font-size: 12px;
  }
`;

let _galleryCssInjected = false;
function _injectGalleryCss() {
  if (_galleryCssInjected) return;
  _galleryCssInjected = true;
  const style = document.createElement("style");
  style.id = "mu-gallery-styles";
  style.textContent = GALLERY_CSS;
  document.head.appendChild(style);
}

// ─── State ───────────────────────────────────────────────────────────
let _page = 1;
let _perPage = 50;
let _sort = "newest";
let _search = "";
let _typeFilter = "all";
let _userFilter = "";
let _currentFiles = [];
let _totalFiles = 0;
let _totalPages = 0;
let _isAdmin = false;
let _galleryEl = null;
let _searchTimer = null;

// ─── Public entry point ──────────────────────────────────────────────

/**
 * Render the output gallery into the given DOM element.
 * Called by ComfyUI's sidebar tab system.
 */
export function renderOutputGallery(el) {
  _injectGalleryCss();
  el.innerHTML = "";

  const user = window.__multiuser_current_user;
  if (!user) {
    el.innerHTML = `
      <div class="mu-gallery-empty">
        <div class="mu-empty-icon">🖼️</div>
        <div>Sign in to view your outputs.</div>
      </div>`;
    return;
  }

  _isAdmin = !!user.is_admin;
  _page = 1;
  _search = "";
  _typeFilter = "all";
  _userFilter = "";

  const container = document.createElement("div");
  container.className = "mu-gallery";
  _galleryEl = container;

  // ── Toolbar ──
  const toolbar = document.createElement("div");
  toolbar.className = "mu-gallery-toolbar";

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search files…";
  searchInput.addEventListener("input", () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      _search = searchInput.value;
      _page = 1;
      _loadGallery();
    }, 300);
  });
  toolbar.appendChild(searchInput);

  const sortSelect = document.createElement("select");
  sortSelect.innerHTML = `
    <option value="newest">Newest</option>
    <option value="oldest">Oldest</option>
    <option value="name">Name</option>
  `;
  sortSelect.value = _sort;
  sortSelect.addEventListener("change", () => {
    _sort = sortSelect.value;
    _page = 1;
    _loadGallery();
  });
  toolbar.appendChild(sortSelect);

  const typeSelect = document.createElement("select");
  typeSelect.innerHTML = `
    <option value="all">All</option>
    <option value="image">Images</option>
    <option value="video">Videos</option>
  `;
  typeSelect.value = _typeFilter;
  typeSelect.addEventListener("change", () => {
    _typeFilter = typeSelect.value;
    _page = 1;
    _loadGallery();
  });
  toolbar.appendChild(typeSelect);

  // Admin-only: user filter
  if (_isAdmin) {
    const userSelect = document.createElement("select");
    userSelect.id = "mu-gallery-user-filter";
    userSelect.innerHTML = '<option value="">All Users</option>';
    userSelect.addEventListener("change", () => {
      _userFilter = userSelect.value;
      _page = 1;
      _loadGallery();
    });
    toolbar.appendChild(userSelect);
    _loadUserFilter(userSelect);
  }

  container.appendChild(toolbar);

  // ── Grid ──
  const grid = document.createElement("div");
  grid.className = "mu-gallery-grid";
  grid.id = "mu-gallery-grid";
  container.appendChild(grid);

  // ── Pagination ──
  const pag = document.createElement("div");
  pag.className = "mu-gallery-pagination";
  pag.id = "mu-gallery-pagination";
  container.appendChild(pag);

  el.appendChild(container);
  _loadGallery();
}

// ─── Data fetching ───────────────────────────────────────────────────

async function _loadGallery() {
  const grid = _galleryEl?.querySelector("#mu-gallery-grid");
  if (!grid) return;

  grid.innerHTML = '<div class="mu-gallery-loading">Loading…</div>';

  try {
    const params = new URLSearchParams({
      page: _page,
      per_page: _perPage,
      sort: _sort,
    });
    if (_search) params.set("search", _search);
    if (_typeFilter !== "all") params.set("type", _typeFilter);
    if (_userFilter) params.set("user", _userFilter);

    const res = await apiGet(`/outputs?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      grid.innerHTML = `<div class="mu-gallery-empty"><div class="mu-empty-icon">⚠️</div><div>${err.error || "Failed to load outputs"}</div></div>`;
      return;
    }

    const data = await res.json();
    _currentFiles = data.files || [];
    _totalFiles = data.total || 0;
    _totalPages = data.pages || 0;

    _renderGrid(grid);
    _renderPagination();
  } catch (e) {
    grid.innerHTML = `<div class="mu-gallery-empty"><div class="mu-empty-icon">⚠️</div><div>Error: ${e.message}</div></div>`;
  }
}

async function _loadUserFilter(select) {
  try {
    const res = await apiGet("/outputs/users");
    if (!res.ok) return;
    const data = await res.json();
    for (const u of (data.users || [])) {
      const opt = document.createElement("option");
      opt.value = u.username === "(shared)" ? "" : u.username;
      opt.textContent = `${u.username} (${u.file_count})`;
      select.appendChild(opt);
    }
  } catch {}
}

// ─── Grid rendering ──────────────────────────────────────────────────

function _renderGrid(grid) {
  grid.innerHTML = "";

  if (_currentFiles.length === 0) {
    grid.innerHTML = `
      <div class="mu-gallery-empty" style="grid-column:1/-1;">
        <div class="mu-empty-icon">🖼️</div>
        <div>No outputs found.</div>
      </div>`;
    return;
  }

  for (const file of _currentFiles) {
    const item = document.createElement("div");
    item.className = "mu-gallery-item";
    item.title = file.relative_path;

    if (file.type === "image") {
      const img = document.createElement("img");
      img.loading = "lazy";
      // Use our thumbnail endpoint for faster loading
      const thumbParams = new URLSearchParams({
        filename: file.filename,
        subfolder: file.subfolder,
        size: "256",
      });
      img.src = `/multiuser/outputs/thumbnail?${thumbParams}`;
      img.alt = file.filename;
      img.onerror = () => {
        // Fallback to ComfyUI /view
        img.src = _viewUrl(file);
      };
      item.appendChild(img);
    } else {
      // Video — show thumbnail placeholder with badge
      const img = document.createElement("img");
      img.loading = "lazy";
      const thumbParams = new URLSearchParams({
        filename: file.filename,
        subfolder: file.subfolder,
      });
      img.src = `/multiuser/outputs/thumbnail?${thumbParams}`;
      item.appendChild(img);

      const badge = document.createElement("div");
      badge.className = "mu-item-video-badge";
      badge.textContent = "VIDEO";
      item.appendChild(badge);
    }

    // Filename label
    const label = document.createElement("div");
    label.className = "mu-item-label";
    label.textContent = file.filename;
    item.appendChild(label);

    // Click → lightbox
    item.addEventListener("click", () => _openLightbox(file));

    grid.appendChild(item);
  }
}

function _viewUrl(file) {
  const params = new URLSearchParams({
    filename: file.filename,
    type: "output",
  });
  if (file.subfolder) params.set("subfolder", file.subfolder);
  return `/view?${params}`;
}

// ─── Pagination ──────────────────────────────────────────────────────

function _renderPagination() {
  const pag = _galleryEl?.querySelector("#mu-gallery-pagination");
  if (!pag) return;
  pag.innerHTML = "";

  if (_totalPages <= 1) {
    // Show total count only
    if (_totalFiles > 0) {
      pag.textContent = `${_totalFiles} file${_totalFiles !== 1 ? "s" : ""}`;
    }
    return;
  }

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "◀ Prev";
  prevBtn.disabled = _page <= 1;
  prevBtn.addEventListener("click", () => { _page--; _loadGallery(); });
  pag.appendChild(prevBtn);

  const info = document.createElement("span");
  info.textContent = `Page ${_page} / ${_totalPages} (${_totalFiles} files)`;
  pag.appendChild(info);

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next ▶";
  nextBtn.disabled = _page >= _totalPages;
  nextBtn.addEventListener("click", () => { _page++; _loadGallery(); });
  pag.appendChild(nextBtn);
}

// ─── Lightbox ────────────────────────────────────────────────────────

function _openLightbox(file) {
  // Remove any existing
  document.querySelector(".mu-lightbox-overlay")?.remove();
  document.querySelector(".mu-lightbox-info")?.remove();
  document.querySelector(".mu-lightbox-actions")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "mu-lightbox-overlay";

  if (file.type === "video") {
    const video = document.createElement("video");
    video.src = _viewUrl(file);
    video.controls = true;
    video.autoplay = true;
    video.style.cursor = "default";
    video.addEventListener("click", (e) => e.stopPropagation());
    overlay.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.src = _viewUrl(file);
    img.alt = file.filename;
    overlay.appendChild(img);
  }

  // Close on overlay click
  overlay.addEventListener("click", () => _closeLightbox());

  // Info bar
  const info = document.createElement("div");
  info.className = "mu-lightbox-info";
  const sizeStr = _formatBytes(file.size);
  const dateStr = new Date(file.modified * 1000).toLocaleString();
  info.textContent = `${file.relative_path}  •  ${sizeStr}  •  ${dateStr}`;

  // Actions
  const actions = document.createElement("div");
  actions.className = "mu-lightbox-actions";

  const downloadBtn = document.createElement("button");
  downloadBtn.className = "mu-lightbox-btn-download";
  downloadBtn.textContent = "Download";
  downloadBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const a = document.createElement("a");
    a.href = _viewUrl(file);
    a.download = file.filename;
    a.click();
  });
  actions.appendChild(downloadBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "mu-lightbox-btn-delete";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete ${file.filename}?`)) return;
    try {
      const params = new URLSearchParams({ filename: file.filename });
      if (file.subfolder) params.set("subfolder", file.subfolder);
      const res = await apiDelete(`/outputs/file?${params}`);
      if (res.ok) {
        _closeLightbox();
        _loadGallery();
        const { showToast } = await import("./multiuser.js");
        showToast("success", "Deleted", file.filename);
      } else {
        const err = await res.json().catch(() => ({}));
        const { showToast } = await import("./multiuser.js");
        showToast("error", "Delete Failed", err.error || "Unknown error");
      }
    } catch (ex) {
      const { showToast } = await import("./multiuser.js");
      showToast("error", "Delete Failed", ex.message);
    }
  });
  actions.appendChild(deleteBtn);

  const closeBtn = document.createElement("button");
  closeBtn.className = "mu-lightbox-btn-close";
  closeBtn.textContent = "✕ Close";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _closeLightbox();
  });
  actions.appendChild(closeBtn);

  document.body.appendChild(overlay);
  document.body.appendChild(info);
  document.body.appendChild(actions);

  // Keyboard: Escape to close, arrows to navigate
  const _keyHandler = (e) => {
    if (e.key === "Escape") {
      _closeLightbox();
      document.removeEventListener("keydown", _keyHandler);
    } else if (e.key === "ArrowRight") {
      _lightboxNavigate(file, 1);
      document.removeEventListener("keydown", _keyHandler);
    } else if (e.key === "ArrowLeft") {
      _lightboxNavigate(file, -1);
      document.removeEventListener("keydown", _keyHandler);
    }
  };
  document.addEventListener("keydown", _keyHandler);
}

function _closeLightbox() {
  document.querySelector(".mu-lightbox-overlay")?.remove();
  document.querySelector(".mu-lightbox-info")?.remove();
  document.querySelector(".mu-lightbox-actions")?.remove();
}

function _lightboxNavigate(currentFile, direction) {
  const idx = _currentFiles.findIndex(
    f => f.relative_path === currentFile.relative_path
  );
  const newIdx = idx + direction;
  if (newIdx >= 0 && newIdx < _currentFiles.length) {
    _openLightbox(_currentFiles[newIdx]);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function _formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
