# ArgoNVR

ArgoNVR is a lightweight, self-hosted Network Video Recorder (NVR) designed for low-power hardware such as a Raspberry Pi 5 as well as macOS and Linux systems. It ingests RTSP camera streams with minimal CPU overhead, performs real-time motion detection, and serves a responsive Progressive Web App (PWA) with instant sprite-based timeline scrubbing and dynamic bandwidth adaptation.

## Features

### Backend Engine (`argonvr.py`)
* **Zero-Transcode HLS & Recording (`-c:v copy`):** Remuxes incoming RTSP video directly into live HLS segments and captures motion clips without re-encoding video, keeping CPU usage minimal.
* **Dual-Stream Architecture (`url` + `sub_url`):** Supports an optional low-resolution RTSP `sub_url` per camera. When configured, the high-resolution master pipeline runs purely with `-c:v copy` (zero video decoding), while the sub-stream pipeline generates `stream_sub.m3u8` and drives both motion detection and live JPEG snapshots (`live.jpg`).
* **Smart Motion Detection & Chunking:** Evaluates scene changes at 2 FPS (`scale=320:-2`) against a per-camera threshold, automatically managing post-motion cooldowns (`COOLDOWN_PERIOD`) and maximum clip lengths (`MAX_RECORD_TIME`).
* **Crash-Safe Staging & Background Packaging:** Motion captures write raw `.ts` streams to a `staging/` directory, move to `queued/` upon completion, and are automatically recovered on startup after an unclean shutdown. A background worker sequentially packages queued clips into VOD HLS playlists (`.m3u8` + 2-second `.ts` segments).
* **Fast Keyframe Sprite Sheets & WebVTT:** Uses `ffprobe` packet inspection and `ffmpeg -skip_frame nokey` to extract I-frames without decoding P/B frames, tiling them into a single `.jpg` sprite sheet paired with a `.vtt` coordinate map for instant visual timeline scrubbing.
* **Automated Disk Space Management:** Monitors the target storage mount (`STORAGE_DEVICE`) every 60 seconds and automatically purges the oldest recordings and segments whenever free space drops below `MIN_FREE_SPACE_PCT`, updating the affected daily `history_YYYYMMDD.json` manifests.
* **Self-Healing Process Watchdogs & Rotating Logs:** Independent per-camera watchdogs monitor both master and sub-stream FFmpeg pipelines and restart stalled streams after 30 seconds of inactivity. Logs (`pipeline.log`, `recording.log`, `encoder_worker.log`) rotate daily at midnight with automatic `.gz` compression and configurable retention (`LOG_DAYS_TO_KEEP`).

### Web Server (`server.py`) & Frontend (`web/`)
* **Responsive SPA & Installable PWA:** Single-Page Application with a web manifest and service worker (`sw.js`) that switches seamlessly between the multi-camera dashboard grid and single-camera view without page reloads.
* **Dynamic Network Speed & Latency Monitor:** Continuously measures round-trip latency (`/health` probes), HLS segment download throughput, and buffer stalls to classify connections into `HIGH`, `MEDIUM`, or `LOW` tiers (with a clickable toolbar badge to cycle between `AUTO`, `LOCK:LOW`, and `LOCK:HIGH`):
  * **High Tier:** Streams live HD HLS (`stream.m3u8`) and prefetches timeline sprites aggressively.
  * **Medium Tier:** Automatically utilizes SD sub-streams (`stream_sub.m3u8`) on multi-camera grids or mobile viewports and switches to ETag-polled live snapshots (`live.jpg`) on larger grids.
  * **Low Tier:** Switches the dashboard grid to low-bandwidth `live.jpg` snapshot polling, uses SD sub-streams in single-camera live view, and restricts background sprite prefetching to the immediate playhead window.
* **Multi-Camera Dashboard Timeline:** Features an auto-scaling camera grid, a zoomable 24-hour timeline (1x to 144x) with a color-coded per-camera motion heatmap, synchronized multi-camera canvas sprite scrubbing, historical playback, and an interactive calendar highlighting dates with recorded events.
* **Single-Camera Event Scrubber:** Compacts recorded clips into a continuous activity bar so you can sweep directly across motion events without dead air, complete with selectable time windows (`1 Hour` to `Full Day` or custom `Start`/`End` sliders) and live `SD`/`HD` stream indicators.
* **Threaded HTTP/1.1 Server with TLS & Caching:** Supports native HTTPS (`SSL_CERT_PATH` / `SSL_KEY_PATH`), timing-safe HTTP Basic Authentication (`hmac.compare_digest`), directory traversal protection, in-memory manifest caching, ETag/304 conditional responses, on-the-fly Gzip compression, and a remote system reboot control.

