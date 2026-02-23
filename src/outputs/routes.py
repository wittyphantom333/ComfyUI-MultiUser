"""Output-file browsing routes with per-user isolation.

Provides a REST API that scans ComfyUI's output directory and returns file
listings scoped to the requesting user.  Admins can view all outputs or
filter by username.  Includes an optional thumbnail endpoint that uses
Pillow to generate resized previews on-the-fly with an LRU disk cache.
"""
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

from aiohttp import web

from ..config import get_config
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.outputs.routes")

# Supported image/video extensions
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv"}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

# Optional Pillow import for thumbnail generation
try:
    from PIL import Image
    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False
    logger.info("Pillow not available — thumbnail generation disabled")


def _get_output_dir() -> Path:
    """Resolve ComfyUI's output directory."""
    try:
        import folder_paths  # ComfyUI built-in
        return Path(folder_paths.get_output_directory())
    except (ImportError, AttributeError):
        # Fallback: assume standard relative path from ComfyUI root
        return Path("output").resolve()


def _get_thumb_cache_dir() -> Path:
    """Get/create the thumbnail cache directory inside our data folder."""
    from ..config import get_base_dir
    cache = get_base_dir() / "data" / "thumb_cache"
    cache.mkdir(parents=True, exist_ok=True)
    return cache


def _file_info(path: Path, output_dir: Path) -> dict:
    """Build a metadata dict for a single file."""
    rel = path.relative_to(output_dir)
    stat = path.stat()
    ext = path.suffix.lower()
    return {
        "filename": path.name,
        "subfolder": str(rel.parent) if str(rel.parent) != "." else "",
        "relative_path": str(rel),
        "size": stat.st_size,
        "modified": stat.st_mtime,
        "type": "video" if ext in VIDEO_EXTS else "image",
    }


