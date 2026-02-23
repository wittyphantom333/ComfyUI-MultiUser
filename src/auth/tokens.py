"""JWT and API token management."""
import hashlib
import logging
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import jwt

from ..config import get_config

logger = logging.getLogger("multiuser.tokens")


def create_jwt(user_id: int, username: str, is_admin: bool = False) -> str:
    """Create a JWT token for session authentication."""
    secret = get_config("auth", "secret_key")
    expiry_hours = get_config("auth", "token_expiry_hours", default=24)

    payload = {
        "sub": user_id,
        "username": username,
        "is_admin": is_admin,
        "iat": int(time.time()),
        "exp": int(time.time()) + (expiry_hours * 3600),
        "type": "session",
    }
    token = jwt.encode(payload, secret, algorithm="HS256")
    logger.info("Created JWT for user %s (id=%d), expires in %dh, secret prefix=%s",
                username, user_id, expiry_hours, secret[:8] if secret else "NONE")
    return token


def verify_jwt(token: str) -> Optional[dict[str, Any]]:
    """Verify and decode a JWT token. Returns payload or None."""
    secret = get_config("auth", "secret_key")
    logger.debug("Verifying JWT, token prefix=%s, secret prefix=%s",
                 token[:20] if token else "NONE", secret[:8] if secret else "NONE")
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"])
        if payload.get("type") != "session":
            logger.warning("JWT valid but type=%s (expected 'session')", payload.get("type"))
            return None
        logger.debug("JWT verified OK for user %s (id=%s)", payload.get("username"), payload.get("sub"))
        return payload
    except jwt.ExpiredSignatureError:
        logger.info("JWT expired for token prefix=%s", token[:20] if token else "?")
        return None
    except jwt.InvalidTokenError as e:
        logger.warning("JWT invalid: %s, token prefix=%s", e, token[:20] if token else "?")
        return None


def generate_api_token() -> tuple[str, str, str]:
    """Generate a new API token.
    
    Returns:
        (full_token, token_hash, prefix) where:
        - full_token: the token to give to the user (shown once)
        - token_hash: SHA-256 hash to store in DB
        - prefix: first 8 chars for identification
    """
    raw_token = secrets.token_urlsafe(48)
    full_token = f"cmu_{raw_token}"  # cmu = ComfyUI MultiUser
    prefix = full_token[:12]
    token_hash = hash_api_token(full_token)
    return full_token, token_hash, prefix


def hash_api_token(token: str) -> str:
    """Hash an API token for storage."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def get_api_token_expiry() -> Optional[datetime]:
    """Get expiry datetime for new API tokens, or None if no expiry."""
    days = get_config("auth", "api_token_expiry_days", default=0)
    if days <= 0:
        return None
    return datetime.now(timezone.utc) + timedelta(days=days)
