"""User management routes (admin-only CRUD)."""
import logging
from aiohttp import web

from ..auth.passwords import hash_password
from ..config import get_config
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.users.routes")


def _require_admin(user: dict) -> None:
    """Raise 403 if user is not an admin."""
    if not user or not user.get("is_admin"):
        raise web.HTTPForbidden(
            text='{"error": "Admin access required"}',
            content_type="application/json"
        )


def setup_user_routes(routes):
    """Register user management routes."""

    @routes.get("/multiuser/users")
    async def list_users(request: web.Request):
        """List all users (admin only)."""
        _require_admin(request.get("multiuser_user"))
        db = await get_db()

        users = await db.fetchall(
            """SELECT u.id, u.username, u.email, u.is_active, u.is_admin,
                      u.created_at, u.last_login, u.failed_login_attempts
               FROM users u ORDER BY u.created_at DESC"""
        )

        # Attach groups for each user
        for user in users:
            groups = await db.fetchall(
                """SELECT g.id, g.name FROM groups g
                   JOIN group_members gm ON g.id = gm.group_id
                   WHERE gm.user_id = ?""",
                (user["id"],)
            )
            user["groups"] = groups

        return web.json_response({"users": users})

    @routes.get("/multiuser/users/{user_id}")
    async def get_user(request: web.Request):
        """Get a specific user (admin only)."""
        _require_admin(request.get("multiuser_user"))
        user_id = int(request.match_info["user_id"])
        db = await get_db()

        user = await db.fetchone(
            """SELECT id, username, email, is_active, is_admin,
                      created_at, last_login, failed_login_attempts
               FROM users WHERE id = ?""",
            (user_id,)
        )
        if not user:
            return web.json_response({"error": "User not found"}, status=404)

        groups = await db.fetchall(
            """SELECT g.id, g.name FROM groups g
               JOIN group_members gm ON g.id = gm.group_id
               WHERE gm.user_id = ?""",
            (user_id,)
        )
        user["groups"] = groups

        return web.json_response(user)

    @routes.post("/multiuser/users")
    async def create_user(request: web.Request):
        """Create a new user (admin only)."""
        admin = request.get("multiuser_user")
        _require_admin(admin)

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        username = data.get("username", "").strip()
        password = data.get("password", "")
        email = data.get("email", "").strip() or None
        is_admin = bool(data.get("is_admin", False))
        group_ids = data.get("group_ids", [])

        if not username or len(username) < 3:
            return web.json_response(
                {"error": "Username must be at least 3 characters"}, status=400
            )
        if len(password) < 8:
            return web.json_response(
                {"error": "Password must be at least 8 characters"}, status=400
            )

        db = await get_db()

        existing = await db.fetchone(
            "SELECT id FROM users WHERE username = ?", (username,)
        )
        if existing:
            return web.json_response(
                {"error": "Username already taken"}, status=409
            )

        pw_hash = hash_password(password)
        user_id = await db.execute_returning_id(
            """INSERT INTO users (username, email, password_hash, is_admin)
               VALUES (?, ?, ?, ?)""",
            (username, email, pw_hash, int(is_admin))
        )

        # Add to default group
        default_group_name = get_config("registration", "default_group", default="users")
        default_group = await db.fetchone(
            "SELECT id FROM groups WHERE name = ?", (default_group_name,)
        )
        if default_group:
            await db.execute(
                "INSERT OR IGNORE INTO group_members (user_id, group_id) VALUES (?, ?)",
                (user_id, default_group["id"])
            )

        # Add to admin group if admin
        if is_admin:
            admin_group = await db.fetchone(
                "SELECT id FROM groups WHERE name = 'admin'"
            )
            if admin_group:
                await db.execute(
                    "INSERT OR IGNORE INTO group_members (user_id, group_id) VALUES (?, ?)",
                    (user_id, admin_group["id"])
                )

        # Add to specified groups
        for gid in group_ids:
            await db.execute(
                "INSERT OR IGNORE INTO group_members (user_id, group_id) VALUES (?, ?)",
                (user_id, int(gid))
            )

        logger.info("Admin %s created user %s", admin["username"], username)
        return web.json_response({
            "id": user_id,
            "username": username,
            "is_admin": is_admin,
        }, status=201)

    @routes.put("/multiuser/users/{user_id}")
    async def update_user(request: web.Request):
        """Update a user (admin only)."""
        admin = request.get("multiuser_user")
        _require_admin(admin)
        user_id = int(request.match_info["user_id"])

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        db = await get_db()
        user = await db.fetchone("SELECT id FROM users WHERE id = ?", (user_id,))
        if not user:
            return web.json_response({"error": "User not found"}, status=404)

        updates = []
        params = []

        if "is_active" in data:
            updates.append("is_active = ?")
            params.append(int(data["is_active"]))

        if "is_admin" in data:
            updates.append("is_admin = ?")
            params.append(int(data["is_admin"]))

        if "email" in data:
            updates.append("email = ?")
            params.append(data["email"] or None)

        if "password" in data and data["password"]:
            if len(data["password"]) < 8:
                return web.json_response(
                    {"error": "Password must be at least 8 characters"}, status=400
                )
            updates.append("password_hash = ?")
            params.append(hash_password(data["password"]))

        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(user_id)
            await db.execute(
                f"UPDATE users SET {', '.join(updates)} WHERE id = ?",
                tuple(params)
            )

        # Update group memberships if provided
        if "group_ids" in data:
            # Remove existing memberships (except system groups kept by admin status)
            await db.execute(
                "DELETE FROM group_members WHERE user_id = ?", (user_id,)
            )
            for gid in data["group_ids"]:
                await db.execute(
                    "INSERT OR IGNORE INTO group_members (user_id, group_id) VALUES (?, ?)",
                    (user_id, int(gid))
                )

        logger.info("Admin %s updated user #%d", admin["username"], user_id)
        return web.json_response({"success": True})

    @routes.delete("/multiuser/users/{user_id}")
    async def delete_user(request: web.Request):
        """Delete a user (admin only)."""
        admin = request.get("multiuser_user")
        _require_admin(admin)
        user_id = int(request.match_info["user_id"])

        if user_id == admin["id"]:
            return web.json_response(
                {"error": "Cannot delete your own account"}, status=400
            )

        db = await get_db()
        user = await db.fetchone("SELECT id FROM users WHERE id = ?", (user_id,))
        if not user:
            return web.json_response({"error": "User not found"}, status=404)

        await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        logger.info("Admin %s deleted user #%d", admin["username"], user_id)
        return web.json_response({"success": True})

    @routes.post("/multiuser/users/{user_id}/unlock")
    async def unlock_user(request: web.Request):
        """Unlock a locked user account (admin only)."""
        _require_admin(request.get("multiuser_user"))
        user_id = int(request.match_info["user_id"])
        db = await get_db()
        await db.execute(
            "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
            (user_id,)
        )
        return web.json_response({"success": True})
