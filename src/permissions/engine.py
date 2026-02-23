"""Permission evaluation engine.

Permission model:
- Users belong to one or more Groups
- Groups have Permissions
- Each Permission grants or denies access to a resource (node class, model, etc.)
- Resources are matched by pattern (supports * wildcards and / path separators)
- Deny rules override Allow rules at the same or higher priority
- Higher priority number = higher precedence
- A user's effective permissions = union of all their groups' permissions

Resource types:
- "node" — ComfyUI node class names (e.g., "KSampler", "ComfyUI-Impact-Pack/*")
- "model" — Model access patterns (e.g., "checkpoints/*", "loras/sdxl/*")
- "feature" — Feature flags (e.g., "queue", "history", "upload")
"""
import fnmatch
import logging
from typing import Optional
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.permissions.engine")

# Cache for user permissions (cleared on permission changes)
_permission_cache: dict[int, list[dict]] = {}


def clear_permission_cache(user_id: Optional[int] = None) -> None:
    """Clear cached permissions. If user_id is None, clear all."""
    if user_id is None:
        _permission_cache.clear()
    else:
        _permission_cache.pop(user_id, None)


async def get_user_permissions(user_id: int) -> list[dict]:
    """Get all permissions for a user (from all their groups), sorted by priority."""
    if user_id in _permission_cache:
        return _permission_cache[user_id]

    db = await get_db()
    permissions = await db.fetchall(
        """SELECT p.id, p.resource_type, p.resource_pattern, p.action, p.priority,
                  g.name as group_name
           FROM permissions p
           JOIN groups g ON p.group_id = g.id
           JOIN group_members gm ON g.id = gm.group_id
           WHERE gm.user_id = ?
           ORDER BY p.priority DESC""",
        (user_id,)
    )

    _permission_cache[user_id] = permissions
    return permissions


async def check_permission(
    user_id: int,
    resource_type: str,
    resource_name: str,
    is_admin: bool = False,
) -> bool:
    """Check if a user has permission to access a resource.
    
    Args:
        user_id: The user's ID
        resource_type: Type of resource ("node", "model", "feature")
        resource_name: Specific resource identifier
        is_admin: Whether user is admin (admins always have access)
    
    Returns:
        True if access is allowed, False if denied
    """
    # Admins always have access
    if is_admin:
        return True

    permissions = await get_user_permissions(user_id)

    # Filter to relevant resource type
    relevant = [p for p in permissions if p["resource_type"] == resource_type]

    if not relevant:
        # No permissions defined for this resource type = deny
        return False

    # Evaluate rules by priority (highest first)
    # At each priority level, deny overrides allow
    best_match = None
    best_priority = -1

    for perm in relevant:
        pattern = perm["resource_pattern"]
        if fnmatch.fnmatch(resource_name, pattern) or fnmatch.fnmatch(resource_name.lower(), pattern.lower()):
            if perm["priority"] > best_priority:
                best_priority = perm["priority"]
                best_match = perm
            elif perm["priority"] == best_priority:
                # At same priority, deny wins
                if perm["action"] == "deny":
                    best_match = perm

    if best_match is None:
        return False

    return best_match["action"] == "allow"


async def get_allowed_nodes(user_id: int, all_node_names: list[str], is_admin: bool = False) -> list[str]:
    """Filter a list of node names to only those the user can access.
    
    This is more efficient than calling check_permission for each node individually.
    """
    if is_admin:
        return all_node_names

    permissions = await get_user_permissions(user_id)
    node_perms = [p for p in permissions if p["resource_type"] == "node"]

    if not node_perms:
        return []

    allowed = []
    for name in all_node_names:
        best_match = None
        best_priority = -1

        for perm in node_perms:
            pattern = perm["resource_pattern"]
            if fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(name.lower(), pattern.lower()):
                if perm["priority"] > best_priority:
                    best_priority = perm["priority"]
                    best_match = perm
                elif perm["priority"] == best_priority and perm["action"] == "deny":
                    best_match = perm

        if best_match and best_match["action"] == "allow":
            allowed.append(name)

    return allowed


async def get_user_limits(user_id: int) -> dict:
    """Get resource limits for a user based on their group permissions."""
    permissions = await get_user_permissions(user_id)

    limits = {
        "max_queue": 0,      # 0 = unlimited
        "max_resolution": 0,  # 0 = unlimited
    }

    feature_perms = [p for p in permissions if p["resource_type"] == "feature"]
    for perm in feature_perms:
        if perm["resource_pattern"] == "queue_limit" and perm["action"] == "allow":
            try:
                limits["max_queue"] = int(perm.get("priority", 0))
            except (ValueError, TypeError):
                pass
        elif perm["resource_pattern"] == "resolution_limit" and perm["action"] == "allow":
            try:
                limits["max_resolution"] = int(perm.get("priority", 0))
            except (ValueError, TypeError):
                pass

    return limits
