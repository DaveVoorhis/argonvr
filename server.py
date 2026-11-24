import http.server
import socketserver
import base64
import hmac
import os
import re
import ssl
import json
import yaml
import socket
import signal
import subprocess
import threading
import tempfile
import gzip
import hashlib
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs, unquote, quote
try:
    import sdnotify
except ImportError:
    sdnotify = None

with open('argonvr.yaml', 'r', encoding='utf-8') as f:
    config = yaml.safe_load(f)

SETTINGS = config.get('SETTINGS', {})
CAMERAS = config.get('CAMERAS', {})

USERNAME = str(SETTINGS.get('WEB_USER', 'admin'))
PASSWORD = str(SETTINGS.get('WEB_PASS', 'secret'))
STORE_DIR = SETTINGS.get('STORE_DIR', './recordings')
BASE_DIR = SETTINGS.get('BASE_DIR', './cameras')
WEB_DIR = SETTINGS.get('WEB_DIR', './web')
VIDEO_DIR = SETTINGS.get('VIDEO_DIR', os.path.join(STORE_DIR, 'videos'))

ABS_STORE_DIR = os.path.abspath(STORE_DIR)
ABS_BASE_DIR = os.path.abspath(BASE_DIR)
ABS_WEB_DIR = os.path.abspath(WEB_DIR)
ABS_VIDEO_DIR = os.path.abspath(VIDEO_DIR)
STORE_DIR_NAME = os.path.basename(os.path.normpath(STORE_DIR))
BASE_DIR_NAME = os.path.basename(os.path.normpath(BASE_DIR))
VIDEO_DIR_NAME = os.path.basename(os.path.normpath(VIDEO_DIR))
NON_CAMERA_STORE_DIRS = {VIDEO_DIR_NAME, 'videos'}

PORT = int(SETTINGS.get('PORT', 8000))
CAMERA_IDS = list(CAMERAS.keys())
CAMERA_COUNT = len(CAMERA_IDS)
SUB_STREAMS = {
    cam_id: bool(cam_cfg.get('sub_url'))
    for cam_id, cam_cfg in CAMERAS.items()
    if isinstance(cam_cfg, dict)
}

SSL_CERT = SETTINGS.get('SSL_CERT_PATH', '')
SSL_KEY = SETTINGS.get('SSL_KEY_PATH', '')
LOG_HTTP_REQUESTS = SETTINGS.get('LOG_HTTP_REQUESTS', False)
LIVE_SNAPSHOT_FPS = max(0.2, float(SETTINGS.get('LIVE_SNAPSHOT_FPS', 1.0)))
LIVE_SNAPSHOT_QUALITY = int(SETTINGS.get('LIVE_SNAPSHOT_QUALITY', 6))
LIVE_SNAPSHOT_WIDTH = max(160, int(SETTINGS.get('LIVE_SNAPSHOT_WIDTH', 320)))
LIVE_SNAPSHOT_CACHE_TTL = max(0.5, min(5.0, 1.0 / LIVE_SNAPSHOT_FPS))
CONTINUOUS_LIVE_SNAPSHOTS = bool(SETTINGS.get('CONTINUOUS_LIVE_SNAPSHOTS', False))

MAX_JSON_BODY_BYTES = 2 * 1024 * 1024  # 2 MB cap for POST/DELETE JSON payloads

# Bounded LRU caches
_HISTORY_FILE_CACHE = OrderedDict()  # path -> ((mtime_ns, size), parsed_data)
_HISTORY_CACHE_LOCK = threading.Lock()
_HISTORY_FILE_CACHE_MAX = 512

_HISTORY_RESPONSE_CACHE = OrderedDict()  # (req_date, req_cam, stat_sig) -> (etag, raw_bytes, gzip_bytes)
_HISTORY_RESPONSE_LOCK = threading.Lock()
_HISTORY_RESPONSE_CACHE_MAX = 64

_VIDEO_SIDECAR_CACHE = OrderedDict()  # path -> ((mtime_ns, size), parsed_data)
_VIDEO_SIDECAR_LOCK = threading.Lock()
_VIDEO_SIDECAR_CACHE_MAX = 512

# In-memory cache for available dates with short TTL
_DATES_CACHE = {"timestamp": 0.0, "populated": False, "dates": [], "etag": ""}
_DATES_CACHE_LOCK = threading.Lock()

# Video generation concurrency limiter & job status tracker
_VIDEO_GEN_SEMA = threading.BoundedSemaphore(2)
_VIDEO_JOBS = {}  # filename -> {status, error, startedAt, updatedAt}
_VIDEO_JOBS_LOCK = threading.Lock()

# On-demand live.jpg snapshot cache & concurrency guards
_LIVE_SNAPSHOT_CACHE = {}  # cam_id -> {"ts": float, "seg_key": tuple, "jpeg": bytes, "etag": str}
_LIVE_SNAPSHOT_CACHE_LOCK = threading.Lock()
_LIVE_SNAPSHOT_LOCKS = {}  # cam_id -> threading.Lock()
_LIVE_SNAPSHOT_LOCKS_GUARD = threading.Lock()
_LIVE_SNAPSHOT_SEMA = threading.BoundedSemaphore(4)

# Regex matching generated video filenames:
# {cam_id}_{YYYYMMDD}_{startHHMMSS}-{endHHMMSS}_{createdYYYYMMDD}_{createdHHMMSS}[_N].mp4
# or {cam_id}_{startYYYYMMDD}_{startHHMMSS}-{endYYYYMMDD}_{endHHMMSS}_{createdYYYYMMDD}_{createdHHMMSS}[_N].mp4
_VIDEO_FILENAME_RE = re.compile(
    r'^(?P<cam_id>.+)_(?P<date>\d{8})_(?P<start>\d{6})-(?:(?P<end_date>\d{8})_)?(?P<end>\d{6})_(?P<cdate>\d{8})_(?P<ctime>\d{6})(?:_\d+)?\.mp4$'
)

# Regex matching clip filenames containing _{YYYYMMDD}_{HHMMSS}
_CLIP_TIMESTAMP_RE = re.compile(
    r'_(?P<date>\d{8})_(?P<time>\d{6})(?:_\d+)?\.(?:m3u8|ts|mp4)$',
    re.IGNORECASE
)


def _cleanup_orphaned_video_temps():
    """Removes stale .part.mp4 and concat_*.txt temp files left behind by unclean server restarts."""
    if not os.path.isdir(ABS_VIDEO_DIR):
        return
    removed = 0
    try:
        for entry in os.scandir(ABS_VIDEO_DIR):
            if not entry.is_file():
                continue
            name = entry.name
            if name.endswith('.part.mp4') or (name.startswith('concat_') and name.endswith('.txt')) or name.endswith('.json.tmp'):
                try:
                    os.remove(entry.path)
                    removed += 1
                except OSError:
                    pass
    except OSError:
        pass
    if removed > 0:
        print(f"[🧹] Cleaned up {removed} orphaned temporary video file(s) in {ABS_VIDEO_DIR}.")


def _get_live_snapshot_lock(cam_id):
    """Returns a per-camera single-flight lock for on-demand live.jpg generation."""
    with _LIVE_SNAPSHOT_LOCKS_GUARD:
        lock = _LIVE_SNAPSHOT_LOCKS.get(cam_id)
        if lock is None:
            lock = threading.Lock()
            _LIVE_SNAPSHOT_LOCKS[cam_id] = lock
        return lock


def _find_latest_live_segment(cam_dir):
    """Finds the newest available live HLS .ts segment in cam_dir (preferring sub-stream)."""
    for playlist_name in ('stream_sub.m3u8', 'stream.m3u8'):
        playlist_path = os.path.join(cam_dir, playlist_name)
        if not os.path.isfile(playlist_path):
            continue
        try:
            with open(playlist_path, 'r', encoding='utf-8') as f:
                seg_names = [
                    os.path.basename(line.strip().split('?', 1)[0].split('#', 1)[0])
                    for line in f
                    if line.strip() and not line.strip().startswith('#')
                ]
        except OSError:
            continue

        for seg_name in reversed(seg_names):
            if not seg_name.endswith('.ts'):
                continue
            seg_path = os.path.join(cam_dir, seg_name)
            try:
                st = os.stat(seg_path)
                if st.st_size > 0:
                    return seg_path, (seg_name, st.st_mtime_ns, st.st_size)
            except OSError:
                continue

    # Fallback if playlists are mid-rotation: pick newest non-empty live segment directly
    best_sub = None
    best_main = None
    try:
        for entry in os.scandir(cam_dir):
            if not entry.is_file() or not entry.name.endswith('.ts'):
                continue
            try:
                st = entry.stat()
            except OSError:
                continue
            if st.st_size <= 0:
                continue
            cand = (st.st_mtime_ns, entry.path, (entry.name, st.st_mtime_ns, st.st_size))
            if entry.name.startswith('stream_sub_'):
                if best_sub is None or cand[0] > best_sub[0]:
                    best_sub = cand
            elif entry.name.startswith('stream_'):
                if best_main is None or cand[0] > best_main[0]:
                    best_main = cand
    except OSError:
        pass

    chosen = best_sub or best_main
    if chosen:
        return chosen[1], chosen[2]
    return None, None


