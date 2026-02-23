"""Abstract database interface for ComfyUI-MultiUser."""
from abc import ABC, abstractmethod
from typing import Any, Optional


class Database(ABC):
    """Abstract database interface. Implementations for SQLite and PostgreSQL."""

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the database connection and run migrations."""
        ...

    @abstractmethod
    async def close(self) -> None:
        """Close the database connection."""
        ...

    @abstractmethod
    async def execute(self, query: str, params: tuple = ()) -> None:
        """Execute a query without returning results."""
        ...

    @abstractmethod
    async def execute_returning_id(self, query: str, params: tuple = ()) -> int:
        """Execute an INSERT and return the new row's ID."""
        ...

    @abstractmethod
    async def fetchone(self, query: str, params: tuple = ()) -> Optional[dict[str, Any]]:
        """Execute a query and return a single row as a dict, or None."""
        ...

    @abstractmethod
    async def fetchall(self, query: str, params: tuple = ()) -> list[dict[str, Any]]:
        """Execute a query and return all rows as list of dicts."""
        ...

    @abstractmethod
    async def fetchval(self, query: str, params: tuple = (), column: int = 0) -> Any:
        """Execute a query and return a single value."""
        ...

    @abstractmethod
    async def executemany(self, query: str, params_list: list[tuple]) -> None:
        """Execute a query with multiple parameter sets."""
        ...

    @abstractmethod
    async def transaction(self):
        """Context manager for transactions."""
        ...

    @abstractmethod
    def placeholder(self, index: int) -> str:
        """Return the parameter placeholder for the given index (1-based).
        
        SQLite uses '?', PostgreSQL uses '$1', '$2', etc.
        """
        ...

    def ph(self, *indices: int) -> str:
        """Build a comma-separated placeholder string for the given indices."""
        return ", ".join(self.placeholder(i) for i in indices)
