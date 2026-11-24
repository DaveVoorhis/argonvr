import asyncio
import os
import re
import time
import atexit
import sys
import json
import yaml
import shutil
import signal
import subprocess
import math
import datetime
import logging
import queue
import threading
from logging.handlers import TimedRotatingFileHandler
import gzip
try:
    import sdnotify
except ImportError:
    sdnotify = None

with open('argonvr.yaml', 'r', encoding='utf-8') as f:
    config = yaml.safe_load(f)

CAMERAS = config.get('CAMERAS', {})
SETTINGS = config.get('SETTINGS', {})

BASE_DIR = SETTINGS.get('BASE_DIR', './cameras')
SPRITE_WIDTH = int(SETTINGS.get('SPRITE_WIDTH', 320))
SPRITE_HEIGHT = int(SETTINGS.get('SPRITE_HEIGHT', 180))
SPRITE_QUALITY = int(SETTINGS.get('SPRITE_QUALITY', 3))
MAX_SPRITE_TILES = max(5, int(SETTINGS.get('MAX_SPRITE_TILES', 60)))
LIVE_SNAPSHOT_FPS = float(SETTINGS.get('LIVE_SNAPSHOT_FPS', 1.0))
LIVE_SNAPSHOT_QUALITY = int(SETTINGS.get('LIVE_SNAPSHOT_QUALITY', 6))
CONTINUOUS_LIVE_SNAPSHOTS = bool(SETTINGS.get('CONTINUOUS_LIVE_SNAPSHOTS', False))
ORPHAN_TS_GRACE_SECONDS = max(300, int(SETTINGS.get('ORPHAN_TS_GRACE_SECONDS', 600)))

# --- Configurable Storage Options ---
STORE_DIR = SETTINGS.get('STORE_DIR', './recordings')
VIDEO_DIR = SETTINGS.get('VIDEO_DIR', os.path.join(STORE_DIR, 'videos'))
STORAGE_DEVICE = SETTINGS.get('STORAGE_DEVICE', '/')
MIN_FREE_SPACE_PCT = float(SETTINGS.get('MIN_FREE_SPACE_PCT', 15.0))

# --- Recording and Process Configuration ---
COOLDOWN_PERIOD = int(SETTINGS.get('COOLDOWN_PERIOD', 10))
MAX_RECORD_TIME = int(SETTINGS.get('MAX_RECORD_TIME', 60))  # Maximum length of a single clip in seconds
STAGGER_SPIN_UP_SECONDS = int(SETTINGS.get('STAGGER_SPIN_UP_SECONDS', 0))
LOG_DAYS_TO_KEEP = int(SETTINGS.get('LOG_DAYS_TO_KEEP', 30))

# --- Subprocess & Stream Timeouts ---
ENCODER_TIMEOUT_SECONDS = int(SETTINGS.get('ENCODER_TIMEOUT_SECONDS', 300))
PROBE_TIMEOUT_SECONDS = int(SETTINGS.get('PROBE_TIMEOUT_SECONDS', 30))
SPRITE_TIMEOUT_SECONDS = int(SETTINGS.get('SPRITE_TIMEOUT_SECONDS', 120))
RTSP_IO_TIMEOUT_SECONDS = int(SETTINGS.get('RTSP_IO_TIMEOUT_SECONDS', 10))

# --- Default Motion Detection Configuration (Overridable per camera) ---
DEFAULT_MOTION_THRESHOLD = float(SETTINGS.get('MOTION_THRESHOLD', 0.01))
DEFAULT_MOTION_MAX_THRESHOLD = float(SETTINGS.get('MOTION_MAX_THRESHOLD', 0.50))
DEFAULT_PIXEL_DIFF_THRESHOLD = int(SETTINGS.get('PIXEL_DIFF_THRESHOLD', 24))
DEFAULT_MOTION_CONFIRM_FRAMES = int(SETTINGS.get('MOTION_CONFIRM_FRAMES', 2))
DEFAULT_MOTION_CONFIRM_WINDOW = float(SETTINGS.get('MOTION_CONFIRM_WINDOW', 2.0))

# Bitstream filter expression that forces valid, identical, strictly monotonic PTS and DTS
# on every packet entering the MPEG-TS muxer, preventing N/A PTS or 1 Hz GOP timestamp jumps.
SETTS_MONOTONIC_BSF = (
    "setts="
    "dts='max(if(eq(PTS,NOPTS),DTS,PTS),if(eq(PREV_OUTDTS,NOPTS),0,PREV_OUTDTS+1))':"
    "pts='max(if(eq(PTS,NOPTS),DTS,PTS),if(eq(PREV_OUTPTS,NOPTS),0,PREV_OUTPTS+1))'"
)

CLIP_TIMESTAMP_RE = re.compile(r'^(?P<cam>.+)_(?P<date>\d{8})_(?P<time>\d{6})$')
DATE_DIR_RE = re.compile(r'^\d{8}$')
MOTION_SCORE_RE = re.compile(r'lavfi\.scene_score=([0-9.]+)')

VIDEO_DIR_NAME = os.path.basename(os.path.normpath(VIDEO_DIR))
NON_CAMERA_STORE_DIRS = {VIDEO_DIR_NAME, 'videos'}

os.makedirs(BASE_DIR, exist_ok=True)
os.makedirs(STORE_DIR, exist_ok=True)

# Global registry to track active processes without leaking finished ones
active_processes = set()


def _detect_rtsp_timeout_args(timeout_seconds):
    """Detects the supported FFmpeg RTSP socket I/O timeout option (-timeout on FFmpeg 5+, -stimeout on 4)."""
    if timeout_seconds <= 0:
        return []
    timeout_us = str(int(timeout_seconds * 1_000_000))
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-h", "demuxer=rtsp"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5
        )
        help_text = (proc.stdout or "") + "\n" + (proc.stderr or "")
        if re.search(r'(?m)^\s*-timeout\b', help_text):
            return ["-timeout", timeout_us]
        if re.search(r'(?m)^\s*-stimeout\b', help_text):
            return ["-stimeout", timeout_us]
    except Exception:
        pass
    return []


RTSP_TIMEOUT_ARGS = _detect_rtsp_timeout_args(RTSP_IO_TIMEOUT_SECONDS)


class _AsyncLogDispatcher:
    """Offloads file writes and midnight gzip log rotation off the asyncio event loop."""

    def __init__(self, maxsize=10000):
        self._queue = queue.Queue(maxsize=maxsize)
        self._stop_sentinel = object()
        self._thread = threading.Thread(target=self._run, name="argonvr-log-writer", daemon=True)
        self._started = False
        self._lock = threading.Lock()

    def ensure_started(self):
        if not self._started:
            with self._lock:
                if not self._started:
                    self._started = True
                    self._thread.start()

    def enqueue(self, handler, record):
        self.ensure_started()
        try:
            self._queue.put_nowait((handler, record))
        except queue.Full:
            # Drop excess log lines rather than blocking the event loop
            pass

    def _run(self):
        while True:
            item = self._queue.get()
            if item is self._stop_sentinel:
                self._queue.task_done()
                break
            handler, record = item
            try:
                handler.handle(record)
            except Exception:
                pass
            finally:
                self._queue.task_done()

    def shutdown(self, timeout=2.0):
        if not self._started:
            return
        try:
            self._queue.put(self._stop_sentinel, timeout=0.5)
        except queue.Full:
            pass
        self._thread.join(timeout=timeout)


_LOG_DISPATCHER = _AsyncLogDispatcher()


class _QueuedProxyHandler(logging.Handler):
    """Lightweight handler that forwards records to a file handler on the background log thread."""

    def __init__(self, target_handler):
        super().__init__()
        self._target_handler = target_handler

    def emit(self, record):
        _LOG_DISPATCHER.enqueue(self._target_handler, record)


def cleanup_processes():
    """Safety net: Kills all tracked FFmpeg processes on exit and flushes logs."""
    print("\n🛑 Cleaning up child processes...")
    for proc in list(active_processes):
        try:
            if proc.returncode is None:
                proc.terminate()
        except Exception:
            pass
    _LOG_DISPATCHER.shutdown(timeout=1.5)


atexit.register(cleanup_processes)


async def safe_kill_process(proc):
    """Kills an asyncio subprocess and awaits its exit to prevent zombie processes."""
    if not proc:
        return
    try:
        if proc.returncode is None:
            proc.kill()
    except ProcessLookupError:
        pass
    except Exception:
        pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except Exception:
        pass
    active_processes.discard(proc)


