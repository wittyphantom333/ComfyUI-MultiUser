"""Output-file browsing routes with per-user isolation.

Provides a REST API that scans ComfyUI's output directory and returns file
listings scoped to the requesting user.  Admins can view all outputs or
filter by username.

Features:
  - Paginated file listing with user-scoping (non-admin sees ONLY own files)
  - Thumbnail generation (Pillow for images, ffmpeg for video first-frame)
  - Per-user tagging system
  - Per-user 0-5 star rating system
  - PNG/EXIF metadata extraction and viewing
"""
import hashlib
import json
import logging
import math
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

from aiohttp import web

from ..config import get_config, get_base_dir
from ..db.factory import get_db

logger = logging.getLogger("comfyui-multiuser.outputs.routes")

# Supported image/video extensions
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

# Optional Pillow import for thumbnail generation
try:
    from PIL import Image
    from PIL.ExifTags import TAGS as EXIF_TAGS
    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False
    EXIF_TAGS = {}
    logger.info("Pillow not available — thumbnail generation disabled")

# Check for ffmpeg (video thumbnails)
_HAS_FFMPEG = shutil.which("ffmpeg") is not None
if not _HAS_FFMPEG:
    logger.info("ffmpeg not found — video thumbnail generation disabled")


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------

def _sanitize_for_json(obj: Any) -> Any:
    """Recursively replace NaN/Infinity floats with None so json.dumps succeeds."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    return obj


def _get_output_dir() -> Path:
    """Resolve ComfyUI's output directory."""
    try:
        import folder_paths  # ComfyUI built-in
        return Path(folder_paths.get_output_directory())
    except (ImportError, AttributeError):
        return Path("output").resolve()


def _get_thumb_cache_dir() -> Path:
    """Get/create the thumbnail cache directory."""
    cache = get_base_dir() / "data" / "thumb_cache"
    cache.mkdir(parents=True, exist_ok=True)
    return cache


def _resolve_file(output_dir: Path, filename: str, subfolder: str) -> Optional[Path]:
    """Safely resolve a file path within the output directory."""
    if subfolder:
        file_path = output_dir / subfolder / filename
    else:
        file_path = output_dir / filename
    try:
        file_path = file_path.resolve()
        if not str(file_path).startswith(str(output_dir.resolve())):
            return None
    except (ValueError, OSError):
        return None
    if not file_path.exists() or not file_path.is_file():
        return None
    return file_path


def _check_access(user: dict, file_path: Path, output_dir: Path, user_dirs: set) -> bool:
    """Return True if the user may access this file."""
    if user.get("is_admin"):
        return True
    rel = file_path.relative_to(output_dir.resolve())
    parts = rel.parts
    if len(parts) <= 1:
        return True  # root-level = shared/legacy
    top = parts[0]
    if top == user["username"]:
        return True
    if top in user_dirs:
        return False  # another user's folder
    return True  # unknown subfolder, treat as shared


def _file_info(path: Path, output_dir: Path) -> dict:
    """Build a metadata dict for a single file."""
    rel = path.relative_to(output_dir)
    stat = path.stat()
    ext = path.suffix.lower()
    mtime = stat.st_mtime
    if math.isnan(mtime) or math.isinf(mtime):
        mtime = 0.0
    return {
        "filename": path.name,
        "subfolder": str(rel.parent) if str(rel.parent) != "." else "",
        "relative_path": str(rel),
        "size": stat.st_size,
        "modified": mtime,
        "type": "video" if ext in VIDEO_EXTS else "image",
        "format": ext.lstrip(".").upper(),  # PNG, JPG, MP4, WEBM, etc.
        "has_meta": False,  # set later by _detect_workflow_batch
    }


# Sampling input keys that confirm a node is a real sampler (not just named like one).
# Matches Majoor's _sampler_inputs_look_sampling() check.
_SAMPLING_INPUT_KEYS = {"steps", "cfg", "cfg_scale", "seed", "denoise"}


def _node_is_sampler(node: dict) -> bool:
    """Check if a prompt-graph node looks like a real sampler.

    Matches Majoor's _node_looks_like_sampler(node, require_sampling_inputs=True):
    1. class_type contains 'ksampler', 'samplercustom', or 'sampler'
    2. BUT NOT if class_type contains 'select' (KSamplerSelect etc.)
    3. Node inputs must contain at least one sampling key (steps/cfg/seed/denoise)
    """
    ct = str(node.get("class_type", "")).lower()
    if not ct:
        return False
    # Exclude selector/utility nodes
    if "select" in ct:
        return False
    # Must match a sampler-like class_type
    if not ("ksampler" in ct or "samplercustom" in ct or "sampler" in ct):
        return False
    # For prompt graphs, require actual sampling inputs
    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
        return False
    return bool(_SAMPLING_INPUT_KEYS & inputs.keys())


