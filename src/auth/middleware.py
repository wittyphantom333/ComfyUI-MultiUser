"""aiohttp middleware for authentication on all ComfyUI routes."""
import logging
from aiohttp import web
from typing import Optional

from .tokens import verify_jwt, hash_api_token
from ..db.factory import get_db
from ..config import get_config

logger = logging.getLogger("comfyui-multiuser.auth.middleware")

# Routes that never require authentication
ALWAYS_PUBLIC = {
    "/multiuser/login",
    "/multiuser/register",
    "/multiuser/health",
    "/multiuser/setup-status",
}

# Route prefixes for static assets that don't need auth
PUBLIC_PREFIXES = (
    "/multiuser/static/",
)


def _is_public_route(path: str) -> bool:
    """Check if a route is public (no auth required)."""
    if path in ALWAYS_PUBLIC:
        return True
    for prefix in PUBLIC_PREFIXES:
        if path.startswith(prefix):
            return True
    # Check config for additional public routes
    extra = get_config("server", "public_routes", default=[])
    if path in extra:
        return True
    return False


async def _get_user_from_jwt(token: str) -> Optional[dict]:
    """Validate JWT and return user info."""
    payload = verify_jwt(token)
    if payload is None:
        return None

    db = await get_db()
    user = await db.fetchone(
        "SELECT id, username, is_admin, is_active FROM users WHERE id = ?",
        (payload["sub"],)
    )
    if user is None or not user["is_active"]:
        return None
    return user


async def _get_user_from_api_token(token: str) -> Optional[dict]:
    """Validate API token and return user info."""
    token_hash = hash_api_token(token)
    db = await get_db()

    token_row = await db.fetchone(
        """SELECT t.id, t.user_id, t.is_active, t.expires_at,
                  u.username, u.is_admin, u.is_active as user_active
           FROM api_tokens t
           JOIN users u ON t.user_id = u.id
           WHERE t.token_hash = ?""",
        (token_hash,)
    )
    if token_row is None:
        return None
    if not token_row["is_active"] or not token_row["user_active"]:
        return None

    # Check expiry
    if token_row["expires_at"]:
        from datetime import datetime, timezone
        expires = token_row["expires_at"]
        if isinstance(expires, str):
            expires = datetime.fromisoformat(expires)
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires < datetime.now(timezone.utc):
            return None

    # Update last_used_at
    await db.execute(
        "UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?",
        (token_row["id"],)
    )

    return {
        "id": token_row["user_id"],
        "username": token_row["username"],
        "is_admin": token_row["is_admin"],
        "is_active": token_row["user_active"],
    }


@web.middleware
async def auth_middleware(request: web.Request, handler):
    """Middleware that checks authentication on every request."""
    path = request.path

    # Allow public routes
    if _is_public_route(path):
        request["multiuser_user"] = None
        return await handler(request)

    # Try to authenticate: first check Authorization header, then cookie
    user = None

    # 1. Check Authorization header (API tokens and Bearer JWT)
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        if token.startswith("cmu_"):
            # API token
            user = await _get_user_from_api_token(token)
        else:
            # JWT token
            user = await _get_user_from_jwt(token)

    # 2. Check cookie
    if user is None:
        cookie_token = request.cookies.get("multiuser_session")
        if cookie_token:
            user = await _get_user_from_jwt(cookie_token)

    if user is None:
        # Check if this is an API request or browser request
        accept = request.headers.get("Accept", "")
        if "text/html" in accept and not path.startswith("/api/"):
            # Browser request - redirect to login
            raise web.HTTPFound("/multiuser/login")
        else:
            # API request - return 401
            return web.json_response(
                {"error": "Authentication required"},
                status=401
            )

    # Attach user to request for downstream handlers
    request["multiuser_user"] = user
    return await handler(request)


def install_middleware(app: web.Application) -> None:
    """Install the auth middleware on the aiohttp app."""
    # Insert at the beginning so it runs first
    app.middlewares.insert(0, auth_middleware)
    logger.info("Auth middleware installed")