async def read_lines_cr_lf(stream, chunk_size=4096, max_buffer_bytes=65536):
    """Reads from an asyncio StreamReader, yielding lines split on either CR or LF.
    Prevents FFmpeg's CR-delimited progress lines from blocking readline() or overflowing memory."""
    if not stream:
        return
    buffer = bytearray()
    while True:
        chunk = await stream.read(chunk_size)
        if not chunk:
            if buffer:
                decoded = buffer.decode('utf-8', errors='ignore').strip()
                if decoded:
                    yield decoded
            break
        buffer.extend(chunk)
        while True:
            idx_r = buffer.find(b'\r')
            idx_n = buffer.find(b'\n')
            if idx_r == -1 and idx_n == -1:
                if len(buffer) > max_buffer_bytes:
                    decoded = buffer.decode('utf-8', errors='ignore').strip()
                    buffer.clear()
                    if decoded:
                        yield decoded
                break
            if idx_r == -1:
                sep_idx = idx_n
            elif idx_n == -1:
                sep_idx = idx_r
            else:
                sep_idx = min(idx_r, idx_n)

            line = bytes(buffer[:sep_idx])
            if sep_idx == idx_r and len(buffer) > sep_idx + 1 and buffer[sep_idx + 1] == 10:
                del buffer[:sep_idx + 2]
            else:
                del buffer[:sep_idx + 1]

            decoded = line.decode('utf-8', errors='ignore').strip()
            if decoded:
                yield decoded


