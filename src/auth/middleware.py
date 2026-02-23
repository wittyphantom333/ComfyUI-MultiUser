"""aiohttp middleware for authentication on all ComfyUI routes."""
import logging
from aiohttp import web
from typing import Optional

from .tokens import verify_jwt, hash_api_token
from ..db.factory import get_db
from ..config import get_config

logger = logging.getLogger("comfyui-multiuser.auth.middleware")

# ---------------------------------------------------------------------------
# Instead of blocking everything and whitelisting public routes, we PROTECT
# specific sensitive routes and let everything else through.  This is critical
# because ComfyUI's Vue/Vite frontend makes many internal API calls during
# bootstrap (system_stats, object_info, settings, etc.) *before* any custom
# extension JS gets a chance to run.  If those calls are blocked the whole
# UI breaks.  Our login overlay — rendered by the JS extension once it loads
# — prevents the user from doing anything meaningful without authenticating.
# ---------------------------------------------------------------------------

# Routes / prefixes that ALWAYS require a valid session.
# Anything NOT listed here passes through to ComfyUI as normal.
PROTECTED_EXACT = {
    # Our own endpoints (except the auth ones listed in AUTH_PUBLIC)
}

PROTECTED_PREFIXES = (
    "/multiuser/",        # all multi-user management APIs
)

# Mutation endpoints in core ComfyUI that must be auth-gated
PROTECTED_MUTATIONS = {
    ("POST",   "/prompt"),         # queue a generation
    ("POST",   "/queue"),          # queue management
    ("DELETE",  "/queue"),         # clear queue
    ("POST",   "/upload/image"),   # upload files
    ("POST",   "/upload/mask"),
}

# Auth-related routes inside /multiuser/ that must remain public
AUTH_PUBLIC = {
    "/multiuser/login",
    "/multiuser/register",
    "/multiuser/health",
    "/multiuser/setup-status",
}


def _requires_auth(method: str, path: str) -> bool:
    """Return True if the given request needs a valid session."""
    # Auth endpoints are always open
    if path in AUTH_PUBLIC:
        return False

    # Everything under /multiuser/ is protected
    for prefix in PROTECTED_PREFIXES:
        if path.startswith(prefix):
            return True

    # Specific ComfyUI mutation endpoints
    if (method, path) in PROTECTED_MUTATIONS:
        return True

    # Check config for additional protected routes
    extra = get_config("server", "protected_routes", default=[])
    if path in extra:
        return True

    # Everything else (ComfyUI UI, read-only APIs, static assets) is open
    return False


async def _get_user_from_jwt(token: str) -> Optional[dict]:
    """Validate JWT and return user info."""
    payload = verify_jwt(token)
    if payload is None:
        logger.debug("JWT decode returned None (expired or invalid)")
        return None

    db = await get_db()
    user = await db.fetchone(
        "SELECT id, username, is_admin, is_active FROM users WHERE id = ?",
        (payload["sub"],)
    )
    if user is None:
        logger.warning("JWT valid for user_id=%s but user not found in DB", payload["sub"])
        return None
    if not user["is_active"]:
        logger.warning("JWT valid for user '%s' but account is disabled", user["username"])
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
    method = request.method
    path = request.path

    # --- Fast path: route does not need auth ---
    if not _requires_auth(method, path):
        # Still attach user info if a valid session exists (best-effort)
        user = await _try_identify_user(request)
        request["multiuser_user"] = user  # may be None — that's fine
        return await handler(request)

    # --- Protected route: credentials required ---
    user = await _try_identify_user(request)

    if user is None:
        logger.debug("Auth failed for protected route: %s %s", method, path)
        return web.json_response(
            {"error": "Authentication required"},
            status=401
        )

    logger.debug("Auth OK: %s %s (user=%s)", method, path, user.get("username"))
    request["multiuser_user"] = user
    return await handler(request)


async def _try_identify_user(request: web.Request) -> Optional[dict]:
    """Try to identify the user from headers or cookies (non-failing)."""
    user = None

    # 1. Authorization header (API tokens / Bearer JWT)
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        if token.startswith("cmu_"):
            user = await _get_user_from_api_token(token)
            if user is None:
                logger.debug("API token verification failed for %s (prefix=%s)",
                            request.path, token[:12])
        else:
            user = await _get_user_from_jwt(token)
            if user is None:
                logger.warning("Bearer JWT verification failed for %s %s (token_len=%d, prefix=%s)",
                             request.method, request.path, len(token), token[:20])

    # 2. Session cookie
    if user is None:
        cookie_token = request.cookies.get("multiuser_session")
        if cookie_token:
            user = await _get_user_from_jwt(cookie_token)
            if user is None:
                logger.debug("Cookie JWT verification failed for %s", request.path)
        elif auth_header:
            logger.debug("No session cookie for %s (had auth header but it failed)", request.path)

    if user is None and (auth_header or request.cookies.get("multiuser_session")):
        logger.debug("All auth methods failed for %s %s", request.method, request.path)

    return user


def install_middleware(app: web.Application) -> None:
    """Install the auth middleware on the aiohttp app."""
    # Insert at the beginning so it runs first
    app.middlewares.insert(0, auth_middleware)
    logger.info("Auth middleware installed")
