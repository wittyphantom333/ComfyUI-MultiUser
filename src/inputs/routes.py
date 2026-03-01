"""Input-file browsing routes with per-user isolation.

Provides a REST API that scans ComfyUI's input directory and returns file
listings scoped to the requesting user.  Admins can view all inputs or
filter by username.

Features:
  - Paginated file listing with user-scoping (non-admin sees ONLY own files)
  - Thumbnail generation (Pillow for images, ffmpeg for video first-frame)
  - Upload files directly into the user's input subfolder
  - Delete own input files
"""
import hashlib
import logging
import math
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from aiohttp import web

from ..config import get_config, get_base_dir
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.inputs.routes")

# Supported image/video extensions
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

# Optional Pillow import for thumbnail generation
try:
    from PIL import Image
    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False
    logger.info("Pillow not available — thumbnail generation disabled")

# Check for ffmpeg (video thumbnails)
_HAS_FFMPEG = shutil.which("ffmpeg") is not None
if not _HAS_FFMPEG:
    logger.info("ffmpeg not found — video thumbnail generation disabled")


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------

def _get_input_dir() -> Path:
    """Resolve ComfyUI's input directory."""
    try:
        import folder_paths  # ComfyUI built-in
        return Path(folder_paths.get_input_directory())
    except (ImportError, AttributeError):
        return Path("input").resolve()


def _get_thumb_cache_dir() -> Path:
    """Get/create the thumbnail cache directory for inputs."""
    cache = get_base_dir() / "data" / "input_thumb_cache"
    cache.mkdir(parents=True, exist_ok=True)
    return cache


def _resolve_file(input_dir: Path, filename: str, subfolder: str) -> Optional[Path]:
    """Safely resolve a file path within the input directory."""
    if subfolder:
        file_path = input_dir / subfolder / filename
    else:
        file_path = input_dir / filename
    try:
        file_path = file_path.resolve()
        if not str(file_path).startswith(str(input_dir.resolve())):
            return None
    except (ValueError, OSError):
        return None
    if not file_path.exists() or not file_path.is_file():
        return None
    return file_path


def _check_access(user: dict, file_path: Path, input_dir: Path, user_dirs: set) -> bool:
    """Return True if the user may access this file."""
    if user.get("is_admin"):
        return True
    rel = file_path.relative_to(input_dir.resolve())
    parts = rel.parts
    if len(parts) <= 1:
        return True  # root-level = shared/legacy
    top = parts[0]
    if top == user["username"]:
        return True
    if top in user_dirs:
        return False  # another user's folder
    return True  # unknown subfolder, treat as shared


def _file_info(path: Path, input_dir: Path) -> dict:
    """Build a metadata dict for a single file."""
    rel = path.relative_to(input_dir)
    stat = path.stat()
    ext = path.suffix.lower()
    mtime = stat.st_mtime
    if math.isnan(mtime) or math.isinf(mtime):
        mtime = 0.0
    return {
        "filename": path.name,
        "subfolder": str(rel.parent) if str(rel.parent) != "." else "",
        "relative_path": str(rel),
        "size": stat.st_size,
        "modified": mtime,
        "type": "video" if ext in VIDEO_EXTS else "image",
        "format": ext.lstrip(".").upper(),
    }


def _generate_image_thumbnail(src: Path, dst: Path, size: int) -> bool:
    """Generate an image thumbnail using Pillow. Returns True on success."""
    if not _HAS_PIL:
        return False
    try:
        img = Image.open(src)
        img.thumbnail((size, size), Image.LANCZOS)
        img.save(dst, "WEBP", quality=80)
        return True
    except Exception as e:
        logger.debug("Image thumbnail failed for %s: %s", src.name, e)
        return False


def _generate_video_thumbnail(src: Path, dst: Path, size: int) -> bool:
    """Extract a frame from a video using ffmpeg and convert to WebP thumbnail."""
    if not _HAS_FFMPEG:
        return False
    try:
        tmp_frame = dst.with_suffix(".tmp.png")
        subprocess.run(
            [
                "ffmpeg", "-y", "-ss", "1",
                "-i", str(src),
                "-vframes", "1",
                "-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease",
                str(tmp_frame),
            ],
            capture_output=True, timeout=15,
        )
        if not tmp_frame.exists():
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", str(src),
                    "-vframes", "1",
                    "-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease",
                    str(tmp_frame),
                ],
                capture_output=True, timeout=15,
            )
        if tmp_frame.exists():
            if _HAS_PIL:
                img = Image.open(tmp_frame)
                img.save(dst, "WEBP", quality=80)
                tmp_frame.unlink(missing_ok=True)
            else:
                tmp_frame.rename(dst)
            return True
    except Exception as e:
        logger.debug("Video thumbnail failed for %s: %s", src.name, e)
    return False


