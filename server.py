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
import subprocess
import threading
import tempfile
import gzip
import hashlib
import time
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs, unquote, quote
try:
    import sdnotify
except ImportError:
    sdnotify = None

from socketserver import ThreadingMixIn

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

PORT = int(SETTINGS.get('PORT', 8000))
CAMERA_COUNT = len(CAMERAS)
SUB_STREAMS = {
    cam_id: bool(cam_cfg.get('sub_url'))
    for cam_id, cam_cfg in CAMERAS.items()
    if isinstance(cam_cfg, dict)
}

SSL_CERT = SETTINGS.get('SSL_CERT_PATH', '')
SSL_KEY = SETTINGS.get('SSL_KEY_PATH', '')
LOG_HTTP_REQUESTS = SETTINGS.get('LOG_HTTP_REQUESTS', False)

# In-memory cache for parsed camera history files keyed by path -> ((mtime_ns, size), parsed_data)
_HISTORY_FILE_CACHE = {}
_HISTORY_CACHE_LOCK = threading.Lock()

# In-memory cache for available dates with short TTL
_DATES_CACHE = {"timestamp": 0.0, "dates": [], "etag": ""}
_DATES_CACHE_LOCK = threading.Lock()

# Limit concurrent ffmpeg video generation jobs to protect CPU/disk I/O
_VIDEO_GEN_SEMA = threading.BoundedSemaphore(2)

# Regex matching generated video filenames:
# {cam_id}_{YYYYMMDD}_{startHHMMSS}-{endHHMMSS}_{createdYYYYMMDD}_{createdHHMMSS}.mp4
# or {cam_id}_{startYYYYMMDD}_{startHHMMSS}-{endYYYYMMDD}_{endHHMMSS}_{createdYYYYMMDD}_{createdHHMMSS}.mp4
_VIDEO_FILENAME_RE = re.compile(
    r'^(?P<cam_id>.+)_(?P<date>\d{8})_(?P<start>\d{6})-(?:(?P<end_date>\d{8})_)?(?P<end>\d{6})_(?P<cdate>\d{8})_(?P<ctime>\d{6})\.mp4$'
)

# Regex matching clip filenames containing _{YYYYMMDD}_{HHMMSS}
_CLIP_TIMESTAMP_RE = re.compile(
    r'_(?P<date>\d{8})_(?P<time>\d{6})(?:_\d+)?\.(?:m3u8|ts|mp4)$',
    re.IGNORECASE
)


