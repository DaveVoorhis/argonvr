import asyncio
import os
import time
import atexit
import sys
import json
import configparser
import shutil

config = configparser.ConfigParser()
config.read('argonvr.cfg')

# Load Cameras
CAMERAS = [config['CAMERAS'][k] for k in config['CAMERAS']]

# Load Settings
SETTINGS = config['SETTINGS']

WEB_USER = SETTINGS.get('WEB_USER', 'admin')
WEB_PASS = SETTINGS.get('WEB_PASS', 'secret')
BASE_DIR = SETTINGS.get('BASE_DIR', './cameras')
MOTION_THRESHOLD = SETTINGS.get('MOTION_THRESHOLD', '0.01')

# --- Configurable Storage Options ---
STORE_DIR = SETTINGS.get('STORE_DIR', './recordings')
STORAGE_DEVICE = SETTINGS.get('STORAGE_DEVICE', '/')
MIN_FREE_SPACE_PCT = float(SETTINGS.get('MIN_FREE_SPACE_PCT', '15.0'))
ENCODER = SETTINGS.get('ENCODER', 'libx264')

COOLDOWN_PERIOD = 10
MAX_RECORD_TIME = 60  # Maximum length of a single clip in seconds
STAGGER_SPIN_UP_SECONDS = 0

os.makedirs(BASE_DIR, exist_ok=True)
os.makedirs(STORE_DIR, exist_ok=True)

# Global registry to track processes for cleanup
active_processes = []

def cleanup_processes():
    """Safety net: Kills all tracked FFmpeg processes on exit."""
    print("\n🛑 Cleaning up child processes...")
    for proc in active_processes:
        try:
            if proc.returncode is None:
                proc.terminate()
        except Exception:
            pass

atexit.register(cleanup_processes)

def update_history_manifest():
    """Scans the recordings directory and generates a JSON manifest for the UI."""
    manifest = {}
    if not os.path.exists(STORE_DIR):
        return

    for cam_id in os.listdir(STORE_DIR):
        cam_path = os.path.join(STORE_DIR, cam_id)
        if os.path.isdir(cam_path):
            files = []
            for f in os.listdir(cam_path):
                if f.endswith('.mp4'):
                    files.append({
                        "filename": f,
                        "url": f"./recordings/{cam_id}/{f}"
                    })
            files.sort(key=lambda x: x['filename'], reverse=True)
            manifest[cam_id] = files
            
    with open(os.path.join(STORE_DIR, 'history.json'), 'w') as f:
        json.dump(manifest, f)
        
def get_free_space_pct(path):
    try:
        total, used, free = shutil.disk_usage(path)
        return (free / total) * 100
    except Exception:
        return 100.0 # Fail safe if mount isn't readable

async def storage_manager():
    """Background loop that deletes oldest videos when disk is full."""
    while True:
        try:
            pct = get_free_space_pct(STORAGE_DEVICE)
            if pct < MIN_FREE_SPACE_PCT:
                print(f"[🧹] Low disk space ({pct:.1f}% < {MIN_FREE_SPACE_PCT}%). Purging oldest files...")
                
                all_files = []
                for root, _, files in os.walk(STORE_DIR):
                    for f in files:
                        if f.endswith('.mp4'):
                            all_files.append(os.path.join(root, f))
                
                # Sort by modification time so the oldest file is at index 0
                all_files.sort(key=os.path.getmtime)
                
                deleted_count = 0
                while all_files and get_free_space_pct(STORAGE_DEVICE) < MIN_FREE_SPACE_PCT:
                    target_file = all_files.pop(0)
                    try:
                        os.remove(target_file)
                        deleted_count += 1
                    except OSError:
                        pass
                        
                if deleted_count > 0:
                    print(f"[🧹] Purged {deleted_count} files. Updating history manifest.")
                    update_history_manifest()
        except Exception as e:
            print(f"[⚠️] Storage Manager error: {e}")
            
        await asyncio.sleep(60) # Check disk space every minute

def recover_stale_staging_files():
    """Moves orphaned .ts files from previous unclean shutdowns into the queue."""
    for cam_id in os.listdir(BASE_DIR):
        staging_dir = os.path.join(BASE_DIR, cam_id, 'staging')
        queued_dir = os.path.join(BASE_DIR, cam_id, 'queued')
        
        if os.path.exists(staging_dir) and os.path.exists(queued_dir):
            for f in os.listdir(staging_dir):
                if f.endswith('.ts'):
                    stale_file = os.path.join(staging_dir, f)
                    target_file = os.path.join(queued_dir, f)
                    shutil.move(stale_file, target_file)
                    print(f"[♻️] Recovered stale capture: {f}")