def _prompt_has_sampler(prompt_text: str) -> bool:
    """Check if a prompt JSON graph contains a real sampler node.

    The prompt graph is a dict of node_id → {class_type, inputs, ...}.
    A sampler node (with real sampling inputs) means actual generation occurred.
    Returns False on parse failure — better to miss a '+' than show a false one.
    """
    try:
        graph = json.loads(prompt_text)
    except (json.JSONDecodeError, TypeError, ValueError):
        return False

    if not isinstance(graph, dict):
        return False

    for node in graph.values():
        if isinstance(node, dict) and _node_is_sampler(node):
            return True
    return False


def _has_generation_data(path: Path) -> bool:
    """Check whether a file contains actual *generation* data (sampler node).

    Matches the Majoor Assets Manager convention:
      '+' = the executed prompt graph contains a sampler node (KSampler, etc.),
            meaning the file was produced by a generation workflow.
      no '+' = no prompt metadata, or a workflow without sampling (upscale,
               compositing, utility, or non-ComfyUI image).

    Uses PIL to properly read PNG text chunks (which live AFTER the image
    data and may be compressed), avoiding the brittle binary scanning approach.
    """
    ext = path.suffix.lower()
    try:
        if ext == ".png" and _HAS_PIL:
            img = Image.open(path)
            prompt_text = (img.info or {}).get("prompt", "")
            if not prompt_text:
                logger.debug("[badge] %s: PNG no prompt chunk → False", path.name)
                return False
            result = _prompt_has_sampler(prompt_text)
            logger.debug("[badge] %s: PNG prompt len=%d → %s", path.name, len(prompt_text), result)
            return result

        if ext in VIDEO_EXTS:
            # VHS sidecar PNG
            sidecar = path.with_suffix(".png")
            if sidecar.exists() and sidecar.is_file() and _HAS_PIL:
                img = Image.open(sidecar)
                prompt_text = (img.info or {}).get("prompt", "")
                if prompt_text:
                    return _prompt_has_sampler(prompt_text)
            return False

        if ext == ".webp" and _HAS_PIL:
            img = Image.open(path)
            exif = img.getexif()
            if exif:
                val = exif.get(0x0110, "")
                if isinstance(val, str) and val.strip().startswith("{"):
                    return _prompt_has_sampler(val)
            return False

        if ext in (".jpg", ".jpeg") and _HAS_PIL:
            img = Image.open(path)
            exif = img.getexif()
            if exif:
                val = exif.get(0x9286, "")  # UserComment
                if isinstance(val, str) and val.strip().startswith("{"):
                    return _prompt_has_sampler(val)
            return False
    except Exception:
        pass
    return False


async def _detect_workflow_batch(files: list[dict], output_dir: Path) -> None:
    """Batch-detect workflow/metadata presence for a list of _file_info dicts."""
    if not files:
        return

    detected = 0
    skipped = 0
    for f in files:
        if f["has_meta"]:
            skipped += 1
            continue
        try:
            full = output_dir / f["relative_path"]
            if full.exists():
                result = _has_generation_data(full)
                f["has_meta"] = result
                if result:
                    detected += 1
        except Exception as exc:
            logger.debug("detect_workflow error for %s: %s", f.get("filename"), exc)

    logger.info(
        "[badge-detect] %d files: %d with gen-data, %d without, %d pre-set  (PIL=%s)",
        len(files), detected, len(files) - detected - skipped, skipped, _HAS_PIL,
    )


def _generate_image_thumbnail(src: Path, dst: Path, size: int) -> bool:
    """Generate an image thumbnail using Pillow. Returns True on success."""
    if not _HAS_PIL:
        return False
    try:
        img = Image.open(src)
        img.thumbnail((size, size), Image.LANCZOS)
        img.save(dst, "WEBP", quality=80)
        return True
    except Exception as e:
        logger.debug("Image thumbnail failed for %s: %s", src.name, e)
        return False


def _generate_video_thumbnail(src: Path, dst: Path, size: int) -> bool:
    """Extract a frame from a video using ffmpeg and convert to WebP thumbnail."""
    if not _HAS_FFMPEG:
        return False
    try:
        tmp_frame = dst.with_suffix(".tmp.png")
        # Try extracting a frame at 1 second
        subprocess.run(
            [
                "ffmpeg", "-y", "-ss", "1",
                "-i", str(src),
                "-vframes", "1",
                "-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease",
                str(tmp_frame),
            ],
            capture_output=True, timeout=15,
        )
        if not tmp_frame.exists():
            # Retry at t=0 for very short clips
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", str(src),
                    "-vframes", "1",
                    "-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease",
                    str(tmp_frame),
                ],
                capture_output=True, timeout=15,
            )
        if tmp_frame.exists():
            if _HAS_PIL:
                img = Image.open(tmp_frame)
                img.save(dst, "WEBP", quality=80)
                tmp_frame.unlink(missing_ok=True)
            else:
                tmp_frame.rename(dst)
            return True
    except Exception as e:
        logger.debug("Video thumbnail failed for %s: %s", src.name, e)
    return False