# ---------------------------------------------------------------------------
#  Route setup
# ---------------------------------------------------------------------------

def setup_input_routes(routes):
    """Register input-browsing routes under /multiuser/inputs."""

    # ------------------------------------------------------------------
    #  GET /multiuser/inputs
    # ------------------------------------------------------------------
    @routes.get("/multiuser/inputs")
    async def list_inputs(request: web.Request):
        """List input files visible to the current user.

        Query params:
            page, per_page, sort, search, type
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        input_dir = _get_input_dir()
        if not input_dir.exists():
            return web.json_response({
                "files": [], "total": 0, "page": 1, "per_page": 50, "pages": 0,
            })

        username = user["username"]

        page = max(1, int(request.query.get("page", 1)))
        per_page = min(max(1, int(request.query.get("per_page", 50))), 500)
        sort = request.query.get("sort", "newest")
        search = request.query.get("search", "").strip().lower()
        type_filter = request.query.get("type", "all")

        # ── Collect files with STRICT scoping ──
        # EVERY user (admin or not) only sees their own subfolder here.
        # Admins use the separate /inputs/all endpoint for cross-user browsing.
        files: list[dict] = []

        user_dir = input_dir / username
        # Auto-create the user's input dir so they have somewhere to upload
        user_dir.mkdir(parents=True, exist_ok=True)

        if user_dir.is_dir():
            for entry in user_dir.rglob("*"):
                if entry.is_file() and entry.suffix.lower() in ALL_MEDIA_EXTS:
                    files.append(_file_info(entry, input_dir))

        logger.info(
            "list_inputs: user=%s found %d files before filters",
            username, len(files),
        )

        # Apply search filter
        if search:
            files = [f for f in files if search in f["filename"].lower()]

        # Apply type filter
        if type_filter == "image":
            files = [f for f in files if f["type"] == "image"]
        elif type_filter == "video":
            files = [f for f in files if f["type"] == "video"]

        # Sort
        if sort == "oldest":
            files.sort(key=lambda f: f["modified"])
        elif sort == "name":
            files.sort(key=lambda f: f["filename"].lower())
        else:
            files.sort(key=lambda f: f["modified"], reverse=True)

        # Paginate
        total = len(files)
        start = (page - 1) * per_page
        page_files = files[start:start + per_page]

        return web.json_response({
            "files": page_files,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": (total + per_page - 1) // per_page if total else 0,
        })

    # ------------------------------------------------------------------
    #  GET /multiuser/inputs/all  —  admin cross-user browser
    # ------------------------------------------------------------------
    @routes.get("/multiuser/inputs/all")
    async def list_all_inputs(request: web.Request):
        """Admin-only: list input files across ALL users.

        Query params:
            page, per_page, sort, search, type, user
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)
        if not user.get("is_admin"):
            return web.json_response({"error": "Admin access required"}, status=403)

        input_dir = _get_input_dir()
        if not input_dir.exists():
            return web.json_response({
                "files": [], "total": 0, "page": 1, "per_page": 50, "pages": 0,
            })

        page = max(1, int(request.query.get("page", 1)))
        per_page = min(max(1, int(request.query.get("per_page", 50))), 500)
        sort = request.query.get("sort", "newest")
        search = request.query.get("search", "").strip().lower()
        type_filter = request.query.get("type", "all")
        user_filter = request.query.get("user", "").strip()

        files: list[dict] = []

        if user_filter:
            target_dir = input_dir / user_filter
            if target_dir.is_dir():
                for entry in target_dir.rglob("*"):
                    if entry.is_file() and entry.suffix.lower() in ALL_MEDIA_EXTS:
                        files.append(_file_info(entry, input_dir))
        else:
            for entry in input_dir.rglob("*"):
                if entry.is_file() and entry.suffix.lower() in ALL_MEDIA_EXTS:
                    files.append(_file_info(entry, input_dir))

        # Apply search filter
        if search:
            files = [f for f in files if search in f["filename"].lower()]

        # Apply type filter
        if type_filter == "image":
            files = [f for f in files if f["type"] == "image"]
        elif type_filter == "video":
            files = [f for f in files if f["type"] == "video"]

        # Sort
        if sort == "oldest":
            files.sort(key=lambda f: f["modified"])
        elif sort == "name":
            files.sort(key=lambda f: f["filename"].lower())
        else:
            files.sort(key=lambda f: f["modified"], reverse=True)

        # Paginate
        total = len(files)
        start = (page - 1) * per_page
        page_files = files[start:start + per_page]

        return web.json_response({
            "files": page_files,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": (total + per_page - 1) // per_page if total else 0,
        })

    # ------------------------------------------------------------------
    #  GET /multiuser/inputs/users
    # ------------------------------------------------------------------
    @routes.get("/multiuser/inputs/users")
    async def list_input_users(request: web.Request):
        """List usernames with input subfolders (admin only)."""
        user = request.get("multiuser_user")
        if not user or not user.get("is_admin"):
            return web.json_response({"error": "Admin access required"}, status=403)

        input_dir = _get_input_dir()
        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_set = {u["username"] for u in all_users}

        result = []
        if input_dir.exists():
            for entry in sorted(input_dir.iterdir()):
                if entry.is_dir() and entry.name in user_set:
                    count = sum(
                        1 for f in entry.rglob("*")
                        if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTS
                    )
                    result.append({"username": entry.name, "file_count": count})

            root_count = sum(
                1 for f in input_dir.iterdir()
                if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTS
            )
            if root_count:
                result.insert(0, {"username": "(shared)", "file_count": root_count})

        return web.json_response({"users": result})

    # ------------------------------------------------------------------
    #  GET /multiuser/inputs/thumbnail
    # ------------------------------------------------------------------
    @routes.get("/multiuser/inputs/thumbnail")
    async def get_thumbnail(request: web.Request):
        """Generate and serve a cached thumbnail (images + videos)."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        size = min(max(64, int(request.query.get("size", 256))), 512)

        if not filename:
            return web.json_response({"error": "filename required"}, status=400)

        input_dir = _get_input_dir()
        file_path = _resolve_file(input_dir, filename, subfolder)
        if not file_path:
            return web.json_response({"error": "File not found"}, status=404)

        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}
        if not _check_access(user, file_path, input_dir, user_dirs):
            return web.json_response({"error": "Access denied"}, status=403)

        ext = file_path.suffix.lower()
        stat = file_path.stat()
        cache_dir = _get_thumb_cache_dir()
        cache_key = hashlib.md5(
            f"{file_path}:{stat.st_mtime}:{size}".encode()
        ).hexdigest()
        cache_path = cache_dir / f"{cache_key}.webp"

        if cache_path.exists():
            return web.FileResponse(cache_path, headers={
                "Content-Type": "image/webp",
                "Cache-Control": "public, max-age=86400",
            })

        # Generate
        success = False
        if ext in VIDEO_EXTS:
            success = _generate_video_thumbnail(file_path, cache_path, size)
        elif ext in IMAGE_EXTS:
            success = _generate_image_thumbnail(file_path, cache_path, size)

        if success and cache_path.exists():
            return web.FileResponse(cache_path, headers={
                "Content-Type": "image/webp",
                "Cache-Control": "public, max-age=86400",
            })

        # Fallback
        if ext in IMAGE_EXTS:
            qs = f"filename={filename}&type=input"
            if subfolder:
                qs += f"&subfolder={subfolder}"
            raise web.HTTPFound(f"/view?{qs}")

        # Video with no ffmpeg — simple placeholder
        return web.Response(
            status=200,
            content_type="image/png",
            body=b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01'
                 b'\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde'
                 b'\x00\x00\x00\x0cIDATx\x9cc```\x00\x00\x00\x04\x00\x01'
                 b'\xf6\x178\x00\x00\x00\x00IEND\xaeB`\x82',
        )

    # ------------------------------------------------------------------
    #  POST /multiuser/inputs/upload  —  upload file to user's input dir
    # ------------------------------------------------------------------
    @routes.post("/multiuser/inputs/upload")
    async def upload_input(request: web.Request):
        """Upload a file to the user's input subfolder.

        Accepts multipart/form-data with field 'file'.
        Optional field 'subfolder' for extra nesting within user dir.
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        username = user["username"]
        input_dir = _get_input_dir()
        user_dir = input_dir / username
        user_dir.mkdir(parents=True, exist_ok=True)

        try:
            reader = await request.multipart()
        except Exception:
            return web.json_response({"error": "Expected multipart form data"}, status=400)

        filename = None
        subfolder_extra = ""
        file_data = None

        async for part in reader:
            if part.name == "file":
                filename = part.filename
                file_data = await part.read(decode=False)
            elif part.name == "subfolder":
                subfolder_extra = (await part.text()).strip()

        if not filename or not file_data:
            return web.json_response({"error": "No file provided"}, status=400)

        # Sanitize filename
        safe_name = Path(filename).name
        if not safe_name:
            return web.json_response({"error": "Invalid filename"}, status=400)

        # Check extension
        ext = Path(safe_name).suffix.lower()
        if ext not in ALL_MEDIA_EXTS:
            return web.json_response(
                {"error": f"Unsupported file type: {ext}. Allowed: {', '.join(sorted(ALL_MEDIA_EXTS))}"},
                status=400,
            )

        # Build target directory
        target_dir = user_dir
        if subfolder_extra:
            # Sanitize subfolder path
            safe_sub = Path(subfolder_extra)
            if safe_sub.is_absolute() or ".." in safe_sub.parts:
                return web.json_response({"error": "Invalid subfolder"}, status=400)
            target_dir = user_dir / safe_sub
            target_dir.mkdir(parents=True, exist_ok=True)

        # Avoid overwriting: append counter if file exists
        target_path = target_dir / safe_name
        if target_path.exists():
            stem = Path(safe_name).stem
            suffix = Path(safe_name).suffix
            counter = 1
            while target_path.exists():
                target_path = target_dir / f"{stem}_{counter}{suffix}"
                counter += 1

        target_path.write_bytes(file_data)
        rel = target_path.relative_to(input_dir)
        logger.info("User %s uploaded input: %s", username, rel)

        return web.json_response({
            "success": True,
            "filename": target_path.name,
            "subfolder": str(rel.parent) if str(rel.parent) != "." else "",
            "relative_path": str(rel),
        })

    # ------------------------------------------------------------------
    #  DELETE /multiuser/inputs/file  —  delete file
    # ------------------------------------------------------------------
    @routes.delete("/multiuser/inputs/file")
    async def delete_input_file(request: web.Request):
        """Delete an input file (own files or admin)."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        if not filename:
            return web.json_response({"error": "filename required"}, status=400)

        input_dir = _get_input_dir()
        file_path = _resolve_file(input_dir, filename, subfolder)
        if not file_path:
            return web.json_response({"error": "File not found"}, status=404)

        if not user.get("is_admin"):
            rel = file_path.relative_to(input_dir.resolve())
            parts = rel.parts
            if len(parts) > 1:
                if parts[0] != user["username"]:
                    return web.json_response({"error": "Access denied"}, status=403)
            else:
                return web.json_response({"error": "Cannot delete shared files"}, status=403)

        try:
            file_path.unlink()
            logger.info("User %s deleted input: %s", user["username"], file_path)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)

        return web.json_response({"success": True})

    # ------------------------------------------------------------------
    #  POST /multiuser/inputs/bulk/delete
    # ------------------------------------------------------------------
    @routes.post("/multiuser/inputs/bulk/delete")
    async def bulk_delete_files(request: web.Request):
        """Delete multiple input files.  Body: { files: [{filename, subfolder}, ...] }"""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        body = await request.json()
        items = body.get("files", [])
        if not items:
            return web.json_response({"error": "files required"}, status=400)

        input_dir = _get_input_dir()
        deleted = 0
        errors = []

        for item in items:
            filename = item.get("filename", "")
            subfolder = item.get("subfolder", "")
            if not filename:
                continue

            file_path = _resolve_file(input_dir, filename, subfolder)
            if not file_path:
                errors.append(f"{filename}: not found")
                continue

            # Access check
            if not user.get("is_admin"):
                rel = file_path.relative_to(input_dir.resolve())
                parts = rel.parts
                if len(parts) > 1:
                    if parts[0] != user["username"]:
                        errors.append(f"{filename}: access denied")
                        continue
                else:
                    errors.append(f"{filename}: cannot delete shared files")
                    continue

            try:
                file_path.unlink()
                deleted += 1
                logger.info("User %s bulk-deleted input: %s", user["username"], file_path)
            except OSError as e:
                errors.append(f"{filename}: {e}")
                continue

        result = {"success": True, "deleted": deleted}
        if errors:
            result["errors"] = errors
        return web.json_response(result)
