"""Authentication routes: login, register, logout, token management."""
import logging
from datetime import datetime, timezone
from aiohttp import web

from .passwords import hash_password, verify_password
from .tokens import create_jwt, generate_api_token, get_api_token_expiry, hash_api_token
from ..config import get_config
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.auth.routes")


def _set_session_cookie(response: web.Response, token: str) -> None:
    """Set the session cookie with proper attributes for both HTTP and HTTPS."""
    secure = get_config("auth", "cookie_secure", default=True)
    samesite = get_config("auth", "cookie_samesite", default="Lax")
    response.set_cookie(
        "multiuser_session", token,
        path="/",
        httponly=True,
        secure=secure,
        samesite=samesite,
        max_age=get_config("auth", "session_lifetime_hours", default=24) * 3600,
    )


def _clear_session_cookie(response: web.Response) -> None:
    """Clear the session cookie."""
    response.del_cookie("multiuser_session", path="/")


def setup_auth_routes(routes):
    """Register auth-related routes."""

    @routes.get("/multiuser/setup-status")
    async def setup_status(request: web.Request):
        """Check if initial setup is needed (no users exist yet)."""
        db = await get_db()
        count = await db.fetchval("SELECT COUNT(*) FROM users")
        return web.json_response({
            "needs_setup": count == 0,
            "registration_mode": get_config("registration", "mode", default="open"),
        })

    @routes.post("/multiuser/register")
    async def register(request: web.Request):
        """Register a new user."""
        db = await get_db()
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        username = data.get("username", "").strip()
        password = data.get("password", "")
        email = data.get("email", "").strip() or None

        # Validation
        if not username or len(username) < 3:
            return web.json_response(
                {"error": "Username must be at least 3 characters"}, status=400
            )
        if len(password) < 8:
            return web.json_response(
                {"error": "Password must be at least 8 characters"}, status=400
            )

        # Check registration mode
        user_count = await db.fetchval("SELECT COUNT(*) FROM users")
        is_first_user = user_count == 0

        if not is_first_user:
            mode = get_config("registration", "mode", default="open")
            if mode == "invite":
                # Check if user has an invite (authenticated admin creating account)
                current_user = request.get("multiuser_user")
                if not current_user or not current_user.get("is_admin"):
                    return web.json_response(
                        {"error": "Registration is invite-only. Contact an administrator."},
                        status=403
                    )

        # Check if email is required
        if get_config("registration", "require_email", default=False) and not email:
            return web.json_response(
                {"error": "Email is required"}, status=400
            )

        # Check uniqueness
        existing = await db.fetchone(
            "SELECT id FROM users WHERE username = ?", (username,)
        )
        if existing:
            return web.json_response(
                {"error": "Username already taken"}, status=409
            )

        # Create user
        pw_hash = hash_password(password)
        is_admin = 1 if is_first_user else 0

        user_id = await db.execute_returning_id(
            """INSERT INTO users (username, email, password_hash, is_admin)
               VALUES (?, ?, ?, ?)""",
            (username, email, pw_hash, is_admin)
        )

        # Add to default group(s)
        if is_first_user:
            # First user gets admin + users group
            admin_group = await db.fetchone(
                "SELECT id FROM groups WHERE name = 'admin'"
            )
            if admin_group:
                await db.execute(
                    "INSERT INTO group_members (user_id, group_id) VALUES (?, ?)",
                    (user_id, admin_group["id"])
                )
        
        # All users get the default group
        default_group_name = get_config("registration", "default_group", default="users")
        default_group = await db.fetchone(
            "SELECT id FROM groups WHERE name = ?", (default_group_name,)
        )
        if default_group:
            await db.execute(
                "INSERT OR IGNORE INTO group_members (user_id, group_id) VALUES (?, ?)",
                (user_id, default_group["id"])
            )

        logger.info("New user registered: %s (admin=%s)", username, bool(is_admin))

        # Auto-login after registration
        token = create_jwt(user_id, username, bool(is_admin))
        response = web.json_response({
            "success": True,
            "token": token,
            "user": {
                "id": user_id,
                "username": username,
                "is_admin": bool(is_admin),
            }
        }, status=201)
        _set_session_cookie(response, token)
        return response

    @routes.post("/multiuser/login")
    async def login(request: web.Request):
        """Authenticate and return a session token."""
        db = await get_db()
        try:
            data = await request.json()
        except Exception:
            logger.warning("Login: invalid JSON body")
            return web.json_response({"error": "Invalid JSON"}, status=400)

        username = data.get("username", "").strip()
        password = data.get("password", "")

        if not username or not password:
            logger.warning("Login: missing username or password")
            return web.json_response(
                {"error": "Username and password required"}, status=400
            )

        logger.info("Login attempt for user: %s", username)

        user = await db.fetchone(
            "SELECT * FROM users WHERE username = ?", (username,)
        )
        if user is None:
            logger.warning("Login: user '%s' not found", username)
            return web.json_response(
                {"error": "Invalid username or password"}, status=401
            )

        # Check lockout
        if user["locked_until"]:
            locked_until = user["locked_until"]
            if isinstance(locked_until, str):
                locked_until = datetime.fromisoformat(locked_until)
            if locked_until.tzinfo is None:
                locked_until = locked_until.replace(tzinfo=timezone.utc)
            if locked_until > datetime.now(timezone.utc):
                return web.json_response(
                    {"error": "Account temporarily locked. Try again later."},
                    status=429
                )
            else:
                # Lockout expired, reset attempts
                await db.execute(
                    "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
                    (user["id"],)
                )

        if not user["is_active"]:
            return web.json_response(
                {"error": "Account is disabled"}, status=403
            )

        if not verify_password(password, user["password_hash"]):
            # Increment failed attempts
            attempts = user["failed_login_attempts"] + 1
            max_attempts = get_config("auth", "max_login_attempts", default=5)
            lockout_minutes = get_config("auth", "lockout_duration_minutes", default=15)

            if attempts >= max_attempts:
                from datetime import timedelta
                locked_until = datetime.now(timezone.utc) + timedelta(minutes=lockout_minutes)
                await db.execute(
                    "UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?",
                    (attempts, locked_until.isoformat(), user["id"])
                )
                return web.json_response(
                    {"error": "Too many failed attempts. Account locked temporarily."},
                    status=429
                )
            else:
                await db.execute(
                    "UPDATE users SET failed_login_attempts = ? WHERE id = ?",
                    (attempts, user["id"])
                )

            return web.json_response(
                {"error": "Invalid username or password"}, status=401
            )

        # Successful login - reset failed attempts
        logger.info("Login successful for user: %s (id=%d)", user["username"], user["id"])
        await db.execute(
            """UPDATE users SET 
               failed_login_attempts = 0, locked_until = NULL,
               last_login = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (user["id"],)
        )

        token = create_jwt(user["id"], user["username"], bool(user["is_admin"]))
        response = web.json_response({
            "success": True,
            "token": token,
            "user": {
                "id": user["id"],
                "username": user["username"],
                "is_admin": bool(user["is_admin"]),
            }
        })
        _set_session_cookie(response, token)
        return response

    @routes.post("/multiuser/logout")
    async def logout(request: web.Request):
        """Clear the session cookie."""
        response = web.json_response({"success": True})
        _clear_session_cookie(response)
        return response

    @routes.post("/multiuser/token-verify")
    async def token_verify(request: web.Request):
        """Verify a JWT token sent in the request body.

        This is the most reliable auth check behind reverse proxies because
        POST bodies are *never* stripped, unlike Authorization headers or
        cookies which proxies can mangle.
        """
        from .tokens import verify_jwt_detailed

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        token = data.get("token", "")
        if not token:
            return web.json_response({"error": "Token required"}, status=400)

        payload, reason = verify_jwt_detailed(token)
        if payload is None:
            logger.debug("token-verify: JWT rejected — %s", reason)
            return web.json_response(
                {"error": f"Invalid or expired token", "reason": reason},
                status=401,
            )

        db = await get_db()
        user = await db.fetchone(
            "SELECT id, username, is_admin, is_active FROM users WHERE id = ?",
            (payload["sub"],)
        )
        if user is None or not user["is_active"]:
            return web.json_response({"error": "User not found or disabled"}, status=401)

        # Get groups
        groups = await db.fetchall(
            """SELECT g.id, g.name, g.description
               FROM groups g
               JOIN group_members gm ON g.id = gm.group_id
               WHERE gm.user_id = ?""",
            (user["id"],)
        )

        logger.debug("token-verify: OK for user %s", user["username"])
        return web.json_response({
            "id": user["id"],
            "username": user["username"],
            "is_admin": bool(user["is_admin"]),
            "groups": [{"id": g["id"], "name": g["name"], "description": g["description"]} for g in groups],
        })

    @routes.get("/multiuser/me")
    async def me(request: web.Request):
        """Get current user info."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        db = await get_db()
        # Get user's groups
        groups = await db.fetchall(
            """SELECT g.id, g.name, g.description
               FROM groups g
               JOIN group_members gm ON g.id = gm.group_id
               WHERE gm.user_id = ?""",
            (user["id"],)
        )

        return web.json_response({
            "id": user["id"],
            "username": user["username"],
            "is_admin": bool(user["is_admin"]),
            "groups": [{"id": g["id"], "name": g["name"], "description": g["description"]} for g in groups],
        })

    # --- API Token Management ---

    @routes.get("/multiuser/api-tokens")
    async def list_api_tokens(request: web.Request):
        """List current user's API tokens (without the actual token)."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        db = await get_db()
        tokens = await db.fetchall(
            """SELECT id, name, prefix, is_active, expires_at, created_at, last_used_at
               FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC""",
            (user["id"],)
        )
        return web.json_response({"tokens": tokens})

    @routes.post("/multiuser/api-tokens")
    async def create_api_token(request: web.Request):
        """Create a new API token for the current user."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        try:
            data = await request.json()
        except Exception:
            data = {}

        name = data.get("name", "API Token").strip()

        full_token, token_hash, prefix = generate_api_token()
        expires_at = get_api_token_expiry()

        db = await get_db()
        token_id = await db.execute_returning_id(
            """INSERT INTO api_tokens (user_id, token_hash, name, prefix, expires_at)
               VALUES (?, ?, ?, ?, ?)""",
            (user["id"], token_hash, name, prefix,
             expires_at.isoformat() if expires_at else None)
        )

        logger.info("API token created for user %s: %s", user["username"], prefix)

        return web.json_response({
            "id": token_id,
            "token": full_token,  # Only shown once!
            "name": name,
            "prefix": prefix,
            "expires_at": expires_at.isoformat() if expires_at else None,
            "warning": "Save this token now. It will not be shown again.",
        }, status=201)

    @routes.delete("/multiuser/api-tokens/{token_id}")
    async def revoke_api_token(request: web.Request):
        """Revoke an API token."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        token_id = int(request.match_info["token_id"])
        db = await get_db()

        # Verify ownership
        token = await db.fetchone(
            "SELECT user_id FROM api_tokens WHERE id = ?", (token_id,)
        )
        if not token or (token["user_id"] != user["id"] and not user.get("is_admin")):
            return web.json_response({"error": "Not found"}, status=404)

        await db.execute(
            "UPDATE api_tokens SET is_active = 0 WHERE id = ?", (token_id,)
        )
        return web.json_response({"success": True})

    @routes.post("/multiuser/change-password")
    async def change_password(request: web.Request):
        """Change current user's password."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        current_password = data.get("current_password", "")
        new_password = data.get("new_password", "")

        if len(new_password) < 8:
            return web.json_response(
                {"error": "New password must be at least 8 characters"}, status=400
            )

        db = await get_db()
        user_row = await db.fetchone(
            "SELECT password_hash FROM users WHERE id = ?", (user["id"],)
        )
        if not verify_password(current_password, user_row["password_hash"]):
            return web.json_response(
                {"error": "Current password is incorrect"}, status=401
            )

        new_hash = hash_password(new_password)
        await db.execute(
            "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_hash, user["id"])
        )

        return web.json_response({"success": True})