def get_rotating_logger(name, log_file):
    """Creates or retrieves a non-blocking rotating logger with daily rotation, gzip compression, and retention."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.setLevel(logging.INFO)
        logger.propagate = False

        file_handler = TimedRotatingFileHandler(
            log_file,
            when="midnight",
            interval=1,
            backupCount=LOG_DAYS_TO_KEEP,
            encoding='utf-8'
        )

        def rotator(source, dest):
            try:
                with open(source, 'rb') as f_in:
                    with gzip.open(dest + '.gz', 'wb') as f_out:
                        shutil.copyfileobj(f_in, f_out)
                os.remove(source)
            except Exception as e:
                print(f"[⚠️] Log compression failed for {source}: {e}")

        def namer(default_name):
            return default_name

        file_handler.rotator = rotator
        file_handler.namer = namer

        formatter = logging.Formatter('%(message)s')
        file_handler.setFormatter(formatter)
        logger.addHandler(_QueuedProxyHandler(file_handler))

    return logger


def get_video_duration(filepath):
    """Extracts duration rapidly from HLS .m3u8 #EXTINF tags in Python, falling back to ffprobe."""
    if filepath.endswith('.m3u8') and os.path.exists(filepath):
        try:
            total_dur = 0.0
            with open(filepath, 'r', encoding='utf-8') as f:
                for line in f:
                    if line.startswith('#EXTINF:'):
                        val = line.split(':', 1)[1].split(',', 1)[0].strip()
                        total_dur += float(val)
            if total_dur > 0:
                return round(total_dur, 2)
        except Exception:
            pass

    try:
        cmd = [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", filepath
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        return round(float(proc.stdout.strip()), 2)
    except Exception:
        return 0.0


def parse_clip_metadata(filename_or_base, duration=0.0, cam_id_fallback=None):
    """Parses clip start date/time and calculates end date/time from a clip filename or base_name."""
    base_name = os.path.splitext(os.path.basename(filename_or_base))[0]
    dur = round(max(0.0, float(duration or 0.0)), 2)

    match = CLIP_TIMESTAMP_RE.match(base_name)
    if match:
        cam_id = cam_id_fallback or match.group('cam')
        date_str = match.group('date')
        time_str = match.group('time')
    else:
        parts = base_name.split('_')
        cam_id = cam_id_fallback or (parts[0] if parts else 'cam1')
        date_str = parts[1] if len(parts) >= 2 and len(parts[1]) == 8 else time.strftime('%Y%m%d')
        time_str = parts[2] if len(parts) >= 3 and len(parts[2]) >= 6 else '000000'
        time_str = time_str[:6]

    start_time_str = f"{time_str[0:2]}:{time_str[2:4]}:{time_str[4:6]}"
    try:
        start_dt = datetime.datetime.strptime(f"{date_str}_{time_str}", "%Y%m%d_%H%M%S")
        end_dt = start_dt + datetime.timedelta(seconds=dur)
        end_date_str = end_dt.strftime("%Y%m%d")
        end_time_str = end_dt.strftime("%H:%M:%S")
        start_epoch = round(start_dt.timestamp(), 2)
    except ValueError:
        end_date_str = date_str
        end_time_str = start_time_str
        start_epoch = 0.0

    return {
        "camId": cam_id,
        "date": date_str,
        "startTime": start_time_str,
        "endDate": end_date_str,
        "endTime": end_time_str,
        "startEpoch": start_epoch,
        "duration": dur
    }


def extract_clip_date(filename_or_base):
    """Extracts YYYYMMDD from a clip filename/base_name, or returns None."""
    base_name = os.path.splitext(os.path.basename(filename_or_base))[0]
    match = CLIP_TIMESTAMP_RE.match(base_name)
    if match:
        return match.group('date')
    parts = base_name.split('_')
    if len(parts) >= 2 and DATE_DIR_RE.match(parts[1]):
        return parts[1]
    return None


def write_clip_sidecar_json(output_dir, base_name, cam_id=None, duration=None):
    """Writes an atomic sidecar .json file for a single packaged HLS clip."""
    m3u8_filename = f"{base_name}.m3u8"
    m3u8_filepath = os.path.join(output_dir, m3u8_filename)
    sidecar_filepath = os.path.join(output_dir, f"{base_name}.json")
    sidecar_tmp = sidecar_filepath + ".tmp"

    if duration is None:
        duration = get_video_duration(m3u8_filepath)

    meta = parse_clip_metadata(base_name, duration=duration, cam_id_fallback=cam_id)
    payload = {
        "filename": m3u8_filename,
        "camId": meta["camId"],
        "date": meta["date"],
        "startTime": meta["startTime"],
        "endDate": meta["endDate"],
        "endTime": meta["endTime"],
        "startEpoch": meta["startEpoch"],
        "duration": meta["duration"],
        "segments": [
            {
                "offset": 0.0,
                "duration": meta["duration"],
                "date": meta["date"],
                "startTime": meta["startTime"],
                "endDate": meta["endDate"],
                "endTime": meta["endTime"],
                "filename": m3u8_filename
            }
        ]
    }

    try:
        with open(sidecar_tmp, 'w', encoding='utf-8') as sf:
            json.dump(payload, sf, indent=2)
        os.replace(sidecar_tmp, sidecar_filepath)
    except OSError as e:
        print(f"[⚠️] Failed to write clip sidecar {sidecar_filepath}: {e}")

    return payload


def write_stitched_mp4_sidecar(mp4_filepath, source_clips, cam_id=None):
    """Builds and atomically writes a multi-segment sidecar .json file for a stitched MP4 video.
    `source_clips` can be a list of filepaths, filenames, or manifest/sidecar dicts."""
    base_path = os.path.splitext(mp4_filepath)[0]
    sidecar_filepath = f"{base_path}.json"
    sidecar_tmp = sidecar_filepath + ".tmp"

    segments = []
    running_offset = 0.0

    for item in source_clips:
        if isinstance(item, dict):
            clip_name = item.get('filename') or item.get('file') or ''
            dur = float(item.get('duration') or 0.0)
            if dur <= 0 and item.get('filepath') and os.path.exists(item['filepath']):
                dur = get_video_duration(item['filepath'])
            meta = parse_clip_metadata(
                clip_name,
                duration=dur,
                cam_id_fallback=item.get('camId') or cam_id
            )
            seg_date = item.get('date') or meta['date']
            seg_start = item.get('startTime') or meta['startTime']
            seg_end_date = item.get('endDate') or meta['endDate']
            seg_end = item.get('endTime') or meta['endTime']
            seg_cam = item.get('camId') or meta['camId']
        else:
            clip_path = str(item)
            clip_name = os.path.basename(clip_path)
            clip_sidecar = os.path.splitext(clip_path)[0] + ".json"
            loaded_sidecar = None
            if os.path.exists(clip_sidecar):
                try:
                    with open(clip_sidecar, 'r', encoding='utf-8') as cf:
                        loaded_sidecar = json.load(cf)
                except Exception:
                    loaded_sidecar = None

            if loaded_sidecar and loaded_sidecar.get('duration', 0) > 0:
                dur = float(loaded_sidecar['duration'])
                seg_date = loaded_sidecar.get('date')
                seg_start = loaded_sidecar.get('startTime')
                seg_end_date = loaded_sidecar.get('endDate')
                seg_end = loaded_sidecar.get('endTime')
                seg_cam = loaded_sidecar.get('camId') or cam_id
            else:
                dur = get_video_duration(clip_path) if os.path.exists(clip_path) else 0.0
                meta = parse_clip_metadata(clip_name, duration=dur, cam_id_fallback=cam_id)
                seg_date = meta['date']
                seg_start = meta['startTime']
                seg_end_date = meta['endDate']
                seg_end = meta['endTime']
                seg_cam = meta['camId']

        if not cam_id and seg_cam:
            cam_id = seg_cam

        dur = round(max(0.0, dur), 2)
        if dur <= 0:
            continue

        segments.append({
            "offset": round(running_offset, 2),
            "duration": dur,
            "date": seg_date,
            "startTime": seg_start,
            "endDate": seg_end_date,
            "endTime": seg_end,
            "filename": clip_name
        })
        running_offset += dur

    first_seg = segments[0] if segments else {}
    last_seg = segments[-1] if segments else {}

    payload = {
        "filename": os.path.basename(mp4_filepath),
        "camId": cam_id or "cam1",
        "date": first_seg.get("date"),
        "startTime": first_seg.get("startTime"),
        "endDate": last_seg.get("endDate") or last_seg.get("date"),
        "endTime": last_seg.get("endTime"),
        "duration": round(running_offset, 2),
        "segments": segments
    }

    try:
        with open(sidecar_tmp, 'w', encoding='utf-8') as sf:
            json.dump(payload, sf, indent=2)
        os.replace(sidecar_tmp, sidecar_filepath)
    except OSError as e:
        print(f"[⚠️] Failed to write stitched MP4 sidecar {sidecar_filepath}: {e}")

    return payload


def format_vtt_time(seconds):
    """Formats raw seconds into WebVTT timestamp format without 60.000 rounding overflow."""
    total_ms = int(round(max(0.0, float(seconds)) * 1000))
    total_secs, milliseconds = divmod(total_ms, 1000)
    hours, rem = divmod(total_secs, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"


def _write_vtt_file_sync(vtt_tmp_filepath, vtt_filepath, base_name, selected_i_frames, cols, width, height):
    """Atomically writes a WebVTT sprite map on a worker thread."""
    num_frames = len(selected_i_frames)
    with open(vtt_tmp_filepath, 'w', encoding='utf-8') as vtt_file:
        vtt_file.write("WEBVTT\n\n")
        for i in range(num_frames):
            col = i % cols
            row = i // cols
            x = col * width
            y = row * height

            start_time = selected_i_frames[i]
            end_time = selected_i_frames[i + 1] if i + 1 < num_frames else start_time + 5.0

            vtt_file.write(f"{format_vtt_time(start_time)} --> {format_vtt_time(end_time)}\n")
            vtt_file.write(f"{base_name}.jpg#xywh={x},{y},{width},{height}\n\n")

    os.replace(vtt_tmp_filepath, vtt_filepath)


async def generate_sprite_and_vtt(mp4_filepath, output_dir, base_name):
    """Extracts I-frames into a bounded JPEG sprite sheet and generates a WebVTT map."""
    jpg_filepath = os.path.join(output_dir, f"{base_name}.jpg")
    vtt_filepath = os.path.join(output_dir, f"{base_name}.vtt")
    vtt_tmp_filepath = vtt_filepath + ".tmp"

    proc_probe = None
    proc_ff = None

    try:
        # 1. FAST PROBE: Read 'packets' instead of 'frames' (bypasses the decoder entirely)
        cmd_probe = [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "packet=pts_time,dts_time,flags",
            "-of", "json", mp4_filepath
        ]
        proc_probe = await asyncio.create_subprocess_exec(
            *cmd_probe,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        active_processes.add(proc_probe)
        try:
            stdout, _ = await asyncio.wait_for(proc_probe.communicate(), timeout=PROBE_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            print(f"[⚠️] ffprobe timed out after {PROBE_TIMEOUT_SECONDS}s for {base_name}; killing.")
            await safe_kill_process(proc_probe)
            return
        finally:
            active_processes.discard(proc_probe)

        probe_data = json.loads(stdout.decode('utf-8', errors='ignore') or "{}")
        packets = probe_data.get('packets', [])

        # 2. Extract keyframe timestamps using the 'K' flag
        valid_i_frames = []
        for p in packets:
            if 'K' in p.get('flags', ''):
                pts = p.get('pts_time', 'N/A')
                if pts == 'N/A':
                    pts = p.get('dts_time', 'N/A')

                if pts != 'N/A':
                    try:
                        valid_i_frames.append(float(pts))
                    except ValueError:
                        pass

        if not valid_i_frames:
            print(f"[⚠️] Skipped sprite generation for {base_name}: No valid float timestamps found.")
            return

        # Bound total sprite tiles to stay well within mobile GPU texture limits (e.g., 4096px)
        stride = max(1, math.ceil(len(valid_i_frames) / MAX_SPRITE_TILES))
        selected_i_frames = valid_i_frames[::stride]

        num_frames = len(selected_i_frames)
        cols = 5
        rows = math.ceil(num_frames / cols)
        width = SPRITE_WIDTH
        height = SPRITE_HEIGHT

        if stride > 1:
            vf_expr = f"select='eq(pict_type,I)',select='not(mod(n,{stride}))',scale={width}:{height},tile={cols}x{rows}"
        else:
            vf_expr = f"select='eq(pict_type,I)',scale={width}:{height},tile={cols}x{rows}"

        # 3. FAST SPRITE GEN: Use '-skip_frame nokey' to avoid decoding P/B frames
        cmd_ffmpeg = [
            "ffmpeg",
            "-skip_frame", "nokey",
            "-i", mp4_filepath,
            "-vf", vf_expr,
            "-frames:v", "1",
            "-q:v", str(SPRITE_QUALITY),
            "-y", jpg_filepath
        ]
        proc_ff = await asyncio.create_subprocess_exec(
            *cmd_ffmpeg,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL
        )
        active_processes.add(proc_ff)
        try:
            await asyncio.wait_for(proc_ff.wait(), timeout=SPRITE_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            print(f"[⚠️] Sprite ffmpeg timed out after {SPRITE_TIMEOUT_SECONDS}s for {base_name}; killing.")
            await safe_kill_process(proc_ff)
            return
        finally:
            active_processes.discard(proc_ff)

        if proc_ff.returncode != 0 or not os.path.exists(jpg_filepath):
            print(f"[⚠️] Skipped VTT generation for {base_name}: Sprite image was not created.")
            if os.path.exists(jpg_filepath):
                try:
                    os.remove(jpg_filepath)
                except OSError:
                    pass
            return

        # 4. Generate WebVTT atomically off the event loop
        await asyncio.to_thread(
            _write_vtt_file_sync,
            vtt_tmp_filepath,
            vtt_filepath,
            base_name,
            selected_i_frames,
            cols,
            width,
            height
        )
        print(f"[🎞️] Generated Sprite ({num_frames} tiles) & VTT for {base_name}")

    except asyncio.CancelledError:
        if proc_probe and proc_probe.returncode is None:
            await safe_kill_process(proc_probe)
        if proc_ff and proc_ff.returncode is None:
            await safe_kill_process(proc_ff)
        raise
    except Exception as e:
        print(f"[⚠️] Failed to process sprite/vtt for {base_name}: {e}")
        for path in (jpg_filepath, vtt_filepath, vtt_tmp_filepath):
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass


def _collect_daily_clips_for_camera(cam_path, target_dates_set=None):
    """Collects clip descriptors for a camera across both daily subdirectories (<YYYYMMDD>/)
    and legacy flat files in cam_path.

    Returns (daily_clips, top_level_entries) where:
      daily_clips[date_str] = list of (filename, clip_dir, rel_url_prefix, dir_entries_set)
    """
    daily_clips = {}
    try:
        top_entries = os.listdir(cam_path)
    except OSError:
        return daily_clips, []

    top_entries_set = set(top_entries)

    # 1. Scan daily subdirectories (<YYYYMMDD>/)
    if target_dates_set is not None:
        candidate_date_dirs = [d for d in target_dates_set if d in top_entries_set]
    else:
        candidate_date_dirs = [d for d in top_entries if DATE_DIR_RE.match(d)]

    for date_dir in candidate_date_dirs:
        day_path = os.path.join(cam_path, date_dir)
        if not os.path.isdir(day_path):
            continue
        try:
            day_entries = os.listdir(day_path)
        except OSError:
            continue
        day_entries_set = set(day_entries)
        for f in day_entries:
            if f.endswith('.m3u8') and f not in ('stream.m3u8', 'stream_sub.m3u8'):
                date_str = extract_clip_date(f) or date_dir
                if target_dates_set is not None and date_str not in target_dates_set:
                    continue
                daily_clips.setdefault(date_str, []).append(
                    (f, day_path, f"{date_dir}/", day_entries_set)
                )

    # 2. Scan legacy flat files directly in cam_path (backward compatibility with pre-partitioned clips)
    for f in top_entries:
        if f.endswith('.m3u8') and f not in ('stream.m3u8', 'stream_sub.m3u8'):
            date_str = extract_clip_date(f)
            if not date_str:
                continue
            if target_dates_set is not None and date_str not in target_dates_set:
                continue
            daily_clips.setdefault(date_str, []).append(
                (f, cam_path, "", top_entries_set)
            )

    return daily_clips, top_entries


def update_history_manifest(target_cam_id=None, target_dates=None):
    """Scans the recordings directory and generates daily JSON manifests per camera.
    Supports both daily subdirectories (recordings/<cam>/<YYYYMMDD>/) and legacy flat files."""
    if not os.path.exists(STORE_DIR):
        return

    if target_cam_id:
        cam_dirs = [target_cam_id]
    else:
        try:
            cam_dirs = [
                d for d in os.listdir(STORE_DIR)
                if d not in NON_CAMERA_STORE_DIRS and os.path.isdir(os.path.join(STORE_DIR, d))
            ]
        except OSError:
            return

    store_basename = os.path.basename(os.path.normpath(STORE_DIR))
    target_dates_set = set(target_dates) if target_dates else None

    for cam_id in cam_dirs:
        if cam_id in NON_CAMERA_STORE_DIRS:
            continue
        cam_path = os.path.join(STORE_DIR, cam_id)
        if not os.path.isdir(cam_path):
            continue

        daily_clips, top_entries = _collect_daily_clips_for_camera(cam_path, target_dates_set)
        dates_to_process = target_dates_set if target_dates_set is not None else daily_clips.keys()
        active_manifests = set()

        for date_str in dates_to_process:
            clips_for_day = daily_clips.get(date_str, [])
            manifest_name = f"history_{date_str}.json"
            active_manifests.add(manifest_name)
            manifest_path = os.path.join(cam_path, manifest_name)

            if not clips_for_day:
                if os.path.exists(manifest_path):
                    try:
                        os.remove(manifest_path)
                    except OSError:
                        pass
                continue

            existing_data = {}
            old_manifest = None
            if os.path.exists(manifest_path):
                try:
                    with open(manifest_path, 'r', encoding='utf-8') as mf:
                        old_manifest = json.load(mf)
                        for item in old_manifest:
                            existing_data[item['filename']] = item
                except Exception:
                    pass

            manifest_data = []
            seen_filenames = set()
            for f, clip_dir, rel_prefix, entries_set in clips_for_day:
                if f in seen_filenames:
                    continue
                seen_filenames.add(f)

                base_name = os.path.splitext(f)[0]
                jpg_filename = f"{base_name}.jpg"
                vtt_filename = f"{base_name}.vtt"
                sidecar_filename = f"{base_name}.json"

                has_sprite = jpg_filename in entries_set
                has_vtt = vtt_filename in entries_set
                has_sidecar = sidecar_filename in entries_set

                expected_url = f"./{store_basename}/{cam_id}/{rel_prefix}{f}"
                expected_sprite_url = f"./{store_basename}/{cam_id}/{rel_prefix}{jpg_filename}" if has_sprite else None
                expected_vtt_url = f"./{store_basename}/{cam_id}/{rel_prefix}{vtt_filename}" if has_vtt else None

                cached = existing_data.get(f)
                if (
                        cached
                        and cached.get('url') == expected_url
                        and cached.get('duration', 0) > 0
                        and cached.get('startTime')
                        and cached.get('endTime')
                        and cached.get('sprite_url') == expected_sprite_url
                        and cached.get('vtt_url') == expected_vtt_url
                ):
                    if not has_sidecar:
                        write_clip_sidecar_json(clip_dir, base_name, cam_id=cam_id, duration=cached['duration'])
                    manifest_data.append(cached)
                else:
                    filepath = os.path.join(clip_dir, f)
                    dur = get_video_duration(filepath)
                    meta = parse_clip_metadata(base_name, duration=dur, cam_id_fallback=cam_id)
                    if not has_sidecar:
                        write_clip_sidecar_json(clip_dir, base_name, cam_id=cam_id, duration=dur)
                    manifest_data.append({
                        "filename": f,
                        "url": expected_url,
                        "duration": dur,
                        "date": meta["date"],
                        "startTime": meta["startTime"],
                        "endDate": meta["endDate"],
                        "endTime": meta["endTime"],
                        "startEpoch": meta["startEpoch"],
                        "sprite_url": expected_sprite_url,
                        "vtt_url": expected_vtt_url
                    })

            manifest_data.sort(key=lambda x: x['filename'], reverse=True)

            if manifest_data != old_manifest:
                tmp_manifest_path = manifest_path + ".tmp"
                try:
                    with open(tmp_manifest_path, 'w', encoding='utf-8') as mf:
                        json.dump(manifest_data, mf)
                    os.replace(tmp_manifest_path, manifest_path)
                except OSError as e:
                    print(f"[⚠️] Failed to write manifest {manifest_path}: {e}")

        if target_dates_set is None:
            for f in top_entries:
                if f.startswith('history_') and f.endswith('.json') and f not in active_manifests:
                    try:
                        os.remove(os.path.join(cam_path, f))
                    except OSError:
                        pass


def get_free_space_pct(path):
    try:
        total, used, free = shutil.disk_usage(path)
        return (free / total) * 100
    except Exception:
        return 100.0


def _delete_packaged_clip_files(m3u8_path):
    """Deletes a packaged HLS clip's .ts segments (parsed from its .m3u8) and companion files without glob()."""
    clip_dir = os.path.dirname(m3u8_path)
    base_name = os.path.splitext(os.path.basename(m3u8_path))[0]
    deleted = 0

    # Parse referenced segments directly from the .m3u8 playlist
    segment_names = set()
    try:
        with open(m3u8_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    seg_name = os.path.basename(line.split('?', 1)[0].split('#', 1)[0])
                    if seg_name:
                        segment_names.add(seg_name)
    except OSError:
        pass

    for seg_name in segment_names:
        seg_path = os.path.join(clip_dir, seg_name)
        try:
            os.remove(seg_path)
            deleted += 1
        except OSError:
            pass

    for suffix in ('.m3u8', '.jpg', '.vtt', '.vtt.tmp', '.json', '.json.tmp'):
        path = os.path.join(clip_dir, base_name + suffix)
        try:
            os.remove(path)
            deleted += 1
        except OSError:
            pass

    # Remove now-empty daily subdirectory (<YYYYMMDD>)
    dir_basename = os.path.basename(clip_dir)
    if DATE_DIR_RE.match(dir_basename):
        try:
            os.rmdir(clip_dir)
        except OSError:
            pass

    return deleted


def _purge_failed_queue_files_sync(max_age_seconds=0):
    """Removes .failed capture files in camera queued/ directories."""
    deleted = 0
    if not os.path.exists(STORE_DIR):
        return deleted

    now = time.time()
    try:
        cam_entries = os.listdir(STORE_DIR)
    except OSError:
        return deleted

    for cam_id in cam_entries:
        if cam_id in NON_CAMERA_STORE_DIRS:
            continue
        queued_dir = os.path.join(STORE_DIR, cam_id, 'queued')
        if not os.path.isdir(queued_dir):
            continue
        try:
            for entry in os.scandir(queued_dir):
                if entry.is_file() and entry.name.endswith('.failed'):
                    try:
                        if max_age_seconds <= 0 or (now - entry.stat().st_mtime) >= max_age_seconds:
                            os.remove(entry.path)
                            deleted += 1
                    except OSError:
                        pass
        except OSError:
            pass
    return deleted


def _purge_orphaned_ts_in_dir_sync(target_dir, grace_seconds=ORPHAN_TS_GRACE_SECONDS):
    """Removes unreferenced .ts segments in target_dir older than grace_seconds."""
    now = time.time()
    m3u8_paths = []
    old_ts_entries = []

    try:
        for entry in os.scandir(target_dir):
            if not entry.is_file():
                continue
            name = entry.name
            if name.endswith('.m3u8') and name not in ('stream.m3u8', 'stream_sub.m3u8'):
                m3u8_paths.append(entry.path)
            elif name.endswith('.ts'):
                try:
                    mtime = entry.stat().st_mtime
                    if (now - mtime) >= grace_seconds:
                        old_ts_entries.append((entry.path, name))
                except OSError:
                    pass
    except OSError:
        return 0

    if not old_ts_entries:
        return 0

    referenced_ts = set()
    for m3u8_path in m3u8_paths:
        try:
            with open(m3u8_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#'):
                        seg_name = os.path.basename(line.split('?', 1)[0].split('#', 1)[0])
                        if seg_name:
                            referenced_ts.add(seg_name)
        except OSError:
            # Bail out for this directory if any playlist cannot be read,
            # avoiding accidental deletion of referenced segments.
            return 0

    deleted = 0
    for ts_path, ts_name in old_ts_entries:
        if ts_name not in referenced_ts:
            try:
                os.remove(ts_path)
                deleted += 1
            except OSError:
                pass

    if deleted > 0 and DATE_DIR_RE.match(os.path.basename(target_dir)):
        try:
            os.rmdir(target_dir)
        except OSError:
            pass

    return deleted


def _purge_orphaned_ts_sync(grace_seconds=ORPHAN_TS_GRACE_SECONDS):
    """Sweeps orphaned .ts segments across all camera recording directories and daily subdirs."""
    deleted = 0
    if not os.path.isdir(STORE_DIR):
        return deleted

    try:
        cam_dirs = [
            d for d in os.listdir(STORE_DIR)
            if d not in NON_CAMERA_STORE_DIRS and os.path.isdir(os.path.join(STORE_DIR, d))
        ]
    except OSError:
        return deleted

    for cam_id in cam_dirs:
        cam_path = os.path.join(STORE_DIR, cam_id)
        deleted += _purge_orphaned_ts_in_dir_sync(cam_path, grace_seconds=grace_seconds)
        try:
            for entry in os.scandir(cam_path):
                if entry.is_dir() and DATE_DIR_RE.match(entry.name):
                    deleted += _purge_orphaned_ts_in_dir_sync(entry.path, grace_seconds=grace_seconds)
        except OSError:
            pass

    return deleted


def _purge_oldest_files_sync():
    """Synchronous helper to purge oldest recordings without blocking the asyncio loop or using glob()."""
    # First reclaim space from failed packaging artifacts
    failed_deleted = _purge_failed_queue_files_sync(max_age_seconds=0)
    if failed_deleted > 0:
        print(f"[🧹] Reclaimed {failed_deleted} failed queue file(s).")
        if get_free_space_pct(STORAGE_DEVICE) >= MIN_FREE_SPACE_PCT:
            return

    # Next reclaim space from orphaned .ts segments not referenced by any .m3u8 playlist
    orphan_deleted = _purge_orphaned_ts_sync(grace_seconds=ORPHAN_TS_GRACE_SECONDS)
    if orphan_deleted > 0:
        print(f"[🧹] Reclaimed {orphan_deleted} orphaned .ts segment(s).")
        if get_free_space_pct(STORAGE_DEVICE) >= MIN_FREE_SPACE_PCT:
            return

    all_files = []
    try:
        cam_dirs = [
            d for d in os.listdir(STORE_DIR)
            if d not in NON_CAMERA_STORE_DIRS and os.path.isdir(os.path.join(STORE_DIR, d))
        ]
    except OSError:
        return

    for cam_id in cam_dirs:
        cam_path = os.path.join(STORE_DIR, cam_id)
        try:
            for entry in os.scandir(cam_path):
                if entry.is_file() and entry.name.endswith('.m3u8') and entry.name not in ('stream.m3u8', 'stream_sub.m3u8'):
                    try:
                        all_files.append((entry.stat().st_mtime, cam_id, entry.path))
                    except OSError:
                        pass
                elif entry.is_dir() and DATE_DIR_RE.match(entry.name):
                    try:
                        for sub_entry in os.scandir(entry.path):
                            if sub_entry.is_file() and sub_entry.name.endswith('.m3u8') and sub_entry.name not in ('stream.m3u8', 'stream_sub.m3u8'):
                                try:
                                    all_files.append((sub_entry.stat().st_mtime, cam_id, sub_entry.path))
                                except OSError:
                                    pass
                    except OSError:
                        pass
        except OSError:
            pass

    all_files.sort(key=lambda x: x[0])

    deleted_count = 0
    affected_by_cam = {}

    for _, cam_id, target_m3u8 in all_files:
        if get_free_space_pct(STORAGE_DEVICE) >= MIN_FREE_SPACE_PCT:
            break

        date_str = extract_clip_date(target_m3u8)
        if date_str:
            affected_by_cam.setdefault(cam_id, set()).add(date_str)

        deleted_count += _delete_packaged_clip_files(target_m3u8)

    if deleted_count > 0:
        print(f"[🧹] Purged {deleted_count} files/chunks. Updating history manifests.")
        for cam_id, dates in affected_by_cam.items():
            update_history_manifest(target_cam_id=cam_id, target_dates=list(dates))


async def storage_manager():
    """Background loop that deletes oldest videos when disk is full and periodically prunes old .failed files."""
    failed_prune_counter = 0
    while True:
        try:
            pct = await asyncio.to_thread(get_free_space_pct, STORAGE_DEVICE)
            if pct < MIN_FREE_SPACE_PCT:
                print(f"[🧹] Low disk space ({pct:.1f}% < {MIN_FREE_SPACE_PCT}%). Purging oldest files...")
                await asyncio.to_thread(_purge_oldest_files_sync)

            failed_prune_counter += 1
            if failed_prune_counter >= 60:
                failed_prune_counter = 0
                await asyncio.to_thread(_purge_failed_queue_files_sync, 86400)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[⚠️] Storage Manager error: {e}")

        await asyncio.sleep(60)


def recover_stale_staging_files():
    """Moves orphaned .ts files from previous unclean shutdowns into the queue."""
    if not os.path.exists(STORE_DIR):
        return

    for cam_id in os.listdir(STORE_DIR):
        if cam_id in NON_CAMERA_STORE_DIRS:
            continue
        staging_dir = os.path.join(STORE_DIR, cam_id, 'staging')
        queued_dir = os.path.join(STORE_DIR, cam_id, 'queued')

        if os.path.exists(staging_dir) and os.path.exists(queued_dir):
            for f in os.listdir(staging_dir):
                if f.endswith('.ts'):
                    stale_file = os.path.join(staging_dir, f)
                    target_file = os.path.join(queued_dir, f)
                    try:
                        if os.path.getsize(stale_file) > 0:
                            shutil.move(stale_file, target_file)
                            print(f"[♻️] Recovered stale capture: {f}")
                        else:
                            os.remove(stale_file)
                    except OSError:
                        pass


def _find_next_queued_item_sync():
    """Finds the globally oldest queued .ts capture across all cameras to prevent per-camera starvation."""
    if not os.path.exists(STORE_DIR):
        return None

    oldest = None  # (mtime, cam_id, filename, filepath)
    try:
        cam_ids = os.listdir(STORE_DIR)
    except OSError:
        return None

    for cam_id in cam_ids:
        if cam_id in NON_CAMERA_STORE_DIRS:
            continue
        queued_dir = os.path.join(STORE_DIR, cam_id, 'queued')
        if not os.path.isdir(queued_dir):
            continue
        try:
            for entry in os.scandir(queued_dir):
                if not entry.is_file() or not entry.name.endswith('.ts'):
                    continue
                try:
                    mtime = entry.stat().st_mtime
                except OSError:
                    continue
                if oldest is None or mtime < oldest[0]:
                    oldest = (mtime, cam_id, entry.name, entry.path)
        except OSError:
            continue

    return oldest


async def background_encoder_worker():
    """A background worker that fairly packages queued .ts files across all cameras into HLS VOD."""
    worker_logger = get_rotating_logger("encoder_worker", os.path.join(STORE_DIR, "encoder_worker.log"))
    print("[⚙️] Background Packager Worker started.")

    while True:
        try:
            next_item = await asyncio.to_thread(_find_next_queued_item_sync)
            if not next_item:
                await asyncio.sleep(5)
                continue

            _, cam_id, raw_filename, raw_filepath = next_item
            base_name = os.path.splitext(raw_filename)[0]
            clip_date = extract_clip_date(base_name) or time.strftime('%Y%m%d')
            final_dir = os.path.join(STORE_DIR, cam_id, clip_date)
            await asyncio.to_thread(os.makedirs, final_dir, exist_ok=True)
            final_filepath = os.path.join(final_dir, f"{base_name}.m3u8")

            print(f"[⚙️] Packaging queue item: {raw_filename} -> {final_filepath}")
            timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
            worker_logger.info(f"\n--- [{timestamp}] PACKAGING {raw_filepath} ---")

            encode_cmd = [
                "ffmpeg",
                "-fflags", "+discardcorrupt",
                "-i", raw_filepath,
                "-c:v", "copy",
                "-bsf:v", SETTS_MONOTONIC_BSF,
                "-an",
                "-avoid_negative_ts", "make_zero",
                "-f", "hls",
                "-hls_time", "4",
                "-hls_playlist_type", "vod",
                "-hls_flags", "independent_segments",
                "-hls_segment_filename", os.path.join(final_dir, f"{base_name}_%03d.ts"),
                "-y", final_filepath
            ]

            proc = await asyncio.create_subprocess_exec(
                *encode_cmd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE
            )
            active_processes.add(proc)

            timed_out = False
            try:
                async def _drain_and_wait():
                    async for line in read_lines_cr_lf(proc.stderr):
                        if not line.startswith("frame="):
                            worker_logger.info(line)
                    await proc.wait()

                await asyncio.wait_for(_drain_and_wait(), timeout=ENCODER_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                timed_out = True
                print(f"[❌] Packaging timed out after {ENCODER_TIMEOUT_SECONDS}s for {raw_filename}; killing.")
                worker_logger.info(f"PACKAGING TIMED OUT AFTER {ENCODER_TIMEOUT_SECONDS}s - KILLED")
                await safe_kill_process(proc)
            except asyncio.CancelledError:
                await safe_kill_process(proc)
                raise
            finally:
                active_processes.discard(proc)

            if not timed_out and proc.returncode == 0 and os.path.exists(final_filepath):
                print(f"[✅] Successfully packaged and stored: {final_filepath}")
                try:
                    os.remove(raw_filepath)
                except OSError:
                    pass

                await asyncio.to_thread(write_clip_sidecar_json, final_dir, base_name, cam_id)
                await generate_sprite_and_vtt(final_filepath, final_dir, base_name)
                await asyncio.to_thread(update_history_manifest, cam_id, [clip_date])
            else:
                print(f"[❌] Error packaging {raw_filename}. See encoder_worker.log")
                if os.path.exists(final_filepath):
                    await asyncio.to_thread(_delete_packaged_clip_files, final_filepath)
                try:
                    if os.path.exists(raw_filepath):
                        os.replace(raw_filepath, raw_filepath + ".failed")
                except OSError:
                    pass

        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[⚠️] Background Packager Worker error: {e}")
            await asyncio.sleep(5)


class CameraStream:
    def __init__(self, cam_id, cam_config):
        self.cam_id = cam_id
        self.rtsp_url = cam_config.get('url')
        self.sub_rtsp_url = cam_config.get('sub_url')

        # Motion detection parameters (per-camera config with global/sensible fallbacks)
        self.motion_threshold = str(cam_config.get('motion_threshold', DEFAULT_MOTION_THRESHOLD))
        self.motion_max_threshold = str(cam_config.get('motion_max_threshold', DEFAULT_MOTION_MAX_THRESHOLD))
        self.pixel_diff_threshold = int(cam_config.get('pixel_diff_threshold', DEFAULT_PIXEL_DIFF_THRESHOLD))
        self.motion_confirm_frames = int(cam_config.get('motion_confirm_frames', DEFAULT_MOTION_CONFIRM_FRAMES))
        self.motion_confirm_window = float(cam_config.get('motion_confirm_window', DEFAULT_MOTION_CONFIRM_WINDOW))
        self.motion_hit_times = []

        # Ramdisk Directory for active HLS streams
        self.cam_dir = f"{BASE_DIR}/{self.cam_id}"

        # Persistent Storage Directories
        self.store_cam_dir = os.path.join(STORE_DIR, self.cam_id)
        self.staging_dir = os.path.join(self.store_cam_dir, "staging")
        self.queued_dir = os.path.join(self.store_cam_dir, "queued")

        self.recording = False
        self._starting_recording = False
        self.last_motion = 0.0
        self.record_start_time = 0.0
        self.last_chunk_time = 0.0
        self.current_output_file = ""
        self.record_proc = None
        self.master_proc = None
        self.sub_proc = None
        now = time.time()
        self.master_start_time = now
        self.sub_start_time = now
        self.last_pipeline_output_time = now
        self.last_sub_output_time = now

        os.makedirs(self.cam_dir, exist_ok=True)
        os.makedirs(self.store_cam_dir, exist_ok=True)
        os.makedirs(self.staging_dir, exist_ok=True)
        os.makedirs(self.queued_dir, exist_ok=True)

        self.pipeline_logger = get_rotating_logger(f"pipeline_{self.cam_id}", os.path.join(self.store_cam_dir, "pipeline.log"))
        self.recording_logger = get_rotating_logger(f"recording_{self.cam_id}", os.path.join(self.store_cam_dir, "recording.log"))

    def write_log_header(self, logger, message):
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        logger.info(f"\n--- [{timestamp}] {message} ---")

    def _build_filter_graph(self, include_snapshot=CONTINUOUS_LIVE_SNAPSHOTS):
        """Builds the motion detection filter graph (and optional legacy continuous live.jpg branch).
        Uses grayscale conversion, 3x3 spatial box blur, temporal frame differencing,
        and a per-pixel luma deadband LUT to ignore gradual lighting changes."""
        if include_snapshot:
            return (
                f"[0:v]fps=2,scale=320:-2,split=2[motion_in][thumb_in];"
                f"[motion_in]format=gray,avgblur=sizeX=3:sizeY=3,"
                f"tblend=all_mode=difference,"
                f"lut=c0='if(gt(val,{self.pixel_diff_threshold}),255,0)',"
                f"select='between(scene,{self.motion_threshold},{self.motion_max_threshold})',"
                f"metadata=mode=print[motion_out];"
                f"[thumb_in]fps={LIVE_SNAPSHOT_FPS}[thumb_out]"
            )
        return (
            f"[0:v]fps=2,scale=320:-2,"
            f"format=gray,avgblur=sizeX=3:sizeY=3,"
            f"tblend=all_mode=difference,"
            f"lut=c0='if(gt(val,{self.pixel_diff_threshold}),255,0)',"
            f"select='between(scene,{self.motion_threshold},{self.motion_max_threshold})',"
            f"metadata=mode=print[motion_out]"
        )

    def _clean_stale_ramdisk_segments(self):
        """Removes leftover main HLS segments without deleting live.jpg (or its atomic temp file) or sub-stream files."""
        try:
            for f in os.listdir(self.cam_dir):
                if f.startswith(('stream_sub', 'live.jpg')):
                    continue
                if f.endswith(('.ts', '.m3u8', '.tmp', '.jpg')):
                    try:
                        os.remove(os.path.join(self.cam_dir, f))
                    except OSError:
                        pass
        except OSError:
            pass

    def _clean_stale_sub_segments(self):
        """Removes leftover sub-stream HLS segments before starting a fresh sub-stream pipeline."""
        try:
            for f in os.listdir(self.cam_dir):
                if f.startswith('stream_sub') and f.endswith(('.ts', '.m3u8', '.tmp')):
                    try:
                        os.remove(os.path.join(self.cam_dir, f))
                    except OSError:
                        pass
        except OSError:
            pass

    def _get_unique_staging_filepath(self):
        """Generates a timestamped .ts path in staging, avoiding collisions if two clips start within 1 second."""
        ts = int(time.time())
        while True:
            stamp = time.strftime('%Y%m%d_%H%M%S', time.localtime(ts))
            filename = f"{self.cam_id}_{stamp}.ts"
            staging_path = os.path.join(self.staging_dir, filename)
            queued_path = os.path.join(self.queued_dir, filename)
            if not os.path.exists(staging_path) and not os.path.exists(queued_path):
                return staging_path
            ts += 1

    def handle_motion_detected(self):
        """Non-blocking motion handler: extends cooldown or schedules raw stream capture asynchronously
        so stderr draining of the RTSP FFmpeg pipeline is never blocked."""
        now = time.time()

        # If already recording or starting a recording, immediately extend cooldown
        if self.recording or self._starting_recording:
            self.last_motion = now
            return

        # Prune hits outside the confirmation window and record the current hit
        self.motion_hit_times = [
            t for t in self.motion_hit_times
            if (now - t) <= self.motion_confirm_window
        ]
        self.motion_hit_times.append(now)

        # Require N motion hits within the confirmation window to reject single-frame AE steps
        if len(self.motion_hit_times) < self.motion_confirm_frames:
            return

        self.motion_hit_times.clear()
        self.last_motion = now
        self._starting_recording = True
        is_chunk_continuation = (now - self.last_chunk_time) < 5.0
        asyncio.create_task(self._start_recording_capture(is_chunk_continuation=is_chunk_continuation))

    async def _start_recording_capture(self, is_chunk_continuation=False):
        """Starts high-res raw stream capture from stream.m3u8 in an isolated task."""
        try:
            print(f"[🚨] Motion detected on {self.cam_id}! Capturing raw stream.")
            self.recording = True
            self.record_start_time = time.time()
            self.current_output_file = await asyncio.to_thread(self._get_unique_staging_filepath)

            self.write_log_header(self.recording_logger, "STARTING RAW STREAM CAPTURE")

            m3u8_path = f"{self.cam_dir}/stream.m3u8"
            wait_time = 0.0
            while not os.path.exists(m3u8_path) and wait_time < 10.0:
                await asyncio.sleep(0.5)
                wait_time += 0.5

            if not os.path.exists(m3u8_path):
                print(f"[⚠️] Aborting capture on {self.cam_id}: Master stream not ready.")
                self.write_log_header(self.recording_logger, "ABORTED: m3u8 file was never created.")
                self.recording = False
                return

            # Use live edge on chunk continuations to avoid ~20s duplicate overlap; full pre-roll on fresh motion
            live_start_index = "-1" if is_chunk_continuation else "0"

            record_cmd = [
                "ffmpeg",
                "-fflags", "+discardcorrupt",
                "-live_start_index", live_start_index,
                "-i", m3u8_path,
                "-map", "0:v",
                "-c:v", "copy",
                "-bsf:v", SETTS_MONOTONIC_BSF,
                "-copyts",
                "-an",
                "-y", self.current_output_file
            ]

            self.record_proc = await asyncio.create_subprocess_exec(
                *record_cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE
            )
            active_processes.add(self.record_proc)

            async def drain_record_stderr(proc, logger):
                try:
                    async for log_line in read_lines_cr_lf(proc.stderr):
                        if not log_line.startswith("frame="):
                            logger.info(log_line)
                except Exception:
                    pass

            asyncio.create_task(drain_record_stderr(self.record_proc, self.recording_logger))
        except asyncio.CancelledError:
            self.recording = False
            raise
        except Exception as e:
            print(f"[❌] Failed to start recording process on {self.cam_id}: {e}")
            self.recording = False
            self.record_proc = None
        finally:
            self._starting_recording = False

    async def finalize_recording(self, proc, filepath):
        """Finalizes the raw capture file and moves it to the encoding queue."""
        if not proc:
            return

        try:
            if proc.returncode is None:
                if proc.stdin:
                    try:
                        proc.stdin.write(b'q\n')
                        await proc.stdin.drain()
                        proc.stdin.close()
                    except Exception:
                        try:
                            proc.terminate()
                        except ProcessLookupError:
                            pass
                else:
                    try:
                        proc.terminate()
                    except ProcessLookupError:
                        pass

                await asyncio.wait_for(proc.wait(), timeout=10.0)

        except asyncio.TimeoutError:
            print(f"[⚠️] FFmpeg hung while capturing {filepath}. Forcing SIGKILL.")
            self.write_log_header(self.recording_logger, "CAPTURE HUNG - FORCING KILL")
            await safe_kill_process(proc)

        except Exception as e:
            print(f"[❌] Error closing capture {filepath}: {type(e).__name__} {e}")
            await safe_kill_process(proc)
        finally:
            active_processes.discard(proc)

        if filepath and os.path.exists(filepath):
            try:
                if os.path.getsize(filepath) > 0:
                    filename = os.path.basename(filepath)
                    queued_filepath = os.path.join(self.queued_dir, filename)
                    await asyncio.to_thread(shutil.move, filepath, queued_filepath)
                    print(f"[📥] Raw capture complete. Queued for encoding: {queued_filepath}")
                else:
                    os.remove(filepath)
            except OSError as e:
                print(f"[❌] Failed to move capture {filepath}: {e}")

    async def shutdown(self):
        """Gracefully stops active recording and pipeline subprocesses for this camera."""
        if self.recording or self.record_proc:
            old_proc = self.record_proc
            old_file = self.current_output_file
            self.record_proc = None
            self.recording = False
            if old_proc:
                await self.finalize_recording(old_proc, old_file)

        if self.master_proc:
            await safe_kill_process(self.master_proc)
            self.master_proc = None

        if self.sub_proc:
            await safe_kill_process(self.sub_proc)
            self.sub_proc = None

    async def start_sub_pipeline(self):
        """Dedicated supervisor loop that remuxes the camera's RTSP sub-stream into stream_sub.m3u8
        and drives motion detection (plus optional continuous live.jpg snapshots when enabled)."""
        if not self.sub_rtsp_url:
            return

        # Stagger initial connection by 1.5s so main and sub RTSP handshakes never collide on the camera
        await asyncio.sleep(1.5)

        first_run = True
        backoff = 3.0
        while True:
            if not first_run:
                await asyncio.sleep(backoff)
            first_run = False

            self._clean_stale_sub_segments()
            self.motion_hit_times.clear()
            mode_label = "HLS + Motion + Snapshot" if CONTINUOUS_LIVE_SNAPSHOTS else "HLS + Motion"
            print(f"[📱] Starting low-bandwidth sub-stream pipeline ({mode_label}) for {self.cam_id}...")
            self.write_log_header(self.pipeline_logger, f"STARTING SUB-STREAM PIPELINE ({mode_label.upper()})")
            run_started = time.time()
            self.sub_start_time = run_started
            self.last_sub_output_time = run_started

            sub_filter_graph = self._build_filter_graph(include_snapshot=CONTINUOUS_LIVE_SNAPSHOTS)

            cmd = [
                "ffmpeg",
                "-thread_queue_size", "1024",
                "-use_wallclock_as_timestamps", "1",
                "-fflags", "+discardcorrupt",
                "-rtsp_transport", "tcp",
                *RTSP_TIMEOUT_ARGS,
                "-i", self.sub_rtsp_url,
                "-map", "0:v", "-c:v", "copy",
                "-bsf:v", SETTS_MONOTONIC_BSF,
                "-an",
                "-f", "hls",
                "-hls_time", "2",
                "-hls_list_size", "10",
                "-hls_delete_threshold", "5",
                "-hls_start_number_source", "epoch",
                "-hls_flags", "delete_segments+independent_segments+temp_file+discont_start",
                "-hls_segment_filename", f"{self.cam_dir}/stream_sub_%05d.ts",
                f"{self.cam_dir}/stream_sub.m3u8",

                "-filter_complex", sub_filter_graph,
                "-map", "[motion_out]", "-fps_mode", "passthrough", "-f", "null", "-",
            ]
            if CONTINUOUS_LIVE_SNAPSHOTS:
                cmd.extend([
                    "-map", "[thumb_out]", "-fps_mode", "passthrough", "-f", "image2",
                    "-update", "1", "-atomic_writing", "1",
                    "-q:v", str(LIVE_SNAPSHOT_QUALITY),
                    "-y", f"{self.cam_dir}/live.jpg"
                ])

            last_stderr_line = ""
            try:
                self.sub_proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE
                )
                active_processes.add(self.sub_proc)

                async for decoded_line in read_lines_cr_lf(self.sub_proc.stderr):
                    self.last_sub_output_time = time.time()
                    if not decoded_line.startswith("frame="):
                        last_stderr_line = decoded_line
                        self.pipeline_logger.info(f"[SUB] {decoded_line}")

                    if MOTION_SCORE_RE.search(decoded_line):
                        self.handle_motion_detected()

                await self.sub_proc.wait()
                if self.sub_proc.returncode != 0:
                    print(f"[⚠️] Sub-stream FFmpeg for {self.cam_id} exited (code {self.sub_proc.returncode}): {last_stderr_line}")

            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[⚠️] Sub-stream pipeline error on {self.cam_id}: {e}")

            finally:
                if self.sub_proc:
                    await safe_kill_process(self.sub_proc)
                    self.sub_proc = None

                if (time.time() - run_started) > 60.0:
                    backoff = 3.0
                else:
                    backoff = min(30.0, backoff * 2.0)

    async def start_master_pipeline(self):
        """Persistent supervisor loop that pulls the main RTSP stream for HLS.
        When sub_url is configured, runs purely with -c:v copy (zero video decoding).
        When sub_url is not configured, also drives Motion Detection and Live Snapshots."""
        use_sub_pipeline = bool(self.sub_rtsp_url)
        first_run = True
        backoff = 2.0

        while True:
            if not first_run:
                await asyncio.sleep(backoff)
            first_run = False

            if not self.recording:
                self._clean_stale_ramdisk_segments()

            if not use_sub_pipeline:
                self.motion_hit_times.clear()

            print(f"[📷] Starting master pipeline for {self.cam_id}...")
            run_started = time.time()
            self.master_start_time = run_started
            self.last_pipeline_output_time = run_started

            if use_sub_pipeline:
                self.write_log_header(self.pipeline_logger, "STARTING MASTER PIPELINE (HLS COPY ONLY)")
                cmd = [
                    "ffmpeg",
                    "-thread_queue_size", "1024",
                    "-use_wallclock_as_timestamps", "1",
                    "-fflags", "+discardcorrupt",
                    "-rtsp_transport", "tcp",
                    *RTSP_TIMEOUT_ARGS,
                    "-i", self.rtsp_url,
                    "-map", "0:v", "-c:v", "copy",
                    "-bsf:v", SETTS_MONOTONIC_BSF,
                    "-an",
                    "-f", "hls",
                    "-hls_time", "2",
                    "-hls_list_size", "10",
                    "-hls_delete_threshold", "5",
                    "-hls_start_number_source", "epoch",
                    "-hls_flags", "delete_segments+independent_segments+temp_file+discont_start",
                    "-hls_segment_filename", f"{self.cam_dir}/stream_%05d.ts",
                    f"{self.cam_dir}/stream.m3u8"
                ]
            else:
                mode_label = "HLS + MOTION + SNAPSHOT" if CONTINUOUS_LIVE_SNAPSHOTS else "HLS + MOTION"
                self.write_log_header(self.pipeline_logger, f"STARTING UNIFIED MASTER PIPELINE ({mode_label})")
                filter_graph = self._build_filter_graph(include_snapshot=CONTINUOUS_LIVE_SNAPSHOTS)
                cmd = [
                    "ffmpeg",
                    "-thread_queue_size", "1024",
                    "-use_wallclock_as_timestamps", "1",
                    "-fflags", "+discardcorrupt",
                    "-rtsp_transport", "tcp",
                    *RTSP_TIMEOUT_ARGS,
                    "-i", self.rtsp_url,

                    "-map", "0:v", "-c:v", "copy",
                    "-bsf:v", SETTS_MONOTONIC_BSF,
                    "-an",
                    "-f", "hls",
                    "-hls_time", "2",
                    "-hls_list_size", "10",
                    "-hls_delete_threshold", "5",
                    "-hls_start_number_source", "epoch",
                    "-hls_flags", "delete_segments+independent_segments+temp_file+discont_start",
                    "-hls_segment_filename", f"{self.cam_dir}/stream_%05d.ts",
                    f"{self.cam_dir}/stream.m3u8",

                    "-filter_complex", filter_graph,
                    "-map", "[motion_out]", "-fps_mode", "passthrough", "-f", "null", "-",
                ]
                if CONTINUOUS_LIVE_SNAPSHOTS:
                    cmd.extend([
                        "-map", "[thumb_out]", "-fps_mode", "passthrough", "-f", "image2",
                        "-update", "1", "-atomic_writing", "1",
                        "-q:v", str(LIVE_SNAPSHOT_QUALITY),
                        "-y", f"{self.cam_dir}/live.jpg"
                    ])

            last_stderr_line = ""
            try:
                self.master_proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE
                )
                active_processes.add(self.master_proc)

                async for decoded_line in read_lines_cr_lf(self.master_proc.stderr):
                    self.last_pipeline_output_time = time.time()

                    if not decoded_line.startswith("frame="):
                        last_stderr_line = decoded_line
                        self.pipeline_logger.info(decoded_line)

                    if not use_sub_pipeline and MOTION_SCORE_RE.search(decoded_line):
                        self.handle_motion_detected()

                await self.master_proc.wait()
                if self.master_proc.returncode != 0:
                    print(f"[⚠️] FFmpeg for {self.cam_id} exited (code {self.master_proc.returncode}): {last_stderr_line}")

            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[⚠️] Master pipeline error on {self.cam_id}: {e}")

            finally:
                if self.master_proc:
                    await safe_kill_process(self.master_proc)
                    self.master_proc = None

                if self.recording or self.record_proc:
                    old_proc = self.record_proc
                    old_file = self.current_output_file
                    self.record_proc = None
                    self.recording = False
                    if old_proc:
                        await self.finalize_recording(old_proc, old_file)

                self._clean_stale_ramdisk_segments()

                if (time.time() - run_started) > 60.0:
                    backoff = 2.0
                else:
                    backoff = min(30.0, backoff * 2.0)

    async def cooldown_manager(self):
        """Manages recording cooldown, premature capture exit recovery, chunking, and process termination."""
        while True:
            try:
                await asyncio.sleep(1)

                if self.recording and not self._starting_recording:
                    # Detect premature capture FFmpeg exit so subsequent motion isn't lost until MAX_RECORD_TIME
                    if self.record_proc is not None and self.record_proc.returncode is not None:
                        print(f"[⚠️] Capture process on {self.cam_id} exited early (code {self.record_proc.returncode}). Finalizing...")
                        old_proc = self.record_proc
                        old_file = self.current_output_file
                        self.record_proc = None
                        self.recording = False
                        asyncio.create_task(self.finalize_recording(old_proc, old_file))
                        continue

                    now = time.time()
                    time_since_last_motion = now - self.last_motion
                    time_since_start = now - self.record_start_time

                    if time_since_last_motion >= COOLDOWN_PERIOD or time_since_start >= MAX_RECORD_TIME:
                        if time_since_start >= MAX_RECORD_TIME:
                            print(f"[⏱️] Max clip length reached on {self.cam_id}. Chunking file...")
                            self.last_chunk_time = now
                        else:
                            print(f"[⏱️] Motion stopped on {self.cam_id}. Finalizing capture...")

                        old_proc = self.record_proc
                        old_file = self.current_output_file
                        self.record_proc = None
                        self.recording = False

                        if old_proc:
                            asyncio.create_task(self.finalize_recording(old_proc, old_file))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[⚠️] Cooldown manager error on {self.cam_id}: {e}")

    def _is_playlist_stale(self, playlist_filename, start_time, now, stall_timeout):
        """Returns True if FFmpeg has been running past startup grace without updating its HLS playlist."""
        if (now - start_time) <= stall_timeout:
            return False
        playlist_path = os.path.join(self.cam_dir, playlist_filename)
        try:
            mtime = os.path.getmtime(playlist_path)
            return (now - mtime) > stall_timeout
        except OSError:
            # Playlist still does not exist after startup grace period
            return True

    async def watchdog(self):
        """Monitors master and sub-stream FFmpeg health (both stderr activity and HLS playlist mtime)."""
        stall_timeout = 30

        while True:
            try:
                await asyncio.sleep(15)

                now = time.time()
                if self.master_proc is not None and self.master_proc.returncode is None:
                    stderr_stalled = (now - self.last_pipeline_output_time) > stall_timeout
                    playlist_stalled = self._is_playlist_stale("stream.m3u8", self.master_start_time, now, stall_timeout)
                    if stderr_stalled or playlist_stalled:
                        reason = "PLAYLIST STALE" if playlist_stalled and not stderr_stalled else "MASTER STALLED"
                        print(f"[⚠️] Watchdog: Master process stalled ({reason}) for {self.cam_id}. Restarting...")
                        self.write_log_header(self.pipeline_logger, f"WATCHDOG TRIGGERED ({reason}) - RESTARTING")
                        self.last_pipeline_output_time = now
                        self.master_start_time = now
                        await safe_kill_process(self.master_proc)

                if self.sub_proc is not None and self.sub_proc.returncode is None:
                    stderr_stalled = (now - self.last_sub_output_time) > stall_timeout
                    playlist_stalled = self._is_playlist_stale("stream_sub.m3u8", self.sub_start_time, now, stall_timeout)
                    if stderr_stalled or playlist_stalled:
                        reason = "SUB PLAYLIST STALE" if playlist_stalled and not stderr_stalled else "SUB STALLED"
                        print(f"[⚠️] Watchdog: Sub-stream process stalled ({reason}) for {self.cam_id}. Restarting...")
                        self.write_log_header(self.pipeline_logger, f"WATCHDOG TRIGGERED ({reason}) - RESTARTING")
                        self.last_sub_output_time = now
                        self.sub_start_time = now
                        await safe_kill_process(self.sub_proc)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[⚠️] Watchdog error on {self.cam_id}: {e}")


async def _systemd_heartbeat():
    """Periodically notifies systemd WATCHDOG=1 from the asyncio event loop."""
    if sdnotify is None:
        return
    try:
        notifier = sdnotify.SystemdNotifier()
        notifier.notify("READY=1")
    except Exception:
        return
    while True:
        try:
            await asyncio.sleep(15)
            notifier.notify("WATCHDOG=1")
        except asyncio.CancelledError:
            raise
        except Exception:
            pass


async def main():
    print("🚀 Initializing Engine...")
    tasks = []
    cameras = []
    shutdown_event = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, shutdown_event.set)
        except NotImplementedError:
            pass

    recover_stale_staging_files()

    if sdnotify is not None and os.environ.get("NOTIFY_SOCKET") and os.environ.get("ARGONVR_ENGINE_NOTIFY", "1") != "0":
        tasks.append(asyncio.create_task(_systemd_heartbeat()))
    tasks.append(asyncio.create_task(storage_manager()))
    tasks.append(asyncio.create_task(background_encoder_worker()))
    tasks.append(asyncio.create_task(asyncio.to_thread(update_history_manifest)))

    for cam_id, cam_config in CAMERAS.items():
        cam = CameraStream(cam_id, cam_config)
        cameras.append(cam)

        tasks.extend([
            asyncio.create_task(cam.start_master_pipeline()),
            asyncio.create_task(cam.cooldown_manager()),
            asyncio.create_task(cam.watchdog())
        ])

        if cam.sub_rtsp_url:
            tasks.append(asyncio.create_task(cam.start_sub_pipeline()))

        if STAGGER_SPIN_UP_SECONDS > 0:
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=STAGGER_SPIN_UP_SECONDS)
                break
            except asyncio.TimeoutError:
                pass

    await shutdown_event.wait()
    print("\n🛑 Shutdown signal received. Stopping tasks and finalizing active recordings...")

    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

    await asyncio.gather(*(cam.shutdown() for cam in cameras), return_exceptions=True)
    for proc in list(active_processes):
        await safe_kill_process(proc)

    _LOG_DISPATCHER.shutdown(timeout=2.0)
    print("🟢 Engine shutdown complete.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 Shutting down.")
