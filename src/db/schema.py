"""SQL schema and migrations for ComfyUI-MultiUser."""

# Schema version - increment when adding migrations
SCHEMA_VERSION = 2

# Base schema (version 1)
SCHEMA_V1 = [
    # Schema version tracking
    """
    CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,

    # Users table
    """
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY {autoincrement},
        username TEXT NOT NULL UNIQUE,
        email TEXT,
        password_hash TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMP
    )
    """,

    # API tokens
    """
    CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY {autoincrement},
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP
    )
    """,

    # Groups
    """
    CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY {autoincrement},
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,

    # Group membership
    """
    CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY {autoincrement},
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, group_id)
    )
    """,

    # Permissions (assigned to groups)
    """
    CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY {autoincrement},
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL,
        resource_pattern TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'allow',
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, resource_type, resource_pattern, action)
    )
    """,

    # External tokens vault (group-level)
    """
    CREATE TABLE IF NOT EXISTS ext_tokens (
        id INTEGER PRIMARY KEY {autoincrement},
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        service_name TEXT NOT NULL,
        token_encrypted TEXT NOT NULL,
        description TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, service_name)
    )
    """,

    # Generation history
    """
    CREATE TABLE IF NOT EXISTS generations (
        id INTEGER PRIMARY KEY {autoincrement},
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prompt_id TEXT NOT NULL,
        workflow_json TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        output_paths TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        execution_time_ms INTEGER,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,

    # Sessions (for cookie auth tracking)
    """
    CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY {autoincrement},
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_token TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address TEXT,
        user_agent TEXT
    )
    """,

    # Indexes
    "CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)",
    "CREATE INDEX IF NOT EXISTS idx_api_tokens_prefix ON api_tokens(prefix)",
    "CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)",
    "CREATE INDEX IF NOT EXISTS idx_permissions_group ON permissions(group_id)",
    "CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions(resource_type, resource_pattern)",
    "CREATE INDEX IF NOT EXISTS idx_ext_tokens_group ON ext_tokens(group_id)",
    "CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_generations_prompt ON generations(prompt_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",

    # Default system groups
    "INSERT OR IGNORE INTO groups (name, description, is_system) VALUES ('admin', 'Administrators with full access', 1)",
    "INSERT OR IGNORE INTO groups (name, description, is_system) VALUES ('users', 'Default group for all users', 1)",

    # Default permissions for admin group (allow everything)
    """
    INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
    VALUES ((SELECT id FROM groups WHERE name = 'admin'), 'node', '*', 'allow', 1000)
    """,

    # Default permissions for users group (allow everything by default, admin can restrict)
    """
    INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
    VALUES ((SELECT id FROM groups WHERE name = 'users'), 'node', '*', 'allow', 0)
    """,

    # ── Per-user workflow storage ──
    """
    CREATE TABLE IF NOT EXISTS user_workflows (
        id INTEGER PRIMARY KEY {autoincrement},
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        workflow_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_user_workflows_user ON user_workflows(user_id)",

    # ── Feature & model permissions for admin group ──
    """
    INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
    VALUES ((SELECT id FROM groups WHERE name = 'admin'), 'feature', '*', 'allow', 1000)
    """,
    """
    INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
    VALUES ((SELECT id FROM groups WHERE name = 'admin'), 'model', '*', 'allow', 1000)
    """,

    # ── Feature permissions for default users group ──
    """
    INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
    VALUES ((SELECT id FROM groups WHERE name = 'users'), 'feature', 'queue', 'allow', 0)
    """,
    """
    INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
    VALUES ((SELECT id FROM groups WHERE name = 'users'), 'feature', 'upload', 'allow', 0)
    """,
    """
    INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
    VALUES ((SELECT id FROM groups WHERE name = 'users'), 'feature', 'history', 'allow', 0)
    """,
    """
    INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
    VALUES ((SELECT id FROM groups WHERE name = 'users'), 'feature', 'workflows', 'allow', 0)
    """,

    # ── Model access for default users group ──
    """
    INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
    VALUES ((SELECT id FROM groups WHERE name = 'users'), 'model', '*', 'allow', 0)
    """,
]


def get_schema_sql(backend: str = "sqlite") -> list[str]:
    """Get schema SQL with backend-specific adjustments."""
    if backend == "sqlite":
        autoincrement = "AUTOINCREMENT"
    else:
        autoincrement = "GENERATED ALWAYS AS IDENTITY"

    result = []
    for sql in SCHEMA_V1:
        formatted = sql.replace("{autoincrement}", autoincrement)
        # PostgreSQL uses ON CONFLICT DO NOTHING instead of OR IGNORE
        if backend == "postgres":
            formatted = formatted.replace("INSERT OR IGNORE", "INSERT INTO")
            formatted = formatted.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX IF NOT EXISTS")
            if "INSERT INTO" in formatted and "OR IGNORE" not in sql:
                pass  # already fine
            elif "INSERT INTO" in formatted:
                formatted += " ON CONFLICT DO NOTHING"
        result.append(formatted)
    return result


# Migration functions for future schema versions
MIGRATIONS: dict[int, list[str]] = {
    2: [
        # ── Per-user workflow storage ──
        """
        CREATE TABLE IF NOT EXISTS user_workflows (
            id INTEGER PRIMARY KEY {autoincrement},
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            workflow_json TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, name)
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_user_workflows_user ON user_workflows(user_id)",

        # ── Feature & model permissions for admin group ──
        """
        INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
        VALUES ((SELECT id FROM groups WHERE name = 'admin'), 'feature', '*', 'allow', 1000)
        """,
        """
        INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
        VALUES ((SELECT id FROM groups WHERE name = 'admin'), 'model', '*', 'allow', 1000)
        """,

        # ── Feature permissions for default users group ──
        """
        INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
        VALUES ((SELECT id FROM groups WHERE name = 'users'), 'feature', 'queue', 'allow', 0)
        """,
        """
        INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
        VALUES ((SELECT id FROM groups WHERE name = 'users'), 'feature', 'upload', 'allow', 0)
        """,
        """
        INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
        VALUES ((SELECT id FROM groups WHERE name = 'users'), 'feature', 'history', 'allow', 0)
        """,
        """
        INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
        VALUES ((SELECT id FROM groups WHERE name = 'users'), 'feature', 'workflows', 'allow', 0)
        """,

        # ── Model access for default users group ──
        """
        INSERT OR IGNORE INTO permissions (group_id, resource_type, resource_pattern, action, priority)
        VALUES ((SELECT id FROM groups WHERE name = 'users'), 'model', '*', 'allow', 0)
        """,
    ],
}


def _apply_backend_adjustments(sql: str, backend: str) -> str:
    """Apply backend-specific SQL adjustments to a single statement."""
    if backend == "sqlite":
        sql = sql.replace("{autoincrement}", "AUTOINCREMENT")
    else:
        sql = sql.replace("{autoincrement}", "GENERATED ALWAYS AS IDENTITY")
        sql = sql.replace("INSERT OR IGNORE", "INSERT INTO")
        if "INSERT INTO" in sql:
            sql += " ON CONFLICT DO NOTHING"
    return sql


def get_migrations_for_version(current: int, target: int, backend: str = "sqlite") -> list[str]:
    """Get migration SQL to go from current version to target version."""
    migrations = []
    for version in range(current + 1, target + 1):
        if version in MIGRATIONS:
            for sql in MIGRATIONS[version]:
                migrations.append(_apply_backend_adjustments(sql, backend))
    return migrations
