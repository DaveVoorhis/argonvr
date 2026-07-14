import asyncio
import os
import time
import atexit
import sys
import json
import configparser

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

STORE_DIR = "./recordings"
COOLDOWN_PERIOD = 10
MAX_RECORD_TIME = 60  # Maximum length of a single clip in seconds
STAGGER_SPIN_UP_SECONDS = 0

# Automatically select the correct hardware encoder based on your platform
ENCODER = "h264_v4l2m2m" if sys.platform.startswith("linux") else "h264_videotoolbox"

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
        
class CameraStream:
    def __init__(self, cam_id, rtsp_url):
        self.cam_id = cam_id
        self.rtsp_url = rtsp_url
        self.cam_dir = f"{BASE_DIR}/{self.cam_id}"
        self.recording = False
        self.last_motion = 0
        self.record_start_time = 0
        self.current_output_file = ""
        self.record_proc = None
        self.master_proc = None
        
        os.makedirs(self.cam_dir, exist_ok=True)
        
        self.pipeline_log = open(os.path.join(self.cam_dir, "pipeline.log"), "a")
        self.recording_log = open(os.path.join(self.cam_dir, "recording.log"), "a")

    def write_log_header(self, log_fd, message):
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        log_fd.write(f"\n\n--- [{timestamp}] {message} ---\n")
        log_fd.flush()

    async def finalize_recording(self, proc, filepath):
        """Asynchronously finalizes an MP4 file without blocking the main event loop."""
        if proc and proc.returncode is None:
            try:
                # 1. Send 'q' to stdin for the most reliable graceful FFmpeg exit
                if proc.stdin:
                    proc.stdin.write(b'q\n')
                    await proc.stdin.drain()
                    proc.stdin.close() # Close stream to signal completion
                else:
                    proc.terminate()
                    
                # 2. Wait up to 60 seconds for FFmpeg to cleanly write the faststart moov atom
                await asyncio.wait_for(proc.wait(), timeout=60.0)
                print(f"[💾] Saved: {filepath}")
                
                update_history_manifest()
                
            except asyncio.TimeoutError:
                # 3. If it genuinely hangs, use a strict SIGKILL
                print(f"[⚠️] FFmpeg hung while saving {filepath}. Forcing SIGKILL.")
                self.write_log_header(self.recording_log, "RECORDING HUNG - FORCING KILL")
                proc.kill()
            except Exception as e: 
                print(f"[❌] Error closing {filepath}: {type(e).__name__} {e}")
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
                    print(f"[🚨] Motion detected on {self.cam_id}! Recording.")
                    self.recording = True
                    self.record_start_time = time.time()
                    
                    cam_record_dir = os.path.join(STORE_DIR, self.cam_id)
                    os.makedirs(cam_record_dir, exist_ok=True)
                    self.current_output_file = os.path.join(
                        cam_record_dir, 
                        f"{self.cam_id}_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
                    )
                    
                    self.write_log_header(self.recording_log, "STARTING DEDICATED RECORDING")
                    
                    m3u8_path = f"{self.cam_dir}/stream.m3u8"
                    wait_time = 0
                    while not os.path.exists(m3u8_path) and wait_time < 10:
                        await asyncio.sleep(0.5)
                        wait_time += 0.5
                        
                    if not os.path.exists(m3u8_path):
                        print(f"[⚠️] Aborting record on {self.cam_id}: Master stream not ready.")
                        self.write_log_header(self.recording_log, "ABORTED: m3u8 file was never created.")
                        self.recording = False
                        continue 
                    
                    record_cmd = [
                        "ffmpeg", 
                        "-i", m3u8_path, 
                        "-map", "0:v", "-c:v", ENCODER, "-an",
                        "-movflags", "faststart", 
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
                        print(f"[⏱️] Motion stopped on {self.cam_id}. Finalizing file...")
                        
                    # Detach the active process and release the recording lock instantly
                    old_proc = self.record_proc
                    old_file = self.current_output_file
                    self.record_proc = None
                    self.recording = False 
                    
                    # Spin off finalization to a background task to prevent blocking the event loop
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