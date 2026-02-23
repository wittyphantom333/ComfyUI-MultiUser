"""Output-file browsing routes with per-user isolation.

Provides a REST API that scans ComfyUI's output directory and returns file
listings scoped to the requesting user.  Admins can view all outputs or
filter by username.

Features:
  - Paginated file listing with user-scoping (non-admin sees ONLY own files)
  - Thumbnail generation (Pillow for images, ffmpeg for video first-frame)
  - Per-user tagging system
  - Per-user 0-5 star rating system
  - PNG/EXIF metadata extraction and viewing
"""
import hashlib
import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

from aiohttp import web

from ..config import get_config, get_base_dir
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.outputs.routes")

# Supported image/video extensions
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

# Optional Pillow import for thumbnail generation
try:
    from PIL import Image
    from PIL.ExifTags import TAGS as EXIF_TAGS
    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False
    EXIF_TAGS = {}
    logger.info("Pillow not available — thumbnail generation disabled")

# Check for ffmpeg (video thumbnails)
_HAS_FFMPEG = shutil.which("ffmpeg") is not None
if not _HAS_FFMPEG:
    logger.info("ffmpeg not found — video thumbnail generation disabled")


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------

def _get_output_dir() -> Path:
    """Resolve ComfyUI's output directory."""
    try:
        import folder_paths  # ComfyUI built-in
        return Path(folder_paths.get_output_directory())
    except (ImportError, AttributeError):
        return Path("output").resolve()


def _get_thumb_cache_dir() -> Path:
    """Get/create the thumbnail cache directory."""
    cache = get_base_dir() / "data" / "thumb_cache"
    cache.mkdir(parents=True, exist_ok=True)
    return cache


def _resolve_file(output_dir: Path, filename: str, subfolder: str) -> Optional[Path]:
    """Safely resolve a file path within the output directory."""
    if subfolder:
        file_path = output_dir / subfolder / filename
    else:
        file_path = output_dir / filename
    try:
        file_path = file_path.resolve()
        if not str(file_path).startswith(str(output_dir.resolve())):
            return None
    except (ValueError, OSError):
        return None
    if not file_path.exists() or not file_path.is_file():
        return None
    return file_path


def _check_access(user: dict, file_path: Path, output_dir: Path, user_dirs: set) -> bool:
    """Return True if the user may access this file."""
    if user.get("is_admin"):
        return True
    rel = file_path.relative_to(output_dir.resolve())
    parts = rel.parts
    if len(parts) <= 1:
        return True  # root-level = shared/legacy
    top = parts[0]
    if top == user["username"]:
        return True
    if top in user_dirs:
        return False  # another user's folder
    return True  # unknown subfolder, treat as shared


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
        # Try extracting a frame at 1 second
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
            # Retry at t=0 for very short clips
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


def _read_png_metadata(file_path: Path) -> dict:
    """Read PNG tEXt/iTXt chunks for ComfyUI workflow metadata."""
    meta = {}
    if not _HAS_PIL:
        return meta
    try:
        img = Image.open(file_path)
        info = img.info or {}
        # ComfyUI stores workflow data in PNG text chunks
        for key in ("prompt", "workflow", "parameters"):
            if key in info:
                val = info[key]
                try:
                    meta[key] = json.loads(val)
                except (json.JSONDecodeError, TypeError):
                    meta[key] = val
        # Grab other text keys
        for key, val in info.items():
            if key not in meta and isinstance(val, str) and len(val) < 50000:
                meta[key] = val
        meta["_dimensions"] = f"{img.width}x{img.height}"
        meta["_mode"] = img.mode
    except Exception as e:
        logger.debug("PNG metadata failed for %s: %s", file_path.name, e)
    return meta