def _load_cached_history_file(history_path):
    """Reads and caches a camera's daily history JSON file based on its mtime_ns and size."""
    try:
        st = os.stat(history_path)
    except OSError:
        return []

    key = (st.st_mtime_ns, st.st_size)
    with _HISTORY_CACHE_LOCK:
        cached = _HISTORY_FILE_CACHE.get(history_path)
        if cached and cached[0] == key:
            return cached[1]

    try:
        with open(history_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        with _HISTORY_CACHE_LOCK:
            if len(_HISTORY_FILE_CACHE) > 512:
                _HISTORY_FILE_CACHE.clear()
            _HISTORY_FILE_CACHE[history_path] = (key, data)
        return data
    except Exception as e:
        print(f"Error reading {history_path}: {e}")
        return []


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


def _resolve_video_file(raw_filename):
    """Validates and resolves a video filename strictly inside ABS_VIDEO_DIR."""
    if not raw_filename or not isinstance(raw_filename, str):
        return None, None

    clean_name = os.path.basename(unquote(raw_filename.strip()))
    if (
            not clean_name
            or clean_name.startswith('.')
            or not clean_name.lower().endswith('.mp4')
            or clean_name.lower().endswith('.part.mp4')
    ):
        return None, None

    candidate = os.path.abspath(os.path.join(ABS_VIDEO_DIR, clean_name))
    if candidate != os.path.join(ABS_VIDEO_DIR, clean_name) or not candidate.startswith(ABS_VIDEO_DIR + os.sep):
        return None, None

    return clean_name, candidate


def _build_video_entry(filename, st):
    """Builds a metadata dictionary for a video file in ABS_VIDEO_DIR."""
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

    return entry


def _list_video_files():
    """Returns metadata for all completed MP4 files in ABS_VIDEO_DIR sorted newest-first."""
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
                    videos.append(_build_video_entry(name, st))
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
    for prefix in ('recordings/', f'{STORE_DIR_NAME}/'):
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
        return clip_item, clip_item

    if isinstance(clip_item, dict):
        path_val = None
        for key in ('playlist', 'm3u8', 'mp4', 'video', 'file', 'url', 'path', 'src', 'filename', 'name'):
            val = clip_item.get(key)
            if isinstance(val, str) and val.strip():
                path_val = val.strip()
                break

        sort_key = (
                clip_item.get('timestamp')
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
    """Resolves the duration in seconds of a clip from its dict metadata, history JSON, or .m3u8 playlist."""
    if isinstance(clip_item, dict) and clip_item.get('duration') is not None:
        try:
            dur = float(clip_item['duration'])
            if dur > 0:
                return dur
        except (ValueError, TypeError):
            pass

    clean_name = os.path.basename(unquote((clip_ref or '').strip()).split('?', 1)[0].split('#', 1)[0])

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

    resolved = _safe_store_path(clip_ref, cam_id, date_str)
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


def _build_generated_video_filename(cam_id, start_date, end_date, start_tag, end_tag, created_stamp=None):
    """Formats the output MP4 filename using the clip date/time range."""
    if not created_stamp:
        created_stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    if end_date and end_date != start_date:
        return f"{cam_id}_{start_date}_{start_tag}-{end_date}_{end_tag}_{created_stamp}.mp4"
    return f"{cam_id}_{start_date}_{start_tag}-{end_tag}_{created_stamp}.mp4"


def _expand_m3u8_segments(m3u8_path, cam_id="", date_str=""):
    """Parses an HLS .m3u8 playlist and returns a list of existing segment file paths."""
    segments = []
    playlist_dir = os.path.dirname(m3u8_path)
    try:
        with open(m3u8_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
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
                    segments.append(seg_path)
                else:
                    print(f"[⚠️] Missing or empty HLS segment '{line}' referenced in {m3u8_path}")
    except Exception as e:
        print(f"[❌] Failed to parse playlist {m3u8_path}: {e}")

    return segments


def _resolve_clip_files(cam_id, date_str, clips):
    """Resolves a list of clip entries into an ordered, deduplicated list of media files for ffmpeg."""
    extracted = []
    for idx, item in enumerate(clips):
        ref, sort_key = _extract_clip_reference(item)
        if ref:
            extracted.append((sort_key, idx, ref))

    # Sort chronologically if sort keys are available so newest-first UI lists play forward in time
    if len(extracted) > 1 and all(item[0] for item in extracted):
        extracted.sort(key=lambda x: (x[0], x[1]))

    media_files = []
    seen = set()
    resolved_clips = 0

    for _, _, ref in extracted:
        resolved = _safe_store_path(ref, cam_id, date_str)
        if not resolved:
            print(f"[⚠️] Clip path could not be resolved for {cam_id} ({date_str}): {ref}")
            continue

        clip_segments = []
        if os.path.isdir(resolved):
            # Look for an .m3u8 playlist or direct .ts/.mp4 segments inside the directory
            dir_entries = sorted(os.listdir(resolved))
            m3u8_files = [e for e in dir_entries if e.endswith('.m3u8')]
            if m3u8_files:
                clip_segments = _expand_m3u8_segments(os.path.join(resolved, m3u8_files[0]), cam_id, date_str)
            else:
                clip_segments = [
                    os.path.join(resolved, e)
                    for e in dir_entries
                    if e.endswith(('.ts', '.mp4')) and os.path.getsize(os.path.join(resolved, e)) > 0
                ]
        elif resolved.endswith('.m3u8'):
            clip_segments = _expand_m3u8_segments(resolved, cam_id, date_str)
        elif resolved.endswith(('.ts', '.mp4')) and os.path.isfile(resolved) and os.path.getsize(resolved) > 0:
            clip_segments = [resolved]

        if clip_segments:
            resolved_clips += 1
            for seg in clip_segments:
                if seg not in seen:
                    seen.add(seg)
                    media_files.append(seg)
        else:
            print(f"[⚠️] No valid media segments found for clip: {resolved}")

    return media_files, resolved_clips


def generate_video_clip(
        cam_id,
        date_str,
        start_sec,
        end_sec,
        clips,
        output_filename=None,
        last_clip_duration=None
):
    """Background worker to generate and store an MP4 video clip from displayed history."""
    start_time_Wall = time.monotonic()
    (
        start_date,
        end_date,
        start_tag,
        end_tag,
        resolved_start_sec,
        resolved_end_sec,
    ) = _extract_clip_time_range(
        clips,
        cam_id=cam_id,
        fallback_date=date_str,
        fallback_start_sec=start_sec,
        fallback_end_sec=end_sec,
        last_clip_duration=last_clip_duration
    )

    start_fmt = _format_seconds_hhmmss(resolved_start_sec, ":")
    end_fmt = _format_seconds_hhmmss(resolved_end_sec, ":")

    if not output_filename:
        output_filename = _build_generated_video_filename(
            cam_id, start_date, end_date, start_tag, end_tag
        )

    date_window_label = f"{start_date}" if start_date == end_date else f"{start_date}..{end_date}"
    print(
        f"[🎬] Queued background video generation for {cam_id} -> {output_filename} "
        f"(date={date_window_label}, window={start_fmt}-{end_fmt}, clips={len(clips)})"
    )

    concat_list_path = None
    temp_output_path = None

    with _VIDEO_GEN_SEMA:
        try:
            os.makedirs(ABS_VIDEO_DIR, exist_ok=True)

            media_files, resolved_clips = _resolve_clip_files(cam_id, start_date, clips)
            print(
                f"[🔍] Resolved {resolved_clips}/{len(clips)} clips into "
                f"{len(media_files)} media segment(s) for {cam_id} ({date_window_label})"
            )

            if not media_files:
                print(
                    f"[❌] Aborting video generation for {cam_id} ({date_window_label}): "
                    f"no valid media segments found on disk."
                )
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
                "-c", "copy",
                "-avoid_negative_ts", "make_zero",
                "-movflags", "+faststart",
                temp_output_path,
            ]

            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=600
            )

            if proc.returncode != 0:
                err_msg = (proc.stderr or "").strip() or f"exit code {proc.returncode}"
                print(
                    f"[⚠️] Stream copy failed for {output_filename} ({err_msg}); "
                    f"retrying with AAC audio bitstream filter..."
                )
                cmd_retry = [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel", "error",
                    "-y",
                    "-fflags", "+genpts+igndts",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", concat_list_path,
                    "-c", "copy",
                    "-bsf:a", "aac_adtstoasc",
                    "-avoid_negative_ts", "make_zero",
                    "-movflags", "+faststart",
                    temp_output_path,
                ]
                proc = subprocess.run(
                    cmd_retry,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=600
                )

            if proc.returncode != 0:
                err_msg = (proc.stderr or "").strip() or f"exit code {proc.returncode}"
                print(f"[❌] ffmpeg failed to generate {output_filename} for {cam_id}: {err_msg}")
                return

            if not os.path.isfile(temp_output_path) or os.path.getsize(temp_output_path) == 0:
                print(f"[❌] ffmpeg produced an empty or missing file for {output_filename}")
                return

            os.replace(temp_output_path, final_output_path)
            temp_output_path = None

            size_mb = os.path.getsize(final_output_path) / (1024 * 1024)
            elapsed = time.monotonic() - start_time_Wall
            print(
                f"[✅] Video created for {cam_id}: {final_output_path} "
                f"({size_mb:.2f} MB in {elapsed:.1f}s)"
            )

        except subprocess.TimeoutExpired:
            print(f"[❌] Timed out generating video clip for {cam_id} ({date_window_label}) after 600s")
        except Exception as e:
            print(f"[❌] Error generating video clip for {cam_id} ({date_window_label}): {e}")
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


class ThreadedHTTPServer(ThreadingMixIn, socketserver.TCPServer):
    """Handle requests in a separate thread with bounded concurrency and per-thread TLS handshakes."""
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(self, server_address, RequestHandlerClass, ssl_context=None):
        super().__init__(server_address, RequestHandlerClass)
        self.ssl_context = ssl_context
        self._thread_sema = threading.BoundedSemaphore(64)

    def process_request_thread(self, request, client_address):
        """Performs the TLS handshake inside the worker thread with a strict timeout
        so a stalled client connection can never block the main accept() loop."""
        with self._thread_sema:
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


class SecureAuthHandler(http.server.SimpleHTTPRequestHandler):

    # Enable HTTP/1.1 persistent connections (Keep-Alive) to avoid repeated TCP/TLS handshakes on mobile
    protocol_version = "HTTP/1.1"

    # Kills zombie threads if the client hangs for 10 seconds
    timeout = 10

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

    def end_headers(self):
        """Intercept header generation to inject custom cache headers before flushing."""
        clean_path = getattr(self, 'path', '').split('?', 1)[0].split('#', 1)[0]

        if (
                clean_path.endswith('.html')
                or clean_path == '/'
                or clean_path.endswith(('/stream.m3u8', '/stream_sub.m3u8'))
                or clean_path.endswith('/live.jpg')
                or clean_path in (
                '/history',
                '/available_dates',
                '/cameracount',
                '/basedir',
                '/health',
                '/api/video/list',
                '/api/videos',
        )
        ):
            self.send_header('Cache-Control', 'no-cache, must-revalidate, max-age=0')
        elif (
                clean_path.startswith(f'/{BASE_DIR_NAME}/')
                and clean_path.endswith('.ts')
        ):
            # Live ring-buffer segments wrap around; cache briefly for active playback without long-term staleness
            self.send_header('Cache-Control', 'private, max-age=15')
        elif (
                clean_path.startswith('/recordings/')
                or (STORE_DIR_NAME != 'recordings' and clean_path.startswith(f'/{STORE_DIR_NAME}/'))
        ) and clean_path.endswith(('.ts', '.jpg', '.vtt', '.m3u8')):
            self.send_header('Cache-Control', 'public, max-age=86400, immutable')

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

    def do_AUTHHEAD(self, body=b"Authentication required."):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="ArgoNVR Secure Access"')
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
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

    def _send_json(self, payload, status=200, etag=None):
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
        self.wfile.write(body)

    def _serve_optimized_file(self, filepath, clean_path, extra_headers=None):
        """Serves static/media files with ETag/304 support, Gzip compression, and strict Content-Length safety."""
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
                    remaining = st.st_size
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
        except FileNotFoundError:
            self.send_error(404)
        except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError, OSError):
            pass

    def serve_range(self, filepath, range_header, extra_headers=None):
        try:
            with open(filepath, 'rb') as f:
                fs = os.fstat(f.fileno())
                file_len = fs.st_size
                etag = f'"{fs.st_mtime_ns:x}-{fs.st_size:x}"'

                if not range_header.startswith('bytes='):
                    self.send_error(416, "Requested Range Not Satisfiable")
                    return

                byte_range = range_header[6:].split(',', 1)[0].strip().split('-')
                if not byte_range[0]:
                    # Suffix byte range: bytes=-500
                    suffix_len = int(byte_range[1]) if (len(byte_range) > 1 and byte_range[1]) else 0
                    if suffix_len <= 0:
                        self.send_error(416, "Requested Range Not Satisfiable")
                        return
                    start = max(0, file_len - suffix_len)
                    end = file_len - 1
                else:
                    start = int(byte_range[0])
                    end = int(byte_range[1]) if (len(byte_range) > 1 and byte_range[1]) else file_len - 1
                    end = min(end, file_len - 1)

                if start >= file_len or start > end or start < 0:
                    self.send_error(416, "Requested Range Not Satisfiable")
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

                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError):
            pass
        except Exception as e:
            self.send_error(500, f"Server Error: {e}")

    def _handle_video_stream(self, path_no_query, query_params):
        """Streams or downloads a requested video file from ABS_VIDEO_DIR."""
        raw_file = (
                query_params.get('file', [None])[0]
                or query_params.get('filename', [None])[0]
                or query_params.get('name', [None])[0]
        )
        if not raw_file and path_no_query.startswith('/api/video/stream/'):
            raw_file = path_no_query[len('/api/video/stream/'):]

        clean_name, filepath = _resolve_video_file(raw_file)
        if not clean_name or not filepath:
            self._send_json({"error": "Invalid or missing video filename"}, status=400)
            return

        if not os.path.isfile(filepath):
            self._send_json({"error": "Video file not found"}, status=404)
            return

        is_download = query_params.get('download', ['0'])[0].lower() in ('1', 'true', 'yes')
        disposition = 'attachment' if is_download else 'inline'
        extra_headers = {
            'Content-Disposition': f'{disposition}; filename="{clean_name}"'
        }

        range_header = self.headers.get('Range')
        if range_header:
            self.serve_range(filepath, range_header, extra_headers=extra_headers)
        else:
            self._serve_optimized_file(filepath, clean_name, extra_headers=extra_headers)

    def _handle_video_delete(self, path_no_query, query_params):
        """Deletes a specified video file from ABS_VIDEO_DIR."""
        raw_file = (
                query_params.get('file', [None])[0]
                or query_params.get('filename', [None])[0]
                or query_params.get('name', [None])[0]
        )
        if not raw_file and path_no_query.startswith('/api/video/delete/'):
            raw_file = path_no_query[len('/api/video/delete/'):]

        if not raw_file:
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length > 0:
                try:
                    raw_body = self.rfile.read(content_length)
                    payload = json.loads(raw_body.decode('utf-8'))
                    if isinstance(payload, dict):
                        raw_file = (
                                payload.get('file')
                                or payload.get('filename')
                                or payload.get('name')
                        )
                except Exception:
                    pass

        clean_name, filepath = _resolve_video_file(raw_file)
        if not clean_name or not filepath:
            self._send_json({"error": "Invalid or missing video filename"}, status=400)
            return

        if not os.path.isfile(filepath):
            self._send_json({"error": "Video file not found"}, status=404)
            return

        try:
            os.remove(filepath)
            print(f"[🗑️] Deleted video file '{clean_name}' (requested by {self.address_string()})")
            self._send_json({"status": "deleted", "filename": clean_name}, status=200)
        except OSError as e:
            print(f"[❌] Failed to delete video file '{clean_name}': {e}")
            self._send_json({"error": f"Failed to delete video file: {e}"}, status=500)

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path_no_query = parsed_url.path
        query_params = parse_qs(parsed_url.query)

        if path_no_query == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b"OK")
            return

        # --- PWA Whitelist ---
        if path_no_query in ('/manifest.json', '/sw.js') or path_no_query.startswith('/icons/'):
            super().do_GET()
            return
        # ---------------------

        if not self._is_authenticated():
            self.do_AUTHHEAD()
            return

        if path_no_query in ('/api/video/list', '/api/videos'):
            videos = _list_video_files()
            self._send_json({"videos": videos})
            return

        if path_no_query == '/api/video/stream' or path_no_query.startswith('/api/video/stream/'):
            self._handle_video_stream(path_no_query, query_params)
            return

        if path_no_query == '/history':
            req_date = query_params.get('date', [None])[0]
            req_cam = query_params.get('cam', [None])[0]

            if not req_date:
                self.send_error(400, "Missing 'date' parameter")
                return

            safe_date = os.path.basename(req_date)
            response_data = {}

            if req_cam:
                safe_cam = os.path.basename(req_cam)
                history_path = os.path.join(ABS_STORE_DIR, safe_cam, f'history_{safe_date}.json')
                response_data[safe_cam] = _load_cached_history_file(history_path) if os.path.exists(history_path) else []
            else:
                try:
                    if os.path.exists(ABS_STORE_DIR):
                        for cam_dir in sorted(os.listdir(ABS_STORE_DIR)):
                            cam_path = os.path.join(ABS_STORE_DIR, cam_dir)
                            if os.path.isdir(cam_path):
                                history_path = os.path.join(cam_path, f'history_{safe_date}.json')
                                response_data[cam_dir] = (
                                    _load_cached_history_file(history_path)
                                    if os.path.exists(history_path)
                                    else []
                                )
                except Exception as e:
                    print(f"Error reading history directories: {e}")

            self._send_json(response_data)
            return

        if path_no_query == '/available_dates':
            now = time.time()
            with _DATES_CACHE_LOCK:
                if now - _DATES_CACHE["timestamp"] < 10.0 and _DATES_CACHE["dates"]:
                    cached_dates = _DATES_CACHE["dates"]
                    cached_etag = _DATES_CACHE["etag"]
                else:
                    cached_dates = None
                    cached_etag = None

            if cached_dates is None:
                dates = set()
                try:
                    if os.path.exists(ABS_STORE_DIR):
                        for cam_dir in os.listdir(ABS_STORE_DIR):
                            cam_path = os.path.join(ABS_STORE_DIR, cam_dir)
                            if os.path.isdir(cam_path):
                                for file in os.listdir(cam_path):
                                    if file.startswith('history_') and file.endswith('.json'):
                                        date_str = file[8:16]
                                        if date_str.isdigit():
                                            dates.add(date_str)
                except Exception as e:
                    print(f"Error reading available dates: {e}")

                cached_dates = sorted(dates)
                cached_etag = f'"{hashlib.md5(json.dumps(cached_dates).encode()).hexdigest()}"'
                with _DATES_CACHE_LOCK:
                    _DATES_CACHE["timestamp"] = now
                    _DATES_CACHE["dates"] = cached_dates
                    _DATES_CACHE["etag"] = cached_etag

            self._send_json(cached_dates, etag=cached_etag)
            return

        if path_no_query == '/cameracount':
            self._send_json({"count": CAMERA_COUNT, "subStreams": SUB_STREAMS})
            return

        if path_no_query == '/basedir':
            self._send_json({"baseDir": BASE_DIR, "subStreams": SUB_STREAMS})
            return

        filepath = self.translate_path(path_no_query)

        if path_no_query.endswith(('.m3u8', '.ts', '.mp4', '.json', '.jpg', '.vtt', '.js', '.css')):
            if not os.path.exists(filepath):
                self.send_error(404)
                return

        range_header = self.headers.get('Range')
        if path_no_query.endswith('.mp4') and range_header:
            self.serve_range(filepath, range_header)
            return

        if os.path.isfile(filepath):
            self._serve_optimized_file(filepath, path_no_query)
            return

        super().do_GET()

    def do_POST(self):
        parsed_url = urlparse(self.path)
        path_no_query = parsed_url.path
        query_params = parse_qs(parsed_url.query)

        if not self._is_authenticated():
            self.do_AUTHHEAD()
            return

        if path_no_query == '/api/video/create':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
                payload = json.loads(raw_body.decode('utf-8'))

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
                output_filename = _build_generated_video_filename(
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
                        clip_start_sec,
                        clip_end_sec,
                        clips,
                        output_filename,
                        last_clip_duration
                    ),
                    daemon=True
                ).start()

                self._send_json(
                    {
                        "status": "accepted",
                        "message": "Video generation started in background.",
                        "filename": output_filename,
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
    tls_context = None
    if SSL_CERT and SSL_KEY and os.path.exists(SSL_CERT) and os.path.exists(SSL_KEY):
        tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_context.load_cert_chain(certfile=SSL_CERT, keyfile=SSL_KEY)

    with ThreadedHTTPServer(("", PORT), SecureAuthHandler, ssl_context=tls_context) as httpd:
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