def _read_png_metadata(file_path: Path) -> dict:
    """Read PNG tEXt/iTXt chunks for ComfyUI workflow metadata."""
    meta = {}
    if not _HAS_PIL:
        return meta
    try:
        img = Image.open(file_path)
        info = img.info or {}
        # ComfyUI stores workflow data in PNG text chunks
        for key in ("prompt", "workflow", "parameters"):
            if key in info:
                val = info[key]
                try:
                    meta[key] = json.loads(val)
                except (json.JSONDecodeError, TypeError):
                    meta[key] = val
        # Grab other text keys
        for key, val in info.items():
            if key not in meta and isinstance(val, str) and len(val) < 50000:
                meta[key] = val
        meta["_dimensions"] = f"{img.width}x{img.height}"
        meta["_mode"] = img.mode
    except Exception as e:
        logger.debug("PNG metadata failed for %s: %s", file_path.name, e)
    return meta


def _read_image_metadata(file_path: Path) -> dict:
    """Read metadata from any image (EXIF for JPEGs, PNG chunks, etc)."""
    ext = file_path.suffix.lower()
    if ext == ".png":
        return _read_png_metadata(file_path)
    if not _HAS_PIL:
        return {}
    meta = {}
    try:
        img = Image.open(file_path)
        meta["_dimensions"] = f"{img.width}x{img.height}"
        meta["_mode"] = img.mode
        if ext in (".jpg", ".jpeg", ".tiff"):
            exif = img.getexif()
            if exif:
                for tag_id, value in exif.items():
                    name = EXIF_TAGS.get(tag_id, str(tag_id))
                    if isinstance(value, (bytes, bytearray)):
                        continue
                    if isinstance(value, str) and len(value) > 1000:
                        continue
                    meta[name] = str(value)
        if ext == ".webp":
            for k, v in (img.info or {}).items():
                if isinstance(v, str) and len(v) < 5000:
                    meta[k] = v
    except Exception as e:
        logger.debug("Metadata failed for %s: %s", file_path.name, e)
    return meta


