"""Permission management routes."""
import logging
from aiohttp import web
from ..db.factory import get_db
from .engine import clear_permission_cache, get_allowed_nodes

logger = logging.getLogger("comfyui-multiuser.permissions.routes")


def _require_admin(user: dict) -> None:
    if not user or not user.get("is_admin"):
        raise web.HTTPForbidden(
            text='{"error": "Admin access required"}',
            content_type="application/json"
        )


def setup_permission_routes(routes):
    """Register permission management routes."""

    @routes.get("/multiuser/permissions")
    async def list_all_permissions(request: web.Request):
        """List all permissions across all groups (admin only)."""
        _require_admin(request.get("multiuser_user"))
        db = await get_db()

        permissions = await db.fetchall(
            """SELECT p.id, p.group_id, g.name as group_name,
                      p.resource_type, p.resource_pattern, p.action, p.priority,
                      p.created_at
               FROM permissions p
               JOIN groups g ON p.group_id = g.id
               ORDER BY g.name, p.resource_type, p.priority DESC"""
        )
        return web.json_response({"permissions": permissions})

    @routes.get("/multiuser/permissions/group/{group_id}")
    async def list_group_permissions(request: web.Request):
        """List permissions for a specific group."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        group_id = int(request.match_info["group_id"])
        db = await get_db()

        permissions = await db.fetchall(
            """SELECT id, resource_type, resource_pattern, action, priority, created_at
               FROM permissions WHERE group_id = ?
               ORDER BY resource_type, priority DESC""",
            (group_id,)
        )
        return web.json_response({"permissions": permissions})

    @routes.post("/multiuser/permissions")
    async def create_permission(request: web.Request):
        """Create a new permission rule (admin only)."""
        admin = request.get("multiuser_user")
        _require_admin(admin)

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        group_id = data.get("group_id")
        resource_type = data.get("resource_type", "").strip()
        resource_pattern = data.get("resource_pattern", "").strip()
        action = data.get("action", "allow").strip()
        priority = int(data.get("priority", 0))

        if not group_id or not resource_type or not resource_pattern:
            return web.json_response(
                {"error": "group_id, resource_type, and resource_pattern are required"},
                status=400
            )

        if resource_type not in ("node", "model", "feature", "sidebar"):
            return web.json_response(
                {"error": "resource_type must be 'node', 'model', 'feature', or 'sidebar'"},
                status=400
            )

        if action not in ("allow", "deny"):
            return web.json_response(
                {"error": "action must be 'allow' or 'deny'"}, status=400
            )

        db = await get_db()

        # Verify group exists
        group = await db.fetchone("SELECT id FROM groups WHERE id = ?", (int(group_id),))
        if not group:
            return web.json_response({"error": "Group not found"}, status=404)

        perm_id = await db.execute_returning_id(
            """INSERT INTO permissions (group_id, resource_type, resource_pattern, action, priority)
               VALUES (?, ?, ?, ?, ?)""",
            (int(group_id), resource_type, resource_pattern, action, priority)
        )

        # Clear permission cache for all users in this group
        members = await db.fetchall(
            "SELECT user_id FROM group_members WHERE group_id = ?",
            (int(group_id),)
        )
        for member in members:
            clear_permission_cache(member["user_id"])

        logger.info(
            "Admin %s created permission: %s %s '%s' for group #%d (priority %d)",
            admin["username"], action, resource_type, resource_pattern, group_id, priority
        )

        return web.json_response({
            "id": perm_id,
            "group_id": group_id,
            "resource_type": resource_type,
            "resource_pattern": resource_pattern,
            "action": action,
            "priority": priority,
        }, status=201)

    @routes.put("/multiuser/permissions/{perm_id}")
    async def update_permission(request: web.Request):
        """Update a permission rule (admin only)."""
        _require_admin(request.get("multiuser_user"))
        perm_id = int(request.match_info["perm_id"])

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        db = await get_db()
        perm = await db.fetchone(
            "SELECT id, group_id FROM permissions WHERE id = ?", (perm_id,)
        )
        if not perm:
            return web.json_response({"error": "Permission not found"}, status=404)

        updates = []
        params = []

        for field in ("resource_pattern", "action", "resource_type"):
            if field in data:
                updates.append(f"{field} = ?")
                params.append(data[field])

        if "priority" in data:
            updates.append("priority = ?")
            params.append(int(data["priority"]))

        if updates:
            params.append(perm_id)
            await db.execute(
                f"UPDATE permissions SET {', '.join(updates)} WHERE id = ?",
                tuple(params)
            )

        # Clear cache
        clear_permission_cache()

        return web.json_response({"success": True})

    @routes.delete("/multiuser/permissions/{perm_id}")
    async def delete_permission(request: web.Request):
        """Delete a permission rule (admin only)."""
        _require_admin(request.get("multiuser_user"))
        perm_id = int(request.match_info["perm_id"])

        db = await get_db()
        perm = await db.fetchone(
            "SELECT id FROM permissions WHERE id = ?", (perm_id,)
        )
        if not perm:
            return web.json_response({"error": "Permission not found"}, status=404)

        await db.execute("DELETE FROM permissions WHERE id = ?", (perm_id,))
        clear_permission_cache()

        return web.json_response({"success": True})

    @routes.get("/multiuser/my-permissions")
    async def my_permissions(request: web.Request):
        """Get current user's effective allowed nodes list."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        # Get all registered node names from ComfyUI
        try:
            from nodes import NODE_CLASS_MAPPINGS
            all_nodes = list(NODE_CLASS_MAPPINGS.keys())
        except ImportError:
            all_nodes = []

        allowed = await get_allowed_nodes(
            user["id"], all_nodes, is_admin=bool(user.get("is_admin"))
        )

        return web.json_response({
            "allowed_nodes": allowed,
            "total_nodes": len(all_nodes),
            "is_admin": bool(user.get("is_admin")),
        })

    @routes.get("/multiuser/my-sidebar")
    async def my_sidebar(request: web.Request):
        """Return sidebar visibility rules for the current user.

        Uses a whitelist approach:
        - Built-in ComfyUI tabs and MultiUser tabs are approved by default.
        - If sidebar.default_hidden is true (default), any extension tab NOT
          explicitly approved is hidden for non-admin users.
        - Admins always see all tabs.
        - Per-group deny rules can hide even approved tabs.
        - Per-group allow rules approve unknown extension tabs.
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        # Admins always see everything
        if user.get("is_admin"):
            return web.json_response({
                "approved_tabs": [],
                "denied_tabs": [],
                "default_hidden": False,
                "is_admin": True,
            })

        from ..config import get_config
        default_hidden = get_config("sidebar", "default_hidden", default=True)
        global_hidden = get_config("sidebar", "hidden_tabs", default=[]) or []

        from .engine import get_user_permissions
        permissions = await get_user_permissions(user["id"])
        sidebar_perms = [p for p in permissions if p["resource_type"] == "sidebar"]

        # Collect allow and deny patterns from permissions
        approved = set()
        denied = set(global_hidden)
        for p in sidebar_perms:
            if p["action"] == "allow":
                approved.add(p["resource_pattern"])
            elif p["action"] == "deny":
                denied.add(p["resource_pattern"])

        return web.json_response({
            "approved_tabs": list(approved),
            "denied_tabs": list(denied),
            "default_hidden": bool(default_hidden),
            "is_admin": False,
        })