## Requirements

* **Python 3.8+**: Required for the backend engine, calibration utility, and web server.
  * **Python Packages:** `PyYAML` (`pip install pyyaml`) and optionally `sdnotify` (`pip install sdnotify`) for systemd readiness notifications.
* **FFmpeg & FFprobe**: Must be installed and available in your system `PATH` for RTSP ingestion, motion detection, VOD packaging, and sprite generation.
* **OS**: Developed and tested on macOS and Linux (including Raspberry Pi 5 / Debian-based systems).

## Configuration (`argonvr.yaml`)

1. **Create your configuration file:**
   ```bash
   cp argonvr.yaml.example argonvr.yaml
   ```
   *(Or edit `argonvr.yaml` directly if already present.)*

2. **Configure cameras and settings:**

   ```yaml
   CAMERAS:
       cam1:
           url: "rtsp://user:password@192.168.1.11:554/stream"
           sub_url: "rtsp://user:password@192.168.1.11:554/stream_sub"
           motion_threshold: 0.001
       cam2:
           url: "rtsp://user:password@192.168.1.12:554/stream"
           motion_threshold: 0.001

   SETTINGS:
       WEB_USER: "admin"
       WEB_PASS: "ChangeMe123!"
       WEB_DIR: "./web"
       BASE_DIR: "./cameras"
       STORE_DIR: "./recordings"
       STORAGE_DEVICE: "/"
       MIN_FREE_SPACE_PCT: 15.0
       PORT: 8000
       SSL_CERT_PATH: ""
       SSL_KEY_PATH: ""
       LOG_HTTP_REQUESTS: false
       SPRITE_WIDTH: 320
       SPRITE_HEIGHT: 180
       SPRITE_QUALITY: 5
       LIVE_SNAPSHOT_FPS: 1.0
       LIVE_SNAPSHOT_QUALITY: 6
       COOLDOWN_PERIOD: 10
       MAX_RECORD_TIME: 60
       STAGGER_SPIN_UP_SECONDS: 0
       LOG_DAYS_TO_KEEP: 30
   ```

### Configuration Reference

| Key | Default | Description |
| :--- | :--- | :--- |
| `CAMERAS.<id>.url` | *(Required)* | Primary (high-resolution) RTSP stream URL used for HD live view and motion recordings. |
| `CAMERAS.<id>.sub_url` | *(Optional)* | Secondary (low-resolution) RTSP sub-stream URL used for SD live view, motion detection, and `live.jpg` snapshots. |
| `CAMERAS.<id>.motion_threshold` | `0.01` | FFmpeg scene-change score threshold required to trigger recording. |
| `WEB_USER` / `WEB_PASS` | `admin` / `secret` | HTTP Basic Authentication credentials for the web interface and API. |
| `WEB_DIR` | `./web` | Directory containing the static frontend assets (`index.html`, `script.js`, `camera.js`, `style.css`). |
| `BASE_DIR` | `./cameras` | Directory for active live HLS playlists, rolling `.ts` segments, and `live.jpg` snapshots (ideal for a RAM disk / `tmpfs`). |
| `STORE_DIR` | `./recordings` | Persistent directory for recorded VOD clips, sprites, WebVTT files, daily JSON manifests, and logs. |
| `STORAGE_DEVICE` | `/` | Filesystem path monitored by the storage manager for free disk space. |
| `MIN_FREE_SPACE_PCT` | `15.0` | Minimum free disk space percentage before the oldest recordings are automatically purged. |
| `PORT` | `8000` | TCP port for the HTTP/HTTPS web server. |
| `SSL_CERT_PATH` / `SSL_KEY_PATH` | `""` | Paths to PEM certificate and private key files to enable HTTPS. Leave blank for HTTP. |
| `LOG_HTTP_REQUESTS` | `false` | When `false`, suppresses routine media/polling requests (`.ts`, `.m3u8`, `.jpg`, `.vtt`, `.json`, `/health`) from console logs. |
| `SPRITE_WIDTH` / `SPRITE_HEIGHT` | `320` / `180` | Resolution of each individual keyframe tile in generated timeline sprite sheets. |
| `SPRITE_QUALITY` | `3` (`5` in sample) | FFmpeg JPEG quality scale (`2` = best quality, `31` = highest compression) for timeline sprite sheets. |
| `LIVE_SNAPSHOT_FPS` | `1.0` | Frame rate for updating `live.jpg` snapshots used by low-bandwidth dashboard mode. |
| `LIVE_SNAPSHOT_QUALITY` | `6` | FFmpeg JPEG quality scale (`2`–`31`) for `live.jpg` snapshots. |
| `COOLDOWN_PERIOD` | `10` | Seconds of no motion required before finalizing an active recording. |
| `MAX_RECORD_TIME` | `60` | Maximum duration (in seconds) of a single recording clip before chunking into a new file. |
| `STAGGER_SPIN_UP_SECONDS` | `0` | Delay (in seconds) between starting each camera's pipelines on initial engine boot. |
| `LOG_DAYS_TO_KEEP` | `30` | Number of days to retain daily compressed (`.gz`) log files. |