def _get_or_generate_live_snapshot(cam_id):
    """Extracts a live JPEG frame on demand from the latest HLS segment, cached per camera in RAM."""
    cam_dir = os.path.abspath(os.path.join(ABS_BASE_DIR, cam_id))
    if not cam_dir.startswith(ABS_BASE_DIR + os.sep) or not os.path.isdir(cam_dir):
        return None, None

    now = time.monotonic()
    with _LIVE_SNAPSHOT_CACHE_LOCK:
        cached = _LIVE_SNAPSHOT_CACHE.get(cam_id)
        if cached and (now - cached["ts"]) < LIVE_SNAPSHOT_CACHE_TTL:
            return cached["jpeg"], cached["etag"]

    cam_lock = _get_live_snapshot_lock(cam_id)
    with cam_lock:
        now = time.monotonic()
        with _LIVE_SNAPSHOT_CACHE_LOCK:
            cached = _LIVE_SNAPSHOT_CACHE.get(cam_id)
            if cached and (now - cached["ts"]) < LIVE_SNAPSHOT_CACHE_TTL:
                return cached["jpeg"], cached["etag"]

        seg_path, seg_key = _find_latest_live_segment(cam_dir)
        if not seg_path:
            # Fallback to an existing on-disk live.jpg if present
            disk_snap = os.path.join(cam_dir, 'live.jpg')
            if os.path.isfile(disk_snap):
                try:
                    with open(disk_snap, 'rb') as f:
                        data = f.read()
                    if data:
                        etag = f'"{hashlib.md5(data).hexdigest()}"'
                        return data, etag
                except OSError:
                    pass
            return None, None

        # If the newest segment hasn't changed since our last extraction, reuse cached JPEG without running FFmpeg
        if cached and cached.get("seg_key") == seg_key:
            with _LIVE_SNAPSHOT_CACHE_LOCK:
                cached["ts"] = now
            return cached["jpeg"], cached["etag"]

        cmd = [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel", "error",
            "-i", seg_path,
            "-frames:v", "1",
            "-vf", f"scale={LIVE_SNAPSHOT_WIDTH}:-2",
            "-q:v", str(LIVE_SNAPSHOT_QUALITY),
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "pipe:1",
        ]
        jpeg_bytes = None
        try:
            with _LIVE_SNAPSHOT_SEMA:
                res = subprocess.run(
                    cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                )
            if res.returncode == 0 and len(res.stdout) > 256 and res.stdout.startswith(b'\xff\xd8'):
                jpeg_bytes = res.stdout
        except (subprocess.TimeoutExpired, OSError):
            jpeg_bytes = None

        if jpeg_bytes:
            etag = f'"{hashlib.md5(jpeg_bytes).hexdigest()}"'
            with _LIVE_SNAPSHOT_CACHE_LOCK:
                _LIVE_SNAPSHOT_CACHE[cam_id] = {
                    "ts": time.monotonic(),
                    "seg_key": seg_key,
                    "jpeg": jpeg_bytes,
                    "etag": etag,
                }
            return jpeg_bytes, etag

        # Graceful fallback if the segment rotated mid-read: serve recent cached frame if still fresh
        if cached and (now - cached["ts"]) < 15.0:
            return cached["jpeg"], cached["etag"]

        return None, None


def _set_video_job_state(filename, status, error=None):
    """Updates the in-memory status tracker for a background video export job."""
    now = time.time()
    with _VIDEO_JOBS_LOCK:
        # Prune entries older than 30 minutes
        stale = [k for k, v in _VIDEO_JOBS.items() if (now - v.get("updatedAt", now)) > 1800]
        for k in stale:
            _VIDEO_JOBS.pop(k, None)

        existing = _VIDEO_JOBS.get(filename)
        started_at = existing["startedAt"] if existing else now
        _VIDEO_JOBS[filename] = {
            "status": status,
            "error": error,
            "startedAt": started_at,
            "updatedAt": now,
        }


def _get_video_job_state(filename):
    """Returns job status for a generated video filename."""
    with _VIDEO_JOBS_LOCK:
        job = _VIDEO_JOBS.get(filename)
        if job:
            return dict(job)
    return None


