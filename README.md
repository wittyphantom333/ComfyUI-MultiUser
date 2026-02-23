# ComfyUI-MultiUser

A ComfyUI custom node extension that adds multi-user authentication, granular permissions, and generation tracking.

## Features

- **Authentication** — Username/password login with JWT sessions; API tokens for programmatic access
- **User Management** — Admin CRUD for users with lockout protection
- **Group-based Permissions** — Users → Groups → Permissions with wildcard pattern matching
- **Node Filtering** — Unauthorized nodes are hidden from the workflow editor
- **External Token Vault** — Group-level encrypted storage for third-party API keys (e.g. ComfyUI-Majoor-AssetsManager)
- **Generation Tracking** — Per-user prompt history with timing, output paths, and error capture
- **Admin Panel** — Integrated ComfyUI sidebar for managing users, groups, permissions, tokens, and stats
- **Dual Database** — SQLite (default, zero-config) or PostgreSQL for production deployments

## Installation

### From ComfyUI Manager
Search for **ComfyUI-MultiUser** in the manager and install.

### Manual
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/YOUR_USERNAME/ComfyUI-MultiUser.git
cd ComfyUI-MultiUser
pip install -r requirements.txt
```

For PostgreSQL support:
```bash
pip install asyncpg>=0.29.0
```

## Configuration

Copy `config.example.yaml` to `config.yaml` and edit as needed:

```bash
cp config.example.yaml config.yaml
```

### Key settings

| Setting | Env Override | Default | Description |
|---------|-------------|---------|-------------|
| `database.backend` | `MULTIUSER_DB_BACKEND` | `sqlite` | `sqlite` or `postgres` |
| `database.sqlite.path` | `MULTIUSER_DB_PATH` | `./data/multiuser.db` | SQLite file path |
| `auth.secret_key` | `MULTIUSER_SECRET_KEY` | *(auto-generated)* | JWT signing key |
| `auth.session_lifetime_hours` | — | `24` | Session duration |
| `registration.mode` | `MULTIUSER_REGISTRATION_MODE` | `open` | `open` or `invite` |

All settings can also be set via environment variables. See `config.example.yaml` for the full list.

## First Run

1. Start ComfyUI normally
2. Open the browser — you'll see a registration screen
3. The **first user** to register automatically becomes an admin
4. Configure groups and permissions from the admin panel (sidebar icon)

## Architecture

```
ComfyUI-MultiUser/
├── __init__.py              # Main entry — wires routes, middleware, hooks
├── config.example.yaml      # Configuration template
├── requirements.txt         # Python dependencies
├── js/                      # Frontend (served via WEB_DIRECTORY)
│   ├── multiuser.js         # ComfyUI extension registration
│   ├── api.js               # HTTP client helpers
│   ├── auth-ui.js           # Login / registration overlay
│   ├── permission-filter.js # Node filtering by permission
│   ├── user-menu.js         # User dropdown menu
│   └── admin-panel.js       # Admin sidebar panel
└── src/                     # Backend Python modules
    ├── config.py            # YAML + env config loader
    ├── auth/                # Authentication & authorization
    │   ├── middleware.py     # aiohttp auth middleware
    │   ├── passwords.py     # bcrypt hashing
    │   ├── tokens.py        # JWT & API token utilities
    │   └── routes.py        # Login, register, token CRUD
    ├── db/                  # Database layer
    │   ├── base.py          # Abstract Database ABC
    │   ├── schema.py        # Table definitions & migrations
    │   ├── sqlite_db.py     # SQLite implementation
    │   ├── postgres_db.py   # PostgreSQL implementation
    │   └── factory.py       # DB singleton factory
    ├── users/routes.py      # User admin CRUD
    ├── groups/routes.py     # Group management
    ├── permissions/
    │   ├── engine.py        # Permission evaluation engine
    │   └── routes.py        # Permission CRUD
    ├── tokens/routes.py     # External token vault
    └── generations/
        ├── tracker.py       # Execution lifecycle hooks
        └── routes.py        # Generation history API
```

## Permission Model

Permissions are matched using **fnmatch wildcard patterns** against resource identifiers:

| Pattern | Matches |
|---------|---------|
| `*` | Everything |
| `KSampler*` | KSampler, KSamplerAdvanced, etc. |
| `Load*` | LoadImage, LoadCheckpoint, etc. |
| `ComfyUI-Impact-Pack.*` | All nodes from Impact Pack |

**Rules:**
- Each permission rule has `effect` (`allow` / `deny`), `resource_type` (`node`, `model`, `feature`), and `resource_pattern`
- Rules are evaluated by `priority` (higher = stronger)
- At equal priority, **deny overrides allow**
- Users inherit permissions from all their groups

## API Tokens

For scripts/automation, create API tokens from the user menu:

```bash
curl -H "Authorization: Bearer cmu_xxxxxxxx..." http://localhost:8188/prompt \
  -d '{"prompt": {...}}'
```

Tokens use the `cmu_` prefix and are hashed with SHA-256 for storage.

## External Token Vault

Admins can store API keys for external services (e.g. Civitai, Hugging Face) at the group level. Extensions can retrieve these tokens via:

```
GET /multiuser/ext-tokens/service/{service_name}
```

Tokens are encrypted at rest using Fernet symmetric encryption.

## License

[GPL v3](LICENSE)
# ComfyUI-MultiUser
