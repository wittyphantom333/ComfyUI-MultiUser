"""User-workspace isolation middleware.

Intercepts ComfyUI endpoints to:
  1. Route SaveImage outputs to per-user subdirectories.
  2. Filter /history to show only the authenticated user's executions.
  3. Filter /view (output image serving) to the user's own folder.
"""
import json as json_mod
import logging
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

        # ── 3. Restrict /view to user's own output subfolder ──
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

        return await handler(request)

    # Insert right after auth middleware (position 1) so it rewrites the
    # request body before the prompt-tracking middleware reads it.
    app.middlewares.insert(1, isolation_middleware)
    logger.info("User workspace isolation middleware installed")



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
