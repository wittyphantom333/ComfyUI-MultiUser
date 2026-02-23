"""Group management routes."""
import logging
from aiohttp import web
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.groups.routes")


def _require_admin(user: dict) -> None:
    if not user or not user.get("is_admin"):
        raise web.HTTPForbidden(
            text='{"error": "Admin access required"}',
            content_type="application/json"
        )


def setup_group_routes(routes):
    """Register group management routes."""

    @routes.get("/multiuser/groups")
    async def list_groups(request: web.Request):
        """List all groups. Any authenticated user can see groups."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        db = await get_db()
        groups = await db.fetchall(
            "SELECT id, name, description, is_system, created_at FROM groups ORDER BY name"
        )

        # Add member count
        for group in groups:
            count = await db.fetchval(
                "SELECT COUNT(*) FROM group_members WHERE group_id = ?",
                (group["id"],)
            )
            group["member_count"] = count

        return web.json_response({"groups": groups})

    @routes.get("/multiuser/groups/{group_id}")
    async def get_group(request: web.Request):
        """Get group details with members and permissions."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        group_id = int(request.match_info["group_id"])
        db = await get_db()

        group = await db.fetchone(
            "SELECT id, name, description, is_system, created_at FROM groups WHERE id = ?",
            (group_id,)
        )
        if not group:
            return web.json_response({"error": "Group not found"}, status=404)

        members = await db.fetchall(
            """SELECT u.id, u.username, u.is_admin, gm.added_at
               FROM users u
               JOIN group_members gm ON u.id = gm.user_id
               WHERE gm.group_id = ?
               ORDER BY u.username""",
            (group_id,)
        )

        permissions = await db.fetchall(
            """SELECT id, resource_type, resource_pattern, action, priority
               FROM permissions WHERE group_id = ?
               ORDER BY priority DESC, resource_type, resource_pattern""",
            (group_id,)
        )

        group["members"] = members
        group["permissions"] = permissions

        return web.json_response(group)

    @routes.post("/multiuser/groups")
    async def create_group(request: web.Request):
        """Create a new group (admin only)."""
        admin = request.get("multiuser_user")
        _require_admin(admin)

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        name = data.get("name", "").strip()
        description = data.get("description", "").strip() or None

        if not name or len(name) < 2:
            return web.json_response(
                {"error": "Group name must be at least 2 characters"}, status=400
            )

        db = await get_db()
        existing = await db.fetchone("SELECT id FROM groups WHERE name = ?", (name,))
        if existing:
            return web.json_response({"error": "Group name already exists"}, status=409)

        group_id = await db.execute_returning_id(
            "INSERT INTO groups (name, description) VALUES (?, ?)",
            (name, description)
        )

        logger.info("Admin %s created group '%s'", admin["username"], name)
        return web.json_response({
            "id": group_id,
            "name": name,
            "description": description,
        }, status=201)

    @routes.put("/multiuser/groups/{group_id}")
    async def update_group(request: web.Request):
        """Update a group (admin only)."""
        admin = request.get("multiuser_user")
        _require_admin(admin)
        group_id = int(request.match_info["group_id"])

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        db = await get_db()
        group = await db.fetchone(
            "SELECT id, is_system FROM groups WHERE id = ?", (group_id,)
        )
        if not group:
            return web.json_response({"error": "Group not found"}, status=404)

        updates = []
        params = []

        if "name" in data and not group["is_system"]:
            updates.append("name = ?")
            params.append(data["name"].strip())

        if "description" in data:
            updates.append("description = ?")
            params.append(data["description"].strip() or None)

        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(group_id)
            await db.execute(
                f"UPDATE groups SET {', '.join(updates)} WHERE id = ?",
                tuple(params)
            )

        return web.json_response({"success": True})

    @routes.delete("/multiuser/groups/{group_id}")
    async def delete_group(request: web.Request):
        """Delete a group (admin only). Cannot delete system groups."""
        admin = request.get("multiuser_user")
        _require_admin(admin)
        group_id = int(request.match_info["group_id"])

        db = await get_db()
        group = await db.fetchone(
            "SELECT id, is_system, name FROM groups WHERE id = ?", (group_id,)
        )
        if not group:
            return web.json_response({"error": "Group not found"}, status=404)
        if group["is_system"]:
            return web.json_response(
                {"error": "Cannot delete system groups"}, status=400
            )

        await db.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        logger.info("Admin %s deleted group '%s'", admin["username"], group["name"])
        return web.json_response({"success": True})

    # --- Group Membership ---

    @routes.post("/multiuser/groups/{group_id}/members")
    async def add_member(request: web.Request):
        """Add a user to a group (admin only)."""
        _require_admin(request.get("multiuser_user"))
        group_id = int(request.match_info["group_id"])

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        user_id = data.get("user_id")
        if not user_id:
            return web.json_response({"error": "user_id required"}, status=400)

        db = await get_db()
        await db.execute(
            "INSERT OR IGNORE INTO group_members (user_id, group_id) VALUES (?, ?)",
            (int(user_id), group_id)
        )
        return web.json_response({"success": True}, status=201)

    @routes.delete("/multiuser/groups/{group_id}/members/{user_id}")
    async def remove_member(request: web.Request):
        """Remove a user from a group (admin only)."""
        _require_admin(request.get("multiuser_user"))
        group_id = int(request.match_info["group_id"])
        user_id = int(request.match_info["user_id"])

        db = await get_db()
        await db.execute(
            "DELETE FROM group_members WHERE user_id = ? AND group_id = ?",
            (user_id, group_id)
        )
        return web.json_response({"success": True})
