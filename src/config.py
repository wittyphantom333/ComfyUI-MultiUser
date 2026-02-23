"""Configuration management for ComfyUI-MultiUser."""
import os
import secrets
import yaml
from pathlib import Path
from typing import Any

_BASE_DIR = Path(__file__).parent.parent.resolve()
_config: dict | None = None


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge override into base."""
    merged = base.copy()
    for key, value in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _load_defaults() -> dict:
    """Load default config from config.example.yaml."""
    example_path = _BASE_DIR / "config.example.yaml"
    with open(example_path, "r") as f:
        return yaml.safe_load(f)


def load_config(force_reload: bool = False) -> dict:
    """Load configuration, merging defaults with user overrides."""
    global _config
    if _config is not None and not force_reload:
        return _config

    defaults = _load_defaults()

    # Check for user config
    user_config_path = _BASE_DIR / "config.yaml"
    if user_config_path.exists():
        with open(user_config_path, "r") as f:
            user_config = yaml.safe_load(f) or {}
        _config = _deep_merge(defaults, user_config)
    else:
        _config = defaults

    # Environment variable overrides
    env_map = {
        "MULTIUSER_DB_BACKEND": ("database", "backend"),
        "MULTIUSER_DB_SQLITE_PATH": ("database", "sqlite", "path"),
        "MULTIUSER_DB_PG_HOST": ("database", "postgres", "host"),
        "MULTIUSER_DB_PG_PORT": ("database", "postgres", "port"),
        "MULTIUSER_DB_PG_DATABASE": ("database", "postgres", "database"),
        "MULTIUSER_DB_PG_USER": ("database", "postgres", "user"),
        "MULTIUSER_DB_PG_PASSWORD": ("database", "postgres", "password"),
        "MULTIUSER_SECRET_KEY": ("auth", "secret_key"),
        "MULTIUSER_REGISTRATION_MODE": ("registration", "mode"),
    }
    for env_var, path in env_map.items():
        value = os.environ.get(env_var)
        if value is not None:
            obj = _config
            for key in path[:-1]:
                obj = obj[key]
            # Convert port to int
            if path[-1] == "port":
                value = int(value)
            obj[path[-1]] = value

    # Generate secret key if not set
    if not _config["auth"]["secret_key"]:
        _config["auth"]["secret_key"] = secrets.token_hex(32)

    # Resolve SQLite path
    sqlite_path = _config["database"]["sqlite"]["path"]
    if not os.path.isabs(sqlite_path):
        _config["database"]["sqlite"]["path"] = str(_BASE_DIR / sqlite_path)

    return _config


def get_config(*keys: str, default: Any = None) -> Any:
    """Get a nested config value by key path."""
    config = load_config()
    obj = config
    for key in keys:
        if isinstance(obj, dict) and key in obj:
            obj = obj[key]
        else:
            return default
    return obj


def get_base_dir() -> Path:
    """Get the base directory of the extension."""
    return _BASE_DIR
