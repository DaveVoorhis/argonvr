import asyncio
import os
import time
import atexit
import sys
import json
import yaml
import shutil
import subprocess
import math
import datetime
import glob
import logging
from logging.handlers import TimedRotatingFileHandler
import gzip

with open('argonvr.yaml', 'r', encoding='utf-8') as f:
    config = yaml.safe_load(f)

CAMERAS = config.get('CAMERAS', {})
SETTINGS = config.get('SETTINGS', {})

BASE_DIR = SETTINGS.get('BASE_DIR', './cameras')
SPRITE_WIDTH = int(SETTINGS.get('SPRITE_WIDTH', 320))
SPRITE_HEIGHT = int(SETTINGS.get('SPRITE_HEIGHT', 180))
SPRITE_QUALITY = int(SETTINGS.get('SPRITE_QUALITY', 3))
LIVE_SNAPSHOT_FPS = float(SETTINGS.get('LIVE_SNAPSHOT_FPS', 1.0))
LIVE_SNAPSHOT_QUALITY = int(SETTINGS.get('LIVE_SNAPSHOT_QUALITY', 6))

# --- Configurable Storage Options ---
STORE_DIR = SETTINGS.get('STORE_DIR', './recordings')
STORAGE_DEVICE = SETTINGS.get('STORAGE_DEVICE', '/')
MIN_FREE_SPACE_PCT = float(SETTINGS.get('MIN_FREE_SPACE_PCT', 15.0))

# --- Recording and Process Configuration ---
COOLDOWN_PERIOD = int(SETTINGS.get('COOLDOWN_PERIOD', 10))
MAX_RECORD_TIME = int(SETTINGS.get('MAX_RECORD_TIME', 60))  # Maximum length of a single clip in seconds
STAGGER_SPIN_UP_SECONDS = int(SETTINGS.get('STAGGER_SPIN_UP_SECONDS', 0))
LOG_DAYS_TO_KEEP = int(SETTINGS.get('LOG_DAYS_TO_KEEP', 30))

os.makedirs(BASE_DIR, exist_ok=True)
os.makedirs(STORE_DIR, exist_ok=True)

# Global registry to track active processes without leaking finished ones
active_processes = set()

def cleanup_processes():
    """Safety net: Kills all tracked FFmpeg processes on exit."""
    print("\n🛑 Cleaning up child processes...")
    for proc in list(active_processes):
        try:
            if proc.returncode is None:
                proc.terminate()
        except Exception:
            pass

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

async def read_lines_cr_lf(stream, chunk_size=4096):
    """Reads from an asyncio StreamReader, yielding lines split on either CR or LF.
    Prevents FFmpeg's CR-delimited progress lines from blocking readline() or overflowing the buffer."""
    if not stream:
        return
    buffer = b""
    while True:
        chunk = await stream.read(chunk_size)
        if not chunk:
            if buffer:
                decoded = buffer.decode('utf-8', errors='ignore').strip()
                if decoded:
                    yield decoded
            break
        buffer += chunk
        while True:
            idx_r = buffer.find(b'\r')
            idx_n = buffer.find(b'\n')
            if idx_r == -1 and idx_n == -1:
                break
            if idx_r == -1:
                sep_idx = idx_n
            elif idx_n == -1:
                sep_idx = idx_r
            else:
                sep_idx = min(idx_r, idx_n)

            line = buffer[:sep_idx]
            if sep_idx == idx_r and len(buffer) > sep_idx + 1 and buffer[sep_idx + 1:sep_idx + 2] == b'\n':
                buffer = buffer[sep_idx + 2:]
            else:
                buffer = buffer[sep_idx + 1:]

            decoded = line.decode('utf-8', errors='ignore').strip()
            if decoded:
                yield decoded