def _load_cached_history_file(history_path):
    """Reads and LRU-caches a camera's daily history JSON file based on its mtime_ns and size."""
    try:
        st = os.stat(history_path)
    except OSError:
        return []

    key = (st.st_mtime_ns, st.st_size)
    with _HISTORY_CACHE_LOCK:
        cached = _HISTORY_FILE_CACHE.get(history_path)
        if cached and cached[0] == key:
            _HISTORY_FILE_CACHE.move_to_end(history_path)
            return cached[1]

    try:
        with open(history_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        with _HISTORY_CACHE_LOCK:
            _HISTORY_FILE_CACHE[history_path] = (key, data)
            _HISTORY_FILE_CACHE.move_to_end(history_path)
            while len(_HISTORY_FILE_CACHE) > _HISTORY_FILE_CACHE_MAX:
                _HISTORY_FILE_CACHE.popitem(last=False)
        return data
    except Exception as e:
        print(f"Error reading {history_path}: {e}")
        return []


def _load_cached_video_sidecar(sidecar_path):
    """Reads and LRU-caches an MP4 sidecar JSON file based on its mtime_ns and size."""
    try:
        st = os.stat(sidecar_path)
    except OSError:
        return None

    key = (st.st_mtime_ns, st.st_size)
    with _VIDEO_SIDECAR_LOCK:
        cached = _VIDEO_SIDECAR_CACHE.get(sidecar_path)
        if cached and cached[0] == key:
            _VIDEO_SIDECAR_CACHE.move_to_end(sidecar_path)
            return cached[1]

    try:
        with open(sidecar_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        with _VIDEO_SIDECAR_LOCK:
            _VIDEO_SIDECAR_CACHE[sidecar_path] = (key, data)
            _VIDEO_SIDECAR_CACHE.move_to_end(sidecar_path)
            while len(_VIDEO_SIDECAR_CACHE) > _VIDEO_SIDECAR_CACHE_MAX:
                _VIDEO_SIDECAR_CACHE.popitem(last=False)
        return data
    except Exception as e:
        print(f"Error reading video sidecar {sidecar_path}: {e}")
        return None


def _format_seconds_hhmmss(seconds, sep=""):
    """Formats seconds since midnight (0-86400) into HHMMSS or HH:MM:SS."""
    sec = max(0, min(86400, int(seconds)))
    hrs = sec // 3600
    mins = (sec % 3600) // 60
    secs = sec % 60
    return f"{hrs:02d}{sep}{mins:02d}{sep}{secs:02d}"


def _hhmmss_to_seconds(hhmmss_str):
    """Converts a 6-digit HHMMSS string into seconds since midnight."""
    if not hhmmss_str or len(hhmmss_str) != 6 or not hhmmss_str.isdigit():
        return None
    hrs = int(hhmmss_str[0:2])
    mins = int(hhmmss_str[2:4])
    secs = int(hhmmss_str[4:6])
    return hrs * 3600 + mins * 60 + secs


def _resolve_video_file(raw_filename, allow_json=False):
    """Validates and resolves a video (or sidecar .json) filename strictly inside ABS_VIDEO_DIR."""
    if not raw_filename or not isinstance(raw_filename, str):
        return None, None

    clean_name = os.path.basename(unquote(raw_filename.strip()))
    lower_name = clean_name.lower()
    allowed_exts = ('.mp4', '.json') if allow_json else ('.mp4',)

    if (
            not clean_name
            or clean_name.startswith('.')
            or not lower_name.endswith(allowed_exts)
            or lower_name.endswith('.part.mp4')
            or lower_name.endswith('.tmp')
    ):
        return None, None

    candidate = os.path.abspath(os.path.join(ABS_VIDEO_DIR, clean_name))
    if candidate != os.path.join(ABS_VIDEO_DIR, clean_name) or not candidate.startswith(ABS_VIDEO_DIR + os.sep):
        return None, None

    return clean_name, candidate


def _build_video_entry(filename, st, include_segments=False):
    """Builds a metadata dictionary for a video file in ABS_VIDEO_DIR.
    By default omits the bulky segments array from list payloads (frontend fetches sidecar on playback)."""
    encoded_name = quote(filename)
    entry = {
        "filename": filename,
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "createdAt": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "camId": None,
        "date": None,
        "endDate": None,
        "startTime": None,
        "endTime": None,
        "startSec": None,
        "endSec": None,
        "duration": None,
        "segmentCount": 0,
        "streamUrl": f"/api/video/stream?file={encoded_name}",
        "downloadUrl": f"/api/video/stream?file={encoded_name}&download=1",
    }

    match = _VIDEO_FILENAME_RE.match(filename)
    if match:
        date_raw = match.group("date")
        end_date_raw = match.group("end_date") or date_raw
        start_raw = match.group("start")
        end_raw = match.group("end")
        cdate_raw = match.group("cdate")
        ctime_raw = match.group("ctime")

        entry["camId"] = match.group("cam_id")
        entry["date"] = date_raw
        entry["endDate"] = end_date_raw
        entry["startTime"] = f"{start_raw[0:2]}:{start_raw[2:4]}:{start_raw[4:6]}"
        entry["endTime"] = f"{end_raw[0:2]}:{end_raw[2:4]}:{end_raw[4:6]}"
        entry["startSec"] = _hhmmss_to_seconds(start_raw)
        entry["endSec"] = _hhmmss_to_seconds(end_raw)
        entry["createdAt"] = (
            f"{cdate_raw[0:4]}-{cdate_raw[4:6]}-{cdate_raw[6:8]} "
            f"{ctime_raw[0:2]}:{ctime_raw[2:4]}:{ctime_raw[4:6]}"
        )

    base_name = os.path.splitext(filename)[0]
    sidecar_name = f"{base_name}.json"
    sidecar_path = os.path.join(ABS_VIDEO_DIR, sidecar_name)
    sidecar_data = _load_cached_video_sidecar(sidecar_path)
    if isinstance(sidecar_data, dict):
        segs = sidecar_data.get("segments")
        if isinstance(segs, list):
            entry["segmentCount"] = len(segs)
            if include_segments:
                entry["segments"] = segs
        if sidecar_data.get("duration") is not None:
            entry["duration"] = sidecar_data["duration"]
        if not entry["camId"] and sidecar_data.get("camId"):
            entry["camId"] = sidecar_data["camId"]
        if not entry["date"] and sidecar_data.get("date"):
            entry["date"] = sidecar_data["date"]
        if not entry["endDate"] and sidecar_data.get("endDate"):
            entry["endDate"] = sidecar_data["endDate"]
        if not entry["startTime"] and sidecar_data.get("startTime"):
            entry["startTime"] = sidecar_data["startTime"]
        if not entry["endTime"] and sidecar_data.get("endTime"):
            entry["endTime"] = sidecar_data["endTime"]
        entry["sidecarUrl"] = f"/api/video/stream?file={quote(sidecar_name)}"

    return entry


def _list_video_files():
    """Returns compact metadata for all completed MP4 files in ABS_VIDEO_DIR sorted newest-first."""
    videos = []
    if not os.path.isdir(ABS_VIDEO_DIR):
        return videos

    try:
        for entry in os.scandir(ABS_VIDEO_DIR):
            if not entry.is_file():
                continue
            name = entry.name
            if name.startswith('.') or not name.lower().endswith('.mp4') or name.lower().endswith('.part.mp4'):
                continue
            try:
                st = entry.stat()
                if st.st_size > 0:
                    videos.append(_build_video_entry(name, st, include_segments=False))
            except OSError:
                continue
    except OSError as e:
        print(f"[❌] Error scanning video directory {ABS_VIDEO_DIR}: {e}")

    videos.sort(key=lambda v: (v["mtime"], v["filename"]), reverse=True)
    return videos


def _safe_store_path(raw_path, cam_id="", date_str=""):
    """Resolves a clip or segment path securely inside ABS_STORE_DIR."""
    if not raw_path or not isinstance(raw_path, str):
        return None

    clean = unquote(raw_path.strip()).split('?', 1)[0].split('#', 1)[0].lstrip('/')
    for prefix in ('recordings/', f'{STORE_DIR_NAME}/', './recordings/', f'./{STORE_DIR_NAME}/'):
        if clean.startswith(prefix):
            clean = clean[len(prefix):]
            break

    search_roots = [ABS_STORE_DIR]
    if cam_id and date_str:
        search_roots.append(os.path.join(ABS_STORE_DIR, cam_id, date_str))
    if cam_id:
        search_roots.append(os.path.join(ABS_STORE_DIR, cam_id))

    for root in search_roots:
        candidate = os.path.abspath(os.path.join(root, clean))
        if (candidate == ABS_STORE_DIR or candidate.startswith(ABS_STORE_DIR + os.sep)) and os.path.exists(candidate):
            return candidate

    return None


def _extract_clip_reference(clip_item):
    """Extracts the file/playlist path string and a chronological sort key from a clip entry."""
    if isinstance(clip_item, str):
        clean_name = os.path.basename(unquote(clip_item.strip()).split('?', 1)[0].split('#', 1)[0])
        match = _CLIP_TIMESTAMP_RE.search(clean_name)
        if match:
            return clip_item, f"{match.group('date')}_{match.group('time')}"
        return clip_item, clip_item

    if isinstance(clip_item, dict):
        path_val = None
        for key in ('playlist', 'm3u8', 'mp4', 'video', 'file', 'url', 'path', 'src', 'filename', 'name'):
            val = clip_item.get(key)
            if isinstance(val, str) and val.strip():
                path_val = val.strip()
                break

        if path_val:
            clean_name = os.path.basename(unquote(path_val).split('?', 1)[0].split('#', 1)[0])
            match = _CLIP_TIMESTAMP_RE.search(clean_name)
            if match:
                return path_val, f"{match.group('date')}_{match.group('time')}"

        sort_key = (
                clip_item.get('timestamp')
                or clip_item.get('startEpoch')
                or clip_item.get('start')
                or clip_item.get('startTime')
                or clip_item.get('time')
                or path_val
                or ""
        )
        return path_val, str(sort_key)

    return None, ""


def _get_m3u8_duration(m3u8_path):
    """Calculates total duration in seconds from #EXTINF tags in an .m3u8 playlist."""
    try:
        total_dur = 0.0
        with open(m3u8_path, 'r', encoding='utf-8') as f:
            for line in f:
                if line.startswith('#EXTINF:'):
                    val = line.split(':', 1)[1].split(',', 1)[0].strip()
                    total_dur += float(val)
        if total_dur > 0:
            return total_dur
    except Exception:
        pass
    return 0.0


def _get_clip_duration(cam_id, date_str, clip_ref, clip_item=None):
    """Resolves the duration in seconds of a clip from its dict metadata, sidecar JSON, history JSON, or .m3u8 playlist."""
    if isinstance(clip_item, dict) and clip_item.get('duration') is not None:
        try:
            dur = float(clip_item['duration'])
            if dur > 0:
                return dur
        except (ValueError, TypeError):
            pass

    clean_name = os.path.basename(unquote((clip_ref or '').strip()).split('?', 1)[0].split('#', 1)[0])

    resolved = _safe_store_path(clip_ref, cam_id, date_str)
    if resolved and os.path.isfile(resolved):
        clip_sidecar = os.path.splitext(resolved)[0] + '.json'
        if os.path.isfile(clip_sidecar):
            try:
                with open(clip_sidecar, 'r', encoding='utf-8') as sf:
                    sdata = json.load(sf)
                dur = float(sdata.get('duration') or 0.0)
                if dur > 0:
                    return dur
            except Exception:
                pass

    if cam_id and date_str and clean_name:
        history_path = os.path.join(ABS_STORE_DIR, cam_id, f'history_{date_str}.json')
        if os.path.exists(history_path):
            for entry in _load_cached_history_file(history_path):
                if isinstance(entry, dict) and entry.get('filename') == clean_name:
                    try:
                        dur = float(entry.get('duration') or 0.0)
                        if dur > 0:
                            return dur
                    except (ValueError, TypeError):
                        pass

    if resolved:
        if os.path.isdir(resolved):
            try:
                m3u8_files = sorted(e for e in os.listdir(resolved) if e.endswith('.m3u8'))
                if m3u8_files:
                    return _get_m3u8_duration(os.path.join(resolved, m3u8_files[0]))
            except OSError:
                pass
        elif resolved.endswith('.m3u8') and os.path.isfile(resolved):
            return _get_m3u8_duration(resolved)

    return 0.0


def _extract_clip_time_range(
        clips,
        cam_id="",
        fallback_date="",
        fallback_start_sec=0,
        fallback_end_sec=86400,
        last_clip_duration=None
):
    """Extracts the earliest clip start and latest clip end (including the last clip's duration)."""
    parsed_stamps = []
    for idx, item in enumerate(clips or []):
        ref, _ = _extract_clip_reference(item)
        if not ref:
            continue
        clean_name = os.path.basename(unquote(ref.strip()).split('?', 1)[0].split('#', 1)[0])
        match = _CLIP_TIMESTAMP_RE.search(clean_name)
        if match:
            parsed_stamps.append((match.group('date'), match.group('time'), idx, item, ref))

    if parsed_stamps:
        parsed_stamps.sort(key=lambda x: (x[0], x[1], x[2]))
        start_date, start_tag, _, _, _ = parsed_stamps[0]
        end_date, end_tag, _, last_item, last_ref = parsed_stamps[-1]

        dur_sec = _get_clip_duration(cam_id, end_date, last_ref, last_item)
        if dur_sec <= 0 and last_clip_duration is not None:
            try:
                dur_sec = max(0.0, float(last_clip_duration))
            except (ValueError, TypeError):
                dur_sec = 0.0

        add_secs = max(0, int(round(dur_sec)))
        if add_secs > 0:
            try:
                end_dt = datetime.strptime(f"{end_date}_{end_tag}", "%Y%m%d_%H%M%S") + timedelta(seconds=add_secs)
                end_date = end_dt.strftime("%Y%m%d")
                end_tag = end_dt.strftime("%H%M%S")
            except ValueError:
                pass

        start_sec = _hhmmss_to_seconds(start_tag)
        end_sec = _hhmmss_to_seconds(end_tag)
        return (
            start_date,
            end_date,
            start_tag,
            end_tag,
            start_sec if start_sec is not None else fallback_start_sec,
            end_sec if end_sec is not None else fallback_end_sec,
        )

    start_tag = _format_seconds_hhmmss(fallback_start_sec)
    end_tag = _format_seconds_hhmmss(fallback_end_sec)
    return fallback_date, fallback_date, start_tag, end_tag, fallback_start_sec, fallback_end_sec


def _build_unique_video_filename(cam_id, start_date, end_date, start_tag, end_tag, created_stamp=None):
    """Formats a collision-safe output MP4 filename using the clip date/time range."""
    if not created_stamp:
        created_stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    if end_date and end_date != start_date:
        base = f"{cam_id}_{start_date}_{start_tag}-{end_date}_{end_tag}_{created_stamp}"
    else:
        base = f"{cam_id}_{start_date}_{start_tag}-{end_tag}_{created_stamp}"

    with _VIDEO_JOBS_LOCK:
        suffix = 0
        while True:
            candidate = f"{base}.mp4" if suffix == 0 else f"{base}_{suffix}.mp4"
            final_path = os.path.join(ABS_VIDEO_DIR, candidate)
            if candidate not in _VIDEO_JOBS and not os.path.exists(final_path):
                _VIDEO_JOBS[candidate] = {
                    "status": "queued",
                    "error": None,
                    "startedAt": time.time(),
                    "updatedAt": time.time(),
                }
                return candidate
            suffix += 1


def _expand_m3u8_segments(m3u8_path, cam_id="", date_str=""):
    """Parses an HLS .m3u8 playlist and returns (valid_segment_paths, valid_duration_seconds)."""
    segments = []
    valid_duration = 0.0
    pending_extinf = 0.0
    playlist_dir = os.path.dirname(m3u8_path)
    try:
        with open(m3u8_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if line.startswith('#EXTINF:'):
                    try:
                        val = line.split(':', 1)[1].split(',', 1)[0].strip()
                        pending_extinf = max(0.0, float(val))
                    except (ValueError, IndexError):
                        pending_extinf = 0.0
                    continue
                if line.startswith('#'):
                    continue

                clean_seg = unquote(line).split('?', 1)[0].split('#', 1)[0]
                if clean_seg.startswith('/'):
                    seg_path = _safe_store_path(clean_seg, cam_id, date_str)
                else:
                    candidate = os.path.abspath(os.path.join(playlist_dir, clean_seg))
                    if candidate.startswith(ABS_STORE_DIR + os.sep) and os.path.isfile(candidate):
                        seg_path = candidate
                    else:
                        seg_path = _safe_store_path(clean_seg, cam_id, date_str)

                if seg_path and os.path.isfile(seg_path) and os.path.getsize(seg_path) > 0:
                    segments.append((seg_path, pending_extinf))
                    valid_duration += pending_extinf
                else:
                    print(f"[⚠️] Missing or empty HLS segment '{line}' referenced in {m3u8_path}")
                pending_extinf = 0.0
    except Exception as e:
        print(f"[❌] Failed to parse playlist {m3u8_path}: {e}")

    return segments, valid_duration


def _resolve_clip_files(cam_id, date_str, clips):
    """Resolves a list of clip entries into:
    1. media_files: ordered, deduplicated list of .ts/.mp4 segment paths for ffmpeg concat
    2. resolved_clips: count of resolved clips
    3. clip_segments_meta: list of segment metadata dicts [{offset, duration, date, startTime, endDate, endTime, filename}]
    """
    extracted = []
    for idx, item in enumerate(clips):
        ref, sort_key = _extract_clip_reference(item)
        if ref:
            extracted.append((sort_key, idx, ref, item))

    # Sort chronologically if sort keys are available so newest-first UI lists play forward in time
    if len(extracted) > 1 and all(item[0] for item in extracted):
        extracted.sort(key=lambda x: (x[0], x[1]))

    media_files = []
    seen = set()
    resolved_clips = 0
    clip_segments_meta = []
    running_offset = 0.0

    for _, _, ref, raw_item in extracted:
        clean_name = os.path.basename(unquote(ref.strip()).split('?', 1)[0].split('#', 1)[0])
        ts_match = _CLIP_TIMESTAMP_RE.search(clean_name)
        clip_date = ts_match.group('date') if ts_match else (
                (raw_item.get('date') if isinstance(raw_item, dict) else None) or date_str
        )
        clip_time_raw = ts_match.group('time') if ts_match else None

        resolved = _safe_store_path(ref, cam_id, clip_date)
        if not resolved and clip_date != date_str:
            resolved = _safe_store_path(ref, cam_id, date_str)
        if not resolved:
            print(f"[⚠️] Clip path could not be resolved for {cam_id} ({clip_date}): {ref}")
            continue

        clip_seg_tuples = []
        m3u8_dur = 0.0
        if os.path.isdir(resolved):
            dir_entries = sorted(os.listdir(resolved))
            m3u8_files = [e for e in dir_entries if e.endswith('.m3u8')]
            if m3u8_files:
                clip_seg_tuples, m3u8_dur = _expand_m3u8_segments(
                    os.path.join(resolved, m3u8_files[0]), cam_id, clip_date
                )
            else:
                clip_seg_tuples = [
                    (os.path.join(resolved, e), 0.0)
                    for e in dir_entries
                    if e.endswith(('.ts', '.mp4')) and os.path.getsize(os.path.join(resolved, e)) > 0
                ]
        elif resolved.endswith('.m3u8'):
            clip_seg_tuples, m3u8_dur = _expand_m3u8_segments(resolved, cam_id, clip_date)
        elif resolved.endswith(('.ts', '.mp4')) and os.path.isfile(resolved) and os.path.getsize(resolved) > 0:
            clip_seg_tuples = [(resolved, 0.0)]

        if clip_seg_tuples:
            added_count = 0
            added_extinf_dur = 0.0
            for seg_path, seg_dur in clip_seg_tuples:
                if seg_path not in seen:
                    seen.add(seg_path)
                    media_files.append(seg_path)
                    added_count += 1
                    added_extinf_dur += seg_dur

            if added_count > 0:
                resolved_clips += 1
                clip_dur = added_extinf_dur if added_extinf_dur > 0 else m3u8_dur
                if clip_dur <= 0:
                    clip_dur = _get_clip_duration(cam_id, clip_date, ref, raw_item)

                start_hhmmss = None
                end_date_str = clip_date
                end_hhmmss = None

                if clip_time_raw and len(clip_time_raw) == 6:
                    start_hhmmss = f"{clip_time_raw[0:2]}:{clip_time_raw[2:4]}:{clip_time_raw[4:6]}"
                    try:
                        start_dt = datetime.strptime(f"{clip_date}_{clip_time_raw}", "%Y%m%d_%H%M%S")
                        end_dt = start_dt + timedelta(seconds=max(0.0, clip_dur))
                        end_date_str = end_dt.strftime("%Y%m%d")
                        end_hhmmss = end_dt.strftime("%H:%M:%S")
                    except ValueError:
                        end_hhmmss = start_hhmmss
                elif isinstance(raw_item, dict) and raw_item.get('startTime'):
                    start_hhmmss = str(raw_item['startTime'])
                    end_hhmmss = str(raw_item.get('endTime') or start_hhmmss)
                    end_date_str = str(raw_item.get('endDate') or clip_date)

                if start_hhmmss and clip_dur > 0:
                    clip_segments_meta.append({
                        "offset": round(running_offset, 2),
                        "duration": round(clip_dur, 2),
                        "date": clip_date,
                        "startTime": start_hhmmss,
                        "endDate": end_date_str,
                        "endTime": end_hhmmss,
                        "filename": clean_name
                    })
                    running_offset += clip_dur
        else:
            print(f"[⚠️] No valid media segments found for clip: {resolved}")

    return media_files, resolved_clips, clip_segments_meta


def _write_video_sidecar_json(
        mp4_filepath,
        cam_id,
        start_date,
        end_date,
        start_time_fmt,
        end_time_fmt,
        clip_segments_meta
):
    """Atomically writes the sidecar .json file alongside a generated MP4 video in ABS_VIDEO_DIR."""
    base_path = os.path.splitext(mp4_filepath)[0]
    sidecar_path = f"{base_path}.json"
    sidecar_tmp = f"{sidecar_path}.tmp"

    total_duration = round(sum(float(s.get("duration") or 0.0) for s in clip_segments_meta), 2)
    payload = {
        "filename": os.path.basename(mp4_filepath),
        "camId": cam_id,
        "date": start_date,
        "startTime": start_time_fmt,
        "endDate": end_date,
        "endTime": end_time_fmt,
        "duration": total_duration,
        "segments": clip_segments_meta
    }

    try:
        with open(sidecar_tmp, 'w', encoding='utf-8') as sf:
            json.dump(payload, sf, indent=2)
        os.replace(sidecar_tmp, sidecar_path)
    except OSError as e:
        print(f"[⚠️] Failed to write sidecar JSON {sidecar_path}: {e}")
        if os.path.exists(sidecar_tmp):
            try:
                os.remove(sidecar_tmp)
            except OSError:
                pass


def generate_video_clip(
        cam_id,
        start_date,
        end_date,
        start_sec,
        end_sec,
        clips,
        output_filename,
):
    """Background worker to generate and store an MP4 video clip and its sidecar .json from displayed history."""
    start_time_wall = time.monotonic()
    start_fmt = _format_seconds_hhmmss(start_sec, ":")
    end_fmt = _format_seconds_hhmmss(end_sec, ":")
    date_window_label = f"{start_date}" if start_date == end_date else f"{start_date}..{end_date}"

    print(
        f"[🎬] Queued background video generation for {cam_id} -> {output_filename} "
        f"(date={date_window_label}, window={start_fmt}-{end_fmt}, clips={len(clips)})"
    )

    concat_list_path = None
    temp_output_path = None

    with _VIDEO_GEN_SEMA:
        _set_video_job_state(output_filename, "running")
        try:
            os.makedirs(ABS_VIDEO_DIR, exist_ok=True)

            media_files, resolved_clips, clip_segments_meta = _resolve_clip_files(cam_id, start_date, clips)
            print(
                f"[🔍] Resolved {resolved_clips}/{len(clips)} clips into "
                f"{len(media_files)} media segment(s) for {cam_id} ({date_window_label})"
            )

            if not media_files:
                err_msg = "No valid media segments found on disk"
                print(f"[❌] Aborting video generation for {cam_id} ({date_window_label}): {err_msg}.")
                _set_video_job_state(output_filename, "failed", err_msg)
                return

            final_output_path = os.path.join(ABS_VIDEO_DIR, output_filename)
            temp_output_path = os.path.join(ABS_VIDEO_DIR, f".{output_filename}.part.mp4")

            with tempfile.NamedTemporaryFile(
                    mode='w',
                    encoding='utf-8',
                    prefix=f"concat_{cam_id}_",
                    suffix=".txt",
                    dir=ABS_VIDEO_DIR,
                    delete=False
            ) as list_file:
                concat_list_path = list_file.name
                for seg_path in media_files:
                    escaped = seg_path.replace("'", r"'\''")
                    list_file.write(f"file '{escaped}'\n")

            print(
                f"[⚙️] Running ffmpeg to build {output_filename} "
                f"from {len(media_files)} segment(s)..."
            )

            cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-fflags", "+genpts+igndts",
                "-f", "concat",
                "-safe", "0",
                "-i", concat_list_path,
                "-c:v", "copy",
                "-an",
                "-avoid_negative_ts", "make_zero",
                "-movflags", "+faststart",
                temp_output_path,
            ]

            proc = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=600
            )

            if proc.returncode != 0:
                err_msg = (proc.stderr or "").strip() or f"exit code {proc.returncode}"
                print(
                    f"[⚠️] Primary stream copy failed for {output_filename} ({err_msg}); "
                    f"retrying with genpts-only timestamp remux..."
                )
                cmd_retry = [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel", "error",
                    "-y",
                    "-fflags", "+genpts+discardcorrupt",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", concat_list_path,
                    "-c:v", "copy",
                    "-an",
                    "-avoid_negative_ts", "make_zero",
                    "-movflags", "+faststart",
                    temp_output_path,
                ]
                proc = subprocess.run(
                    cmd_retry,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=600
                )

            if proc.returncode != 0:
                err_msg = (proc.stderr or "").strip() or f"exit code {proc.returncode}"
                print(f"[❌] ffmpeg failed to generate {output_filename} for {cam_id}: {err_msg}")
                _set_video_job_state(output_filename, "failed", err_msg)
                return

            if not os.path.isfile(temp_output_path) or os.path.getsize(temp_output_path) == 0:
                err_msg = "ffmpeg produced an empty or missing file"
                print(f"[❌] {err_msg} for {output_filename}")
                _set_video_job_state(output_filename, "failed", err_msg)
                return

            os.replace(temp_output_path, final_output_path)
            temp_output_path = None

            _write_video_sidecar_json(
                final_output_path,
                cam_id=cam_id,
                start_date=start_date,
                end_date=end_date,
                start_time_fmt=start_fmt,
                end_time_fmt=end_fmt,
                clip_segments_meta=clip_segments_meta
            )

            _set_video_job_state(output_filename, "ready")

            size_mb = os.path.getsize(final_output_path) / (1024 * 1024)
            elapsed = time.monotonic() - start_time_wall
            print(
                f"[✅] Video created for {cam_id}: {final_output_path} "
                f"({size_mb:.2f} MB, {len(clip_segments_meta)} clip segment(s) in {elapsed:.1f}s)"
            )

        except subprocess.TimeoutExpired:
            err_msg = "Timed out generating video clip after 600s"
            print(f"[❌] {err_msg} for {cam_id} ({date_window_label})")
            _set_video_job_state(output_filename, "failed", err_msg)
        except Exception as e:
            print(f"[❌] Error generating video clip for {cam_id} ({date_window_label}): {e}")
            _set_video_job_state(output_filename, "failed", str(e))
        finally:
            if concat_list_path and os.path.exists(concat_list_path):
                try:
                    os.remove(concat_list_path)
                except OSError:
                    pass
            if temp_output_path and os.path.exists(temp_output_path):
                try:
                    os.remove(temp_output_path)
                except OSError:
                    pass


class PooledHTTPServer(socketserver.TCPServer):
    """Bounded ThreadPoolExecutor HTTP/HTTPS server with per-worker TLS handshakes and load shedding."""
    allow_reuse_address = True
    request_queue_size = 64
    MAX_WORKERS = 64
    MAX_INFLIGHT = 128

    def __init__(self, server_address, RequestHandlerClass, ssl_context=None):
        super().__init__(server_address, RequestHandlerClass)
        self.ssl_context = ssl_context
        self._executor = ThreadPoolExecutor(max_workers=self.MAX_WORKERS, thread_name_prefix="http-worker")
        self._conn_lock = threading.Lock()
        self._inflight = 0
        self._active_workers = 0

    def active_connection_ratio(self):
        with self._conn_lock:
            return self._active_workers / float(self.MAX_WORKERS)

    def process_request(self, request, client_address):
        with self._conn_lock:
            if self._inflight >= self.MAX_INFLIGHT:
                # Shed load gracefully instead of spawning unbounded threads/FDs
                try:
                    self.shutdown_request(request)
                except Exception:
                    pass
                return
            self._inflight += 1

        try:
            self._executor.submit(self._process_request_worker, request, client_address)
        except RuntimeError:
            with self._conn_lock:
                self._inflight = max(0, self._inflight - 1)
            self.shutdown_request(request)

    def _process_request_worker(self, request, client_address):
        """Performs TLS handshake and handles requests inside the pooled worker thread."""
        with self._conn_lock:
            self._active_workers += 1
        try:
            request.settimeout(10)
            try:
                request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            if self.ssl_context is not None:
                request = self.ssl_context.wrap_socket(request, server_side=True)
            self.finish_request(request, client_address)
        except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError, OSError):
            pass
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)
            with self._conn_lock:
                self._active_workers = max(0, self._active_workers - 1)
                self._inflight = max(0, self._inflight - 1)

    def server_close(self):
        super().server_close()
        try:
            self._executor.shutdown(wait=False, cancel_futures=True)
        except TypeError:
            self._executor.shutdown(wait=False)