def _read_video_metadata(file_path: Path) -> dict:
    """Read video metadata using ffprobe + sidecar/embedded workflow data.

    Sources tried in order:
    1. ffprobe — container info (duration, codec, fps, dimensions, bitrate)
    2. ffprobe format tags — ComfyUI/VHS may embed 'prompt' and 'workflow' JSON
    3. VHS-style PNG sidecar — same base name with .png extension
    4. Animated WebP EXIF — ComfyUI stores prompt in EXIF tag 0x0110, workflow in 0x010F
    """
    meta = {}
    ext = file_path.suffix.lower()

    # ── 1 & 2: ffprobe — container info + metadata tags ──
    if _HAS_FFMPEG:
        try:
            result = subprocess.run(
                [
                    "ffprobe", "-v", "quiet",
                    "-print_format", "json",
                    "-show_format", "-show_streams",
                    str(file_path),
                ],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0 and result.stdout:
                data = json.loads(result.stdout)
                fmt = data.get("format", {})
                meta["_duration"] = fmt.get("duration", "unknown")
                meta["_format"] = fmt.get("format_long_name", fmt.get("format_name", ""))
                meta["_bitrate"] = fmt.get("bit_rate", "")
                for stream in data.get("streams", []):
                    if stream.get("codec_type") == "video":
                        meta["_dimensions"] = f"{stream.get('width', '?')}x{stream.get('height', '?')}"
                        meta["_codec"] = stream.get("codec_long_name", stream.get("codec_name", ""))
                        meta["_fps"] = stream.get("r_frame_rate", "")
                        break

                # Check format tags for embedded prompt/workflow JSON
                tags = fmt.get("tags", {})
                for key in ("prompt", "workflow"):
                    val = tags.get(key)
                    if val and isinstance(val, str):
                        try:
                            meta[key] = json.loads(val)
                        except (json.JSONDecodeError, TypeError):
                            meta[key] = val
        except Exception as e:
            logger.debug("Video ffprobe failed for %s: %s", file_path.name, e)

    # ── 3: VHS-style PNG sidecar (same directory, same base name + .png) ──
    if "prompt" not in meta:
        sidecar = file_path.with_suffix(".png")
        if sidecar.exists() and sidecar.is_file():
            try:
                png_meta = _read_png_metadata(sidecar)
                if png_meta.get("prompt"):
                    meta["prompt"] = png_meta["prompt"]
                    meta["_sidecar"] = sidecar.name
                if png_meta.get("workflow") and "workflow" not in meta:
                    meta["workflow"] = png_meta["workflow"]
            except Exception as e:
                logger.debug("Video sidecar PNG failed for %s: %s", sidecar.name, e)

    # ── 4: Animated WebP EXIF tags ──
    if "prompt" not in meta and ext == ".webp" and _HAS_PIL:
        try:
            from PIL import Image as _PILImage
            img = _PILImage.open(file_path)
            exif = img.getexif()
            if exif:
                # ComfyUI stores prompt in EXIF tag 0x0110 (Model)
                prompt_val = exif.get(0x0110)
                if prompt_val:
                    try:
                        meta["prompt"] = json.loads(prompt_val)
                    except (json.JSONDecodeError, TypeError):
                        meta["prompt"] = prompt_val
                # Workflow in EXIF tag 0x010F (Make)
                workflow_val = exif.get(0x010F)
                if workflow_val:
                    try:
                        meta["workflow"] = json.loads(workflow_val)
                    except (json.JSONDecodeError, TypeError):
                        meta["workflow"] = workflow_val
            if "_dimensions" not in meta:
                meta["_dimensions"] = f"{img.width}x{img.height}"
        except Exception as e:
            logger.debug("Video WebP EXIF failed for %s: %s", file_path.name, e)

    return meta


# ---------------------------------------------------------------------------
#  ComfyUI workflow → structured generation info
# ---------------------------------------------------------------------------

def _format_model_name(value: str) -> str:
    """Strip paths and extensions from model filenames."""
    s = str(value).strip().replace("\\", "/")
    base = s.rsplit("/", 1)[-1]
    for ext in (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf"):
        if base.lower().endswith(ext):
            base = base[: -len(ext)]
    return base


def _parse_comfyui_prompt(prompt: dict) -> dict:
    """Extract generation parameters from a ComfyUI workflow prompt dict.

    Walks the node graph to find:
      - Checkpoint / UNET / VAE / CLIP models
      - LoRAs with strength values
      - Sampler, scheduler, steps, CFG, seed
      - Positive/negative prompts (CLIPTextEncode)
      - Denoise, image dimensions
    Returns a flat dict suitable for the frontend.
    """
    if not prompt or not isinstance(prompt, dict):
        return {}

    info: dict[str, Any] = {}
    loras: list[dict] = []
    positives: list[str] = []
    negatives: list[str] = []
    clip_nodes: dict[str, dict] = {}  # node_id → node

    # Build a lookup: node_id → node
    nodes = {}
    for nid, node in prompt.items():
        if isinstance(node, dict):
            nodes[str(nid)] = node

    for nid, node in nodes.items():
        ct = node.get("class_type", "")
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue

        ct_lower = ct.lower()

        # ── Checkpoints / UNET / VAE ──
        if "checkpointloader" in ct_lower or ct_lower in ("checkpointloadersimple",):
            ckpt = inputs.get("ckpt_name", "")
            if ckpt:
                info["checkpoint"] = _format_model_name(ckpt)

        if "unetloader" in ct_lower:
            unet = inputs.get("unet_name", "") or inputs.get("model_name", "")
            if unet:
                info["unet"] = _format_model_name(unet)

        if "vaeloader" in ct_lower:
            vae = inputs.get("vae_name", "")
            if vae:
                info["vae"] = _format_model_name(vae)

        # ── LoRA ──
        if "lora" in ct_lower and ("loader" in ct_lower or "stack" in ct_lower):
            name = inputs.get("lora_name", "") or inputs.get("lora", "")
            if name:
                lora_entry: dict[str, Any] = {"name": _format_model_name(name)}
                sm = inputs.get("strength_model")
                sc = inputs.get("strength_clip")
                if sm is not None:
                    lora_entry["strength_model"] = sm
                if sc is not None:
                    lora_entry["strength_clip"] = sc
                loras.append(lora_entry)

        # ── Samplers ──
        if ct_lower in ("ksampler", "ksampleradvanced", "samplercustom",
                         "ksamplerselectadvanced") or "ksampler" in ct_lower:
            if "sampler_name" in inputs and not info.get("sampler"):
                info["sampler"] = inputs["sampler_name"]
            if "scheduler" in inputs and not info.get("scheduler"):
                info["scheduler"] = inputs["scheduler"]
            if "steps" in inputs and not info.get("steps"):
                info["steps"] = inputs["steps"]
            if "cfg" in inputs and not info.get("cfg"):
                info["cfg"] = inputs["cfg"]
            if "seed" in inputs and not info.get("seed"):
                seed_val = inputs["seed"]
                # Seed might be a direct value or a reference [node_id, output_idx]
                if isinstance(seed_val, (int, float)):
                    info["seed"] = str(int(seed_val))
                elif isinstance(seed_val, str) and seed_val.isdigit():
                    info["seed"] = seed_val
            if "denoise" in inputs and not info.get("denoise"):
                info["denoise"] = inputs["denoise"]

        # ── CLIPTextEncode (prompts) ──
        if ct_lower in ("cliptextencode", "cliptextencodesdxl"):
            text = inputs.get("text", "")
            if isinstance(text, str) and text.strip():
                clip_nodes[nid] = {"text": text.strip(), "class_type": ct}

        # ── Empty latent (dimensions) ──
        if ct_lower == "emptylatentimage":
            w = inputs.get("width")
            h = inputs.get("height")
            if w and h:
                info["width"] = w
                info["height"] = h
                info["batch_size"] = inputs.get("batch_size", 1)

        # ── Upscale models ──
        if "upscale" in ct_lower and "model" in ct_lower and "loader" in ct_lower:
            model = inputs.get("model_name", "")
            if model:
                info["upscale_model"] = _format_model_name(model)

    # ── Resolve positive/negative prompts ──
    # Heuristic: trace KSampler's positive/negative inputs back to
    # CLIPTextEncode nodes.
    for nid, node in nodes.items():
        ct = node.get("class_type", "")
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        if "ksampler" not in ct.lower():
            continue

        for label, dest_list in (("positive", positives), ("negative", negatives)):
            ref = inputs.get(label)
            if isinstance(ref, list) and len(ref) >= 1:
                ref_id = str(ref[0])
                if ref_id in clip_nodes:
                    dest_list.append(clip_nodes[ref_id]["text"])

    # Fallback: if we didn't resolve via KSampler refs, just collect all
    if not positives and not negatives and clip_nodes:
        for cn in clip_nodes.values():
            txt = cn["text"]
            # simple heuristic: negative prompts are often shorter
            # or contain negative keywords — just list all as positive
            positives.append(txt)

    if positives:
        info["positive_prompt"] = "\n\n".join(positives)
    if negatives:
        info["negative_prompt"] = "\n\n".join(negatives)
    if loras:
        info["loras"] = loras

    return info


# ---------------------------------------------------------------------------
#  Route setup
# ---------------------------------------------------------------------------

def setup_output_routes(routes):
    """Register output-browsing routes under /multiuser/outputs."""

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs")
    async def list_outputs(request: web.Request):
        """List output files visible to the current user.

        Query params:
            page, per_page, sort, search, type, user, tag, min_rating
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        output_dir = _get_output_dir()
        if not output_dir.exists():
            return web.json_response({
                "files": [], "total": 0, "page": 1, "per_page": 50, "pages": 0,
            })

        is_admin = bool(user.get("is_admin"))
        username = user["username"]
        user_id = user["id"]

        page = max(1, int(request.query.get("page", 1)))
        per_page = min(max(1, int(request.query.get("per_page", 50))), 500)
        sort = request.query.get("sort", "newest")
        search = request.query.get("search", "").strip().lower()
        type_filter = request.query.get("type", "all")
        tag_filter = request.query.get("tag", "").strip().title()
        min_rating = int(request.query.get("min_rating", 0))

        db = await get_db()

        # ── Collect files with STRICT scoping ──
        # EVERY user (admin or not) only sees their own subfolder here.
        # Admins use the separate /outputs/all endpoint for cross-user browsing.
        files: list[dict] = []
        logger.info(
            "list_outputs: user=%s is_admin=%s output_dir=%s",
            username, is_admin, output_dir,
        )

        user_dir = output_dir / username
        logger.info(
            "list_outputs: scanning user_dir=%s exists=%s is_dir=%s",
            user_dir, user_dir.exists(), user_dir.is_dir() if user_dir.exists() else False,
        )
        if user_dir.is_dir():
            for entry in user_dir.rglob("*"):
                if entry.is_file() and entry.suffix.lower() in ALL_MEDIA_EXTS:
                    files.append(_file_info(entry, output_dir))

        # Also list root-level dirs so we can see what's in the output folder
        if output_dir.exists():
            root_items = [e.name for e in output_dir.iterdir()]
            logger.info(
                "list_outputs: output_dir root contents: %s",
                root_items[:20],
            )

        logger.info(
            "list_outputs: user=%s found %d files before filters",
            username, len(files),
        )

        # Apply search filter
        if search:
            files = [f for f in files if search in f["filename"].lower()]

        # Apply type filter
        if type_filter == "image":
            files = [f for f in files if f["type"] == "image"]
        elif type_filter == "video":
            files = [f for f in files if f["type"] == "video"]

        # ── Load tags + ratings from DB ──
        file_paths = [f["relative_path"] for f in files]
        tags_map: dict[str, list[str]] = {}
        ratings_map: dict[str, int] = {}

        if file_paths:
            placeholders = ", ".join("?" for _ in file_paths)
            tag_rows = await db.fetchall(
                f"SELECT file_path, tag FROM output_tags WHERE user_id = ? AND file_path IN ({placeholders})",
                (user_id, *file_paths),
            )
            for row in tag_rows:
                tags_map.setdefault(row["file_path"], []).append(row["tag"])

            rating_rows = await db.fetchall(
                f"SELECT file_path, rating FROM output_ratings WHERE user_id = ? AND file_path IN ({placeholders})",
                (user_id, *file_paths),
            )
            for row in rating_rows:
                ratings_map[row["file_path"]] = row["rating"]

        for f in files:
            rp = f["relative_path"]
            f["tags"] = tags_map.get(rp, [])
            f["rating"] = ratings_map.get(rp, 0)

        # Apply tag filter
        if tag_filter:
            files = [f for f in files if tag_filter in [t.lower() for t in f["tags"]]]

        # Apply rating filter
        if min_rating > 0:
            files = [f for f in files if f["rating"] >= min_rating]

        # Sort
        if sort == "oldest":
            files.sort(key=lambda f: f["modified"])
        elif sort == "name":
            files.sort(key=lambda f: f["filename"].lower())
        elif sort == "rating":
            files.sort(key=lambda f: (-f["rating"], -f["modified"]))
        else:
            files.sort(key=lambda f: f["modified"], reverse=True)

        # Paginate
        total = len(files)
        start = (page - 1) * per_page
        page_files = files[start:start + per_page]

        # Detect workflow/metadata presence for the current page only
        await _detect_workflow_batch(page_files, output_dir)

        return web.json_response({
            "files": page_files,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": (total + per_page - 1) // per_page if total else 0,
        })

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs/all  —  admin cross-user browser
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/all")
    async def list_all_outputs(request: web.Request):
        """Admin-only: list output files across ALL users.

        Query params:
            page, per_page, sort, search, type, user, tag, min_rating
        """
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)
        if not user.get("is_admin"):
            return web.json_response({"error": "Admin access required"}, status=403)

        output_dir = _get_output_dir()
        if not output_dir.exists():
            return web.json_response({
                "files": [], "total": 0, "page": 1, "per_page": 50, "pages": 0,
            })

        user_id = user["id"]

        page = max(1, int(request.query.get("page", 1)))
        per_page = min(max(1, int(request.query.get("per_page", 50))), 500)
        sort = request.query.get("sort", "newest")
        search = request.query.get("search", "").strip().lower()
        type_filter = request.query.get("type", "all")
        user_filter = request.query.get("user", "").strip()
        tag_filter = request.query.get("tag", "").strip().title()
        min_rating = int(request.query.get("min_rating", 0))

        db = await get_db()

        # ── Collect files across all users or a specific user ──
        files: list[dict] = []

        if user_filter:
            target_dir = output_dir / user_filter
            if target_dir.is_dir():
                for entry in target_dir.rglob("*"):
                    if entry.is_file() and entry.suffix.lower() in ALL_MEDIA_EXTS:
                        files.append(_file_info(entry, output_dir))
        else:
            for entry in output_dir.rglob("*"):
                if entry.is_file() and entry.suffix.lower() in ALL_MEDIA_EXTS:
                    files.append(_file_info(entry, output_dir))

        # Apply search filter
        if search:
            files = [f for f in files if search in f["filename"].lower()]

        # Apply type filter
        if type_filter == "image":
            files = [f for f in files if f["type"] == "image"]
        elif type_filter == "video":
            files = [f for f in files if f["type"] == "video"]

        # ── Load tags + ratings from DB ──
        file_paths = [f["relative_path"] for f in files]
        tags_map: dict[str, list[str]] = {}
        ratings_map: dict[str, int] = {}

        if file_paths:
            placeholders = ", ".join("?" for _ in file_paths)
            tag_rows = await db.fetchall(
                f"SELECT file_path, tag FROM output_tags WHERE user_id = ? AND file_path IN ({placeholders})",
                (user_id, *file_paths),
            )
            for row in tag_rows:
                tags_map.setdefault(row["file_path"], []).append(row["tag"])

            rating_rows = await db.fetchall(
                f"SELECT file_path, rating FROM output_ratings WHERE user_id = ? AND file_path IN ({placeholders})",
                (user_id, *file_paths),
            )
            for row in rating_rows:
                ratings_map[row["file_path"]] = row["rating"]

        for f in files:
            rp = f["relative_path"]
            f["tags"] = tags_map.get(rp, [])
            f["rating"] = ratings_map.get(rp, 0)

        # Apply tag filter
        if tag_filter:
            files = [f for f in files if tag_filter in [t.lower() for t in f["tags"]]]

        # Apply rating filter
        if min_rating > 0:
            files = [f for f in files if f["rating"] >= min_rating]

        # Sort
        if sort == "oldest":
            files.sort(key=lambda f: f["modified"])
        elif sort == "name":
            files.sort(key=lambda f: f["filename"].lower())
        elif sort == "rating":
            files.sort(key=lambda f: (-f["rating"], -f["modified"]))
        else:
            files.sort(key=lambda f: f["modified"], reverse=True)

        # Paginate
        total = len(files)
        start = (page - 1) * per_page
        page_files = files[start:start + per_page]

        # Detect workflow/metadata presence for the current page only
        await _detect_workflow_batch(page_files, output_dir)

        return web.json_response({
            "files": page_files,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": (total + per_page - 1) // per_page if total else 0,
        })

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs/users
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/users")
    async def list_output_users(request: web.Request):
        """List usernames with output subfolders (admin only)."""
        user = request.get("multiuser_user")
        if not user or not user.get("is_admin"):
            return web.json_response({"error": "Admin access required"}, status=403)

        output_dir = _get_output_dir()
        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_set = {u["username"] for u in all_users}

        result = []
        if output_dir.exists():
            for entry in sorted(output_dir.iterdir()):
                if entry.is_dir() and entry.name in user_set:
                    count = sum(
                        1 for f in entry.rglob("*")
                        if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTS
                    )
                    result.append({"username": entry.name, "file_count": count})

            root_count = sum(
                1 for f in output_dir.iterdir()
                if f.is_file() and f.suffix.lower() in ALL_MEDIA_EXTS
            )
            if root_count:
                result.insert(0, {"username": "(shared)", "file_count": root_count})

        return web.json_response({"users": result})

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs/thumbnail
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/thumbnail")
    async def get_thumbnail(request: web.Request):
        """Generate and serve a cached thumbnail (images + videos)."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        size = min(max(64, int(request.query.get("size", 256))), 512)

        if not filename:
            return web.json_response({"error": "filename required"}, status=400)

        output_dir = _get_output_dir()
        file_path = _resolve_file(output_dir, filename, subfolder)
        if not file_path:
            return web.json_response({"error": "File not found"}, status=404)

        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}
        if not _check_access(user, file_path, output_dir, user_dirs):
            return web.json_response({"error": "Access denied"}, status=403)

        ext = file_path.suffix.lower()
        stat = file_path.stat()
        cache_dir = _get_thumb_cache_dir()
        cache_key = hashlib.md5(
            f"{file_path}:{stat.st_mtime}:{size}".encode()
        ).hexdigest()
        cache_path = cache_dir / f"{cache_key}.webp"

        if cache_path.exists():
            return web.FileResponse(cache_path, headers={
                "Content-Type": "image/webp",
                "Cache-Control": "public, max-age=86400",
            })

        # Generate
        success = False
        if ext in VIDEO_EXTS:
            success = _generate_video_thumbnail(file_path, cache_path, size)
        elif ext in IMAGE_EXTS:
            success = _generate_image_thumbnail(file_path, cache_path, size)

        if success and cache_path.exists():
            return web.FileResponse(cache_path, headers={
                "Content-Type": "image/webp",
                "Cache-Control": "public, max-age=86400",
            })

        # Fallback
        if ext in IMAGE_EXTS:
            qs = f"filename={filename}&type=output"
            if subfolder:
                qs += f"&subfolder={subfolder}"
            raise web.HTTPFound(f"/view?{qs}")

        # Video with no ffmpeg — simple placeholder
        return web.Response(
            status=200,
            content_type="image/png",
            body=b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01'
                 b'\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde'
                 b'\x00\x00\x00\x0cIDATx\x9cc```\x00\x00\x00\x04\x00\x01'
                 b'\xf6\x178\x00\x00\x00\x00IEND\xaeB`\x82',
        )

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs/metadata
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/metadata")
    async def get_metadata(request: web.Request):
        """Return embedded metadata (PNG chunks, EXIF, ffprobe)."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        if not filename:
            return web.json_response({"error": "filename required"}, status=400)

        output_dir = _get_output_dir()
        file_path = _resolve_file(output_dir, filename, subfolder)
        if not file_path:
            return web.json_response({"error": "File not found"}, status=404)

        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}
        if not _check_access(user, file_path, output_dir, user_dirs):
            return web.json_response({"error": "Access denied"}, status=403)

        ext = file_path.suffix.lower()
        stat = file_path.stat()
        mtime = stat.st_mtime
        if math.isnan(mtime) or math.isinf(mtime):
            mtime = 0.0
        meta = {
            "filename": file_path.name,
            "size": stat.st_size,
            "modified": mtime,
            "extension": ext,
        }
        if ext in VIDEO_EXTS:
            meta["embedded"] = _read_video_metadata(file_path)
        elif ext in IMAGE_EXTS:
            meta["embedded"] = _read_image_metadata(file_path)
        else:
            meta["embedded"] = {}

        # Parse ComfyUI prompt into structured generation info
        emb = meta.get("embedded", {})
        prompt_data = emb.get("prompt")

        # Fallback: look up workflow_json from the generations table
        # if no embedded prompt data was found
        if not prompt_data:
            try:
                fname = file_path.name
                rows = await db.fetchall(
                    "SELECT workflow_json FROM generations "
                    "WHERE output_paths IS NOT NULL AND status = 'completed' "
                    "ORDER BY completed_at DESC"
                )
                for row in rows:
                    op = row.get("output_paths") or row["output_paths"]
                    if op:
                        try:
                            paths_list = json.loads(op) if isinstance(op, str) else op
                        except (json.JSONDecodeError, TypeError):
                            continue
                        if isinstance(paths_list, list) and fname in paths_list:
                            wf = row.get("workflow_json") or row["workflow_json"]
                            if wf:
                                prompt_data = json.loads(wf) if isinstance(wf, str) else wf
                            break
            except Exception:
                pass  # DB fallback is best-effort

        if isinstance(prompt_data, dict):
            meta["geninfo"] = _parse_comfyui_prompt(prompt_data)
        elif isinstance(prompt_data, str):
            try:
                meta["geninfo"] = _parse_comfyui_prompt(json.loads(prompt_data))
            except (json.JSONDecodeError, TypeError):
                meta["geninfo"] = {}
        else:
            meta["geninfo"] = {}

        return web.json_response(_sanitize_for_json(meta))

    # ------------------------------------------------------------------
    #  POST /multiuser/outputs/tags  —  add tags
    # ------------------------------------------------------------------
    @routes.post("/multiuser/outputs/tags")
    async def add_tags(request: web.Request):
        """Add tags to a file.  Body: { file_path, tags: [...] }"""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        body = await request.json()
        file_path_str = body.get("file_path", "").strip()
        tags = body.get("tags", [])
        if not file_path_str or not tags:
            return web.json_response({"error": "file_path and tags required"}, status=400)

        output_dir = _get_output_dir()
        full_path = (output_dir / file_path_str).resolve()
        if not str(full_path).startswith(str(output_dir.resolve())) or not full_path.exists():
            return web.json_response({"error": "File not found"}, status=404)

        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}
        if not _check_access(user, full_path, output_dir, user_dirs):
            return web.json_response({"error": "Access denied"}, status=403)

        clean_tags = list({t.strip().title() for t in tags if t.strip()})
        for tag in clean_tags:
            await db.execute(
                "INSERT OR IGNORE INTO output_tags (user_id, file_path, tag) VALUES (?, ?, ?)",
                (user["id"], file_path_str, tag),
            )
        return web.json_response({"success": True, "tags": clean_tags})

    # ------------------------------------------------------------------
    #  DELETE /multiuser/outputs/tags  —  remove a tag
    # ------------------------------------------------------------------
    @routes.delete("/multiuser/outputs/tags")
    async def remove_tag(request: web.Request):
        """Remove a tag.  Query: file_path, tag"""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        file_path_str = request.query.get("file_path", "").strip()
        tag = request.query.get("tag", "").strip().title()
        if not file_path_str or not tag:
            return web.json_response({"error": "file_path and tag required"}, status=400)

        db = await get_db()
        await db.execute(
            "DELETE FROM output_tags WHERE user_id = ? AND file_path = ? AND tag = ?",
            (user["id"], file_path_str, tag),
        )
        return web.json_response({"success": True})

    # ------------------------------------------------------------------
    #  GET /multiuser/outputs/tags  —  all user tags (autocomplete)
    # ------------------------------------------------------------------
    @routes.get("/multiuser/outputs/tags")
    async def list_tags(request: web.Request):
        """List all distinct tags for this user."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        db = await get_db()
        rows = await db.fetchall(
            "SELECT DISTINCT tag FROM output_tags WHERE user_id = ? ORDER BY tag",
            (user["id"],),
        )
        return web.json_response({"tags": [r["tag"] for r in rows]})

    # ------------------------------------------------------------------
    #  PUT /multiuser/outputs/rating  —  set rating (0-5)
    # ------------------------------------------------------------------
    @routes.put("/multiuser/outputs/rating")
    async def set_rating(request: web.Request):
        """Set 0-5 rating.  Body: { file_path, rating }"""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        body = await request.json()
        file_path_str = body.get("file_path", "").strip()
        rating = int(body.get("rating", 0))
        if not file_path_str:
            return web.json_response({"error": "file_path required"}, status=400)
        if rating < 0 or rating > 5:
            return web.json_response({"error": "rating must be 0-5"}, status=400)

        output_dir = _get_output_dir()
        full_path = (output_dir / file_path_str).resolve()
        if not str(full_path).startswith(str(output_dir.resolve())) or not full_path.exists():
            return web.json_response({"error": "File not found"}, status=404)

        db = await get_db()
        all_users = await db.fetchall("SELECT username FROM users")
        user_dirs = {u["username"] for u in all_users}
        if not _check_access(user, full_path, output_dir, user_dirs):
            return web.json_response({"error": "Access denied"}, status=403)

        user_id = user["id"]
        if rating == 0:
            await db.execute(
                "DELETE FROM output_ratings WHERE user_id = ? AND file_path = ?",
                (user_id, file_path_str),
            )
        else:
            existing = await db.fetchone(
                "SELECT id FROM output_ratings WHERE user_id = ? AND file_path = ?",
                (user_id, file_path_str),
            )
            if existing:
                await db.execute(
                    "UPDATE output_ratings SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (rating, existing["id"]),
                )
            else:
                await db.execute(
                    "INSERT INTO output_ratings (user_id, file_path, rating) VALUES (?, ?, ?)",
                    (user_id, file_path_str, rating),
                )

        return web.json_response({"success": True, "rating": rating})

    # ------------------------------------------------------------------
    #  DELETE /multiuser/outputs/file  —  delete file
    # ------------------------------------------------------------------
    @routes.delete("/multiuser/outputs/file")
    async def delete_output_file(request: web.Request):
        """Delete an output file (own files or admin)."""
        user = request.get("multiuser_user")
        if not user:
            return web.json_response({"error": "Not authenticated"}, status=401)

        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        if not filename:
            return web.json_response({"error": "filename required"}, status=400)

        output_dir = _get_output_dir()
        file_path = _resolve_file(output_dir, filename, subfolder)
        if not file_path:
            return web.json_response({"error": "File not found"}, status=404)

        if not user.get("is_admin"):
            rel = file_path.relative_to(output_dir.resolve())
            parts = rel.parts
            if len(parts) > 1:
                if parts[0] != user["username"]:
                    return web.json_response({"error": "Access denied"}, status=403)
            else:
                return web.json_response({"error": "Cannot delete shared files"}, status=403)

        rel_path = str(file_path.relative_to(output_dir.resolve()))
        try:
            file_path.unlink()
            logger.info("User %s deleted output: %s", user["username"], file_path)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)

        # Clean up DB records
        db = await get_db()
        await db.execute("DELETE FROM output_tags WHERE file_path = ?", (rel_path,))
        await db.execute("DELETE FROM output_ratings WHERE file_path = ?", (rel_path,))

        return web.json_response({"success": True})