def get_rotating_logger(name, log_file):
    """Creates or retrieves a rotating logger with daily rotation, gzip compression, and configurable retention."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.setLevel(logging.INFO)

        handler = TimedRotatingFileHandler(
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

        def namer(name):
            return name

        handler.rotator = rotator
        handler.namer = namer

        formatter = logging.Formatter('%(message)s')
        handler.setFormatter(formatter)
        logger.addHandler(handler)

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

def format_vtt_time(seconds):
    """Formats raw seconds into WebVTT timestamp format."""
    total_seconds = max(0.0, float(seconds))
    hours = int(total_seconds // 3600)
    minutes = int((total_seconds % 3600) // 60)
    secs = int(total_seconds % 60)
    milliseconds = int(round((total_seconds - int(total_seconds)) * 1000))
    if milliseconds >= 1000:
        secs += 1
        milliseconds -= 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"

async def generate_sprite_and_vtt(mp4_filepath, output_dir, base_name):
    """Extracts I-frames into a single JPEG sprite sheet and generates a WebVTT map."""
    jpg_filepath = os.path.join(output_dir, f"{base_name}.jpg")
    vtt_filepath = os.path.join(output_dir, f"{base_name}.vtt")
    vtt_tmp_filepath = vtt_filepath + ".tmp"

    try:
        # 1. FAST PROBE: Read 'packets' instead of 'frames' (bypasses the decoder entirely)
        cmd_probe = [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "packet=pts_time,dts_time,flags",
            "-of", "json", mp4_filepath
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd_probe,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()

        probe_data = json.loads(stdout.decode('utf-8') or "{}")
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

        num_frames = len(valid_i_frames)
        cols = 5
        rows = math.ceil(num_frames / cols)
        width = SPRITE_WIDTH
        height = SPRITE_HEIGHT

        # 3. FAST SPRITE GEN: Use '-skip_frame nokey' to avoid decoding P/B frames
        cmd_ffmpeg = [
            "ffmpeg",
            "-skip_frame", "nokey",
            "-i", mp4_filepath,
            "-vf", f"select='eq(pict_type,I)',scale={width}:{height},tile={cols}x{rows}",
            "-frames:v", "1",
            "-q:v", str(SPRITE_QUALITY),
            "-y", jpg_filepath
        ]
        proc_ff = await asyncio.create_subprocess_exec(
            *cmd_ffmpeg,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL
        )
        active_processes.add(proc_ff)
        await proc_ff.wait()
        active_processes.discard(proc_ff)

        if proc_ff.returncode != 0 or not os.path.exists(jpg_filepath):
            print(f"[⚠️] Skipped VTT generation for {base_name}: Sprite image was not created.")
            if os.path.exists(jpg_filepath):
                os.remove(jpg_filepath)
            return

        # 4. Generate WebVTT atomically
        with open(vtt_tmp_filepath, 'w', encoding='utf-8') as vtt_file:
            vtt_file.write("WEBVTT\n\n")

            for i in range(num_frames):
                col = i % cols
                row = i // cols
                x = col * width
                y = row * height

                start_time = valid_i_frames[i]
                end_time = valid_i_frames[i + 1] if i + 1 < num_frames else start_time + 5.0

                vtt_file.write(f"{format_vtt_time(start_time)} --> {format_vtt_time(end_time)}\n")
                vtt_file.write(f"{base_name}.jpg#xywh={x},{y},{width},{height}\n\n")

        os.replace(vtt_tmp_filepath, vtt_filepath)
        print(f"[🎞️] Generated Sprite ({num_frames} tiles) & VTT for {base_name}")

    except Exception as e:
        print(f"[⚠️] Failed to process sprite/vtt for {base_name}: {e}")
        for path in (jpg_filepath, vtt_filepath, vtt_tmp_filepath):
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass

def update_history_manifest(target_cam_id=None, target_dates=None):
    """Scans the recordings directory and generates daily JSON manifests per camera.
    If target_dates is provided, only those specific daily manifests are updated."""
    if not os.path.exists(STORE_DIR):
        return

    cam_dirs = [target_cam_id] if target_cam_id else os.listdir(STORE_DIR)
    store_basename = os.path.basename(os.path.normpath(STORE_DIR))

    for cam_id in cam_dirs:
        cam_path = os.path.join(STORE_DIR, cam_id)
        if not os.path.isdir(cam_path):
            continue

        daily_files = {}
        try:
            dir_entries = os.listdir(cam_path)
        except OSError:
            continue

        for f in dir_entries:
            if f.endswith('.m3u8') and f not in ('stream.m3u8', 'stream_sub.m3u8'):
                try:
                    parts = f.split('_')
                    if len(parts) >= 2:
                        date_str = parts[1]

                        if target_dates and date_str not in target_dates:
                            continue

                        if date_str not in daily_files:
                            daily_files[date_str] = []
                        daily_files[date_str].append(f)
                except IndexError:
                    continue

        dates_to_process = target_dates if target_dates else daily_files.keys()

        active_manifests = set()

        for date_str in dates_to_process:
            files = daily_files.get(date_str, [])
            manifest_name = f"history_{date_str}.json"
            active_manifests.add(manifest_name)
            manifest_path = os.path.join(cam_path, manifest_name)

            if not files:
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
            for f in files:
                base_name = os.path.splitext(f)[0]
                jpg_filename = f"{base_name}.jpg"
                vtt_filename = f"{base_name}.vtt"

                has_sprite = os.path.exists(os.path.join(cam_path, jpg_filename))
                has_vtt = os.path.exists(os.path.join(cam_path, vtt_filename))

                cached = existing_data.get(f)
                if (
                        cached
                        and cached.get('duration', 0) > 0
                        and bool(cached.get('sprite_url')) == has_sprite
                        and bool(cached.get('vtt_url')) == has_vtt
                ):
                    manifest_data.append(cached)
                else:
                    filepath = os.path.join(cam_path, f)
                    manifest_data.append({
                        "filename": f,
                        "url": f"./{store_basename}/{cam_id}/{f}",
                        "duration": get_video_duration(filepath),
                        "sprite_url": f"./{store_basename}/{cam_id}/{jpg_filename}" if has_sprite else None,
                        "vtt_url": f"./{store_basename}/{cam_id}/{vtt_filename}" if has_vtt else None
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

        if not target_dates:
            for f in dir_entries:
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

def _purge_oldest_files_sync():
    """Synchronous helper to purge oldest recordings without blocking the asyncio loop."""
    all_files = []
    for root, _, files in os.walk(STORE_DIR):
        for f in files:
            if f.endswith('.m3u8') and f not in ('stream.m3u8', 'stream_sub.m3u8'):
                full_path = os.path.join(root, f)
                try:
                    mtime = os.path.getmtime(full_path)
                    all_files.append((mtime, full_path))
                except OSError:
                    pass

    all_files.sort(key=lambda x: x[0])

    deleted_count = 0
    affected_dates = set()

    while all_files and get_free_space_pct(STORAGE_DEVICE) < MIN_FREE_SPACE_PCT:
        _, target_m3u8 = all_files.pop(0)
        base_path = os.path.splitext(target_m3u8)[0]

        try:
            filename = os.path.basename(target_m3u8)
            parts = filename.split('_')
            if len(parts) >= 2:
                affected_dates.add(parts[1])
        except Exception:
            pass

        for f_to_delete in glob.glob(f"{glob.escape(base_path)}*"):
            try:
                os.remove(f_to_delete)
                deleted_count += 1
            except OSError:
                pass

    if deleted_count > 0:
        print(f"[🧹] Purged {deleted_count} files/chunks. Updating history manifests.")
        update_history_manifest(target_dates=list(affected_dates))

async def storage_manager():
    """Background loop that deletes oldest videos when disk is full."""
    while True:
        try:
            pct = get_free_space_pct(STORAGE_DEVICE)
            if pct < MIN_FREE_SPACE_PCT:
                print(f"[🧹] Low disk space ({pct:.1f}% < {MIN_FREE_SPACE_PCT}%). Purging oldest files...")
                await asyncio.to_thread(_purge_oldest_files_sync)
        except Exception as e:
            print(f"[⚠️] Storage Manager error: {e}")

        await asyncio.sleep(60)

def recover_stale_staging_files():
    """Moves orphaned .ts files from previous unclean shutdowns into the queue."""
    if not os.path.exists(STORE_DIR):
        return

    for cam_id in os.listdir(STORE_DIR):
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

async def background_encoder_worker():
    """A background worker that sequentially packages queued .ts files into HLS VOD."""
    worker_logger = get_rotating_logger("encoder_worker", os.path.join(STORE_DIR, "encoder_worker.log"))
    print("[⚙️] Background Packager Worker started.")

    while True:
        task_found = False

        if os.path.exists(STORE_DIR):
            for cam_id in os.listdir(STORE_DIR):
                queued_dir = os.path.join(STORE_DIR, cam_id, 'queued')
                if not os.path.isdir(queued_dir):
                    continue

                try:
                    queued_files = [f for f in os.listdir(queued_dir) if f.endswith('.ts')]
                except OSError:
                    continue

                if queued_files:
                    queued_files.sort(key=lambda x: os.path.getmtime(os.path.join(queued_dir, x)))
                    raw_filename = queued_files[0]
                    raw_filepath = os.path.join(queued_dir, raw_filename)

                    base_name = os.path.splitext(raw_filename)[0]
                    final_dir = os.path.join(STORE_DIR, cam_id)
                    final_filepath = os.path.join(final_dir, f"{base_name}.m3u8")

                    print(f"[⚙️] Packaging queue item: {raw_filename} -> {final_filepath}")
                    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
                    worker_logger.info(f"\n--- [{timestamp}] PACKAGING {raw_filepath} ---")

                    encode_cmd = [
                        "ffmpeg",
                        "-i", raw_filepath,
                        "-c:v", "copy",
                        "-an",
                        "-f", "hls",
                        "-hls_time", "2",
                        "-hls_playlist_type", "vod",
                        "-hls_flags", "independent_segments",
                        "-hls_segment_filename", os.path.join(final_dir, f"{base_name}_%03d.ts"),
                        "-y", final_filepath
                    ]

                    proc = await asyncio.create_subprocess_exec(
                        *encode_cmd,
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.PIPE
                    )
                    active_processes.add(proc)

                    async for line in read_lines_cr_lf(proc.stderr):
                        if not line.startswith("frame="):
                            worker_logger.info(line)

                    await proc.wait()
                    active_processes.discard(proc)

                    if proc.returncode == 0:
                        print(f"[✅] Successfully packaged and stored: {final_filepath}")
                        try:
                            os.remove(raw_filepath)
                        except OSError:
                            pass

                        await generate_sprite_and_vtt(final_filepath, final_dir, base_name)

                        try:
                            parts = base_name.split('_')
                            if len(parts) >= 2:
                                target_date = parts[1]
                                await asyncio.to_thread(update_history_manifest, cam_id, [target_date])
                            else:
                                await asyncio.to_thread(update_history_manifest, cam_id)
                        except Exception:
                            await asyncio.to_thread(update_history_manifest, cam_id)
                    else:
                        print(f"[❌] Error packaging {raw_filename}. See encoder_worker.log")
                        try:
                            os.replace(raw_filepath, raw_filepath + ".failed")
                        except OSError:
                            pass

                    task_found = True
                    break

        if not task_found:
            await asyncio.sleep(5)

class CameraStream:
    def __init__(self, cam_id, cam_config):
        self.cam_id = cam_id
        self.rtsp_url = cam_config.get('url')
        self.sub_rtsp_url = cam_config.get('sub_url')
        self.motion_threshold = str(cam_config.get('motion_threshold', '0.01'))

        # Ramdisk Directory for active HLS streams
        self.cam_dir = f"{BASE_DIR}/{self.cam_id}"

        # Persistent Storage Directories
        self.store_cam_dir = os.path.join(STORE_DIR, self.cam_id)
        self.staging_dir = os.path.join(self.store_cam_dir, "staging")
        self.queued_dir = os.path.join(self.store_cam_dir, "queued")

        self.recording = False
        self.last_motion = 0
        self.record_start_time = 0
        self.current_output_file = ""
        self.record_proc = None
        self.master_proc = None
        self.sub_proc = None
        self.last_pipeline_output_time = time.time()
        self.last_sub_output_time = time.time()

        os.makedirs(self.cam_dir, exist_ok=True)
        os.makedirs(self.store_cam_dir, exist_ok=True)
        os.makedirs(self.staging_dir, exist_ok=True)
        os.makedirs(self.queued_dir, exist_ok=True)

        self.pipeline_logger = get_rotating_logger(f"pipeline_{self.cam_id}", os.path.join(self.store_cam_dir, "pipeline.log"))
        self.recording_logger = get_rotating_logger(f"recording_{self.cam_id}", os.path.join(self.store_cam_dir, "recording.log"))

    def write_log_header(self, logger, message):
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        logger.info(f"\n--- [{timestamp}] {message} ---")

    def _clean_stale_ramdisk_segments(self):
        """Removes leftover main HLS segments without deleting live.jpg or sub-stream files."""
        try:
            for f in os.listdir(self.cam_dir):
                if f.startswith('stream_sub') or f == 'live.jpg':
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
                    shutil.move(filepath, queued_filepath)
                    print(f"[📥] Raw capture complete. Queued for encoding: {queued_filepath}")
                else:
                    os.remove(filepath)
            except OSError as e:
                print(f"[❌] Failed to move capture {filepath}: {e}")

    async def start_sub_pipeline(self):
        """Dedicated lightweight supervisor loop that remuxes the camera's RTSP sub-stream into stream_sub.m3u8."""
        if not self.sub_rtsp_url:
            return

        # Stagger initial connection by 1.5s so main and sub RTSP handshakes never collide on the camera
        await asyncio.sleep(1.5)

        first_run = True
        while True:
            if not first_run:
                await asyncio.sleep(3)
            first_run = False

            self._clean_stale_sub_segments()
            print(f"[📱] Starting low-bandwidth sub-stream pipeline for {self.cam_id}...")
            self.write_log_header(self.pipeline_logger, "STARTING SUB-STREAM HLS PIPELINE")
            self.last_sub_output_time = time.time()

            cmd = [
                "ffmpeg", "-rtsp_transport", "tcp",
                "-i", self.sub_rtsp_url,
                "-map", "0:v", "-c:v", "copy", "-an",
                "-f", "hls", "-hls_time", "2", "-hls_list_size", "10",
                "-hls_flags", "delete_segments+independent_segments+temp_file",
                "-strftime", "1",
                "-hls_segment_filename", f"{self.cam_dir}/stream_sub_%Y%m%d_%H%M%S.ts",
                f"{self.cam_dir}/stream_sub.m3u8"
            ]

            last_stderr_line = ""
            try:
                self.sub_proc = await asyncio.create_subprocess_exec(
                    *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
                )
                active_processes.add(self.sub_proc)

                async for decoded_line in read_lines_cr_lf(self.sub_proc.stderr):
                    self.last_sub_output_time = time.time()
                    if not decoded_line.startswith("frame="):
                        last_stderr_line = decoded_line
                        self.pipeline_logger.info(f"[SUB] {decoded_line}")

                await self.sub_proc.wait()
                if self.sub_proc.returncode != 0:
                    print(f"[⚠️] Sub-stream FFmpeg for {self.cam_id} exited (code {self.sub_proc.returncode}): {last_stderr_line}")

            except Exception as e:
                print(f"[⚠️] Sub-stream pipeline error on {self.cam_id}: {e}")

            finally:
                if self.sub_proc:
                    await safe_kill_process(self.sub_proc)
                    self.sub_proc = None

    async def start_master_pipeline(self):
        """Persistent supervisor loop that pulls the main RTSP stream for HLS, Motion, and Live Snapshots."""
        first_run = True
        while True:
            if not first_run:
                await asyncio.sleep(2)
            first_run = False

            if not self.recording:
                self._clean_stale_ramdisk_segments()

            print(f"[📷] Starting master pipeline for {self.cam_id}...")
            self.write_log_header(self.pipeline_logger, "STARTING UNIFIED MASTER PIPELINE (HLS + MOTION + SNAPSHOT)")
            self.last_pipeline_output_time = time.time()

            filter_graph = (
                f"[0:v]fps=2,scale=320:-2,split=2[motion_in][thumb_in];"
                f"[motion_in]select='gt(scene,{self.motion_threshold})',metadata=mode=print[motion_out];"
                f"[thumb_in]fps={LIVE_SNAPSHOT_FPS}[thumb_out]"
            )

            cmd = [
                "ffmpeg", "-rtsp_transport", "tcp",
                "-i", self.rtsp_url,

                "-map", "0:v", "-c:v", "copy", "-an",
                "-f", "hls", "-hls_time", "2", "-hls_list_size", "10",
                "-hls_flags", "delete_segments+independent_segments+temp_file",
                "-strftime", "1",
                "-hls_segment_filename", f"{self.cam_dir}/stream_%Y%m%d_%H%M%S.ts",
                f"{self.cam_dir}/stream.m3u8",

                "-filter_complex", filter_graph,
                "-map", "[motion_out]", "-f", "null", "-",
                "-map", "[thumb_out]", "-f", "image2",
                "-update", "1", "-atomic_writing", "1",
                "-q:v", str(LIVE_SNAPSHOT_QUALITY),
                "-y", f"{self.cam_dir}/live.jpg"
            ]

            last_stderr_line = ""
            try:
                self.master_proc = await asyncio.create_subprocess_exec(
                    *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
                )
                active_processes.add(self.master_proc)

                async for decoded_line in read_lines_cr_lf(self.master_proc.stderr):
                    self.last_pipeline_output_time = time.time()

                    if not decoded_line.startswith("frame="):
                        last_stderr_line = decoded_line
                        self.pipeline_logger.info(decoded_line)

                    if "frame:" in decoded_line:
                        self.last_motion = time.time()

                        if not self.recording:
                            print(f"[🚨] Motion detected on {self.cam_id}! Capturing raw stream.")
                            self.recording = True
                            self.record_start_time = time.time()
                            self.current_output_file = self._get_unique_staging_filepath()

                            self.write_log_header(self.recording_logger, "STARTING RAW STREAM CAPTURE")

                            m3u8_path = f"{self.cam_dir}/stream.m3u8"
                            wait_time = 0.0
                            while not os.path.exists(m3u8_path) and wait_time < 10.0:
                                await asyncio.sleep(0.5)
                                wait_time += 0.5
                                self.last_pipeline_output_time = time.time()

                            if not os.path.exists(m3u8_path):
                                print(f"[⚠️] Aborting capture on {self.cam_id}: Master stream not ready.")
                                self.write_log_header(self.recording_logger, "ABORTED: m3u8 file was never created.")
                                self.recording = False
                                continue

                            record_cmd = [
                                "ffmpeg",
                                "-i", m3u8_path,
                                "-map", "0:v",
                                "-c:v", "copy",
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

                await self.master_proc.wait()
                if self.master_proc.returncode != 0:
                    print(f"[⚠️] FFmpeg for {self.cam_id} exited (code {self.master_proc.returncode}): {last_stderr_line}")

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

    async def cooldown_manager(self):
        """Manages recording cooldown, chunking, and isolated process termination."""
        while True:
            await asyncio.sleep(1)

            if self.recording:
                time_since_last_motion = time.time() - self.last_motion
                time_since_start = time.time() - self.record_start_time

                if time_since_last_motion >= COOLDOWN_PERIOD or time_since_start >= MAX_RECORD_TIME:

                    if time_since_start >= MAX_RECORD_TIME:
                        print(f"[⏱️] Max clip length reached on {self.cam_id}. Chunking file...")
                    else:
                        print(f"[⏱️] Motion stopped on {self.cam_id}. Finalizing capture...")

                    old_proc = self.record_proc
                    old_file = self.current_output_file
                    self.record_proc = None
                    self.recording = False

                    if old_proc:
                        asyncio.create_task(self.finalize_recording(old_proc, old_file))

    async def watchdog(self):
        """Monitors master and sub-stream FFmpeg health and restarts stalled pipelines."""
        stall_timeout = 30

        while True:
            await asyncio.sleep(15)

            now = time.time()
            is_master_stalled = (
                    self.master_proc is not None
                    and self.master_proc.returncode is None
                    and (now - self.last_pipeline_output_time) > stall_timeout
            )

            if is_master_stalled:
                print(f"[⚠️] Watchdog: Master process stalled for {self.cam_id}. Restarting...")
                self.write_log_header(self.pipeline_logger, "WATCHDOG TRIGGERED (MASTER STALLED) - RESTARTING")
                self.last_pipeline_output_time = now
                await safe_kill_process(self.master_proc)

            is_sub_stalled = (
                    self.sub_proc is not None
                    and self.sub_proc.returncode is None
                    and (now - self.last_sub_output_time) > stall_timeout
            )

            if is_sub_stalled:
                print(f"[⚠️] Watchdog: Sub-stream process stalled for {self.cam_id}. Restarting...")
                self.write_log_header(self.pipeline_logger, "WATCHDOG TRIGGERED (SUB STALLED) - RESTARTING")
                self.last_sub_output_time = now
                await safe_kill_process(self.sub_proc)

async def main():
    print("🚀 Initializing Engine...")
    tasks = []

    recover_stale_staging_files()

    tasks.append(asyncio.create_task(storage_manager()))
    tasks.append(asyncio.create_task(background_encoder_worker()))
    tasks.append(asyncio.create_task(asyncio.to_thread(update_history_manifest)))

    for cam_id, cam_config in CAMERAS.items():
        cam = CameraStream(cam_id, cam_config)

        tasks.extend([
            asyncio.create_task(cam.start_master_pipeline()),
            asyncio.create_task(cam.cooldown_manager()),
            asyncio.create_task(cam.watchdog())
        ])

        if cam.sub_rtsp_url:
            tasks.append(asyncio.create_task(cam.start_sub_pipeline()))

        if STAGGER_SPIN_UP_SECONDS > 0:
            await asyncio.sleep(STAGGER_SPIN_UP_SECONDS)

    await asyncio.gather(*tasks)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 Shutting down.")