class SecureAuthHandler(http.server.SimpleHTTPRequestHandler):

    # Enable HTTP/1.1 persistent connections (Keep-Alive) to avoid repeated TCP/TLS handshakes
    protocol_version = "HTTP/1.1"

    # Keep idle Keep-Alive sockets short so worker slots recycle quickly under concurrency
    timeout = 5

    # Ensure correct HLS & media MIME types across both Linux and macOS
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.m3u8': 'application/vnd.apple.mpegurl',
        '.ts': 'video/mp2t',
        '.mp4': 'video/mp4',
        '.vtt': 'text/vtt',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
    }

    COMPRESSIBLE_EXTENSIONS = ('.json', '.vtt', '.m3u8', '.js', '.css', '.html', '.svg')

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def address_string(self):
        """Prevents reverse DNS lookups that cause initial connection lag."""
        return self.client_address[0]

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError, OSError):
            pass
        except Exception as e:
            print(f"Unexpected error: {e}")

    def log_message(self, format, *args):
        request_path = getattr(self, 'path', '')
        quiet_extensions = ('.ts', '.m3u8', '.mp4', '.json', '.jpg', '.vtt', '.js', '/health')
        if not LOG_HTTP_REQUESTS and any(ext in request_path for ext in quiet_extensions):
            return
        super().log_message(format, *args)

    def _accepts_gzip(self):
        accept_enc = self.headers.get('Accept-Encoding', '')
        return 'gzip' in accept_enc.lower()

    def _maybe_close_under_load(self):
        """Instructs clients to close Keep-Alive connections when worker pool pressure exceeds 50%."""
        if self.close_connection or (
                hasattr(self.server, 'active_connection_ratio') and self.server.active_connection_ratio() >= 0.5
        ):
            self.close_connection = True
            self.send_header('Connection', 'close')

    def end_headers(self):
        """Intercept header generation to inject custom cache headers and load-aware Connection headers."""
        clean_path = getattr(self, 'path', '').split('?', 1)[0].split('#', 1)[0]
        basename = os.path.basename(clean_path)

        if (
                clean_path.endswith('.html')
                or clean_path == '/'
                or clean_path.endswith(('/stream.m3u8', '/stream_sub.m3u8'))
                or clean_path.endswith('/live.jpg')
                or (basename.startswith('history_') and basename.endswith('.json'))
                or clean_path in (
                '/history',
                '/available_dates',
                '/cameracount',
                '/basedir',
                '/health',
                '/api/video/list',
                '/api/videos',
                '/api/video/status',
        )
        ):
            self.send_header('Cache-Control', 'no-cache, must-revalidate, max-age=0')
        elif (
                clean_path.startswith(f'/{BASE_DIR_NAME}/')
                and clean_path.endswith('.ts')
        ):
            # Live segments use epoch-based numbering so short caching is safe and fast
            self.send_header('Cache-Control', 'private, max-age=15')
        elif (
                clean_path.startswith('/recordings/')
                or (STORE_DIR_NAME != 'recordings' and clean_path.startswith(f'/{STORE_DIR_NAME}/'))
        ) and clean_path.endswith(('.ts', '.jpg', '.vtt', '.m3u8', '.json')):
            self.send_header('Cache-Control', 'public, max-age=86400, immutable')

        self._maybe_close_under_load()
        super().end_headers()

    @staticmethod
    def _safe_join(root_abs, relative_path):
        """Resolves a relative path inside root_abs and blocks directory traversal."""
        rel = unquote(relative_path).lstrip('/')
        candidate = os.path.abspath(os.path.join(root_abs, rel))
        if candidate == root_abs or candidate.startswith(root_abs + os.sep):
            return candidate
        return root_abs

    def translate_path(self, path):
        clean_path = path.split('?', 1)[0].split('#', 1)[0]

        # 1. Keep recordings explicitly mapped to STORE_DIR
        if clean_path.startswith('/recordings/'):
            relative_path = clean_path[len('/recordings/'):]
            return self._safe_join(ABS_STORE_DIR, relative_path)
        if STORE_DIR_NAME != 'recordings' and clean_path.startswith(f'/{STORE_DIR_NAME}/'):
            relative_path = clean_path[len(f'/{STORE_DIR_NAME}/'):]
            return self._safe_join(ABS_STORE_DIR, relative_path)

        # 2. Map /videos/ directly to ABS_VIDEO_DIR regardless of where VIDEO_DIR is configured
        if clean_path.startswith('/videos/'):
            relative_path = clean_path[len('/videos/'):]
            return self._safe_join(ABS_VIDEO_DIR, relative_path)

        # 3. Ensure active camera streams explicitly map to BASE_DIR outside of WEB_DIR
        if clean_path.startswith(f'/{BASE_DIR_NAME}/'):
            relative_path = clean_path[len(f'/{BASE_DIR_NAME}/'):]
            return self._safe_join(ABS_BASE_DIR, relative_path)

        # 4. Everything else defaults to being securely served out of WEB_DIR
        return super().translate_path(path)

    def do_AUTHHEAD(self, body=b"Authentication required.", send_body=True):
        if self.headers and self.headers.get('Content-Length') not in (None, '', '0'):
            self.close_connection = True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="ArgoNVR Secure Access"')
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body and body:
            self.wfile.write(body)

    def _is_authenticated(self):
        auth_header = self.headers.get('Authorization')
        if not auth_header:
            return False
        try:
            auth_type, encoded_credentials = auth_header.split(' ', 1)
            if auth_type.lower() != 'basic':
                return False
            decoded_credentials = base64.b64decode(encoded_credentials).decode('utf-8')
            username, password = decoded_credentials.split(':', 1)
            return (
                    hmac.compare_digest(username, USERNAME)
                    and hmac.compare_digest(password, PASSWORD)
            )
        except Exception:
            return False

    def _read_json_body(self):
        """Safely reads and parses a bounded JSON request body."""
        try:
            content_length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            self.close_connection = True
            return None, (400, "Invalid Content-Length header")

        if content_length < 0:
            self.close_connection = True
            return None, (400, "Invalid negative Content-Length")
        if content_length > MAX_JSON_BODY_BYTES:
            self.close_connection = True
            return None, (413, "Request body too large")
        if content_length == 0:
            return {}, None

        raw_body = self.rfile.read(content_length)
        try:
            return json.loads(raw_body.decode('utf-8')), None
        except Exception:
            return None, (400, "Invalid JSON payload")

    def _send_preencoded_json(self, raw_bytes, gzip_bytes, status=200, etag=None, send_body=True):
        if status == 200 and etag and self.headers.get('If-None-Match') == etag:
            self.send_response(304)
            self.send_header('ETag', etag)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        use_gzip = self._accepts_gzip() and gzip_bytes is not None
        body = gzip_bytes if use_gzip else raw_bytes

        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        if etag:
            self.send_header('ETag', etag)
        if use_gzip:
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _send_json(self, payload, status=200, etag=None, send_body=True):
        raw_bytes = json.dumps(payload, separators=(',', ':')).encode('utf-8')
        if etag is None and status == 200:
            etag = f'"{hashlib.md5(raw_bytes).hexdigest()}"'

        if status == 200 and etag and self.headers.get('If-None-Match') == etag:
            self.send_response(304)
            self.send_header('ETag', etag)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        use_gzip = self._accepts_gzip() and len(raw_bytes) > 256
        body = gzip.compress(raw_bytes, compresslevel=6) if use_gzip else raw_bytes

        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        if etag:
            self.send_header('ETag', etag)
        if use_gzip:
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _serve_optimized_file(self, filepath, clean_path, extra_headers=None, send_body=True):
        """Serves static/media files with ETag/304 support, Gzip compression, and strict Content-Length safety."""
        headers_sent = False
        try:
            with open(filepath, 'rb') as f:
                st = os.fstat(f.fileno())
                etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'

                if self.headers.get('If-None-Match') == etag:
                    self.send_response(304)
                    self.send_header('ETag', etag)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return

                ctype = self.guess_type(filepath)
                should_compress = (
                        clean_path.endswith(self.COMPRESSIBLE_EXTENSIONS)
                        and self._accepts_gzip()
                        and 256 < st.st_size <= 2 * 1024 * 1024
                )

                # Buffer small/mutable files (<= 1 MB, including live.jpg, .m3u8, .vtt) in RAM first
                # so Content-Length is guaranteed to match the exact bytes written on HTTP/1.1 Keep-Alive
                if should_compress or st.st_size <= 1024 * 1024:
                    raw_data = f.read()
                    body = gzip.compress(raw_data, compresslevel=6) if should_compress else raw_data
                    self.send_response(200)
                    self.send_header('Content-Type', ctype)
                    self.send_header('ETag', etag)
                    if clean_path.endswith('.mp4'):
                        self.send_header('Accept-Ranges', 'bytes')
                    if extra_headers:
                        for h_key, h_val in extra_headers.items():
                            self.send_header(h_key, h_val)
                    if should_compress:
                        self.send_header('Content-Encoding', 'gzip')
                        self.send_header('Vary', 'Accept-Encoding')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    headers_sent = True
                    if send_body:
                        self.wfile.write(body)
                else:
                    self.send_response(200)
                    self.send_header('Content-Type', ctype)
                    self.send_header('ETag', etag)
                    if clean_path.endswith('.mp4'):
                        self.send_header('Accept-Ranges', 'bytes')
                    if extra_headers:
                        for h_key, h_val in extra_headers.items():
                            self.send_header(h_key, h_val)
                    self.send_header('Content-Length', str(st.st_size))
                    self.end_headers()
                    headers_sent = True
                    if send_body:
                        remaining = st.st_size
                        while remaining > 0:
                            chunk = f.read(min(65536, remaining))
                            if not chunk:
                                # File truncated mid-transfer: close socket to avoid corrupting Keep-Alive framing
                                self.close_connection = True
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
        except FileNotFoundError:
            if not headers_sent:
                self.send_error(404)
            else:
                self.close_connection = True
        except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError, OSError):
            self.close_connection = True

    def _send_range_not_satisfiable(self, file_len):
        body = b"Requested Range Not Satisfiable"
        self.send_response(416)
        self.send_header('Content-Range', f'bytes */{file_len}')
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_range(self, filepath, range_header, extra_headers=None, send_body=True):
        headers_sent = False
        try:
            with open(filepath, 'rb') as f:
                fs = os.fstat(f.fileno())
                file_len = fs.st_size
                etag = f'"{fs.st_mtime_ns:x}-{fs.st_size:x}"'

                if file_len <= 0 or not range_header.startswith('bytes='):
                    self._send_range_not_satisfiable(file_len)
                    return

                try:
                    byte_range = range_header[6:].split(',', 1)[0].strip().split('-')
                    if len(byte_range) != 2:
                        raise ValueError("Invalid range syntax")
                    if not byte_range[0]:
                        # Suffix byte range: bytes=-500
                        suffix_len = int(byte_range[1]) if byte_range[1] else 0
                        if suffix_len <= 0:
                            self._send_range_not_satisfiable(file_len)
                            return
                        start = max(0, file_len - suffix_len)
                        end = file_len - 1
                    else:
                        start = int(byte_range[0])
                        end = int(byte_range[1]) if byte_range[1] else file_len - 1
                        end = min(end, file_len - 1)
                except ValueError:
                    self._send_range_not_satisfiable(file_len)
                    return

                if start >= file_len or start > end or start < 0:
                    self._send_range_not_satisfiable(file_len)
                    return

                length = end - start + 1
                self.send_response(206)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('ETag', etag)
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_len}')
                self.send_header('Cache-Control', 'private, max-age=3600')
                if extra_headers:
                    for h_key, h_val in extra_headers.items():
                        self.send_header(h_key, h_val)
                self.send_header('Content-Length', str(length))
                self.end_headers()
                headers_sent = True

                if send_body:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk:
                            self.close_connection = True
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
        except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError, OSError):
            self.close_connection = True
        except Exception as e:
            if not headers_sent:
                self.send_error(500, f"Server Error: {e}")
            else:
                self.close_connection = True

    def _handle_video_stream(self, path_no_query, query_params, send_body=True):
        """Streams or downloads a requested video (or sidecar .json) file from ABS_VIDEO_DIR."""
        raw_file = (
                query_params.get('file', [None])[0]
                or query_params.get('filename', [None])[0]
                or query_params.get('name', [None])[0]
        )
        if not raw_file and path_no_query.startswith('/api/video/stream/'):
            raw_file = path_no_query[len('/api/video/stream/'):]

        clean_name, filepath = _resolve_video_file(raw_file, allow_json=True)
        if not clean_name or not filepath:
            self._send_json({"error": "Invalid or missing video filename"}, status=400, send_body=send_body)
            return

        if not os.path.isfile(filepath):
            self._send_json({"error": "Video file not found"}, status=404, send_body=send_body)
            return

        is_download = query_params.get('download', ['0'])[0].lower() in ('1', 'true', 'yes')
        disposition = 'attachment' if is_download else 'inline'
        extra_headers = {
            'Content-Disposition': f'{disposition}; filename="{clean_name}"'
        }

        range_header = self.headers.get('Range')
        if range_header and clean_name.lower().endswith('.mp4'):
            self.serve_range(filepath, range_header, extra_headers=extra_headers, send_body=send_body)
        else:
            self._serve_optimized_file(filepath, clean_name, extra_headers=extra_headers, send_body=send_body)

    def _handle_video_status(self, query_params, send_body=True):
        """Returns background export status (queued/running/ready/failed) for a target filename."""
        raw_file = (
                query_params.get('file', [None])[0]
                or query_params.get('filename', [None])[0]
                or query_params.get('name', [None])[0]
        )
        clean_name, filepath = _resolve_video_file(raw_file, allow_json=False)
        if not clean_name or not filepath:
            self._send_json({"error": "Invalid or missing video filename"}, status=400, send_body=send_body)
            return

        job = _get_video_job_state(clean_name)
        if os.path.isfile(filepath) and os.path.getsize(filepath) > 0:
            elapsed = round(time.time() - job["startedAt"], 1) if job else 0.0
            self._send_json(
                {"status": "ready", "filename": clean_name, "error": None, "elapsedSec": elapsed},
                status=200,
                send_body=send_body
            )
            return

        if job:
            elapsed = round(time.time() - job["startedAt"], 1)
            self._send_json(
                {
                    "status": job["status"],
                    "filename": clean_name,
                    "error": job.get("error"),
                    "elapsedSec": elapsed
                },
                status=200,
                send_body=send_body
            )
            return

        self._send_json({"status": "not_found", "filename": clean_name}, status=404, send_body=send_body)

    def _handle_video_delete(self, path_no_query, query_params):
        """Deletes a specified video file and its sidecar .json from ABS_VIDEO_DIR."""
        raw_file = (
                query_params.get('file', [None])[0]
                or query_params.get('filename', [None])[0]
                or query_params.get('name', [None])[0]
        )
        if not raw_file and path_no_query.startswith('/api/video/delete/'):
            raw_file = path_no_query[len('/api/video/delete/'):]

        if not raw_file:
            payload, err = self._read_json_body()
            if err:
                self._send_json({"error": err[1]}, status=err[0])
                return
            if isinstance(payload, dict):
                raw_file = (
                        payload.get('file')
                        or payload.get('filename')
                        or payload.get('name')
                )

        clean_name, filepath = _resolve_video_file(raw_file)
        if not clean_name or not filepath:
            self._send_json({"error": "Invalid or missing video filename"}, status=400)
            return

        if not os.path.isfile(filepath):
            self._send_json({"error": "Video file not found"}, status=404)
            return

        try:
            os.remove(filepath)
            sidecar_path = os.path.splitext(filepath)[0] + '.json'
            if os.path.isfile(sidecar_path):
                try:
                    os.remove(sidecar_path)
                except OSError:
                    pass
            with _VIDEO_SIDECAR_LOCK:
                _VIDEO_SIDECAR_CACHE.pop(sidecar_path, None)
            with _VIDEO_JOBS_LOCK:
                _VIDEO_JOBS.pop(clean_name, None)

            print(f"[🗑️] Deleted video file '{clean_name}' (requested by {self.address_string()})")
            self._send_json({"status": "deleted", "filename": clean_name}, status=200)
        except OSError as e:
            print(f"[❌] Failed to delete video file '{clean_name}': {e}")
            self._send_json({"error": f"Failed to delete video file: {e}"}, status=500)

    def _handle_history_request(self, query_params, send_body=True):
        """Serves /history with a stat-based composite ETag and pre-encoded LRU cache
        so unchanged 30s polls return 304 without reading, serializing, or hashing JSON."""
        req_date = query_params.get('date', [None])[0]
        req_cam = query_params.get('cam', [None])[0]

        if not req_date:
            self.send_error(400, "Missing 'date' parameter")
            return

        safe_date = os.path.basename(req_date)
        safe_cam = os.path.basename(req_cam) if req_cam else ""

        cam_targets = []
        if safe_cam:
            history_path = os.path.join(ABS_STORE_DIR, safe_cam, f'history_{safe_date}.json')
            try:
                st = os.stat(history_path)
                cam_targets.append((safe_cam, history_path, st.st_mtime_ns, st.st_size))
            except OSError:
                cam_targets.append((safe_cam, history_path, 0, 0))
        else:
            try:
                if os.path.isdir(ABS_STORE_DIR):
                    cam_dirs = sorted(
                        e.name for e in os.scandir(ABS_STORE_DIR)
                        if e.is_dir() and e.name not in NON_CAMERA_STORE_DIRS
                    )
                    for cam_dir in cam_dirs:
                        history_path = os.path.join(ABS_STORE_DIR, cam_dir, f'history_{safe_date}.json')
                        try:
                            st = os.stat(history_path)
                            cam_targets.append((cam_dir, history_path, st.st_mtime_ns, st.st_size))
                        except OSError:
                            cam_targets.append((cam_dir, history_path, 0, 0))
            except Exception as e:
                print(f"Error reading history directories: {e}")

        stat_sig = tuple((c, m, s) for c, _, m, s in cam_targets)
        sig_str = f"{safe_date}|{safe_cam}|{stat_sig}"
        etag = f'"{hashlib.md5(sig_str.encode("utf-8")).hexdigest()}"'

        if self.headers.get('If-None-Match') == etag:
            self.send_response(304)
            self.send_header('ETag', etag)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        cache_key = (safe_date, safe_cam, stat_sig)
        with _HISTORY_RESPONSE_LOCK:
            cached_resp = _HISTORY_RESPONSE_CACHE.get(cache_key)
            if cached_resp:
                _HISTORY_RESPONSE_CACHE.move_to_end(cache_key)

        if cached_resp:
            cached_etag, raw_bytes, gzip_bytes = cached_resp
            self._send_preencoded_json(raw_bytes, gzip_bytes, status=200, etag=cached_etag, send_body=send_body)
            return

        response_data = {}
        for cam_dir, history_path, mtime_ns, size in cam_targets:
            response_data[cam_dir] = _load_cached_history_file(history_path) if size > 0 else []

        raw_bytes = json.dumps(response_data, separators=(',', ':')).encode('utf-8')
        gzip_bytes = gzip.compress(raw_bytes, compresslevel=6) if len(raw_bytes) > 256 else None

        with _HISTORY_RESPONSE_LOCK:
            _HISTORY_RESPONSE_CACHE[cache_key] = (etag, raw_bytes, gzip_bytes)
            _HISTORY_RESPONSE_CACHE.move_to_end(cache_key)
            while len(_HISTORY_RESPONSE_CACHE) > _HISTORY_RESPONSE_CACHE_MAX:
                _HISTORY_RESPONSE_CACHE.popitem(last=False)

        self._send_preencoded_json(raw_bytes, gzip_bytes, status=200, etag=etag, send_body=send_body)

    def _handle_live_snapshot_request(self, cam_id, send_body=True):
        """Serves an on-demand live.jpg extracted from the camera's latest HLS segment."""
        jpeg_bytes, etag = _get_or_generate_live_snapshot(cam_id)
        if not jpeg_bytes:
            self.send_error(404)
            return

        if etag and self.headers.get('If-None-Match') == etag:
            self.send_response(304)
            self.send_header('ETag', etag)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        if etag:
            self.send_header('ETag', etag)
        self.send_header('Content-Length', str(len(jpeg_bytes)))
        self.end_headers()
        if send_body:
            self.wfile.write(jpeg_bytes)

    def _handle_get_or_head(self, send_body=True):
        parsed_url = urlparse(self.path)
        path_no_query = parsed_url.path
        query_params = parse_qs(parsed_url.query)

        if path_no_query == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', '2')
            self.end_headers()
            if send_body:
                self.wfile.write(b"OK")
            return

        # --- PWA Whitelist ---
        if path_no_query in ('/manifest.json', '/sw.js') or path_no_query.startswith('/icons/'):
            if send_body:
                super().do_GET()
            else:
                super().do_HEAD()
            return
        # ---------------------

        if not self._is_authenticated():
            self.do_AUTHHEAD(send_body=send_body)
            return

        if path_no_query in ('/api/video/list', '/api/videos'):
            videos = _list_video_files()
            self._send_json({"videos": videos}, send_body=send_body)
            return

        if path_no_query == '/api/video/status':
            self._handle_video_status(query_params, send_body=send_body)
            return

        if path_no_query == '/api/video/stream' or path_no_query.startswith('/api/video/stream/'):
            self._handle_video_stream(path_no_query, query_params, send_body=send_body)
            return

        if path_no_query == '/history':
            self._handle_history_request(query_params, send_body=send_body)
            return

        if path_no_query == '/available_dates':
            now = time.time()
            with _DATES_CACHE_LOCK:
                if _DATES_CACHE["populated"] and (now - _DATES_CACHE["timestamp"]) < 10.0:
                    cached_dates = _DATES_CACHE["dates"]
                    cached_etag = _DATES_CACHE["etag"]
                else:
                    cached_dates = None
                    cached_etag = None

            if cached_dates is None:
                dates = set()
                try:
                    if os.path.isdir(ABS_STORE_DIR):
                        for cam_entry in os.scandir(ABS_STORE_DIR):
                            if not cam_entry.is_dir() or cam_entry.name in NON_CAMERA_STORE_DIRS:
                                continue
                            try:
                                for f_entry in os.scandir(cam_entry.path):
                                    fname = f_entry.name
                                    if fname.startswith('history_') and fname.endswith('.json') and len(fname) == 21:
                                        date_str = fname[8:16]
                                        if date_str.isdigit():
                                            dates.add(date_str)
                            except OSError:
                                continue
                except Exception as e:
                    print(f"Error reading available dates: {e}")

                cached_dates = sorted(dates)
                cached_etag = f'"{hashlib.md5(json.dumps(cached_dates).encode()).hexdigest()}"'
                with _DATES_CACHE_LOCK:
                    _DATES_CACHE["timestamp"] = now
                    _DATES_CACHE["populated"] = True
                    _DATES_CACHE["dates"] = cached_dates
                    _DATES_CACHE["etag"] = cached_etag

            self._send_json(cached_dates, etag=cached_etag, send_body=send_body)
            return

        if path_no_query == '/cameracount':
            self._send_json({"count": CAMERA_COUNT, "cameras": CAMERA_IDS, "subStreams": SUB_STREAMS}, send_body=send_body)
            return

        if path_no_query == '/basedir':
            self._send_json({"baseDir": BASE_DIR, "subStreams": SUB_STREAMS}, send_body=send_body)
            return

        live_snap_prefix = f'/{BASE_DIR_NAME}/'
        if path_no_query.startswith(live_snap_prefix) and path_no_query.endswith('/live.jpg'):
            rel_parts = unquote(path_no_query[len(live_snap_prefix):]).split('/')
            if len(rel_parts) == 2 and rel_parts[1] == 'live.jpg':
                snap_cam_id = rel_parts[0]
                if snap_cam_id and snap_cam_id not in ('.', '..') and '/' not in snap_cam_id and '\\' not in snap_cam_id:
                    if not CONTINUOUS_LIVE_SNAPSHOTS or not os.path.isfile(self.translate_path(path_no_query)):
                        self._handle_live_snapshot_request(snap_cam_id, send_body=send_body)
                        return

        filepath = self.translate_path(path_no_query)

        if path_no_query.endswith(('.m3u8', '.ts', '.mp4', '.json', '.jpg', '.vtt', '.js', '.css')):
            if not os.path.exists(filepath):
                self.send_error(404)
                return

        range_header = self.headers.get('Range')
        if path_no_query.endswith('.mp4') and range_header:
            self.serve_range(filepath, range_header, send_body=send_body)
            return

        if os.path.isfile(filepath):
            self._serve_optimized_file(filepath, path_no_query, send_body=send_body)
            return

        if send_body:
            super().do_GET()
        else:
            super().do_HEAD()

    def do_GET(self):
        self._handle_get_or_head(send_body=True)

    def do_HEAD(self):
        self._handle_get_or_head(send_body=False)

    def do_POST(self):
        parsed_url = urlparse(self.path)
        path_no_query = parsed_url.path
        query_params = parse_qs(parsed_url.query)

        if not self._is_authenticated():
            self.do_AUTHHEAD()
            return

        if path_no_query == '/api/video/create':
            try:
                payload, err = self._read_json_body()
                if err:
                    self._send_json({"error": err[1]}, status=err[0])
                    return

                cam_id = os.path.basename(str(payload.get('camId', '')).strip())
                date_str = os.path.basename(str(payload.get('date', '')).strip())
                start_sec = int(payload.get('startSec', 0))
                end_sec = int(payload.get('endSec', 86400))
                last_clip_duration = payload.get('lastClipDuration')
                clips = payload.get('clips', [])

                if not cam_id or not date_str or not isinstance(clips, list) or len(clips) == 0:
                    print(
                        f"[⚠️] Rejected /api/video/create request from {self.address_string()}: "
                        f"camId='{cam_id}', date='{date_str}', clips={len(clips) if isinstance(clips, list) else 'invalid'}"
                    )
                    self._send_json(
                        {"error": "Invalid video creation parameters (non-empty clips list required)"},
                        status=400
                    )
                    return

                (
                    start_date,
                    end_date,
                    start_tag,
                    end_tag,
                    clip_start_sec,
                    clip_end_sec,
                ) = _extract_clip_time_range(
                    clips,
                    cam_id=cam_id,
                    fallback_date=date_str,
                    fallback_start_sec=start_sec,
                    fallback_end_sec=end_sec,
                    last_clip_duration=last_clip_duration
                )

                created_stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                output_filename = _build_unique_video_filename(
                    cam_id, start_date, end_date, start_tag, end_tag, created_stamp
                )
                encoded_name = quote(output_filename)

                print(
                    f"[📥] Accepted /api/video/create from {self.address_string()} "
                    f"for {cam_id} on {start_date} ({len(clips)} clip(s)) -> {output_filename}"
                )

                threading.Thread(
                    target=generate_video_clip,
                    args=(
                        cam_id,
                        start_date,
                        end_date,
                        clip_start_sec,
                        clip_end_sec,
                        clips,
                        output_filename,
                    ),
                    daemon=True
                ).start()

                self._send_json(
                    {
                        "status": "accepted",
                        "message": "Video generation started in background.",
                        "filename": output_filename,
                        "statusUrl": f"/api/video/status?file={encoded_name}",
                        "streamUrl": f"/api/video/stream?file={encoded_name}",
                        "downloadUrl": f"/api/video/stream?file={encoded_name}&download=1",
                    },
                    status=202
                )
            except Exception as e:
                print(f"[❌] Error handling /api/video/create request: {e}")
                self._send_json({"error": str(e)}, status=500)
            return

        if path_no_query == '/api/video/delete' or path_no_query.startswith('/api/video/delete/'):
            self._handle_video_delete(path_no_query, query_params)
            return

        if path_no_query == '/api/system/reboot':
            try:
                self._send_json({"message": "Rebooting host machine..."}, status=200)
                self.wfile.flush()

                def _trigger_reboot():
                    try:
                        subprocess.run(["sudo", "reboot"], check=True)
                    except Exception as err:
                        print(f"Failed to execute reboot: {err}")

                threading.Timer(0.5, _trigger_reboot).start()
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        self.send_error(404, "Endpoint not found")

    def do_DELETE(self):
        parsed_url = urlparse(self.path)
        path_no_query = parsed_url.path
        query_params = parse_qs(parsed_url.query)

        if not self._is_authenticated():
            self.do_AUTHHEAD()
            return

        if path_no_query == '/api/video/delete' or path_no_query.startswith('/api/video/delete/'):
            self._handle_video_delete(path_no_query, query_params)
            return

        self.send_error(404, "Endpoint not found")


