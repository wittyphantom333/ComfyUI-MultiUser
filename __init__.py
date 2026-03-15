"""
ComfyUI-MultiUser — Multi-user authentication, permissions, and tracking for ComfyUI.

This is the main entry point for the custom node. ComfyUI discovers this file and uses
NODE_CLASS_MAPPINGS and WEB_DIRECTORY to register nodes and serve frontend JavaScript.
"""

import asyncio
import logging
import server  # ComfyUI's PromptServer module

from .src.config import get_config
from .src.db.factory import get_db, close_db
from .src.auth.middleware import install_middleware
from .src.auth.routes import setup_auth_routes
from .src.users.routes import setup_user_routes
from .src.groups.routes import setup_group_routes
from .src.permissions.routes import setup_permission_routes
from .src.tokens.routes import setup_ext_token_routes
from .src.generations.routes import setup_generation_routes
from .src.workflows.routes import setup_workflow_routes
from .src.outputs.routes import setup_output_routes
from .src.inputs.routes import setup_input_routes
from .src.isolation.middleware import install_isolation_middleware
from .src.generations.tracker import (
    on_prompt_queued,
    on_prompt_started,
    on_prompt_completed,
    on_prompt_error,
    get_prompt_user,
)

logger = logging.getLogger("comfyui-multiuser")

# Reference to the main event loop, captured at module load or first middleware call.
_main_loop: asyncio.AbstractEventLoop | None = None


def _fire_and_forget(coro):
    """Schedule an async coroutine on the main event loop from any thread.

    Uses run_coroutine_threadsafe so it works from ComfyUI's execution thread
    (which is NOT the asyncio event loop thread).  Swallows exceptions to avoid
    crashing the generation pipeline.
    """
    loop = _main_loop
    if loop is None or loop.is_closed():
        # Fallback: try the running loop (works if called from the loop thread)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.debug("MultiUser: no event loop available, skipping tracker call")
            return

    fut = asyncio.run_coroutine_threadsafe(coro, loop)
    # Add a callback to log (but not raise) any errors
    fut.add_done_callback(
        lambda f: f.exception() and logger.debug("MultiUser tracker: %s", f.exception())
    )

# ---------------------------------------------------------------------------
# ComfyUI Custom Node exports
# ---------------------------------------------------------------------------

# No workflow-facing nodes for now — this extension is purely server-side + UI.
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Serve the JS frontend from ./js/
WEB_DIRECTORY = "./js"

# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

prompt_server = server.PromptServer.instance
routes = prompt_server.routes

setup_auth_routes(routes)
setup_user_routes(routes)
setup_group_routes(routes)
setup_permission_routes(routes)
setup_ext_token_routes(routes)
setup_generation_routes(routes)
setup_workflow_routes(routes)
setup_output_routes(routes)
setup_input_routes(routes)

logger.info("MultiUser: all API routes registered")

# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

install_middleware(prompt_server.app)
install_isolation_middleware(prompt_server.app)

# ---------------------------------------------------------------------------
# on_prompt_handler: per-user output directories (PRIMARY mechanism)
# ---------------------------------------------------------------------------

def _install_prompt_rewrite_handler():
    """Register a ComfyUI on_prompt_handler to rewrite filename_prefix.

    This is the idiomatic ComfyUI approach: PromptServer.trigger_on_prompt()
    calls our handler with the already-parsed json_data *before* validation
    and queueing.  The isolation middleware tags prompt_server._mu_prompt_user
    with the authenticated username; we read it here and prefix every
    filename_prefix in the prompt dict.

    No aiohttp body-patching, no ContextVars, no queue monkey-patching.
    """

    def rewrite_handler(json_data):
        username = getattr(prompt_server, "_mu_prompt_user", None)
        print(f"[ISOLATION on_prompt] handler called — _mu_prompt_user={username}")

        if not username:
            return json_data

        prompt = json_data.get("prompt")
        if not prompt or not isinstance(prompt, dict):
            return json_data

        for _nid, node in prompt.items():
            if not isinstance(node, dict):
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            if "filename_prefix" in inputs:
                pfx = inputs.get("filename_prefix", "ComfyUI")
                if isinstance(pfx, str) and not pfx.startswith(f"{username}/"):
                    inputs["filename_prefix"] = f"{username}/{pfx}"
                    print(
                        f"[ISOLATION on_prompt] node {_nid} filename_prefix → "
                        f"'{inputs['filename_prefix']}' (user={username})"
                    )

        # Clear the tag so it doesn't leak to subsequent requests
        prompt_server._mu_prompt_user = None
        return json_data

    prompt_server.add_on_prompt_handler(rewrite_handler)
    print("[ISOLATION] on_prompt_handler registered")
    logger.info("MultiUser: on_prompt_handler registered for per-user isolation")

_install_prompt_rewrite_handler()

# ---------------------------------------------------------------------------
# Database initialisation (runs in background at startup)
# ---------------------------------------------------------------------------

async def _init_db():
    """Initialise the database pool/connection and run migrations."""
    try:
        db = await get_db()
        logger.info("MultiUser: database ready (%s)", type(db).__name__)
    except Exception:
        logger.exception("MultiUser: failed to initialise database")

