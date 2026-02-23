"""SQLite database implementation for ComfyUI-MultiUser."""
import aiosqlite
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from .base import Database
from .schema import SCHEMA_VERSION, get_schema_sql, get_migrations_for_version

logger = logging.getLogger("comfyui-multiuser.db.sqlite")


class SQLiteDatabase(Database):
    """SQLite implementation using aiosqlite."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._conn: Optional[aiosqlite.Connection] = None

    async def initialize(self) -> None:
        """Initialize database, create tables, run migrations."""
        # Ensure data directory exists
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

        self._conn = await aiosqlite.connect(self.db_path)
        self._conn.row_factory = aiosqlite.Row

        # Enable WAL mode for better concurrent access
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")

        # Check current schema version
        current_version = await self._get_schema_version()

        if current_version == 0:
            # Fresh install - create all tables
            logger.info("Creating database schema v%d", SCHEMA_VERSION)
            for sql in get_schema_sql("sqlite"):
                await self._conn.execute(sql)
            await self._conn.execute(
                "INSERT INTO schema_version (version) VALUES (?)",
                (SCHEMA_VERSION,)
            )
            await self._conn.commit()
            logger.info("Database schema created successfully")
        elif current_version < SCHEMA_VERSION:
            # Run migrations
            logger.info("Migrating database from v%d to v%d", current_version, SCHEMA_VERSION)
            migrations = get_migrations_for_version(current_version, SCHEMA_VERSION, "sqlite")
            for sql in migrations:
                await self._conn.execute(sql)
            await self._conn.execute(
                "INSERT INTO schema_version (version) VALUES (?)",
                (SCHEMA_VERSION,)
            )
            await self._conn.commit()
            logger.info("Database migration complete")
        else:
            logger.info("Database schema is up to date (v%d)", current_version)

    async def _get_schema_version(self) -> int:
        """Get the current schema version, 0 if no schema exists."""
        try:
            cursor = await self._conn.execute(
                "SELECT MAX(version) FROM schema_version"
            )
            row = await cursor.fetchone()
            return row[0] if row and row[0] is not None else 0
        except aiosqlite.OperationalError:
            return 0

    async def close(self) -> None:
        """Close the database connection."""
        if self._conn:
            await self._conn.close()
            self._conn = None

    async def execute(self, query: str, params: tuple = ()) -> None:
        """Execute a query without returning results."""
        await self._conn.execute(query, params)
        await self._conn.commit()

    async def execute_returning_id(self, query: str, params: tuple = ()) -> int:
        """Execute an INSERT and return the new row's ID."""
        cursor = await self._conn.execute(query, params)
        await self._conn.commit()
        return cursor.lastrowid

    async def fetchone(self, query: str, params: tuple = ()) -> Optional[dict[str, Any]]:
        """Execute a query and return a single row as a dict."""
        cursor = await self._conn.execute(query, params)
        row = await cursor.fetchone()
        if row is None:
            return None
        return dict(row)

    async def fetchall(self, query: str, params: tuple = ()) -> list[dict[str, Any]]:
        """Execute a query and return all rows as list of dicts."""
        cursor = await self._conn.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def fetchval(self, query: str, params: tuple = (), column: int = 0) -> Any:
        """Execute a query and return a single value."""
        cursor = await self._conn.execute(query, params)
        row = await cursor.fetchone()
        if row is None:
            return None
        return row[column]

    async def executemany(self, query: str, params_list: list[tuple]) -> None:
        """Execute a query with multiple parameter sets."""
        await self._conn.executemany(query, params_list)
        await self._conn.commit()

    @asynccontextmanager
    async def transaction(self):
        """Context manager for transactions."""
        await self._conn.execute("BEGIN")
        try:
            yield self
            await self._conn.commit()
        except Exception:
            await self._conn.rollback()
            raise

    def placeholder(self, index: int) -> str:
        """SQLite uses ? for all placeholders."""
        return "?"