if __name__ == "__main__":
    _cleanup_orphaned_video_temps()

    tls_context = None
    if SSL_CERT and SSL_KEY and os.path.exists(SSL_CERT) and os.path.exists(SSL_KEY):
        tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_context.load_cert_chain(certfile=SSL_CERT, keyfile=SSL_KEY)

    with PooledHTTPServer(("", PORT), SecureAuthHandler, ssl_context=tls_context) as httpd:
        def _handle_shutdown_signal(signum, frame):
            threading.Thread(target=httpd.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, _handle_shutdown_signal)
        signal.signal(signal.SIGINT, _handle_shutdown_signal)

        if tls_context is not None:
            print(f"🔒 Secure HTTPS ArgoNVR server running on port {PORT}")
        else:
            print(f"🔓 ArgoNVR server running on port {PORT} (No SSL configured)")

        print(f"📂 Storage mapped to: {STORE_DIR} (Videos: {VIDEO_DIR})")
        print(f"📷 Cameras discovered from config: {CAMERA_COUNT} (Sub-streams: {sum(SUB_STREAMS.values())})")

        if sdnotify is not None:
            try:
                notifier = sdnotify.SystemdNotifier()
                notifier.notify("READY=1")
                print("Systemd notified: READY=1")
            except Exception as e:
                print(f"Warning: Could not notify systemd ({e})")

        httpd.serve_forever()