async def background_encoder_worker():
    """A background worker that sequentially encodes queued .ts files into .mp4."""
    worker_log = open(os.path.join(BASE_DIR, "encoder_worker.log"), "a")
    print("[⚙️] Background Encoder Worker started.")
    
    while True:
        task_found = False
        
        for cam_id in os.listdir(BASE_DIR):
            queued_dir = os.path.join(BASE_DIR, cam_id, 'queued')
            if not os.path.isdir(queued_dir):
                continue
                
            queued_files = [f for f in os.listdir(queued_dir) if f.endswith('.ts')]
            if queued_files:
                # Sort to encode the oldest first
                queued_files.sort(key=lambda x: os.path.getmtime(os.path.join(queued_dir, x)))
                raw_filename = queued_files[0]
                raw_filepath = os.path.join(queued_dir, raw_filename)
                
                base_name = os.path.splitext(raw_filename)[0]
                final_dir = os.path.join(STORE_DIR, cam_id)
                os.makedirs(final_dir, exist_ok=True)
                final_filepath = os.path.join(final_dir, f"{base_name}.mp4")
                
                print(f"[⚙️] Encoding queue item: {raw_filename} -> {final_filepath}")
                timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
                worker_log.write(f"\n--- [{timestamp}] ENCODING {raw_filepath} ---\n")
                worker_log.flush()
                
                encode_cmd = [
                    "ffmpeg", 
                    "-i", raw_filepath, 
                    "-c:v", ENCODER, 
                    "-preset", "ultrafast", 
                    "-an",
                    "-movflags", "faststart", 
                    "-y", final_filepath
                ]
                
                proc = await asyncio.create_subprocess_exec(
                    *encode_cmd, 
                    stdin=asyncio.subprocess.PIPE, 
                    stdout=asyncio.subprocess.DEVNULL, 
                    stderr=worker_log
                )
                active_processes.append(proc)
                await proc.wait()
                active_processes.remove(proc)
                
                if proc.returncode == 0:
                    print(f"[✅] Successfully encoded and stored: {final_filepath}")
                    os.remove(raw_filepath)
                    update_history_manifest()
                else:
                    print(f"[❌] Error encoding {raw_filename}. See encoder_worker.log")
                    os.rename(raw_filepath, raw_filepath + ".failed")
                
                task_found = True
                break # Break out of the directory loop to evaluate the global queue again
                
        if not task_found:
            await asyncio.sleep(5) # No tasks, rest the CPU

