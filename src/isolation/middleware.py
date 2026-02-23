"""User-workspace isolation middleware.

Intercepts ComfyUI endpoints to:
  1. Route SaveImage outputs to per-user subdirectories.
  2. Filter /history to show only the authenticated user's executions.
  3. Filter /view (output image serving) to the user's own folder.
"""
import asyncio
import contextvars
import json as json_mod
import logging
from aiohttp import web

from ..config import get_config

logger = logging.getLogger("comfyui-multiuser.isolation")

# ContextVar that carries the authenticated username for the current request.
# The prompt-queue monkey-patch in __init__.py reads this to rewrite
# filename_prefix at the Python-dict level — completely independent of
# any aiohttp request-body patching.
current_prompt_user: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "isolation_prompt_user", default=None
)


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

        # ── 1. Per-user output directory (rewrite SaveImage in /prompt) ──
        if (
            request.method == "POST"
            and request.path in ("/prompt", "/prompt/")
            and user
            and _is_enabled("per_user_outputs")
        ):
            return await _rewrite_prompt_outputs(request, handler, user)
        
        # Debug: log if we see a prompt POST that wasn't caught
        if request.method == "POST" and "prompt" in request.path.lower():
            logger.info(
                "Isolation: saw POST %s — user=%s, per_user_outputs=%s",
                request.path, user.get("username") if user else None,
                _is_enabled("per_user_outputs"),
            )

        # ── 2. Restrict /history to user's own prompts ──
        if (
            request.method == "GET"
            and (request.path in ("/history", "/history/")
                 or request.path.startswith("/history/"))
            and user
            and not user.get("is_admin")
            and _is_enabled("restrict_history_access")
        ):
            # Single-prompt variant: /history/{prompt_id}
            parts = request.path.rstrip("/").split("/")
            if len(parts) == 3 and parts[2]:
                return await _filter_history_single(
                    request, handler, user, parts[2]
                )
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
    """Tag the current async context with the username.

    The actual filename_prefix rewriting happens in the PromptQueue
    monkey-patch (see __init__.py) which reads *current_prompt_user*.
    We also attempt a best-effort request-body rewrite so that the
    prompt-tracking middleware records the rewritten prefix, but the
    queue-level patch is the **primary** mechanism that guarantees
    files land in per-user subdirectories.
    """
    username = user["username"]

    # ── PRIMARY: set ContextVar so the queue patch can pick it up ──
    current_prompt_user.set(username)
    print(f"[ISOLATION] Set prompt user context → {username}")
    logger.info("Isolation: set current_prompt_user=%s", username)

    # ── SECONDARY: best-effort body rewrite (helps prompt-tracking) ──
    try:
        body = await request.read()
        data = json_mod.loads(body)
        prompt = data.get("prompt", {})
        modified = False
        if isinstance(prompt, dict):
            for _nid, node in prompt.items():
                if not isinstance(node, dict):
                    continue
                inputs = node.get("inputs")
                if isinstance(inputs, dict) and "filename_prefix" in inputs:
                    pfx = inputs.get("filename_prefix", "ComfyUI")
                    if isinstance(pfx, str) and not pfx.startswith(f"{username}/"):
                        inputs["filename_prefix"] = f"{username}/{pfx}"
                        modified = True
        if modified:
            new_body = json_mod.dumps(data).encode()
            request._read_bytes = new_body
            logger.info("Isolation: body-patched prompt for user %s", username)
    except Exception as exc:
        logger.debug("Isolation: body rewrite skipped: %s", exc)

    return await handler(request)


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

    # Only gate "output" type — temp previews and inputs are unrestricted.
    img_type = request.query.get("type", "output")
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
