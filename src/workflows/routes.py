"""Per-user workflow storage routes.

Users can save, list, load, and delete their own workflows server-side.
Admins can optionally view any user's workflows.
"""
import json
import logging
from aiohttp import web

from ..db.factory import get_db
from ..config import get_config

logger = logging.getLogger("comfyui-multiuser.workflows.routes")


def setup_workflow_routes(routes):
    """Register per-user workflow routes under /multiuser/workflows."""

    @routes.get("/multiuser/workflows")
    async def list_workflows(request: web.Request):
        """List the current user's saved workflows.

        Admins may pass ?user_id=X to list another user's workflows.
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        target_user_id = user["id"]
        if user.get("is_admin"):
            req_uid = request.query.get("user_id")
            if req_uid:
                target_user_id = int(req_uid)

        db = await get_db()
        workflows = await db.fetchall(
            """SELECT id, name, description, created_at, updated_at
               FROM user_workflows
               WHERE user_id = ?
               ORDER BY updated_at DESC""",
            (target_user_id,)
        )

        return web.json_response({"workflows": workflows})

    @routes.get("/multiuser/workflows/{wf_id}")
    async def get_workflow(request: web.Request):
        """Load a specific workflow (including JSON payload)."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        wf_id = int(request.match_info["wf_id"])
        db = await get_db()

        wf = await db.fetchone(
            """SELECT id, user_id, name, description, workflow_json,
                      created_at, updated_at
               FROM user_workflows WHERE id = ?""",
            (wf_id,)
        )

        if not wf:
            return web.json_response({"error": "Workflow not found"}, status=404)

        # Non-admins can only access their own
        if wf["user_id"] != user["id"] and not user.get("is_admin"):
            return web.json_response({"error": "Access denied"}, status=403)

        # Parse stored JSON
        try:
            wf["workflow_json"] = json.loads(wf["workflow_json"])
        except (json.JSONDecodeError, TypeError):
            pass

        return web.json_response(wf)

    @routes.post("/multiuser/workflows")
    async def save_workflow(request: web.Request):
        """Save a new workflow for the current user."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        name = data.get("name", "").strip()
        description = data.get("description", "").strip() or None
        workflow_json = data.get("workflow_json")

        if not name:
            return web.json_response({"error": "Workflow name is required"}, status=400)
        if not workflow_json:
            return web.json_response({"error": "workflow_json is required"}, status=400)

        # Ensure we store it as a JSON string
        if isinstance(workflow_json, dict):
            workflow_json = json.dumps(workflow_json)

        db = await get_db()

        # Upsert: if a workflow with the same name exists for this user, update it
        existing = await db.fetchone(
            "SELECT id FROM user_workflows WHERE user_id = ? AND name = ?",
            (user["id"], name),
        )

        if existing:
            await db.execute(
                """UPDATE user_workflows
                   SET workflow_json = ?, description = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?""",
                (workflow_json, description, existing["id"]),
            )
            wf_id = existing["id"]
            logger.info("User %s updated workflow '%s' (id=%d)", user["username"], name, wf_id)
            return web.json_response({"id": wf_id, "name": name, "updated": True})
        else:
            wf_id = await db.execute_returning_id(
                """INSERT INTO user_workflows (user_id, name, description, workflow_json)
                   VALUES (?, ?, ?, ?)""",
                (user["id"], name, description, workflow_json),
            )
            logger.info("User %s created workflow '%s' (id=%d)", user["username"], name, wf_id)
            return web.json_response({"id": wf_id, "name": name, "created": True}, status=201)

    @routes.put("/multiuser/workflows/{wf_id}")
    async def update_workflow(request: web.Request):
        """Update an existing workflow."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        wf_id = int(request.match_info["wf_id"])

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        db = await get_db()
        wf = await db.fetchone(
            "SELECT id, user_id FROM user_workflows WHERE id = ?", (wf_id,)
        )
        if not wf:
            return web.json_response({"error": "Workflow not found"}, status=404)
        if wf["user_id"] != user["id"] and not user.get("is_admin"):
            return web.json_response({"error": "Access denied"}, status=403)

        updates = []
        params = []

        if "name" in data:
            updates.append("name = ?")
            params.append(data["name"].strip())
        if "description" in data:
            updates.append("description = ?")
            params.append(data["description"].strip() or None)
        if "workflow_json" in data:
            wj = data["workflow_json"]
            if isinstance(wj, dict):
                wj = json.dumps(wj)
            updates.append("workflow_json = ?")
            params.append(wj)

        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(wf_id)
            await db.execute(
                f"UPDATE user_workflows SET {', '.join(updates)} WHERE id = ?",
                tuple(params),
            )

        return web.json_response({"success": True})

    @routes.delete("/multiuser/workflows/{wf_id}")
    async def delete_workflow(request: web.Request):
        """Delete a workflow."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        wf_id = int(request.match_info["wf_id"])
        db = await get_db()

        wf = await db.fetchone(
            "SELECT id, user_id, name FROM user_workflows WHERE id = ?", (wf_id,)
        )
        if not wf:
            return web.json_response({"error": "Workflow not found"}, status=404)
        if wf["user_id"] != user["id"] and not user.get("is_admin"):
            return web.json_response({"error": "Access denied"}, status=403)

        await db.execute("DELETE FROM user_workflows WHERE id = ?", (wf_id,))
        logger.info("User %s deleted workflow '%s'", user["username"], wf["name"])
        return web.json_response({"success": True})
