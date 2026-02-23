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
    "/multiuser/token-verify",
    "/multiuser/debug-auth",
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
    """Try to identify the user from headers or cookies (non-failing).

    Checks three sources in order:
      1. Authorization: Bearer header  (standard, but proxies may strip it)
      2. multiuser_session cookie      (HttpOnly, set by server Set-Cookie)
      3. multiuser_token cookie         (JS-set, bypasses proxy Set-Cookie issues)
    """
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
                logger.warning("Bearer JWT failed for %s %s (token_len=%d)",
                             request.method, request.path, len(token))

    # 2. HttpOnly session cookie (set by server)
    if user is None:
        cookie_token = request.cookies.get("multiuser_session")
        if cookie_token:
            user = await _get_user_from_jwt(cookie_token)
            if user is None:
                logger.debug("Session cookie JWT failed for %s", request.path)

    # 3. JS-set cookie — most reliable behind reverse proxies because it is
    #    set with document.cookie in the browser, not via Set-Cookie header.
    if user is None:
        from urllib.parse import unquote
        js_token = request.cookies.get("multiuser_token")
        if js_token:
            js_token = unquote(js_token)  # JS uses encodeURIComponent
            user = await _get_user_from_jwt(js_token)
            if user is None:
                logger.debug("JS cookie JWT failed for %s", request.path)
            else:
                logger.debug("Auth via JS cookie for %s %s", request.method, request.path)

    # 4. X-MultiUser-Token custom header — some proxies strip the standard
    #    Authorization header but pass through custom X- headers.
    if user is None:
        custom_token = request.headers.get("X-MultiUser-Token", "")
        if custom_token:
            user = await _get_user_from_jwt(custom_token)
            if user is None:
                logger.debug("X-MultiUser-Token header JWT failed for %s", request.path)
            else:
                logger.debug("Auth via X-MultiUser-Token header for %s %s", request.method, request.path)

    if user is None:
        has_creds = bool(auth_header or request.cookies.get("multiuser_session")
                         or request.cookies.get("multiuser_token")
                         or request.headers.get("X-MultiUser-Token"))
        if has_creds:
            logger.warning("All auth methods failed for %s %s (auth_hdr=%s, session_cookie=%s, js_cookie=%s, x_header=%s)",
                           request.method, request.path,
                           bool(auth_header), bool(request.cookies.get("multiuser_session")),
                           bool(request.cookies.get("multiuser_token")),
                           bool(request.headers.get("X-MultiUser-Token")))

    return user


def install_middleware(app: web.Application) -> None:
    """Install the auth middleware on the aiohttp app."""
    # Insert at the beginning so it runs first
    app.middlewares.insert(0, auth_middleware)
    logger.info("Auth middleware installed")
