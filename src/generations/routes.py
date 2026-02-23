"""Generation history routes."""
import json
import logging
from aiohttp import web
from ..db.factory import get_db
from ..config import get_config

logger = logging.getLogger("comfyui-multiuser.generations.routes")


def setup_generation_routes(routes):
    """Register generation history routes."""

    @routes.get("/multiuser/generations")
    async def list_generations(request: web.Request):
        """List generation history for the current user.
        
        Admins can pass ?user_id=X to view other users' history.
        Supports pagination: ?page=1&per_page=50
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        # Pagination
        page = int(request.query.get("page", 1))
        per_page = min(int(request.query.get("per_page", 50)), 200)
        offset = (page - 1) * per_page

        # Filter by user
        target_user_id = user["id"]
        if user.get("is_admin"):
            req_user_id = request.query.get("user_id")
            if req_user_id:
                target_user_id = int(req_user_id)
            elif request.query.get("all") == "true":
                target_user_id = None  # Show all

        db = await get_db()

        if target_user_id is None:
            # Admin viewing all generations
            total = await db.fetchval("SELECT COUNT(*) FROM generations")
            generations = await db.fetchall(
                """SELECT g.id, g.user_id, u.username, g.prompt_id, g.status,
                          g.output_paths, g.started_at, g.completed_at,
                          g.execution_time_ms, g.error_message, g.created_at
                   FROM generations g
                   LEFT JOIN users u ON g.user_id = u.id
                   ORDER BY g.created_at DESC
                   LIMIT ? OFFSET ?""",
                (per_page, offset)
            )
        else:
            total = await db.fetchval(
                "SELECT COUNT(*) FROM generations WHERE user_id = ?",
                (target_user_id,)
            )
            generations = await db.fetchall(
                """SELECT g.id, g.user_id, u.username, g.prompt_id, g.status,
                          g.output_paths, g.started_at, g.completed_at,
                          g.execution_time_ms, g.error_message, g.created_at
                   FROM generations g
                   LEFT JOIN users u ON g.user_id = u.id
                   WHERE g.user_id = ?
                   ORDER BY g.created_at DESC
                   LIMIT ? OFFSET ?""",
                (target_user_id, per_page, offset)
            )

        # Parse output_paths JSON
        for gen in generations:
            if gen.get("output_paths"):
                try:
                    gen["output_paths"] = json.loads(gen["output_paths"])
                except (json.JSONDecodeError, TypeError):
                    pass

        return web.json_response({
            "generations": generations,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": (total + per_page - 1) // per_page if total else 0,
        })

    @routes.get("/multiuser/generations/{gen_id}")
    async def get_generation(request: web.Request):
        """Get a specific generation with full details including workflow JSON."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        gen_id = int(request.match_info["gen_id"])
        db = await get_db()

        gen = await db.fetchone(
            """SELECT g.*, u.username
               FROM generations g
               LEFT JOIN users u ON g.user_id = u.id
               WHERE g.id = ?""",
            (gen_id,)
        )
        if not gen:
            return web.json_response({"error": "Generation not found"}, status=404)

        # Non-admins can only view their own
        if gen["user_id"] != user["id"] and not user.get("is_admin"):
            return web.json_response({"error": "Not authorized"}, status=403)

        if gen.get("output_paths"):
            try:
                gen["output_paths"] = json.loads(gen["output_paths"])
            except (json.JSONDecodeError, TypeError):
                pass

        if gen.get("workflow_json"):
            try:
                gen["workflow_json"] = json.loads(gen["workflow_json"])
            except (json.JSONDecodeError, TypeError):
                pass

        return web.json_response(gen)

    @routes.get("/multiuser/generations/stats")
    async def generation_stats(request: web.Request):
        """Get generation statistics."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        db = await get_db()

        if user.get("is_admin"):
            stats = await db.fetchone(
                """SELECT 
                   COUNT(*) as total,
                   SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
                   SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
                   SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
                   AVG(CASE WHEN execution_time_ms > 0 THEN execution_time_ms END) as avg_time_ms
                   FROM generations"""
            )
        else:
            stats = await db.fetchone(
                """SELECT 
                   COUNT(*) as total,
                   SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
                   SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
                   SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
                   AVG(CASE WHEN execution_time_ms > 0 THEN execution_time_ms END) as avg_time_ms
                   FROM generations WHERE user_id = ?""",
                (user["id"],)
            )

        return web.json_response(stats or {})

    @routes.delete("/multiuser/generations/{gen_id}")
    async def delete_generation(request: web.Request):
        """Delete a generation record."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        gen_id = int(request.match_info["gen_id"])
        db = await get_db()

        gen = await db.fetchone(
            "SELECT user_id FROM generations WHERE id = ?", (gen_id,)
        )
        if not gen:
            return web.json_response({"error": "Not found"}, status=404)
        if gen["user_id"] != user["id"] and not user.get("is_admin"):
            return web.json_response({"error": "Not authorized"}, status=403)

        await db.execute("DELETE FROM generations WHERE id = ?", (gen_id,))
        return web.json_response({"success": True})
