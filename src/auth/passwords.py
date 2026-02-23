"""Password hashing and verification using bcrypt."""
import bcrypt
from ..config import get_config


def hash_password(password: str) -> str:
    """Hash a password with bcrypt."""
    cost = get_config("auth", "bcrypt_cost", default=12)
    salt = bcrypt.gensalt(rounds=cost)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password against its hash."""
    return bcrypt.checkpw(
        password.encode("utf-8"),
        password_hash.encode("utf-8")
    )