## Motion Threshold Calibration (`calibrate.py`)

ArgoNVR includes an interactive CLI calibration tool that connects to your camera's motion source (`sub_url` if configured, otherwise `url`) and displays FFmpeg's real-time scene score so you can dial in each camera's threshold.

1. **Run the calibration script:**
   ```bash
   python3 calibrate.py
   ```
2. **Select a camera:** Choose the camera number from the list (which displays the current threshold and active motion source stream).
3. **Observe baseline noise:** Watch the live score for a few moments to gauge ambient motion (wind, foliage, sensor noise).
4. **Trigger motion:** Walk in front of the camera and watch the ASCII bar and `Peak` score spike, along with the `🚨 TRIGGER` indicator.
5. **Save the new threshold:** Press `Ctrl+C` to stop. Enter a threshold safely above ambient noise but below your peak motion score. The script automatically backs up `argonvr.yaml` to `argonvr.yaml.bak` and writes the updated value.

## Running the System (Manual Start)

1. **Start the server and engine:**
   ```bash
   ./launch.sh
   ```
   `launch.sh` automatically detects a local virtual environment (`./.venv` or `./venv`) if present, starts `server.py` in the background, verifies that it initialized cleanly, and launches `argonvr.py` with signal traps to shut down both processes cleanly on `Ctrl+C`.

2. **Access the Dashboard:**
   Open your browser to `http://localhost:8000` (or `https://localhost:8000` if SSL is configured) and log in with the `WEB_USER` and `WEB_PASS` defined in `argonvr.yaml`.

## Running as a Background Service (Systemd)

To start ArgoNVR automatically on boot under Linux:

1. **Edit the Service File:**
   Open `argonvr.service` and verify that `User`, `WorkingDirectory`, and `ExecStart` match your installation path. *(Note: Using ` the `⚠️ Reboot` button in the web UI requires the service user to have passwordless `sudo reboot` privileges or run as `root`.)*

2. **Install the Service:**
   ```bash
   sudo cp argonvr.service /etc/systemd/system/
   ```

3. **Enable and Start:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable argonvr
   sudo systemctl start argonvr
   ```

4. **Managing the Service:**
   * **Stop the service:** `sudo systemctl stop argonvr`
   * **Restart the service:** `sudo systemctl restart argonvr`
   * **View live logs:** `sudo journalctl -fu argonvr`

## Directory Structure

* `web/`: Frontend Single-Page Application (`index.html`, `script.js`, `camera.js`, `style.css`, PWA manifest, and service worker).
* `cameras/` (`BASE_DIR`): Ephemeral live stream workspace per camera containing `stream.m3u8`, optional `stream_sub.m3u8`, rolling `.ts` segments, and `live.jpg`.
* `recordings/` (`STORE_DIR`): Persistent storage containing `encoder_worker.log` and per-camera subdirectories:
  * `<cam_id>/staging/`: Active in-progress raw `.ts` motion captures.
  * `<cam_id>/queued/`: Completed raw `.ts` captures awaiting VOD packaging.
  * `<cam_id>/`: Packaged VOD HLS playlists (`.m3u8`), segments (`_000.ts`), sprite sheets (`.jpg`), WebVTT maps (`.vtt`), daily manifests (`history_YYYYMMDD.json`), and rotating logs (`pipeline.log`, `recording.log`).

---

*This project is designed for local home networks and requires basic knowledge of RTSP streams.*

---

This project is an experiment in using Google Gemini to generate
useful code when prompted by an experienced developer. The only
directly human-written content is this final section of this README.md
and the TODO.md and CHANGES.md files, plus occasional minor tweaks
like changing a comment to be more accurate, or the config values.

Everything else is Gemini output in response to my prompts.

As such, the code may be flawed and comments and directions
incorrect!