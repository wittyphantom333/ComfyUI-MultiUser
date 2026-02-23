"""External token vault routes — group-level shared API keys for external services."""
import logging
import base64
import hashlib
from cryptography.fernet import Fernet
from aiohttp import web

from ..config import get_config
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.tokens.routes")


def _get_cipher() -> Fernet:
    """Get Fernet cipher from the auth secret key."""
    secret = get_config("auth", "secret_key")
    # Derive a 32-byte key from the secret for Fernet
    key = hashlib.sha256(secret.encode()).digest()
    fernet_key = base64.urlsafe_b64encode(key)
    return Fernet(fernet_key)


def _encrypt_token(plaintext: str) -> str:
    """Encrypt an external API token for storage."""
    cipher = _get_cipher()
    return cipher.encrypt(plaintext.encode()).decode()


def _decrypt_token(ciphertext: str) -> str:
    """Decrypt an external API token from storage."""
    cipher = _get_cipher()
    return cipher.decrypt(ciphertext.encode()).decode()


def _require_admin(user: dict) -> None:
    if not user or not user.get("is_admin"):
        raise web.HTTPForbidden(
            text='{"error": "Admin access required"}',
            content_type="application/json"
        )


def setup_ext_token_routes(routes):
    """Register external token vault routes."""

    @routes.get("/multiuser/ext-tokens")
    async def list_ext_tokens(request: web.Request):
        """List external tokens visible to the current user.
        
        Admins see all tokens. Regular users see tokens for their groups.
        The actual token values are NOT returned, only metadata.
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        db = await get_db()

        if user.get("is_admin"):
            tokens = await db.fetchall(
                """SELECT et.id, et.group_id, g.name as group_name,
                          et.service_name, et.description,
                          et.created_at, et.updated_at,
                          u.username as created_by_username
                   FROM ext_tokens et
                   JOIN groups g ON et.group_id = g.id
                   LEFT JOIN users u ON et.created_by = u.id
                   ORDER BY g.name, et.service_name"""
            )
        else:
            tokens = await db.fetchall(
                """SELECT et.id, et.group_id, g.name as group_name,
                          et.service_name, et.description,
                          et.created_at, et.updated_at
                   FROM ext_tokens et
                   JOIN groups g ON et.group_id = g.id
                   JOIN group_members gm ON g.id = gm.group_id
                   WHERE gm.user_id = ?
                   ORDER BY g.name, et.service_name""",
                (user["id"],)
            )

        return web.json_response({"tokens": tokens})

    @routes.get("/multiuser/ext-tokens/{token_id}")
    async def get_ext_token_value(request: web.Request):
        """Get the decrypted value of an external token.
        
        Only users in the token's group can access it.
        This is used internally when extensions need the token.
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        token_id = int(request.match_info["token_id"])
        db = await get_db()

        token = await db.fetchone(
            """SELECT et.*, g.name as group_name 
               FROM ext_tokens et
               JOIN groups g ON et.group_id = g.id
               WHERE et.id = ?""",
            (token_id,)
        )
        if not token:
            return web.json_response({"error": "Token not found"}, status=404)

        # Check access: admin or member of the group
        if not user.get("is_admin"):
            membership = await db.fetchone(
                "SELECT id FROM group_members WHERE user_id = ? AND group_id = ?",
                (user["id"], token["group_id"])
            )
            if not membership:
                return web.json_response({"error": "Not authorized"}, status=403)

        try:
            decrypted = _decrypt_token(token["token_encrypted"])
        except Exception:
            return web.json_response(
                {"error": "Failed to decrypt token"}, status=500
            )

        return web.json_response({
            "service_name": token["service_name"],
            "token": decrypted,
            "group_name": token["group_name"],
        })

    @routes.get("/multiuser/ext-tokens/service/{service_name}")
    async def get_ext_token_by_service(request: web.Request):
        """Get external token value by service name for current user's groups.
        
        This is the primary endpoint extensions will use to retrieve their tokens.
        Returns the first matching token from any of the user's groups.
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        service_name = request.match_info["service_name"]
        db = await get_db()

        if user.get("is_admin"):
            token = await db.fetchone(
                """SELECT et.token_encrypted, et.service_name, g.name as group_name
                   FROM ext_tokens et
                   JOIN groups g ON et.group_id = g.id
                   WHERE et.service_name = ?
                   ORDER BY g.name LIMIT 1""",
                (service_name,)
            )
        else:
            token = await db.fetchone(
                """SELECT et.token_encrypted, et.service_name, g.name as group_name
                   FROM ext_tokens et
                   JOIN groups g ON et.group_id = g.id
                   JOIN group_members gm ON g.id = gm.group_id
                   WHERE gm.user_id = ? AND et.service_name = ?
                   ORDER BY g.name LIMIT 1""",
                (user["id"], service_name)
            )

        if not token:
            return web.json_response({"error": "Token not found"}, status=404)

        try:
            decrypted = _decrypt_token(token["token_encrypted"])
        except Exception:
            return web.json_response(
                {"error": "Failed to decrypt token"}, status=500
            )

        return web.json_response({
            "service_name": token["service_name"],
            "token": decrypted,
            "group_name": token["group_name"],
        })

    @routes.post("/multiuser/ext-tokens")
    async def create_ext_token(request: web.Request):
        """Create or update an external token for a group (admin only)."""
        admin = request.get("multiuser_user")
        _require_admin(admin)

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        group_id = data.get("group_id")
        service_name = data.get("service_name", "").strip()
        token_value = data.get("token", "").strip()
        description = data.get("description", "").strip() or None

        if not group_id or not service_name or not token_value:
            return web.json_response(
                {"error": "group_id, service_name, and token are required"},
                status=400
            )

        db = await get_db()

        # Verify group exists
        group = await db.fetchone("SELECT id FROM groups WHERE id = ?", (int(group_id),))
        if not group:
            return web.json_response({"error": "Group not found"}, status=404)

        encrypted = _encrypt_token(token_value)

        # Upsert — update if exists for this group+service, else insert
        existing = await db.fetchone(
            "SELECT id FROM ext_tokens WHERE group_id = ? AND service_name = ?",
            (int(group_id), service_name)
        )

        if existing:
            await db.execute(
                """UPDATE ext_tokens 
                   SET token_encrypted = ?, description = ?,
                       created_by = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?""",
                (encrypted, description, admin["id"], existing["id"])
            )
            token_id = existing["id"]
        else:
            token_id = await db.execute_returning_id(
                """INSERT INTO ext_tokens (group_id, service_name, token_encrypted, description, created_by)
                   VALUES (?, ?, ?, ?, ?)""",
                (int(group_id), service_name, encrypted, description, admin["id"])
            )

        logger.info(
            "Admin %s set ext token '%s' for group #%d",
            admin["username"], service_name, group_id
        )

        return web.json_response({
            "id": token_id,
            "service_name": service_name,
            "group_id": group_id,
        }, status=201)

    @routes.delete("/multiuser/ext-tokens/{token_id}")
    async def delete_ext_token(request: web.Request):
        """Delete an external token (admin only)."""
        _require_admin(request.get("multiuser_user"))
        token_id = int(request.match_info["token_id"])

        db = await get_db()
        await db.execute("DELETE FROM ext_tokens WHERE id = ?", (token_id,))
        return web.json_response({"success": True})
