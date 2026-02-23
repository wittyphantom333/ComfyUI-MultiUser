"""Database factory - creates the appropriate database backend."""
import logging
from typing import Optional

from .base import Database
from ..config import get_config

logger = logging.getLogger("comfyui-multiuser.db")

# Singleton database instance
_db_instance: Optional[Database] = None


async def get_db() -> Database:
    """Get or create the database singleton."""
    global _db_instance
    if _db_instance is None:
        _db_instance = await create_db()
    return _db_instance


async def create_db() -> Database:
    """Create and initialize a database instance based on config."""
    backend = get_config("database", "backend", default="sqlite")

    if backend == "sqlite":
        from .sqlite_db import SQLiteDatabase
        db_path = get_config("database", "sqlite", "path")
        db = SQLiteDatabase(db_path)
    elif backend == "postgres":
        from .postgres_db import PostgresDatabase
        db = PostgresDatabase(
            host=get_config("database", "postgres", "host"),
            port=get_config("database", "postgres", "port"),
            database=get_config("database", "postgres", "database"),
            user=get_config("database", "postgres", "user"),
            password=get_config("database", "postgres", "password"),
        )
    else:
        raise ValueError(f"Unsupported database backend: {backend}")

    logger.info("Initializing %s database", backend)
    await db.initialize()
    return db


async def close_db() -> None:
    """Close the database connection."""
    global _db_instance
    if _db_instance is not None:
        await _db_instance.close()
        _db_instance = None
