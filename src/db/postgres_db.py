"""PostgreSQL database implementation for ComfyUI-MultiUser."""
import logging
from contextlib import asynccontextmanager
from typing import Any, Optional

from .base import Database
from .schema import SCHEMA_VERSION, get_schema_sql, get_migrations_for_version

logger = logging.getLogger("comfyui-multiuser.db.postgres")


class PostgresDatabase(Database):
    """PostgreSQL implementation using asyncpg."""

    def __init__(self, host: str, port: int, database: str, user: str, password: str):
        self._host = host
        self._port = port
        self._database = database
        self._user = user
        self._password = password
        self._pool = None

    async def initialize(self) -> None:
        """Initialize database connection pool, create tables, run migrations."""
        try:
            import asyncpg
        except ImportError:
            raise ImportError(
                "asyncpg is required for PostgreSQL support. "
                "Install it with: pip install comfyui-multiuser[postgres]"
            )

        self._pool = await asyncpg.create_pool(
            host=self._host,
            port=self._port,
            database=self._database,
            user=self._user,
            password=self._password,
            min_size=2,
            max_size=10,
        )

        current_version = await self._get_schema_version()

        if current_version == 0:
            logger.info("Creating database schema v%d", SCHEMA_VERSION)
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    for sql in get_schema_sql("postgres"):
                        await conn.execute(sql)
                    await conn.execute(
                        "INSERT INTO schema_version (version) VALUES ($1)",
                        SCHEMA_VERSION,
                    )
            logger.info("Database schema created successfully")
        elif current_version < SCHEMA_VERSION:
            logger.info("Migrating database from v%d to v%d", current_version, SCHEMA_VERSION)
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    migrations = get_migrations_for_version(current_version, SCHEMA_VERSION, "postgres")
                    for sql in migrations:
                        await conn.execute(sql)
                    await conn.execute(
                        "INSERT INTO schema_version (version) VALUES ($1)",
                        SCHEMA_VERSION,
                    )
            logger.info("Database migration complete")
        else:
            logger.info("Database schema is up to date (v%d)", current_version)

    async def _get_schema_version(self) -> int:
        """Get the current schema version."""
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchval("SELECT MAX(version) FROM schema_version")
                return row if row is not None else 0
        except Exception:
            return 0

    async def close(self) -> None:
        """Close the connection pool."""
        if self._pool:
            await self._pool.close()
            self._pool = None

    async def execute(self, query: str, params: tuple = ()) -> None:
        """Execute a query without returning results."""
        query = self._convert_placeholders(query)
        async with self._pool.acquire() as conn:
            await conn.execute(query, *params)

    async def execute_returning_id(self, query: str, params: tuple = ()) -> int:
        """Execute an INSERT and return the new row's ID."""
        query = self._convert_placeholders(query)
        # Add RETURNING id if not present
        if "RETURNING" not in query.upper():
            query = query.rstrip().rstrip(";") + " RETURNING id"
        async with self._pool.acquire() as conn:
            return await conn.fetchval(query, *params)

    async def fetchone(self, query: str, params: tuple = ()) -> Optional[dict[str, Any]]:
        """Execute a query and return a single row as a dict."""
        query = self._convert_placeholders(query)
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(query, *params)
            if row is None:
                return None
            return dict(row)

    async def fetchall(self, query: str, params: tuple = ()) -> list[dict[str, Any]]:
        """Execute a query and return all rows as list of dicts."""
        query = self._convert_placeholders(query)
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(query, *params)
            return [dict(row) for row in rows]

    async def fetchval(self, query: str, params: tuple = (), column: int = 0) -> Any:
        """Execute a query and return a single value."""
        query = self._convert_placeholders(query)
        async with self._pool.acquire() as conn:
            return await conn.fetchval(query, *params, column=column)

    async def executemany(self, query: str, params_list: list[tuple]) -> None:
        """Execute a query with multiple parameter sets."""
        query = self._convert_placeholders(query)
        async with self._pool.acquire() as conn:
            await conn.executemany(query, params_list)

    @asynccontextmanager
    async def transaction(self):
        """Context manager for transactions."""
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                # Create a wrapper that uses this connection
                wrapper = _PostgresTransactionWrapper(conn)
                yield wrapper

    def placeholder(self, index: int) -> str:
        """PostgreSQL uses $1, $2, etc."""
        return f"${index}"

    @staticmethod
    def _convert_placeholders(query: str) -> str:
        """Convert ? placeholders to $N PostgreSQL style."""
        result = []
        param_index = 0
        i = 0
        while i < len(query):
            if query[i] == "?":
                param_index += 1
                result.append(f"${param_index}")
            elif query[i] == "'" :
                # Skip string literals
                result.append(query[i])
                i += 1
                while i < len(query) and query[i] != "'":
                    result.append(query[i])
                    i += 1
                if i < len(query):
                    result.append(query[i])
            else:
                result.append(query[i])
            i += 1
        return "".join(result)


class _PostgresTransactionWrapper:
    """Thin wrapper to provide the same interface within a transaction."""

    def __init__(self, conn):
        self._conn = conn

    async def execute(self, query: str, params: tuple = ()) -> None:
        query = PostgresDatabase._convert_placeholders(query)
        await self._conn.execute(query, *params)

    async def fetchone(self, query: str, params: tuple = ()) -> Optional[dict[str, Any]]:
        query = PostgresDatabase._convert_placeholders(query)
        row = await self._conn.fetchrow(query, *params)
        return dict(row) if row else None

    async def fetchall(self, query: str, params: tuple = ()) -> list[dict[str, Any]]:
        query = PostgresDatabase._convert_placeholders(query)
        rows = await self._conn.fetch(query, *params)
        return [dict(row) for row in rows]
