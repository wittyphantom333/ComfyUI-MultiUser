"""Generation tracking — hooks into ComfyUI execution to record per-user history."""
import json
import logging
import time
from typing import Optional

from ..config import get_config
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.generations.tracker")

# In-flight prompts: prompt_id -> {user_id, started_at}
_active_prompts: dict[str, dict] = {}


async def on_prompt_queued(prompt_id: str, user_id: int, workflow_json: Optional[str] = None) -> None:
    """Called when a prompt is queued for execution."""
    if not get_config("generations", "enabled", default=True):
        return

    db = await get_db()

    store_prompts = get_config("generations", "store_prompts", default=True)
    wf_json = workflow_json if store_prompts else None

    await db.execute_returning_id(
        """INSERT INTO generations (user_id, prompt_id, workflow_json, status)
           VALUES (?, ?, ?, 'queued')""",
        (user_id, prompt_id, wf_json)
    )

    _active_prompts[prompt_id] = {
        "user_id": user_id,
        "started_at": None,
    }


async def on_prompt_started(prompt_id: str) -> None:
    """Called when a prompt begins execution."""
    if prompt_id not in _active_prompts:
        return

    _active_prompts[prompt_id]["started_at"] = time.time()

    db = await get_db()
    await db.execute(
        "UPDATE generations SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE prompt_id = ?",
        (prompt_id,)
    )


async def on_prompt_completed(prompt_id: str, output_paths: Optional[list[str]] = None) -> None:
    """Called when a prompt completes successfully."""
    info = _active_prompts.pop(prompt_id, None)
    execution_time_ms = None
    if info and info["started_at"]:
        execution_time_ms = int((time.time() - info["started_at"]) * 1000)

    paths_json = json.dumps(output_paths) if output_paths else None

    db = await get_db()
    await db.execute(
        """UPDATE generations SET 
           status = 'completed', completed_at = CURRENT_TIMESTAMP,
           execution_time_ms = ?, output_paths = ?
           WHERE prompt_id = ?""",
        (execution_time_ms, paths_json, prompt_id)
    )


async def on_prompt_error(prompt_id: str, error_message: str = "") -> None:
    """Called when a prompt execution fails."""
    info = _active_prompts.pop(prompt_id, None)
    execution_time_ms = None
    if info and info["started_at"]:
        execution_time_ms = int((time.time() - info["started_at"]) * 1000)

    db = await get_db()
    await db.execute(
        """UPDATE generations SET 
           status = 'error', completed_at = CURRENT_TIMESTAMP,
           execution_time_ms = ?, error_message = ?
           WHERE prompt_id = ?""",
        (execution_time_ms, error_message[:2000], prompt_id)
    )


def get_prompt_user(prompt_id: str) -> Optional[int]:
    """Get the user_id for an active prompt, or None."""
    info = _active_prompts.get(prompt_id)
    return info["user_id"] if info else None