def _read_image_metadata(file_path: Path) -> dict:
    """Read metadata from any image (EXIF for JPEGs, PNG chunks, etc)."""
    ext = file_path.suffix.lower()
    if ext == ".png":
        return _read_png_metadata(file_path)
    if not _HAS_PIL:
        return {}
    meta = {}
    try:
        img = Image.open(file_path)
        meta["_dimensions"] = f"{img.width}x{img.height}"
        meta["_mode"] = img.mode
        if ext in (".jpg", ".jpeg", ".tiff"):
            exif = img.getexif()
            if exif:
                for tag_id, value in exif.items():
                    name = EXIF_TAGS.get(tag_id, str(tag_id))
                    if isinstance(value, (bytes, bytearray)):
                        continue
                    if isinstance(value, str) and len(value) > 1000:
                        continue
                    meta[name] = str(value)
        if ext == ".webp":
            for k, v in (img.info or {}).items():
                if isinstance(v, str) and len(v) < 5000:
                    meta[k] = v
    except Exception as e:
        logger.debug("Metadata failed for %s: %s", file_path.name, e)
    return meta


def _read_video_metadata(file_path: Path) -> dict:
    """Read video metadata using ffprobe."""
    meta = {}
    if not _HAS_FFMPEG:
        return meta
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_format", "-show_streams",
                str(file_path),
            ],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0 and result.stdout:
            data = json.loads(result.stdout)
            fmt = data.get("format", {})
            meta["_duration"] = fmt.get("duration", "unknown")
            meta["_format"] = fmt.get("format_long_name", fmt.get("format_name", ""))
            meta["_bitrate"] = fmt.get("bit_rate", "")
            for stream in data.get("streams", []):
                if stream.get("codec_type") == "video":
                    meta["_dimensions"] = f"{stream.get('width', '?')}x{stream.get('height', '?')}"
                    meta["_codec"] = stream.get("codec_long_name", stream.get("codec_name", ""))
                    meta["_fps"] = stream.get("r_frame_rate", "")
                    break
    except Exception as e:
        logger.debug("Video metadata failed for %s: %s", file_path.name, e)
    return meta


# ---------------------------------------------------------------------------
#  Route setup
# ---------------------------------------------------------------------------