class CameraStream:
    def __init__(self, cam_id, rtsp_url):
        self.cam_id = cam_id
        self.rtsp_url = rtsp_url
        self.cam_dir = f"{BASE_DIR}/{self.cam_id}"
        
        # New Staging and Queued directories
        self.staging_dir = os.path.join(self.cam_dir, "staging")
        self.queued_dir = os.path.join(self.cam_dir, "queued")
        
        self.recording = False
        self.last_motion = 0
        self.record_start_time = 0
        self.current_output_file = ""
        self.record_proc = None
        self.master_proc = None
        
        os.makedirs(self.cam_dir, exist_ok=True)
        os.makedirs(self.staging_dir, exist_ok=True)
        os.makedirs(self.queued_dir, exist_ok=True)
        
        self.pipeline_log = open(os.path.join(self.cam_dir, "pipeline.log"), "a")
        self.recording_log = open(os.path.join(self.cam_dir, "recording.log"), "a")

    def write_log_header(self, log_fd, message):
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        log_fd.write(f"\n\n--- [{timestamp}] {message} ---\n")
        log_fd.flush()

    async def finalize_recording(self, proc, filepath):
        """Finalizes the raw capture file and moves it to the encoding queue."""
        if proc and proc.returncode is None:
            try:
                if proc.stdin:
                    proc.stdin.write(b'q\n')
                    await proc.stdin.drain()
                    proc.stdin.close()
                else:
                    proc.terminate()
                    
                await asyncio.wait_for(proc.wait(), timeout=10.0)
                
                # Move to queued directory for the background worker
                filename = os.path.basename(filepath)
                queued_filepath = os.path.join(self.queued_dir, filename)
                shutil.move(filepath, queued_filepath)
                
                print(f"[📥] Raw capture complete. Queued for encoding: {queued_filepath}")
                
            except asyncio.TimeoutError:
                print(f"[⚠️] FFmpeg hung while capturing {filepath}. Forcing SIGKILL.")
                self.write_log_header(self.recording_log, "CAPTURE HUNG - FORCING KILL")
                proc.kill()
            except Exception as e: 
                print(f"[❌] Error closing capture {filepath}: {type(e).__name__} {e}")
                proc.kill()

    async def start_master_pipeline(self):
        """Pulls a single RTSP stream and splits it internally for HLS and Motion."""
        await asyncio.sleep(2) 
        
        self.write_log_header(self.pipeline_log, "STARTING UNIFIED MASTER PIPELINE (HLS + MOTION)")
        
        cmd = [
            "ffmpeg", "-rtsp_transport", "tcp", "-i", self.rtsp_url,
            
            "-map", "0:v", "-c:v", "copy", "-an",
            "-f", "hls", "-hls_time", "2", "-hls_list_size", "10",
            "-hls_flags", "delete_segments", 
            "-strftime", "1", 
            "-hls_segment_filename", f"{self.cam_dir}/stream_%Y%m%d_%H%M%S.ts", 
            f"{self.cam_dir}/stream.m3u8",
            
            "-map", "0:v", "-vf", f"fps=2,scale=320:-1,select='gt(scene,{MOTION_THRESHOLD})',metadata=mode=print",
            "-f", "null", "-"
        ]
                
        self.master_proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
        )
        active_processes.append(self.master_proc)

        while True:
            chunk = await self.master_proc.stderr.read(1024)
            if not chunk: break
            
            self.pipeline_log.write(chunk.decode('utf-8', errors='ignore'))
            self.pipeline_log.flush()
            
            if b"frame:" in chunk:
                self.last_motion = time.time()
                
                if not self.recording:
                    print(f"[🚨] Motion detected on {self.cam_id}! Capturing raw stream.")
                    self.recording = True
                    self.record_start_time = time.time()
                    
                    # Target the staging directory, not STORE_DIR
                    self.current_output_file = os.path.join(
                        self.staging_dir, 
                        f"{self.cam_id}_{time.strftime('%Y%m%d_%H%M%S')}.ts"
                    )
                    
                    self.write_log_header(self.recording_log, "STARTING RAW STREAM CAPTURE")
                    
                    m3u8_path = f"{self.cam_dir}/stream.m3u8"
                    wait_time = 0
                    while not os.path.exists(m3u8_path) and wait_time < 10:
                        await asyncio.sleep(0.5)
                        wait_time += 0.5
                        
                    if not os.path.exists(m3u8_path):
                        print(f"[⚠️] Aborting capture on {self.cam_id}: Master stream not ready.")
                        self.write_log_header(self.recording_log, "ABORTED: m3u8 file was never created.")
                        self.recording = False
                        continue 
                    
                    # Direct Stream Copy: Negligible CPU footprint
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
                        stderr=self.recording_log 
                    )
                    active_processes.append(self.record_proc)
                    
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
        """Monitors FFmpeg health and restarts pipelines if they hang."""
        while True:
            await asyncio.sleep(30)
            if self.master_proc and self.master_proc.returncode is not None:
                print(f"[⚠️] Watchdog: Master process died for {self.cam_id}. Restarting...")
                self.write_log_header(self.pipeline_log, "WATCHDOG TRIGGERED - CLEANING UP AND RESTARTING")
                
                for proc in [self.master_proc, self.record_proc]:
                    if proc and proc.returncode is None:
                        try:
                            proc.terminate()
                        except ProcessLookupError:
                            pass
                
                self.master_proc = None
                self.record_proc = None
                self.recording = False
                
                asyncio.create_task(self.start_master_pipeline())

async def main():
    print("🚀 Initializing Engine...")
    tasks = []
    
    # 1. Recover any orphaned .ts files from previous unclean shutdowns
    recover_stale_staging_files()
    
    # 2. Start the background storage manager
    tasks.append(asyncio.create_task(storage_manager()))
    
    # 3. Start the singular background encoding queue worker
    tasks.append(asyncio.create_task(background_encoder_worker()))
    
    update_history_manifest()
    
    for index, url in enumerate(CAMERAS):
        cam = CameraStream(f"cam{index + 1}", url)
        
        tasks.extend([
            asyncio.create_task(cam.start_master_pipeline()), 
            asyncio.create_task(cam.cooldown_manager()), 
            asyncio.create_task(cam.watchdog())
        ])
        
        await asyncio.sleep(STAGGER_SPIN_UP_SECONDS)
        
    await asyncio.gather(*tasks)

if __name__ == "__main__":
    try: 
        asyncio.run(main())
    except KeyboardInterrupt: 
        print("\n🛑 Shutting down.")