# Schedule DB init on the running event loop (available at import-time in ComfyUI)
loop = asyncio.get_event_loop()
loop.create_task(_init_db())

# ---------------------------------------------------------------------------
# Execution hooks for generation tracking
# ---------------------------------------------------------------------------

def _hook_execution_events():
    """
    Hook into PromptServer signals to track prompt lifecycle.

    ComfyUI's PromptServer provides an `on_prompt_handler` list — callables
    invoked with (json_data) when /prompt is POSTed. We also monkey-patch the
    send_sync method to capture execution status broadcasts.
    """
    original_send_sync = prompt_server.send_sync

    def patched_send_sync(event, data, sid=None):
        """Intercept status events to track prompt lifecycle."""
        try:
            if event == "execution_start":
                prompt_id = data.get("prompt_id")
                if prompt_id:
                    _fire_and_forget(on_prompt_started(prompt_id))

            elif event == "execution_success":
                prompt_id = data.get("prompt_id")
                if prompt_id:
                    # Try to gather output images/videos from the data
                    output_paths = None
                    outputs = data.get("output", {})
                    if outputs:
                        paths = []
                        for node_output in outputs.values():
                            # Capture images and video/gif outputs
                            for key in ("images", "gifs"):
                                items = node_output.get(key, [])
                                for item in items:
                                    if isinstance(item, dict) and "filename" in item:
                                        fname = item["filename"]
                                        subfolder = item.get("subfolder", "")
                                        # Store relative path (subfolder/filename) for unique identification
                                        if subfolder:
                                            paths.append(f"{subfolder}/{fname}")
                                        else:
                                            paths.append(fname)
                        output_paths = paths or None
                    _fire_and_forget(on_prompt_completed(prompt_id, output_paths))

            elif event == "execution_error":
                prompt_id = data.get("prompt_id")
                error_msg = data.get("exception_message", "")
                if prompt_id:
                    _fire_and_forget(on_prompt_error(prompt_id, str(error_msg)))

            elif event == "execution_interrupted":
                prompt_id = data.get("prompt_id")
                if prompt_id:
                    _fire_and_forget(on_prompt_error(prompt_id, "Interrupted"))

        except Exception:
            logger.exception("MultiUser: error in execution hook")

        # Always call the original
        return original_send_sync(event, data, sid)

    prompt_server.send_sync = patched_send_sync
    logger.info("MultiUser: execution tracking hooks installed")


def _hook_prompt_via_middleware():
    """
    Use a targeted middleware to intercept /prompt POST and tag generation tracking.
    This is cleaner than trying to replace route handlers.
    """
    import json as json_mod
    from aiohttp import web

    @web.middleware
    async def prompt_tracking_middleware(request: web.Request, handler):
        # Capture the main event loop on first request (runs in the aiohttp loop thread)
        global _main_loop
        if _main_loop is None or _main_loop.is_closed():
            _main_loop = asyncio.get_running_loop()

        # Only intercept POST /prompt (or /api/prompt)
        if request.method == "POST" and request.path in ("/prompt", "/api/prompt"):
            user = request.get("multiuser_user")

            if user and get_config("generations", "enabled", default=True):
                # Read and cache the body so downstream can re-read it
                body = await request.read()
                # aiohttp caches the result of read() internally, so subsequent
                # calls to request.read() / request.json() return the same bytes.

                try:
                    json_data = json_mod.loads(body)
                except (json_mod.JSONDecodeError, Exception):
                    json_data = {}

                # Call the original handler
                response = await handler(request)

                # After successful queue, track the generation
                if response.status == 200:
                    try:
                        resp_body = response.body
                        if isinstance(resp_body, bytes):
                            resp_data = json_mod.loads(resp_body)
                        else:
                            resp_data = {}

                        prompt_id = resp_data.get("prompt_id", "")
                        if prompt_id:
                            workflow_json = None
                            if get_config("generations", "store_prompts", default=True):
                                prompt_data = json_data.get("prompt")
                                if prompt_data:
                                    workflow_json = json_mod.dumps(prompt_data)

                            await on_prompt_queued(
                                prompt_id=prompt_id,
                                user_id=user["id"],
                                workflow_json=workflow_json,
                            )
                    except Exception:
                        logger.exception("MultiUser: error tracking prompt")

                return response

        return await handler(request)

    # Insert after auth + isolation middleware (position 2) so output-
    # rewriting happens before we record the prompt for tracking.
    prompt_server.app.middlewares.insert(2, prompt_tracking_middleware)
    logger.info("MultiUser: prompt tracking middleware installed")


# Install execution hooks
_hook_execution_events()

# Install prompt tracking
_hook_prompt_via_middleware()

# ---------------------------------------------------------------------------
# Cleanup on shutdown
# ---------------------------------------------------------------------------

async def _on_shutdown(app):
    """Cleanly close database connections on server shutdown."""
    try:
        await close_db()
        logger.info("MultiUser: database connections closed")
    except Exception:
        logger.exception("MultiUser: error closing database")

prompt_server.app.on_shutdown.append(_on_shutdown)

# ---------------------------------------------------------------------------
# Module exports for ComfyUI
# ---------------------------------------------------------------------------

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