def setup_output_routes(routes):
    """Register output-browsing routes under /multiuser/outputs."""

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs")
    async def list_outputs(request: web.Request):
        """List output files visible to the current user.

        Query params:
            page, per_page, sort, search, type, user, tag, min_rating
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
        user_id = user["id"]

        page = max(1, int(request.query.get("page", 1)))
        per_page = min(max(1, int(request.query.get("per_page", 50))), 500)
        sort = request.query.get("sort", "newest")
        search = request.query.get("search", "").strip().lower()
        type_filter = request.query.get("type", "all")
        tag_filter = request.query.get("tag", "").strip().title()
        min_rating = int(request.query.get("min_rating", 0))

        db = await get_db()

        # ── Collect files with STRICT scoping ──
        # EVERY user (admin or not) only sees their own subfolder here.
        # Admins use the separate /outputs/all endpoint for cross-user browsing.
        files: list[dict] = []
        logger.debug(
            "list_outputs: user=%s is_admin=%s output_dir=%s",
            username, is_admin, output_dir,
        )

        user_dir = output_dir / username
        if user_dir.is_dir():
            for entry in user_dir.rglob("*"):
                if entry.is_file() and entry.suffix.lower() in ALL_MEDIA_EXTS:
                    files.append(_file_info(entry, output_dir))

        logger.debug(
            "list_outputs: user=%s found %d files before filters",
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

        # ── Load tags + ratings from DB ──
        file_paths = [f["relative_path"] for f in files]
        tags_map: dict[str, list[str]] = {}
        ratings_map: dict[str, int] = {}

        if file_paths:
            placeholders = ", ".join("?" for _ in file_paths)
            tag_rows = await db.fetchall(
                f"SELECT file_path, tag FROM output_tags WHERE user_id = ? AND file_path IN ({placeholders})",
                (user_id, *file_paths),
            )
            for row in tag_rows:
                tags_map.setdefault(row["file_path"], []).append(row["tag"])

            rating_rows = await db.fetchall(
                f"SELECT file_path, rating FROM output_ratings WHERE user_id = ? AND file_path IN ({placeholders})",
                (user_id, *file_paths),
            )
            for row in rating_rows:
                ratings_map[row["file_path"]] = row["rating"]

        for f in files:
            rp = f["relative_path"]
            f["tags"] = tags_map.get(rp, [])
            f["rating"] = ratings_map.get(rp, 0)

        # Apply tag filter
        if tag_filter:
            files = [f for f in files if tag_filter in [t.lower() for t in f["tags"]]]

        # Apply rating filter
        if min_rating > 0:
            files = [f for f in files if f["rating"] >= min_rating]

        # Sort
        if sort == "oldest":
            files.sort(key=lambda f: f["modified"])
        elif sort == "name":
            files.sort(key=lambda f: f["filename"].lower())
        elif sort == "rating":
            files.sort(key=lambda f: (-f["rating"], -f["modified"]))
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
    #  GET /multiuser/outputs/all  —  admin cross-user browser
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/all")
    async def list_all_outputs(request: web.Request):
        """Admin-only: list output files across ALL users.

        Query params:
            page, per_page, sort, search, type, user, tag, min_rating
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)
        if not user.get("is_admin"):
            return web.json_response({"error": "Admin access required"}, status=403)

        output_dir = _get_output_dir()
        if not output_dir.exists():
            return web.json_response({
                "files": [], "total": 0, "page": 1, "per_page": 50, "pages": 0,
            })

        user_id = user["id"]

        page = max(1, int(request.query.get("page", 1)))
        per_page = min(max(1, int(request.query.get("per_page", 50))), 500)
        sort = request.query.get("sort", "newest")
        search = request.query.get("search", "").strip().lower()
        type_filter = request.query.get("type", "all")
        user_filter = request.query.get("user", "").strip()
        tag_filter = request.query.get("tag", "").strip().title()
        min_rating = int(request.query.get("min_rating", 0))

        db = await get_db()

        # ── Collect files across all users or a specific user ──
        files: list[dict] = []

        if user_filter:
            target_dir = output_dir / user_filter
            if target_dir.is_dir():
                for entry in target_dir.rglob("*"):
                    if entry.is_file() and entry.suffix.lower() in ALL_MEDIA_EXTS:
                        files.append(_file_info(entry, output_dir))
        else:
            for entry in output_dir.rglob("*"):
                if entry.is_file() and entry.suffix.lower() in ALL_MEDIA_EXTS:
                    files.append(_file_info(entry, output_dir))

        # Apply search filter
        if search:
            files = [f for f in files if search in f["filename"].lower()]

        # Apply type filter
        if type_filter == "image":
            files = [f for f in files if f["type"] == "image"]
        elif type_filter == "video":
            files = [f for f in files if f["type"] == "video"]

        # ── Load tags + ratings from DB ──
        file_paths = [f["relative_path"] for f in files]
        tags_map: dict[str, list[str]] = {}
        ratings_map: dict[str, int] = {}

        if file_paths:
            placeholders = ", ".join("?" for _ in file_paths)
            tag_rows = await db.fetchall(
                f"SELECT file_path, tag FROM output_tags WHERE user_id = ? AND file_path IN ({placeholders})",
                (user_id, *file_paths),
            )
            for row in tag_rows:
                tags_map.setdefault(row["file_path"], []).append(row["tag"])

            rating_rows = await db.fetchall(
                f"SELECT file_path, rating FROM output_ratings WHERE user_id = ? AND file_path IN ({placeholders})",
                (user_id, *file_paths),
            )
            for row in rating_rows:
                ratings_map[row["file_path"]] = row["rating"]

        for f in files:
            rp = f["relative_path"]
            f["tags"] = tags_map.get(rp, [])
            f["rating"] = ratings_map.get(rp, 0)

        # Apply tag filter
        if tag_filter:
            files = [f for f in files if tag_filter in [t.lower() for t in f["tags"]]]

        # Apply rating filter
        if min_rating > 0:
            files = [f for f in files if f["rating"] >= min_rating]

        # Sort
        if sort == "oldest":
            files.sort(key=lambda f: f["modified"])
        elif sort == "name":
            files.sort(key=lambda f: f["filename"].lower())
        elif sort == "rating":
            files.sort(key=lambda f: (-f["rating"], -f["modified"]))
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
    #  GET /multiuser/outputs/users
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/users")
    async def list_output_users(request: web.Request):
        """List usernames with output subfolders (admin only)."""
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
                    count = sum(
                        1 for f in entry.rglob("*")
                        if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTS
                    )
                    result.append({"username": entry.name, "file_count": count})

            root_count = sum(
                1 for f in output_dir.iterdir()
                if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTS
            )
            if root_count:
                result.insert(0, {"username": "(shared)", "file_count": root_count})

        return web.json_response({"users": result})

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs/thumbnail
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/thumbnail")
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

        output_dir = _get_output_dir()
        file_path = _resolve_file(output_dir, filename, subfolder)
        if not file_path:
            return web.json_response({"error": "File not found"}, status=404)

        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}
        if not _check_access(user, file_path, output_dir, user_dirs):
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
            qs = f"filename={filename}&type=output"
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
    #  GET /multiuser/outputs/metadata
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/metadata")
    async def get_metadata(request: web.Request):
        """Return embedded metadata (PNG chunks, EXIF, ffprobe)."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        if not filename:
            return web.json_response({"error": "filename required"}, status=400)

        output_dir = _get_output_dir()
        file_path = _resolve_file(output_dir, filename, subfolder)
        if not file_path:
            return web.json_response({"error": "File not found"}, status=404)

        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}
        if not _check_access(user, file_path, output_dir, user_dirs):
            return web.json_response({"error": "Access denied"}, status=403)

        ext = file_path.suffix.lower()
        stat = file_path.stat()
        meta = {
            "filename": file_path.name,
            "size": stat.st_size,
            "modified": stat.st_mtime,
            "extension": ext,
        }
        if ext in VIDEO_EXTS:
            meta["embedded"] = _read_video_metadata(file_path)
        elif ext in IMAGE_EXTS:
            meta["embedded"] = _read_image_metadata(file_path)
        else:
            meta["embedded"] = {}

        return web.json_response(meta)

    # ------------------------------------------------------------------
    #  POST /multiuser/outputs/tags  —  add tags
    # ------------------------------------------------------------------
    @routes.post("/multiuser/outputs/tags")
    async def add_tags(request: web.Request):
        """Add tags to a file.  Body: { file_path, tags: [...] }"""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        body = await request.json()
        file_path_str = body.get("file_path", "").strip()
        tags = body.get("tags", [])
        if not file_path_str or not tags:
            return web.json_response({"error": "file_path and tags required"}, status=400)

        output_dir = _get_output_dir()
        full_path = (output_dir / file_path_str).resolve()
        if not str(full_path).startswith(str(output_dir.resolve())) or not full_path.exists():
            return web.json_response({"error": "File not found"}, status=404)

        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}
        if not _check_access(user, full_path, output_dir, user_dirs):
            return web.json_response({"error": "Access denied"}, status=403)

        clean_tags = list({t.strip().title() for t in tags if t.strip()})
        for tag in clean_tags:
            await db.execute(
                "INSERT OR IGNORE INTO output_tags (user_id, file_path, tag) VALUES (?, ?, ?)",
                (user["id"], file_path_str, tag),
            )
        return web.json_response({"success": True, "tags": clean_tags})

    # ------------------------------------------------------------------
    #  DELETE /multiuser/outputs/tags  —  remove a tag
    # ------------------------------------------------------------------
    @routes.delete("/multiuser/outputs/tags")
    async def remove_tag(request: web.Request):
        """Remove a tag.  Query: file_path, tag"""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        file_path_str = request.query.get("file_path", "").strip()
        tag = request.query.get("tag", "").strip().title()
        if not file_path_str or not tag:
            return web.json_response({"error": "file_path and tag required"}, status=400)

        db = await get_db()
        await db.execute(
            "DELETE FROM output_tags WHERE user_id = ? AND file_path = ? AND tag = ?",
            (user["id"], file_path_str, tag),
        )
        return web.json_response({"success": True})

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs/tags  —  all user tags (autocomplete)
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/tags")
    async def list_tags(request: web.Request):
        """List all distinct tags for this user."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        db = await get_db()
        rows = await db.fetchall(
            "SELECT DISTINCT tag FROM output_tags WHERE user_id = ? ORDER BY tag",
            (user["id"],),
        )
        return web.json_response({"tags": [r["tag"] for r in rows]})

    # ------------------------------------------------------------------
    #  PUT /multiuser/outputs/rating  —  set rating (0-5)
    # ------------------------------------------------------------------
    @routes.put("/multiuser/outputs/rating")
    async def set_rating(request: web.Request):
        """Set 0-5 rating.  Body: { file_path, rating }"""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        body = await request.json()
        file_path_str = body.get("file_path", "").strip()
        rating = int(body.get("rating", 0))
        if not file_path_str:
            return web.json_response({"error": "file_path required"}, status=400)
        if rating < 0 or rating > 5:
            return web.json_response({"error": "rating must be 0-5"}, status=400)

        output_dir = _get_output_dir()
        full_path = (output_dir / file_path_str).resolve()
        if not str(full_path).startswith(str(output_dir.resolve())) or not full_path.exists():
            return web.json_response({"error": "File not found"}, status=404)

        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}
        if not _check_access(user, full_path, output_dir, user_dirs):
            return web.json_response({"error": "Access denied"}, status=403)

        user_id = user["id"]
        if rating == 0:
            await db.execute(
                "DELETE FROM output_ratings WHERE user_id = ? AND file_path = ?",
                (user_id, file_path_str),
            )
        else:
            existing = await db.fetchone(
                "SELECT id FROM output_ratings WHERE user_id = ? AND file_path = ?",
                (user_id, file_path_str),
            )
            if existing:
                await db.execute(
                    "UPDATE output_ratings SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (rating, existing["id"]),
                )
            else:
                await db.execute(
                    "INSERT INTO output_ratings (user_id, file_path, rating) VALUES (?, ?, ?)",
                    (user_id, file_path_str, rating),
                )

        return web.json_response({"success": True, "rating": rating})

    # ------------------------------------------------------------------
    #  DELETE /multiuser/outputs/file  —  delete file
    # ------------------------------------------------------------------
    @routes.delete("/multiuser/outputs/file")
    async def delete_output_file(request: web.Request):
        """Delete an output file (own files or admin)."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        if not filename:
            return web.json_response({"error": "filename required"}, status=400)

        output_dir = _get_output_dir()
        file_path = _resolve_file(output_dir, filename, subfolder)
        if not file_path:
            return web.json_response({"error": "File not found"}, status=404)

        if not user.get("is_admin"):
            rel = file_path.relative_to(output_dir.resolve())
            parts = rel.parts
            if len(parts) > 1:
                if parts[0] != user["username"]:
                    return web.json_response({"error": "Access denied"}, status=403)
            else:
                return web.json_response({"error": "Cannot delete shared files"}, status=403)

        rel_path = str(file_path.relative_to(output_dir.resolve()))
        try:
            file_path.unlink()
            logger.info("User %s deleted output: %s", user["username"], file_path)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)

        # Clean up DB records
        db = await get_db()
        await db.execute("DELETE FROM output_tags WHERE file_path = ?", (rel_path,))
        await db.execute("DELETE FROM output_ratings WHERE file_path = ?", (rel_path,))

        return web.json_response({"success": True})
