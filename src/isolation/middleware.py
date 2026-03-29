"""User-workspace isolation middleware.

Intercepts ComfyUI endpoints to:
  1. Route SaveImage outputs to per-user subdirectories.
  2. Filter /history to show only the authenticated user's executions.
  3. Filter /view (output image serving) to the user's own folder.
  4. Route /upload/image+mask into per-user input subdirectories.
  5. Filter /object_info so node dropdowns only list user's own input files.
"""
import json as json_mod
import logging
import os

from aiohttp import web

import server as comfyui_server  # ComfyUI's PromptServer module

from ..config import get_config

logger = logging.getLogger("comfyui-multiuser.isolation")

# ComfyUI may serve routes at /prompt or /api/prompt depending on version.
_PROMPT_PATHS = ("/prompt", "/prompt/", "/api/prompt", "/api/prompt/")
_HISTORY_PREFIXES = ("/history", "/api/history")
_VIEW_PATHS = ("/view", "/api/view")
_QUEUE_PATHS = ("/queue", "/queue/", "/api/queue", "/api/queue/")
_INTERRUPT_PATHS = ("/interrupt", "/interrupt/", "/api/interrupt", "/api/interrupt/")
_UPLOAD_PATHS = ("/upload/image", "/api/upload/image")
_OBJECT_INFO_PATHS = ("/object_info", "/object_info/", "/api/object_info", "/api/object_info/")
_INTERNAL_FILES_PATHS = ("/internal/files/input", "/internal/files/output")

