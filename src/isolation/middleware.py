"""User-workspace isolation middleware.

Intercepts ComfyUI endpoints to:
  1. Route SaveImage outputs to per-user subdirectories.
  2. Filter /history to show only the authenticated user's executions.
  3. Filter /view (output image serving) to the user's own folder.
"""
import json as json_mod
import logging
from aiohttp import web

from ..config import get_config

logger = logging.getLogger("comfyui-multiuser.isolation")


def _is_enabled(key: str) -> bool:
    return bool(get_config("isolation", key, default=True))


def install_isolation_middleware(app: web.Application) -> None:
    """Install a middleware that enforces per-user workspace isolation."""

    @web.middleware
    async def isolation_middleware(request: web.Request, handler):
        user = request.get("multiuser_user")

        # ── 1. Per-user output directory (rewrite SaveImage in /prompt) ──
        if (
            request.method == "POST"
            and request.path == "/prompt"
            and user
            and not user.get("is_admin")
            and _is_enabled("per_user_outputs")
        ):
            return await _rewrite_prompt_outputs(request, handler, user)

        # ── 2. Restrict /history to user's own prompts ──
        if (
            request.path in ("/history", "/history/")
            and request.method == "GET"
            and user
            and not user.get("is_admin")
            and _is_enabled("restrict_history_access")
        ):
            return await _filter_history(request, handler, user)

        # ── 3. Restrict /view to user's own output subfolder ──
        if (
            request.path == "/view"
            and request.method == "GET"
            and user
            and not user.get("is_admin")
            and _is_enabled("restrict_output_access")
        ):
            return await _filter_view(request, handler, user)

        return await handler(request)

    # Insert right after auth middleware (position 1) so it rewrites the
    # request body before the prompt-tracking middleware reads it.
    app.middlewares.insert(1, isolation_middleware)
    logger.info("User workspace isolation middleware installed")


# ---------------------------------------------------------------------------
#  /prompt — rewrite SaveImage / PreviewImage output_prefix
# ---------------------------------------------------------------------------

async def _rewrite_prompt_outputs(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Prefix SaveImage / PreviewImage output with the user's username."""
    body = await request.read()
    try:
        data = json_mod.loads(body)
    except (json_mod.JSONDecodeError, Exception):
        return await handler(request)

    prompt = data.get("prompt")
    if not prompt or not isinstance(prompt, dict):
        return await handler(request)

    username = user["username"]
    modified = False

    for _node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        # Any node that has a filename_prefix input and is known to save/preview
        if class_type in ("SaveImage", "PreviewImage", "SaveAnimatedWEBP",
                          "SaveAnimatedPNG", "SaveLatent"):
            prefix = inputs.get("filename_prefix", "ComfyUI")
            # Avoid double-prefixing on retry
            if not prefix.startswith(f"{username}/"):
                inputs["filename_prefix"] = f"{username}/{prefix}"
                modified = True

    if modified:
        # Patch the cached body so downstream (ComfyUI's /prompt handler and
        # our prompt-tracking middleware) sees the rewritten prompt.
        # aiohttp caches request.read() in request._read_bytes.
        new_body = json_mod.dumps(data).encode()
        request._read_bytes = new_body

    return await handler(request)


# ---------------------------------------------------------------------------
#  /history — filter to user's own prompt_ids
# ---------------------------------------------------------------------------

async def _filter_history(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Let the request through, then strip entries the user doesn't own."""
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

    # Our generations table maps prompt_id -> user_id
    user_id = user["id"]
    owned_prompts = await db.fetchall(
        "SELECT prompt_id FROM generations WHERE user_id = ?",
        (user_id,)
    )
    owned_set = {r["prompt_id"] for r in owned_prompts}

    # Keep only entries whose key is in the user's owned set
    filtered = {k: v for k, v in history.items() if k in owned_set}

    return web.json_response(filtered)


# ---------------------------------------------------------------------------
#  /view — restrict to user's output subfolder
# ---------------------------------------------------------------------------

async def _filter_view(
    request: web.Request, handler, user: dict
) -> web.Response:
    """Block serving images that are outside the user's output subfolder."""
    filename = request.query.get("filename", "")
    subfolder = request.query.get("subfolder", "")

    username = user["username"]

    # For "output" type, the file must live under <username>/
    img_type = request.query.get("type", "output")
    if img_type == "output":
        # The subfolder should start with the user's directory
        # Files saved with prefix "username/ComfyUI" end up as
        #   subfolder="" filename="username/ComfyUI_00001_.png"  or
        #   subfolder="username" filename="ComfyUI_00001_.png"
        full_path = f"{subfolder}/{filename}" if subfolder else filename
        if not full_path.startswith(f"{username}/") and not full_path.startswith(f"{username}\\"):
            return web.json_response(
                {"error": "Access denied — you can only view your own outputs"},
                status=403,
            )

    return await handler(request)