def setup_output_routes(routes):
    """Register output-browsing routes under /multiuser/outputs."""

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs")
    async def list_outputs(request: web.Request):
        """List output files visible to the current user.

        Query params:
            page        (int)   Page number, default 1
            per_page    (int)   Files per page, default 50 (max 500)
            sort        (str)   "newest" | "oldest" | "name" (default newest)
            search      (str)   Filename substring filter
            type        (str)   "image" | "video" | "all" (default all)
            user        (str)   Admin-only: filter by username
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        output_dir = _get_output_dir()
        if not output_dir.exists():
            return web.json_response({
                "files": [], "total": 0, "page": 1, "per_page": 50, "pages": 0,
            })

        is_admin = bool(user.get("is_admin"))
        username = user["username"]

        # Parse query params
        page = max(1, int(request.query.get("page", 1)))
        per_page = min(max(1, int(request.query.get("per_page", 50))), 500)
        sort = request.query.get("sort", "newest")
        search = request.query.get("search", "").strip().lower()
        type_filter = request.query.get("type", "all")
        user_filter = request.query.get("user", "").strip()

        # Determine which directories to scan
        scan_roots: list[Path] = []
        target_username: Optional[str] = None

        if is_admin:
            if user_filter:
                # Admin filtering by specific user
                target_username = user_filter
                user_dir = output_dir / user_filter
                if user_dir.is_dir():
                    scan_roots.append(user_dir)
            else:
                # Admin sees everything
                scan_roots.append(output_dir)
        else:
            # Regular user — only their own subfolder + shared root files
            target_username = username
            user_dir = output_dir / username
            if user_dir.is_dir():
                scan_roots.append(user_dir)
            # Also include loose files in the root (legacy/shared)
            # but NOT files inside other users' folders
            scan_roots.append(output_dir)

        # Collect files
        files: list[dict] = []
        seen_paths: set[str] = set()

        # Build set of known usernames for filtering
        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}

        for root in scan_roots:
            if not root.exists():
                continue
            try:
                entries = list(root.rglob("*"))
            except PermissionError:
                continue

            for entry in entries:
                if not entry.is_file():
                    continue
                if entry.suffix.lower() not in ALL_MEDIA_EXTS:
                    continue

                rel = entry.relative_to(output_dir)
                rel_str = str(rel)

                # Skip duplicates
                if rel_str in seen_paths:
                    continue
                seen_paths.add(rel_str)

                # For non-admin users, skip files inside OTHER users' dirs
                if not is_admin:
                    parts = rel.parts
                    if len(parts) > 1 and parts[0] in user_dirs and parts[0] != username:
                        continue

                # For admin with user_filter, only show that user's subfolder
                if is_admin and user_filter:
                    rel_parts = rel.parts
                    if not rel_parts or rel_parts[0] != user_filter:
                        continue

                # Apply search filter
                if search and search not in entry.name.lower():
                    continue

                # Apply type filter
                ext = entry.suffix.lower()
                if type_filter == "image" and ext not in IMAGE_EXTS:
                    continue
                if type_filter == "video" and ext not in VIDEO_EXTS:
                    continue

                files.append(_file_info(entry, output_dir))

        # Sort
        if sort == "oldest":
            files.sort(key=lambda f: f["modified"])
        elif sort == "name":
            files.sort(key=lambda f: f["filename"].lower())
        else:  # newest
            files.sort(key=lambda f: f["modified"], reverse=True)

        # Paginate
        total = len(files)
        start = (page - 1) * per_page
        end = start + per_page
        page_files = files[start:end]

        return web.json_response({
            "files": page_files,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": (total + per_page - 1) // per_page if total else 0,
        })

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs/users
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/users")
    async def list_output_users(request: web.Request):
        """List usernames that have output subfolders (admin only)."""
        user = request.get("multiuser_user")
        if not user or not user.get("is_admin"):
            return web.json_response({"error": "Admin access required"}, status=403)

        output_dir = _get_output_dir()
        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_set = {u["username"] for u in all_users}

        result = []
        if output_dir.exists():
            for entry in sorted(output_dir.iterdir()):
                if entry.is_dir() and entry.name in user_set:
                    # Count files in this user's dir
                    count = sum(
                        1 for f in entry.rglob("*")
                        if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTS
                    )
                    result.append({"username": entry.name, "file_count": count})

        # Also count shared/root files
        root_count = sum(
            1 for f in output_dir.iterdir()
            if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTS
        ) if output_dir.exists() else 0
        if root_count:
            result.insert(0, {"username": "(shared)", "file_count": root_count})

        return web.json_response({"users": result})

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs/thumbnail
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/thumbnail")
    async def get_thumbnail(request: web.Request):
        """Generate and serve a thumbnail for an output image.

        Query params:
            filename    (str)   Filename
            subfolder   (str)   Subfolder within output dir
            size        (int)   Max dimension, default 256
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        size = min(max(64, int(request.query.get("size", 256))), 512)

        if not filename:
            return web.json_response({"error": "filename required"}, status=400)

        output_dir = _get_output_dir()
        if subfolder:
            file_path = output_dir / subfolder / filename
        else:
            file_path = output_dir / filename

        # Security: resolve and verify it's within output_dir
        try:
            file_path = file_path.resolve()
            if not str(file_path).startswith(str(output_dir.resolve())):
                return web.json_response({"error": "Invalid path"}, status=400)
        except (ValueError, OSError):
            return web.json_response({"error": "Invalid path"}, status=400)

        if not file_path.exists() or not file_path.is_file():
            return web.json_response({"error": "File not found"}, status=404)

        # Access check: non-admin can only access own subfolder or shared root
        if not user.get("is_admin"):
            username = user["username"]
            rel = file_path.relative_to(output_dir.resolve())
            parts = rel.parts
            if len(parts) > 1:
                db = await get_db()
                top = parts[0]
                owner = await db.fetchone(
                    "SELECT id FROM users WHERE username = ?", (top,)
                )
                if owner and top != username:
                    return web.json_response({"error": "Access denied"}, status=403)

        ext = file_path.suffix.lower()

        # Video files — return a placeholder or let ComfyUI handle it
        if ext in VIDEO_EXTS:
            # Return a 1x1 transparent PNG as placeholder for videos
            return web.Response(
                status=200,
                content_type="image/png",
                body=b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01'
                     b'\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89'
                     b'\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01'
                     b'\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82',
            )

        if not _HAS_PIL or ext not in IMAGE_EXTS:
            # Fallback: redirect to ComfyUI's /view endpoint
            qs = f"filename={filename}&type=output"
            if subfolder:
                qs += f"&subfolder={subfolder}"
            raise web.HTTPFound(f"/view?{qs}")

        # Generate / serve from cache
        cache_dir = _get_thumb_cache_dir()
        stat = file_path.stat()
        cache_key = hashlib.md5(
            f"{file_path}:{stat.st_mtime}:{size}".encode()
        ).hexdigest()
        cache_path = cache_dir / f"{cache_key}.webp"

        if not cache_path.exists():
            try:
                img = Image.open(file_path)
                img.thumbnail((size, size), Image.LANCZOS)
                img.save(cache_path, "WEBP", quality=80)
            except Exception as e:
                logger.warning("Thumbnail generation failed for %s: %s", filename, e)
                qs = f"filename={filename}&type=output"
                if subfolder:
                    qs += f"&subfolder={subfolder}"
                raise web.HTTPFound(f"/view?{qs}")

        return web.FileResponse(cache_path, headers={
            "Content-Type": "image/webp",
            "Cache-Control": "public, max-age=86400",
        })

    # ------------------------------------------------------------------
    #  DELETE /multiuser/outputs/file
    # ------------------------------------------------------------------
    @routes.delete("/multiuser/outputs/file")
    async def delete_output_file(request: web.Request):
        """Delete an output file (own files or admin).

        Query params:
            filename    (str)
            subfolder   (str)
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")

        if not filename:
            return web.json_response({"error": "filename required"}, status=400)

        output_dir = _get_output_dir()
        if subfolder:
            file_path = output_dir / subfolder / filename
        else:
            file_path = output_dir / filename

        try:
            file_path = file_path.resolve()
            if not str(file_path).startswith(str(output_dir.resolve())):
                return web.json_response({"error": "Invalid path"}, status=400)
        except (ValueError, OSError):
            return web.json_response({"error": "Invalid path"}, status=400)

        if not file_path.exists():
            return web.json_response({"error": "File not found"}, status=404)

        # Access check
        if not user.get("is_admin"):
            username = user["username"]
            rel = file_path.relative_to(output_dir.resolve())
            parts = rel.parts
            if len(parts) > 1:
                top = parts[0]
                if top != username:
                    return web.json_response({"error": "Access denied"}, status=403)
            else:
                # Root-level file — non-admin can't delete shared files
                return web.json_response(
                    {"error": "Cannot delete shared files"}, status=403
                )

        try:
            file_path.unlink()
            logger.info("User %s deleted output: %s", user["username"], file_path)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)

        return web.json_response({"success": True})