# Headers to prevent browsers from caching error responses (404, 400, etc.)
_NO_CACHE_HEADERS = {"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}


def _is_enabled(key: str) -> bool:
    return bool(get_config("isolation", key, default=True))


def install_isolation_middleware(app: web.Application) -> None:
    """Install a middleware that enforces per-user workspace isolation."""

    @web.middleware
    async def isolation_middleware(request: web.Request, handler):
        user = request.get("multiuser_user")

        # ── 0. Block third-party asset-manager routes that bypass isolation ──
        if (
            request.path.startswith("/mjr/")
            and user
            and not user.get("is_admin")
            and _is_enabled("restrict_output_access")
        ):
            return web.json_response(
                {"error": "Use the built-in output browser. Third-party asset managers are restricted."},
                status=403,
            )

        # ── 1. Per-user output directory ──
        # Tag the prompt_server with the current username so the
        # on_prompt_handler (registered in __init__.py) can rewrite
        # filename_prefix before ComfyUI queues the prompt.
        if (
            request.method == "POST"
            and request.path in _PROMPT_PATHS
            and user
            and _is_enabled("per_user_outputs")
        ):
            username = user["username"]
            ps = comfyui_server.PromptServer.instance
            ps._mu_prompt_user = username
            print(f"[ISOLATION MW] POST {request.path} — tagged user={username}")
            logger.info("Isolation: tagged prompt user=%s on PromptServer", username)

        # ── 2. Restrict /history to user's own prompts ──
        if (
            request.method == "GET"
            and any(
                request.path == p or request.path.startswith(p + "/")
                for p in _HISTORY_PREFIXES
            )
            and user
            and not user.get("is_admin")
            and _is_enabled("restrict_history_access")
        ):
            # Single-prompt variant: /history/{prompt_id} or /api/history/{id}
            parts = request.path.rstrip("/").split("/")
            # parts for /history/xxx = ["", "history", xxx]
            # parts for /api/history/xxx = ["", "api", "history", xxx]
            prompt_id = parts[-1] if parts[-1] not in ("history", "api", "") else None
            if prompt_id:
                return await _filter_history_single(
                    request, handler, user, prompt_id
                )
            return await _filter_history(request, handler, user)

        # ── 3. Serve /view?type=input directly for user-subfolder files ──
        # ComfyUI's /view handler calls os.path.basename(filename), which
        # strips directory components.  Files like "witt/photo.png" get
        # looked up as just "photo.png" in the root input dir → 404.
        # Instead of trying to clone the request (fragile across aiohttp
        # versions), we serve input files directly when the filename
        # contains a path separator.  This also handles path splitting
        # for flat filenames with an explicit subfolder.
        #
        # ComfyUI convention: filenames can end with " [output]",
        # " [input]", or " [temp]" to indicate directory type.
        # The widget dropdown's "All" tab mixes input + output history
        # items.  When the frontend requests a thumbnail for an output
        # history item it sends  filename="photo.jpg [output]"&type=input.
        # We parse the suffix, strip it, and serve from the right dir.
        if (
            request.path in _VIEW_PATHS
            and request.method == "GET"
        ):
            raw_filename = request.query.get("filename", "")
            explicit_subfolder = request.query.get("subfolder", "")
            view_type = request.query.get("type", "output")

            # Parse ComfyUI's " [type]" suffix convention
            actual_type = view_type
            clean_filename = raw_filename
            import re as _re
            _type_suffix = _re.search(r'\s+\[(input|output|temp)\]\s*$', raw_filename)
            if _type_suffix:
                actual_type = _type_suffix.group(1)
                clean_filename = raw_filename[:_type_suffix.start()]

            if actual_type == "input" and clean_filename:
                return await _serve_input_file(request, clean_filename, explicit_subfolder)

            # " [output]" or " [temp]" suffix → serve from output/temp dir
            if actual_type in ("output", "temp") and clean_filename:
                return await _serve_output_file(request, clean_filename, actual_type, explicit_subfolder)

        # ── 3b. Restrict /view to user's own output subfolder ──
        if (
            request.path in _VIEW_PATHS
            and request.method == "GET"
            and user
            and not user.get("is_admin")
            and _is_enabled("restrict_output_access")
        ):
            return await _filter_view(request, handler, user)

        # ── 4. Restrict /queue to user's own jobs ──
        if (
            request.path in _QUEUE_PATHS
            and user
            and not user.get("is_admin")
            and _is_enabled("restrict_history_access")
        ):
            if request.method == "GET":
                return await _filter_queue(request, handler, user)
            elif request.method == "POST":
                return await _filter_queue_actions(request, handler, user)

        # ── 5. Restrict /interrupt to user's own running prompt ──
        if (
            request.path in _INTERRUPT_PATHS
            and request.method == "POST"
            and user
            and not user.get("is_admin")
            and _is_enabled("restrict_history_access")
        ):
            return await _filter_interrupt(request, handler, user)

        # ── 6. Per-user input uploads ──
        # Rewrite the subfolder in upload requests so files land in
        # input/{username}/{original_subfolder}/ instead of input/.
        # This applies to ALL users including admins — everyone gets their
        # own input subfolder.  Admins get extra *visibility* (can browse
        # all users' inputs), but their own uploads still go to their folder.
        if (
            request.method == "POST"
            and request.path in _UPLOAD_PATHS
            and user
            and _is_enabled("per_user_inputs")
        ):
            return await _rewrite_upload(request, handler, user)

        # ── 7. Filter /internal/files/{input,output} — ComfyUI's internal file API ──
        # Modern ComfyUI uses /internal/files/{type} to populate node dropdowns
        # (e.g. LoadImage uses /input, LoadImageOutput uses /output).
        # ComfyUI only lists root-level files by default, so user subfolder
        # files won't appear.  We intercept and return the full user-scoped list.
        if (
            request.method == "GET"
            and request.path in ("/internal/files/input", "/internal/files/output")
            and user
            and _is_enabled("per_user_inputs")
        ):
            print(f"[MULTIUSER] Intercepting {request.path} for user={user['username']} (parent middleware)")
            return await _filter_internal_files(request, user)

        # ── 8. Filter /object_info — restrict input file lists per user ──
        # Admins also need this so their own subfolder files appear in
        # node dropdowns (ComfyUI only lists root-level files by default).
        if (
            request.method == "GET"
            and any(
                request.path == p or request.path.startswith(p)
                for p in _OBJECT_INFO_PATHS
            )
            and user
            and _is_enabled("per_user_inputs")
        ):
            print(f"[MULTIUSER] Intercepting {request.path} for user={user['username']}")
            return await _filter_object_info(request, handler, user)

        return await handler(request)

    # Insert right after auth middleware (position 1) so it rewrites the
    # request body before the prompt-tracking middleware reads it.
    app.middlewares.insert(1, isolation_middleware)
    logger.info("User workspace isolation middleware installed")


# ---------------------------------------------------------------------------
#  /upload/image + /upload/mask — redirect into input/{username}/
# ---------------------------------------------------------------------------

async def _rewrite_upload(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Re-route an upload so the file lands in ``input/{username}/``.

    ComfyUI's ``image_upload()`` reads a ``subfolder`` field from the POST
    body.  We read the multipart form, prepend ``{username}/`` to that
    subfolder, and write the file ourselves (mirroring ComfyUI logic) so
    we don't have to hack aiohttp request internals.
    """
    import folder_paths
    import hashlib as _hashlib

    username = user["username"]

    try:
        post = await request.post()
    except Exception:
        return web.json_response({"error": "Malformed upload body"}, status=400)

    image = post.get("image")
    if not image or not getattr(image, "file", None):
        return web.Response(status=400)

    filename = image.filename
    if not filename:
        return web.Response(status=400)

    overwrite = post.get("overwrite")
    image_upload_type = post.get("type") or "input"

    # Only redirect input-type uploads; output/temp pass through to ComfyUI.
    if image_upload_type != "input":
        return await handler(request)

    # Resolve destination directory
    upload_dir = folder_paths.get_input_directory()

    # Prepend username to the subfolder
    orig_subfolder = post.get("subfolder", "")
    if orig_subfolder:
        subfolder = os.path.join(username, os.path.normpath(orig_subfolder))
    else:
        subfolder = username

    full_output_folder = os.path.join(upload_dir, os.path.normpath(subfolder))
    filepath = os.path.abspath(os.path.join(full_output_folder, filename))

    # Security: verify the path stays inside the upload dir
    if os.path.commonpath((upload_dir, filepath)) != upload_dir:
        return web.Response(status=400)

    os.makedirs(full_output_folder, exist_ok=True)

    split = os.path.splitext(filename)
    image_is_duplicate = False

    def _file_hash(path):
        h = _hashlib.sha256()
        with open(path, "rb") as f:
            h.update(f.read())
        return h.hexdigest()

    def _stream_hash(stream):
        h = _hashlib.sha256()
        h.update(stream.read())
        stream.seek(0)
        return h.hexdigest()

    if overwrite in ("true", "1"):
        pass
    else:
        i = 1
        while os.path.exists(filepath):
            try:
                if _file_hash(filepath) == _stream_hash(image.file):
                    image_is_duplicate = True
                    break
            except Exception:
                pass
            filename = f"{split[0]} ({i}){split[1]}"
            filepath = os.path.join(full_output_folder, filename)
            i += 1

    if not image_is_duplicate:
        image.file.seek(0)
        with open(filepath, "wb") as f:
            f.write(image.file.read())

    logger.info("Upload isolation: %s → %s/%s", username, subfolder, filename)

    return web.json_response({
        "name": filename,
        "subfolder": subfolder,
        "type": image_upload_type,
    })


# ---------------------------------------------------------------------------
#  /view?type=input — serve input files directly (bypass ComfyUI's handler)
# ---------------------------------------------------------------------------

async def _serve_input_file(
    request: web.Request, raw_filename: str, explicit_subfolder: str
) -> web.Response:
    """Serve an input file directly, resolving user-subfolder paths.

    ComfyUI's ``/view`` handler calls ``os.path.basename(filename)`` which
    strips directory components.  Files stored as ``input/witt/photo.png``
    would need ``subfolder=witt&filename=photo.png``, but the frontend
    sends ``filename=witt/photo.png`` with no subfolder.

    This handler resolves the full path and serves the file, matching
    ComfyUI's response format (Content-Type, Content-Disposition, preview
    support).

    Fallback: if the file isn't found at the requested location, try the
    authenticated user's subfolder.  This handles the case where
    ``/object_info`` lists a file as a bare name but the file actually
    lives in the user's subfolder.
    """
    import folder_paths
    import mimetypes

    try:
        input_dir = os.path.realpath(folder_paths.get_input_directory())

        # Resolve filename and subfolder
        if "/" in raw_filename and not explicit_subfolder:
            idx = raw_filename.rfind("/")
            subfolder = raw_filename[:idx]
            filename = raw_filename[idx + 1:]
        else:
            subfolder = explicit_subfolder
            filename = raw_filename

        if not filename:
            print(f"[MULTIUSER] _serve_input_file: empty filename")
            return web.Response(status=400)

        # Security: reject path traversal
        if ".." in filename or ".." in subfolder or filename.startswith("/"):
            print(f"[MULTIUSER] _serve_input_file: path traversal rejected")
            return web.Response(status=400)

        # Build candidate paths to try (in order)
        candidates = []
        allowed_dirs = [input_dir]

        # 1. Exact requested path in input dir
        if subfolder:
            candidates.append(os.path.join(input_dir, subfolder, filename))
        else:
            candidates.append(os.path.join(input_dir, filename))

        # 2. Fallback: try the user's own input subfolder
        user = request.get("multiuser_user")
        if user:
            username = user["username"]
            if not subfolder:
                candidates.append(os.path.join(input_dir, username, filename))
            elif subfolder != username:
                candidates.append(os.path.join(input_dir, username, filename))

        # 3. Fallback: check output directory too — the widget's "All" tab
        #    mixes input files with execution history (output) items but
        #    requests everything with type=input.
        output_dir = os.path.realpath(folder_paths.get_output_directory())
        allowed_dirs.append(output_dir)
        candidates.append(os.path.join(output_dir, filename))
        if user:
            candidates.append(os.path.join(output_dir, username, filename))

        # Try each candidate
        file_path = None
        for cand in candidates:
            cand = os.path.realpath(cand)
            # Security: ensure path stays inside an allowed directory
            if not any(
                cand.startswith(d + os.sep) or cand == d
                for d in allowed_dirs
            ):
                continue
            if os.path.isfile(cand):
                file_path = cand
                break

        if not file_path:
            return web.Response(status=404, headers=_NO_CACHE_HEADERS)

        # Preview mode (thumbnail) — same as ComfyUI's handler
        if "preview" in request.query:
            try:
                from PIL import Image
                from io import BytesIO

                with Image.open(file_path) as img:
                    preview_info = request.query["preview"].split(";")
                    image_format = preview_info[0]
                    if image_format not in ("webp", "jpeg"):
                        image_format = "webp"

                    quality = 90
                    if preview_info[-1].isdigit():
                        quality = int(preview_info[-1])

                    buffer = BytesIO()
                    if image_format == "jpeg" or request.query.get("channel") == "rgb":
                        img = img.convert("RGB")
                    img.save(buffer, format=image_format, quality=quality)
                    buffer.seek(0)

                    return web.Response(
                        body=buffer.read(),
                        content_type=f"image/{image_format}",
                        headers={
                            "Content-Disposition": f'filename="{filename}"',
                            "Cache-Control": "public, max-age=86400",
                        },
                    )
            except Exception as exc:
                print(f"[MULTIUSER] _serve_input_file: preview failed: {exc}")
                # Fall through to normal file serve

        # Serve the file directly
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

        # Security: force download for dangerous MIME types
        if content_type in {
            "text/html", "text/html-sandboxed", "application/xhtml+xml",
            "text/javascript", "text/css",
        }:
            content_type = "application/octet-stream"

        return web.FileResponse(
            file_path,
            headers={
                "Content-Disposition": f'filename="{filename}"',
                "Content-Type": content_type,
                "Cache-Control": "public, max-age=86400",
            },
        )

    except Exception as exc:
        print(f"[MULTIUSER] _serve_input_file: EXCEPTION: {exc}")
        import traceback
        traceback.print_exc()
        return web.Response(status=500)


# ---------------------------------------------------------------------------
#  /view — serve output/temp files (handles " [output]" suffix from widget)
# ---------------------------------------------------------------------------

async def _serve_output_file(
    request: web.Request,
    clean_filename: str,
    dir_type: str,
    explicit_subfolder: str,
) -> web.Response:
    """Serve an output or temp file.

    Called when the widget dropdown sends ``filename=photo.jpg [output]``
    with ``type=input``.  We've already stripped the suffix; now locate the
    file in the correct directory.
    """
    import folder_paths
    import mimetypes

    try:
        if dir_type == "output":
            base_dir = os.path.realpath(folder_paths.get_output_directory())
        else:
            base_dir = os.path.realpath(folder_paths.get_temp_directory())

        # Resolve filename and subfolder
        if "/" in clean_filename and not explicit_subfolder:
            idx = clean_filename.rfind("/")
            subfolder = clean_filename[:idx]
            filename = clean_filename[idx + 1:]
        else:
            subfolder = explicit_subfolder
            filename = clean_filename

        if not filename:
            return web.Response(status=400)

        if ".." in filename or ".." in subfolder or filename.startswith("/"):
            return web.Response(status=400)

        if subfolder:
            file_path = os.path.join(base_dir, subfolder, filename)
        else:
            file_path = os.path.join(base_dir, filename)

        file_path = os.path.realpath(file_path)
        if not file_path.startswith(base_dir + os.sep) and file_path != base_dir:
            return web.Response(status=400)

        # For non-admin users, restrict to their own output subfolder
        user = request.get("multiuser_user")
        if user and not user.get("is_admin"):
            username = user["username"]
            user_output_dir = os.path.realpath(
                os.path.join(base_dir, username)
            )
            # Allow root-level files + user's own subfolder
            is_root_file = os.path.dirname(file_path) == base_dir
            is_own_file = file_path.startswith(user_output_dir + os.sep)
            if not is_root_file and not is_own_file:
                # Try user's subfolder as fallback
                file_path = os.path.realpath(
                    os.path.join(base_dir, username, filename)
                )
                if not os.path.isfile(file_path):
                    return web.Response(status=404, headers=_NO_CACHE_HEADERS)

        if not os.path.isfile(file_path):
            return web.Response(status=404, headers=_NO_CACHE_HEADERS)

        # Preview mode
        if "preview" in request.query:
            try:
                from PIL import Image
                from io import BytesIO

                with Image.open(file_path) as img:
                    preview_info = request.query["preview"].split(";")
                    image_format = preview_info[0]
                    if image_format not in ("webp", "jpeg"):
                        image_format = "webp"

                    quality = 90
                    if preview_info[-1].isdigit():
                        quality = int(preview_info[-1])

                    buffer = BytesIO()
                    if image_format == "jpeg" or request.query.get("channel") == "rgb":
                        img = img.convert("RGB")
                    img.save(buffer, format=image_format, quality=quality)
                    buffer.seek(0)

                    return web.Response(
                        body=buffer.read(),
                        content_type=f"image/{image_format}",
                        headers={
                            "Content-Disposition": f'filename="{filename}"',
                            "Cache-Control": "public, max-age=86400",
                        },
                    )
            except Exception:
                pass  # Fall through to normal file serve

        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if content_type in {
            "text/html", "text/html-sandboxed", "application/xhtml+xml",
            "text/javascript", "text/css",
        }:
            content_type = "application/octet-stream"

        return web.FileResponse(
            file_path,
            headers={
                "Content-Disposition": f'filename="{filename}"',
                "Content-Type": content_type,
                "Cache-Control": "public, max-age=86400",
            },
        )

    except Exception as exc:
        print(f"[MULTIUSER] _serve_output_file: EXCEPTION: {exc}")
        import traceback
        traceback.print_exc()
        return web.Response(status=500)


# ---------------------------------------------------------------------------
#  /internal/files/{input,output} — filter ComfyUI's internal file API
# ---------------------------------------------------------------------------

async def _filter_internal_files(
    request: web.Request, user: dict
) -> web.Response:
    """Intercept ComfyUI's ``/internal/files/input`` and ``/internal/files/output``
    endpoints to enforce per-user file isolation.

    The original endpoint returns a flat JSON array of root-level filenames.
    We replace it with user-scoped relative paths so the node dropdown shows
    only the user's own files (plus shared assets).
    """
    import folder_paths

    directory_type = request.path.rsplit("/", 1)[-1]  # "input" or "output"

    if directory_type == "input":
        base_dir = folder_paths.get_input_directory()
    elif directory_type == "output":
        try:
            base_dir = folder_paths.get_output_directory()
        except (AttributeError, Exception):
            base_dir = os.path.join(os.getcwd(), "output")
    else:
        return web.json_response({"error": "Invalid directory type"}, status=400)

    username = user["username"]

    from ..db.factory import get_db
    db = await get_db()
    all_users_rows = await db.fetchall("SELECT username FROM users")
    all_usernames = {r["username"] for r in all_users_rows}

    visible_files: list[str] = []

    # Everyone (including admins) sees only their own files + shared.
    # Admin privileges are for user management, not browsing others' files.
    user_dir = os.path.join(base_dir, username)
    if os.path.isdir(user_dir):
        for dirpath, _subdirs, filenames in os.walk(user_dir):
            for fname in filenames:
                if fname.startswith("."):
                    continue
                abs_path = os.path.join(dirpath, fname)
                rel = os.path.relpath(abs_path, base_dir)
                visible_files.append(rel)

    # Shared files: root-level files + non-user directories
    try:
        root_entries = os.listdir(base_dir)
    except OSError:
        root_entries = []

    for entry in root_entries:
        full = os.path.join(base_dir, entry)
        if entry.startswith("."):
            continue
        if os.path.isfile(full):
            visible_files.append(entry)
        elif os.path.isdir(full) and entry not in all_usernames:
            for dirpath, _subdirs, filenames in os.walk(full):
                for fname in filenames:
                    if fname.startswith("."):
                        continue
                    abs_path = os.path.join(dirpath, fname)
                    rel = os.path.relpath(abs_path, base_dir)
                    visible_files.append(rel)

    # Sort by filename (matching ComfyUI's original behavior for input,
    # or reverse mtime for output — but we don't have mtime readily, so sort alpha)
    visible_files.sort()

    print(f"[MULTIUSER] _filter_internal_files: user={username}, "
          f"type={directory_type}, files={len(visible_files)}")

    return web.json_response(visible_files)


# ---------------------------------------------------------------------------
#  /object_info — filter input file lists to the current user
# ---------------------------------------------------------------------------


async def _get_all_usernames() -> set[str]:
    """Return the set of all known usernames from the DB."""
    try:
        from ..db.factory import get_db
        db = await get_db()
        rows = await db.fetchall("SELECT username FROM users")
        return {r["username"] for r in rows}
    except Exception as exc:
        print(f"[MULTIUSER] WARN: could not fetch usernames: {exc}")
        return set()


def _extract_response_json(response: web.Response):
    """Best-effort extraction of JSON data from an aiohttp response.

    Tries multiple methods to handle different aiohttp versions.
    Returns the parsed dict or None.
    """
    import gzip as _gzip

    # Method 1: response.body (standard for web.Response / json_response)
    try:
        body = response.body
        if isinstance(body, bytes) and body:
            # Could be gzip-compressed if compress_body ran inline
            if body[:2] == b'\x1f\x8b':
                body = _gzip.decompress(body)
            return json_mod.loads(body)
        if isinstance(body, (bytearray, memoryview)):
            return json_mod.loads(bytes(body))
    except Exception:
        pass

    # Method 2: response.text (aiohttp decodes body via charset)
    try:
        text = response.text
        if text:
            return json_mod.loads(text)
    except Exception:
        pass

    # Method 3: internal _body attribute
    try:
        raw = getattr(response, '_body', None)
        if raw and isinstance(raw, bytes):
            if raw[:2] == b'\x1f\x8b':
                raw = _gzip.decompress(raw)
            return json_mod.loads(raw)
    except Exception:
        pass

    return None


def _build_object_info_from_scratch() -> dict:
    """Fallback: build /object_info data directly from node registrations.

    Mirrors ComfyUI's ``node_info()`` in server.py.  Used when we cannot
    parse the response body (e.g., different aiohttp version, compression, etc.).
    """
    import nodes
    import folder_paths

    try:
        from comfy_api.internal import _ComfyNodeInternal
    except ImportError:
        _ComfyNodeInternal = None

    out = {}
    # Use folder_paths.cache_helper for performance (same as ComfyUI does)
    try:
        ctx = folder_paths.cache_helper
    except AttributeError:
        from contextlib import nullcontext
        ctx = nullcontext()

    with ctx:
        for node_class_name in nodes.NODE_CLASS_MAPPINGS:
            try:
                obj_class = nodes.NODE_CLASS_MAPPINGS[node_class_name]
                if _ComfyNodeInternal and issubclass(obj_class, _ComfyNodeInternal):
                    out[node_class_name] = obj_class.GET_NODE_INFO_V1()
                    continue

                info = {}
                info['input'] = obj_class.INPUT_TYPES()
                info['input_order'] = {
                    key: list(value.keys())
                    for key, value in obj_class.INPUT_TYPES().items()
                }
                info['is_input_list'] = getattr(obj_class, "INPUT_IS_LIST", False)
                info['output'] = obj_class.RETURN_TYPES
                info['output_is_list'] = (
                    obj_class.OUTPUT_IS_LIST
                    if hasattr(obj_class, 'OUTPUT_IS_LIST')
                    else [False] * len(obj_class.RETURN_TYPES)
                )
                info['output_name'] = (
                    obj_class.RETURN_NAMES
                    if hasattr(obj_class, 'RETURN_NAMES')
                    else info['output']
                )
                info['name'] = node_class_name
                info['display_name'] = (
                    nodes.NODE_DISPLAY_NAME_MAPPINGS.get(node_class_name, node_class_name)
                )
                info['description'] = getattr(obj_class, 'DESCRIPTION', '')
                info['python_module'] = getattr(obj_class, "RELATIVE_PYTHON_MODULE", "nodes")
                info['category'] = getattr(obj_class, 'CATEGORY', 'sd')
                info['output_node'] = bool(getattr(obj_class, 'OUTPUT_NODE', False))
                if getattr(obj_class, "DEPRECATED", False):
                    info['deprecated'] = True
                if getattr(obj_class, "EXPERIMENTAL", False):
                    info['experimental'] = True
                if hasattr(obj_class, 'API_NODE'):
                    info['api_node'] = obj_class.API_NODE
                out[node_class_name] = info
            except Exception:
                pass

    return out


async def _filter_object_info(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Filter ``/object_info`` so node dropdowns list the correct input files.

    For non-admins: only show files from ``input/{username}/`` + shared files.
    For admins: show ALL files across all user directories + shared files.

    File names are returned as ``{username}/file.png`` (or just ``file.png``
    for root-level) so that ComfyUI's path resolution resolves them correctly.
    """
    import folder_paths

    username = user["username"]

    # ── Step 1: Get the original /object_info response ──
    try:
        response = await handler(request)
    except Exception as exc:
        print(f"[MULTIUSER] ERROR: /object_info handler raised: {exc}")
        return web.json_response({"error": "Internal error"}, status=500)

    if response.status != 200:
        print(f"[MULTIUSER] /object_info returned status {response.status}, passing through")
        return response

    # ── Step 2: Extract JSON from response ──
    data = _extract_response_json(response)
    built_from_scratch = False

    if data is None or not isinstance(data, dict):
        print(f"[MULTIUSER] WARN: Could not parse /object_info body "
              f"(body type={type(getattr(response, 'body', None)).__name__}, "
              f"body len={len(response.body) if isinstance(getattr(response, 'body', None), bytes) else '?'}). "
              f"Rebuilding from scratch.")
        data = _build_object_info_from_scratch()
        built_from_scratch = True

    if not data:
        print("[MULTIUSER] WARN: /object_info data is empty, passing through")
        return response

    # ── Step 3: Build the visible file list for this user ──
    try:
        input_dir = folder_paths.get_input_directory()
        user_dir = os.path.join(input_dir, username)
        all_usernames = await _get_all_usernames()

        visible_files: list[str] = []

        # Everyone (including admins) sees only their own files + shared.
        if os.path.isdir(user_dir):
            for dirpath, _subdirs, filenames in os.walk(user_dir):
                for fname in filenames:
                    if fname.startswith("."):
                        continue
                    rel = os.path.relpath(os.path.join(dirpath, fname), input_dir)
                    visible_files.append(rel)

        # Shared: root-level files + non-user directories
        try:
            root_entries = os.listdir(input_dir)
        except OSError:
            root_entries = []

        for entry in root_entries:
            if entry.startswith("."):
                continue
            full = os.path.join(input_dir, entry)
            if os.path.isfile(full):
                visible_files.append(entry)
            elif os.path.isdir(full) and entry not in all_usernames:
                for dirpath, _subdirs, filenames in os.walk(full):
                    for fname in filenames:
                        if fname.startswith("."):
                            continue
                        rel = os.path.relpath(
                            os.path.join(dirpath, fname), input_dir
                        )
                        visible_files.append(rel)

        visible_files_set = set(visible_files)
    except Exception as exc:
        print(f"[MULTIUSER] ERROR building visible file list: {exc}")
        return response  # fallback: unfiltered

    # ── Step 4: Walk every node definition and filter image_upload inputs ──
    try:
        modified = False
        nodes_filtered = 0

        for node_name, node_info_val in data.items():
            if not isinstance(node_info_val, dict):
                continue
            input_defs = node_info_val.get("input")
            if not isinstance(input_defs, dict):
                continue

            for category in ("required", "optional"):
                cat_inputs = input_defs.get(category)
                if not isinstance(cat_inputs, dict):
                    continue

                for input_name, input_spec in list(cat_inputs.items()):
                    if not isinstance(input_spec, (list, tuple)) or len(input_spec) < 2:
                        continue

                    file_list, opts = input_spec[0], input_spec[1]

                    if not isinstance(opts, dict) or not opts.get("image_upload"):
                        continue

                    # V2 COMBO format: file_list is the string "COMBO",
                    # not a list.  These use remote routes — skip them.
                    if not isinstance(file_list, list):
                        continue

                    # Only filter "input"-folder lists; output/temp stay
                    # untouched.
                    image_folder = opts.get("image_folder", "input")
                    if image_folder != "input":
                        continue

                    # Replace the file list with only visible files
                    filtered = [f for f in file_list if f in visible_files_set]

                    # Add files that are absent from the original list
                    # (LoadImage only does os.listdir on root; user files
                    # in subdirectories won't be there).
                    existing = set(filtered)
                    for vf in visible_files:
                        if vf not in existing:
                            filtered.append(vf)
                            existing.add(vf)

                    # Apply content-type filtering (e.g., keep only images)
                    try:
                        filtered = folder_paths.filter_files_content_types(
                            filtered, ["image"]
                        )
                    except Exception:
                        pass

                    filtered.sort()

                    # Replace in the data structure
                    if isinstance(input_spec, tuple):
                        cat_inputs[input_name] = (filtered, opts) + input_spec[2:]
                    else:
                        cat_inputs[input_name] = [filtered, opts] + list(input_spec[2:])

                    modified = True
                    nodes_filtered += 1

        print(f"[MULTIUSER] /object_info filter: user={username}, "
              f"visible_files={len(visible_files)}, "
              f"nodes_filtered={nodes_filtered}, "
              f"modified={modified}, "
              f"from_scratch={built_from_scratch}")

        if modified or built_from_scratch:
            return web.json_response(data)

    except Exception as exc:
        print(f"[MULTIUSER] ERROR during /object_info filtering: {exc}")
        import traceback
        traceback.print_exc()

    return response



# ---------------------------------------------------------------------------
#  /history — filter to user's own prompt_ids
# ---------------------------------------------------------------------------

async def _filter_history(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Let the request through, then strip entries belonging to *other* users.

    Strategy: block prompts that the generations table attributes to someone
    else.  Prompts not tracked at all (legacy / pre-plugin) are left visible
    so existing history isn't wiped out.
    """
    response = await handler(request)

    if response.status != 200:
        return response

    try:
        body = response.body
        if isinstance(body, bytes):
            history = json_mod.loads(body)
        else:
            history = {}
    except Exception:
        return response

    if not isinstance(history, dict):
        return response

    from ..db.factory import get_db
    db = await get_db()

    user_id = user["id"]

    # Fetch all tracked prompt_ids that belong to OTHER users.
    other_prompts = await db.fetchall(
        "SELECT prompt_id FROM generations WHERE user_id != ?",
        (user_id,)
    )
    other_set = {r["prompt_id"] for r in other_prompts}

    # Remove entries known to belong to someone else.
    # Untracked prompts (not in generations at all) stay visible.
    filtered = {k: v for k, v in history.items() if k not in other_set}

    return web.json_response(filtered)


async def _filter_history_single(
    request: web.Request, handler, user: dict, prompt_id: str
) -> web.Response:
    """Gate /history/{prompt_id} — deny if it's known to belong to another user."""
    from ..db.factory import get_db
    db = await get_db()

    owner = await db.fetchone(
        "SELECT user_id FROM generations WHERE prompt_id = ?",
        (prompt_id,)
    )
    # If tracked and belongs to someone else → deny
    if owner and owner["user_id"] != user["id"]:
        return web.json_response({}, status=200)

    # Not tracked (legacy) or belongs to this user → allow
    return await handler(request)


# ---------------------------------------------------------------------------
#  /view — restrict to user's output subfolder
# ---------------------------------------------------------------------------

async def _filter_view(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Block output images that live inside *another* user's subfolder.

    Files at the root of the output directory (no user-prefix) are treated as
    shared / legacy and are allowed through.  Only files explicitly inside a
    different user's subfolder are denied.
    """
    filename = request.query.get("filename", "")
    subfolder = request.query.get("subfolder", "")

    username = user["username"]

    img_type = request.query.get("type", "output")

    # Gate input files — non-admins can only view their own input subfolder
    if img_type == "input" and _is_enabled("per_user_inputs"):
        full_path = f"{subfolder}/{filename}" if subfolder else filename
        top_dir = full_path.split("/")[0] if "/" in full_path else None
        if top_dir and top_dir != username:
            from ..db.factory import get_db
            db = await get_db()
            owner = await db.fetchone(
                "SELECT id FROM users WHERE username = ?", (top_dir,)
            )
            if owner:
                return web.json_response(
                    {"error": "Access denied — you can only view your own inputs"},
                    status=403,
                )

    # Gate output files
    if img_type == "output":
        # Build the effective path the same way ComfyUI does:
        #   subfolder="username"  filename="ComfyUI_00001_.png"
        #     → full_path = "username/ComfyUI_00001_.png"
        #   subfolder=""  filename="ComfyUI_00001_.png"
        #     → full_path = "ComfyUI_00001_.png"  (shared / legacy)
        full_path = f"{subfolder}/{filename}" if subfolder else filename

        # Determine the top-level directory component (if any).
        top_dir = full_path.split("/")[0] if "/" in full_path else None

        if top_dir and top_dir != username:
            # The file sits inside a named subfolder that isn't ours.
            # Check whether that subfolder belongs to another user.
            from ..db.factory import get_db
            db = await get_db()
            owner = await db.fetchone(
                "SELECT id FROM users WHERE username = ?", (top_dir,)
            )
            if owner:
                # It's another user's folder — deny.
                return web.json_response(
                    {"error": "Access denied — you can only view your own outputs"},
                    status=403,
                )
            # top_dir isn't a known username → treat as a shared/custom
            # subfolder and allow.

    return await handler(request)


# ---------------------------------------------------------------------------
#  /queue — filter running/pending items to user's own prompt_ids
# ---------------------------------------------------------------------------

async def _filter_queue(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Filter GET /queue response so non-admins only see their own jobs.

    Queue item format: [number, prompt_id, prompt, extra_data, outputs_to_execute]
    We use the generations table to identify which prompt_ids belong to the user.
    Untracked prompts (pre-plugin) are hidden from non-admins for safety.
    """
    response = await handler(request)

    if response.status != 200:
        return response

    try:
        body = response.body
        if isinstance(body, bytes):
            queue_data = json_mod.loads(body)
        else:
            queue_data = {}
    except Exception:
        return response

    if not isinstance(queue_data, dict):
        return response

    from ..db.factory import get_db
    db = await get_db()
    user_id = user["id"]

    # Get this user's prompt_ids
    own_prompts = await db.fetchall(
        "SELECT prompt_id FROM generations WHERE user_id = ?",
        (user_id,)
    )
    own_set = {r["prompt_id"] for r in own_prompts}

    # Filter both running and pending queues
    for key in ("queue_running", "queue_pending"):
        items = queue_data.get(key, [])
        queue_data[key] = [
            item for item in items
            if isinstance(item, (list, tuple)) and len(item) >= 2 and item[1] in own_set
        ]

    return web.json_response(queue_data)


async def _filter_queue_actions(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Filter POST /queue (clear/delete) so non-admins only affect their own jobs.

    Body formats:
      { "clear": true }   → only clear user's own items
      { "delete": [...] } → only delete user's own prompt_ids
    """
    try:
        body = await request.json()
    except Exception:
        return await handler(request)

    from ..db.factory import get_db
    db = await get_db()
    user_id = user["id"]

    if body.get("clear"):
        # Instead of clearing everything, delete only user's own items
        own_prompts = await db.fetchall(
            "SELECT prompt_id FROM generations WHERE user_id = ? AND status IN ('queued', 'running')",
            (user_id,)
        )
        own_ids = [r["prompt_id"] for r in own_prompts]
        if not own_ids:
            return web.json_response({"status": "ok"})
        # Interact with the queue directly through ComfyUI's API.
        ps = comfyui_server.PromptServer.instance
        for pid in own_ids:
            ps.prompt_queue.delete_queue_item(pid)
        return web.json_response({"status": "ok"})

    if body.get("delete"):
        delete_ids = body["delete"]
        if not isinstance(delete_ids, list):
            return web.json_response({"error": "Invalid delete list"}, status=400)

        # Filter to only user's own prompt_ids
        own_prompts = await db.fetchall(
            "SELECT prompt_id FROM generations WHERE user_id = ?",
            (user_id,)
        )
        own_set = {r["prompt_id"] for r in own_prompts}
        allowed = [pid for pid in delete_ids if pid in own_set]

        if not allowed:
            return web.json_response({"status": "ok"})

        # Delete only the allowed items
        ps = comfyui_server.PromptServer.instance
        for pid in allowed:
            ps.prompt_queue.delete_queue_item(pid)
        return web.json_response({"status": "ok"})

    return await handler(request)


async def _filter_interrupt(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Filter POST /interrupt so non-admins can only interrupt their own running prompt."""
    from ..db.factory import get_db
    db = await get_db()
    user_id = user["id"]

    # Check if there's a target prompt_id in the body
    try:
        body = await request.json()
        target_pid = body.get("prompt_id")
    except Exception:
        target_pid = None

    if target_pid:
        # Verify user owns this prompt
        owner = await db.fetchone(
            "SELECT user_id FROM generations WHERE prompt_id = ?",
            (target_pid,)
        )
        if owner and owner["user_id"] != user_id:
            return web.json_response(
                {"error": "Cannot interrupt another user's generation"},
                status=403,
            )

    # If no target prompt_id, ComfyUI interrupts the currently running prompt.
    # Check if the currently running prompt belongs to this user.
    if not target_pid:
        ps = comfyui_server.PromptServer.instance
        current_queue = ps.prompt_queue.get_current_queue()
        running = current_queue[0] if current_queue else []  # queue_running
        if running:
            for item in running:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    running_pid = item[1]
                    owner = await db.fetchone(
                        "SELECT user_id FROM generations WHERE prompt_id = ?",
                        (running_pid,)
                    )
                    if owner and owner["user_id"] != user_id:
                        return web.json_response(
                            {"error": "Cannot interrupt — another user's generation is running"},
                            status=403,
                        )

    return await handler(request)


# ---------------------------------------------------------------------------
#  Internal sub-app middleware — /internal/files/{input,output}
# ---------------------------------------------------------------------------

def install_internal_files_middleware(prompt_server_instance) -> None:
    """Install a middleware on ComfyUI's internal sub-app for file isolation.

    ComfyUI's ``/internal`` routes live in a separate ``web.Application``
    registered via ``add_subapp``.  Depending on the aiohttp version the
    parent app's middleware chain may or may not wrap sub-app requests.
    Installing middleware *directly* on the sub-app guarantees that
    ``/internal/files/input`` (used by the new React frontend to populate
    node dropdowns like LoadImage) is always filtered.
    """
    try:
        internal_app = prompt_server_instance.internal_routes.get_app()
    except AttributeError:
        logger.warning(
            "Could not access internal_routes on PromptServer; "
            "/internal/files filtering will rely on parent middleware only"
        )
        return

    @web.middleware
    async def _internal_files_filter(request: web.Request, handler):
        # Only act on GET requests to /files/{type}
        if request.method != "GET" or "/files/" not in request.path:
            return await handler(request)

        # Extract directory type from the last path segment.
        # request.path may be "/internal/files/input" (if parent middleware
        # cloned the request) or "/files/input" (sub-app relative).
        directory_type = request.path.rsplit("/", 1)[-1]
        # Filter both input and output directories
        if directory_type not in ("input", "output"):
            return await handler(request)

        if not _is_enabled("per_user_inputs"):
            return await handler(request)

        # Prefer user set by parent auth middleware; fall back to our own
        # auth check in case parent middleware did not run for sub-apps.
        user = request.get("multiuser_user")
        if user is None:
            from ..auth.middleware import _try_identify_user
            user = await _try_identify_user(request, quiet=True)

        if user is None:
            # Anonymous / unauthenticated — let default handler run
            return await handler(request)

        return await _filter_internal_files(request, user)

    internal_app.middlewares.insert(0, _internal_files_filter)
    logger.info("Internal files isolation middleware installed on sub-app")
