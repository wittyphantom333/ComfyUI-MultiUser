"""JWT and API token management."""
import hashlib
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import jwt

from ..config import get_config


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
    return jwt.encode(payload, secret, algorithm="HS256")


def verify_jwt(token: str) -> Optional[dict[str, Any]]:
    """Verify and decode a JWT token. Returns payload or None."""
    secret = get_config("auth", "secret_key")
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"])
        if payload.get("type") != "session":
            return None
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
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
