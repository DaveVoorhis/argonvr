# ArgoNVR

ArgoNVR is a lightweight, self-hosted Network Video Recorder (NVR) designed for low-power hardware such as a Raspberry Pi 5 as well as macOS and Linux systems. It ingests RTSP camera streams with minimal CPU overhead, performs real-time motion detection, and serves a responsive, offline-capable Progressive Web App (PWA) with instant sprite-based timeline scrubbing, MP4 clip export, and dynamic bandwidth adaptation.

## Features

### Backend Engine (`argonvr.py`)

* **Zero-Transcode HLS & Recording (`-c:v copy`):** Remuxes incoming RTSP video directly into epoch-numbered live HLS segments (`-hls_start_number_source epoch`, `discont_start`) and captures motion clips without re-encoding video, keeping CPU usage minimal.

* **Dual-Stream Architecture (`url` + `sub_url`):** Supports an optional low-resolution RTSP `sub_url` per camera. When configured, the high-resolution master pipeline runs purely with `-c:v copy` (zero video decoding), while the sub-stream pipeline generates `stream_sub.m3u8` and drives motion detection (and optional continuous `live.jpg` snapshots if `CONTINUOUS_LIVE_SNAPSHOTS` is enabled).

* **On-Demand Live Snapshots (Default):** Continuous FFmpeg JPEG snapshot encoding is disabled by default (`CONTINUOUS_LIVE_SNAPSHOTS: false`) to eliminate idle CPU and storage overhead. Instead, `server.py` extracts `live.jpg` on demand from the newest live HLS segment (preferring `stream_sub.m3u8`) and caches it in RAM. Legacy continuous snapshot generation can be re-enabled via `CONTINUOUS_LIVE_SNAPSHOTS: true`.

* **Sunlight-Resilient Motion Detection & Chunking:** Evaluates motion at 2 FPS (`scale=320:-2`) using grayscale conversion, a 3x3 spatial box blur (`avgblur`), temporal frame differencing (`tblend`), and a per-pixel luminance deadband LUT (`pixel_diff_threshold`) to ignore gradual sunlight drift, cloud shadows, and Auto-White-Balance shifts. Combines bounded scene scoring (`motion_threshold` to `motion_max_threshold`) with a multi-frame confirmation window (`motion_confirm_frames` within `motion_confirm_window`) to reject full-frame IR/exposure flips and single-frame camera Auto-Exposure steps. Motion triggers start recordings asynchronously so RTSP stderr draining is never blocked, automatically managing post-motion cooldowns (`COOLDOWN_PERIOD`) and maximum clip lengths (`MAX_RECORD_TIME`), with chunk continuations starting from the live edge (`-live_start_index -1`) to avoid duplicate pre-roll overlap.

* **Crash-Safe Staging, Fair Packaging & Daily Partitioning:** Motion captures write raw `.ts` streams to a `staging/` directory, move to `queued/` upon completion, and are automatically recovered on startup after an unclean shutdown. A background worker fairly selects the globally oldest queued clip across all cameras (preventing high-activity cameras from starving quieter ones) and packages it into VOD HLS playlists (`.m3u8` + 4-second `.ts` segments with monotonic PTS/DTS enforcement and sidecar `.json` metadata) partitioned into per-day subdirectories (`<STORE_DIR>/<cam_id>/<YYYYMMDD>/`, with full backward compatibility for legacy flat clips). Configurable timeouts (`ENCODER_TIMEOUT_SECONDS`) ensure corrupted captures cannot stall the worker.

* **GPU-Safe Keyframe Sprite Sheets & WebVTT:** Uses `ffprobe` packet inspection and `ffmpeg -skip_frame nokey` to extract I-frames without decoding P/B frames, automatically striding keyframes to stay within `MAX_SPRITE_TILES` (default `60`) so sprite textures remain within mobile GPU texture limits. Tiles are packed into a single `.jpg` sprite sheet paired with an atomically written `.vtt` coordinate map generated off the event loop, protected by `PROBE_TIMEOUT_SECONDS` and `SPRITE_TIMEOUT_SECONDS`.

* **Automated Disk Space Management:** Runs off the asyncio event loop every 60 seconds to monitor the target storage mount (`STORAGE_DEVICE`). When free space drops below `MIN_FREE_SPACE_PCT`, it reclaims space in priority order: `.failed` queue artifacts first, then unreferenced orphaned `.ts` segments older than `ORPHAN_TS_GRACE_SECONDS`, and finally the oldest packaged clips (deleting referenced segments from each `.m3u8`, pruning empty `<YYYYMMDD>` directories, and updating the affected daily `history_YYYYMMDD.json` manifests). Failed queue files older than 24 hours are also pruned periodically.

* **Self-Healing Process Watchdogs, Async Logging & Graceful Shutdown:** Independent per-camera watchdogs monitor both FFmpeg stderr activity and live HLS playlist (`stream.m3u8` / `stream_sub.m3u8`) modification times, restarting stalled pipelines after 30 seconds with exponential backoff (up to 30 seconds). FFmpeg RTSP socket I/O timeouts (`RTSP_IO_TIMEOUT_SECONDS`) are auto-detected (`-timeout` on FFmpeg 5+, `-stimeout` on FFmpeg 4.x) so dead streams fail fast. Logs (`pipeline.log`, `recording.log`, `encoder_worker.log`) are written and midnight-rotated with `.gz` compression on a dedicated background thread (`LOG_DAYS_TO_KEEP`). On `SIGTERM`/`SIGINT`, the engine gracefully finalizes active recordings into `queued/`, reaps child FFmpeg processes, flushes logs, and supports native systemd `sdnotify` (`READY=1` / `WATCHDOG=1`) heartbeats.

### Web Server (`server.py`, `watchdog.py`) & Frontend (`web/`)

* **Offline-Capable Responsive SPA & Installable PWA:** Single-Page Application with a bundled local copy of `hls.js` (`web/hls.min.js`, requiring no external CDN for air-gapped LAN use), a web manifest, and a Network-First service worker (`web/sw.js`) that caches the app shell on fetch while bypassing interception for live/recorded media and dynamic API routes. Dynamically discovers arbitrary configured camera IDs from `argonvr.yaml` via `/cameracount` and staggers dashboard stream startups.

* **Dynamic Network Speed & Latency Monitor:** Continuously measures round-trip latency (`/health` probes), HLS segment download throughput, and buffer stalls to classify connections into `HIGH`, `MEDIUM`, or `LOW` tiers (with a clickable toolbar badge to cycle between `AUTO`, `LOCK:LOW`, and `LOCK:HIGH`):

  * **High Tier:** Streams live HD HLS (`stream.m3u8`) and prefetches timeline sprites aggressively within a bounded memory budget.

  * **Medium Tier:** Automatically utilizes SD sub-streams (`stream_sub.m3u8`) on multi-camera grids or mobile viewports and switches to ETag-polled live snapshots (`live.jpg`) on larger grids.

  * **Low Tier:** Switches the dashboard grid to low-bandwidth on-demand `live.jpg` snapshot polling, uses SD sub-streams in single-camera live view, and restricts background sprite prefetching to the immediate playhead window.

* **Multi-Camera Dashboard Timeline:** Features an auto-scaling camera grid, a zoomable 24-hour timeline (1x to 144x) with a color-coded per-camera motion heatmap, binary-search clip lookup, synchronized multi-camera canvas sprite scrubbing, historical playback, bounded sprite/VTT cache eviction to prevent mobile OOM, ETag/abort-guarded `/history` polling, and an interactive calendar highlighting dates with recorded events.

* **Single-Camera Event Scrubber & Video Export (`videos.js`):** Compacts recorded clips into a continuous activity bar so you can sweep directly across motion events without dead air, complete with selectable time windows (`1 Hour` to `Full Day` or custom `Start`/`End` sliders), live `SD`/`HD` stream indicators, bounded HLS fatal-error recovery, and a live playback watchdog. Supports exporting selected time windows as stream-copied MP4 videos (`-c:v copy -an`) with background job status tracking (`/api/video/status`), clip markers, playback, download, and deletion in the built-in Videos view. Switching between Dashboard, Single-Camera, and Videos views fully tears down unused HLS players to free MSE buffers and hardware decoders.

* **Bounded Thread-Pool HTTP/1.1 Server (`PooledHTTPServer`) with TLS & Caching:** Uses a bounded `ThreadPoolExecutor` (64 workers, 128 max in-flight with load shedding and load-aware `Connection: close`), per-worker TLS handshakes (`SSL_CERT_PATH` / `SSL_KEY_PATH`), timing-safe HTTP Basic Authentication (`hmac.compare_digest`), directory traversal protection, full `HEAD` and strict HTTP `Range`/`416` support, 2 MB JSON request body limits, bounded LRU caches for history manifests (with pre-gzipped ETag-validated responses) and video sidecars, on-demand RAM-cached `live.jpg` extraction with single-flight locking, startup cleanup of orphaned temporary video export files, graceful `SIGTERM`/`SIGINT` shutdown, a companion `/health` watchdog (`watchdog.py`), and a remote system reboot control.

## Requirements

* **Python 3.8+**: Required for the backend engine, calibration utility, watchdog, and web server.

  * **Python Packages:** `PyYAML` (`pip install pyyaml`) and optionally `sdnotify` (`pip install sdnotify`) for systemd readiness and watchdog heartbeats.

* **FFmpeg & FFprobe**: Must be installed and available in your system `PATH` for RTSP ingestion, motion detection, VOD packaging, sprite generation, on-demand snapshots, and MP4 export.

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
           # Optional per-camera motion tuning (overrides global defaults in SETTINGS):
           # motion_max_threshold: 0.50
           # pixel_diff_threshold: 24
           # motion_confirm_frames: 2
           # motion_confirm_window: 2.0
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
       MOTION_THRESHOLD: 0.01
       MOTION_MAX_THRESHOLD: 0.50
       PIXEL_DIFF_THRESHOLD: 24
       MOTION_CONFIRM_FRAMES: 2
       MOTION_CONFIRM_WINDOW: 2.0
   ```

### Configuration Reference

| Key | Default | Description |
| :--- | :--- | :--- |
| `CAMERAS.<id>.url` | *(Required)* | Primary (high-resolution) RTSP stream URL used for HD live view and motion recordings. Any valid camera key name is supported. |
| `CAMERAS.<id>.sub_url` | *(Optional)* | Secondary (low-resolution) RTSP sub-stream URL used for SD live view, motion detection, and preferred source for `live.jpg` snapshots. |
| `CAMERAS.<id>.motion_threshold` | `MOTION_THRESHOLD` (`0.01`) | Minimum fraction of the frame (`0.0`–`1.0`) that must exceed `pixel_diff_threshold` to count as motion. |
| `CAMERAS.<id>.motion_max_threshold` | `MOTION_MAX_THRESHOLD` (`0.50`) | Maximum fraction of the frame (`0.0`–`1.0`) before rejecting the frame as a global exposure or IR cut-filter flip. |
| `CAMERAS.<id>.pixel_diff_threshold` | `PIXEL_DIFF_THRESHOLD` (`24`) | Per-pixel luminance change (`0`–`255`) required between consecutive `0.5s` frames to ignore slow sunlight drift. |
| `CAMERAS.<id>.motion_confirm_frames` | `MOTION_CONFIRM_FRAMES` (`2`) | Number of motion frames required within `motion_confirm_window` to initiate a new recording. |
| `CAMERAS.<id>.motion_confirm_window` | `MOTION_CONFIRM_WINDOW` (`2.0`) | Time window (in seconds) within which `motion_confirm_frames` must occur to filter out single-frame AE steps. |
| `WEB_USER` / `WEB_PASS` | `admin` / `secret` | HTTP Basic Authentication credentials for the web interface and API. |
| `WEB_DIR` | `./web` | Directory containing the static frontend assets (`index.html`, `script.js`, `camera.js`, `videos.js`, `hls.min.js`, `style.css`, `sw.js`). |
| `BASE_DIR` | `./cameras` | Directory for active live HLS playlists, rolling `.ts` segments, and optional continuous `live.jpg` snapshots (ideal for a RAM disk / `tmpfs`). |
| `STORE_DIR` | `./recordings` | Persistent directory for recorded VOD clips (partitioned by `<YYYYMMDD>`), sprites, WebVTT files, daily JSON manifests, and logs. |
| `VIDEO_DIR` | `<STORE_DIR>/videos` | Persistent directory for exported MP4 videos and their sidecar `.json` metadata files. |
| `STORAGE_DEVICE` | `/` | Filesystem path monitored by the storage manager for free disk space. |
| `MIN_FREE_SPACE_PCT` | `15.0` | Minimum free disk space percentage before failed artifacts, orphaned segments, and the oldest recordings are automatically purged. |
| `ORPHAN_TS_GRACE_SECONDS` | `600` *(min `300`)* | Minimum age (in seconds) before unreferenced `.ts` segments in recording directories are eligible for cleanup during low-space purging. |
| `PORT` | `8000` | TCP port for the HTTP/HTTPS web server. |
| `SSL_CERT_PATH` / `SSL_KEY_PATH` | `""` | Paths to PEM certificate and private key files to enable HTTPS. Leave blank for HTTP. |
| `LOG_HTTP_REQUESTS` | `false` | When `false`, suppresses routine media/polling requests (`.ts`, `.m3u8`, `.jpg`, `.vtt`, `.json`, `/health`) from console logs. |
| `SPRITE_WIDTH` / `SPRITE_HEIGHT` | `320` / `180` | Resolution of each individual keyframe tile in generated timeline sprite sheets. |
| `SPRITE_QUALITY` | `3` (`5` in sample) | FFmpeg JPEG quality scale (`2` = best quality, `31` = highest compression) for timeline sprite sheets. |
| `MAX_SPRITE_TILES` | `60` *(min `5`)* | Maximum number of keyframe tiles per sprite sheet (keyframes are automatically strided to stay within mobile GPU texture limits). |
| `CONTINUOUS_LIVE_SNAPSHOTS` | `false` | When `false`, `server.py` extracts `live.jpg` on demand from the newest live HLS segment and caches it in RAM. Set `true` to continuously write `live.jpg` from `argonvr.py`. |
| `LIVE_SNAPSHOT_FPS` | `1.0` | Refresh rate for `live.jpg` snapshots: sets the RAM cache TTL (`1 / fps`, clamped to `0.5s`–`5.0s`) in on-demand mode, or FFmpeg output FPS when `CONTINUOUS_LIVE_SNAPSHOTS` is `true`. |
| `LIVE_SNAPSHOT_QUALITY` | `6` | FFmpeg JPEG quality scale (`2`–`31`) for `live.jpg` snapshots. |
| `LIVE_SNAPSHOT_WIDTH` | `320` *(min `160`)* | Target width in pixels (aspect ratio preserved) for on-demand `live.jpg` snapshots generated by `server.py`. |
| `COOLDOWN_PERIOD` | `10` | Seconds of no motion required before finalizing an active recording. |
| `MAX_RECORD_TIME` | `60` | Maximum duration (in seconds) of a single recording clip before chunking into a new file. |
| `STAGGER_SPIN_UP_SECONDS` | `0` | Delay (in seconds) between starting each camera's pipelines on initial engine boot. |
| `LOG_DAYS_TO_KEEP` | `30` | Number of days to retain daily compressed (`.gz`) log files. |
| `RTSP_IO_TIMEOUT_SECONDS` | `10` | Socket I/O timeout (in seconds) passed to FFmpeg (`-timeout` or `-stimeout`, auto-detected) for RTSP streams and `calibrate.py`. Set `0` to disable. |
| `ENCODER_TIMEOUT_SECONDS` | `300` | Maximum seconds allowed for the background VOD packager FFmpeg subprocess before terminating it. |
| `PROBE_TIMEOUT_SECONDS` | `30` | Maximum seconds allowed for `ffprobe` packet inspection during sprite generation. |
| `SPRITE_TIMEOUT_SECONDS` | `120` | Maximum seconds allowed for FFmpeg sprite sheet generation. |
| `MOTION_THRESHOLD` | `0.01` | Global default for minimum fraction of the frame (`0.0`–`1.0`) required to trigger motion. |
| `MOTION_MAX_THRESHOLD` | `0.50` | Global default for maximum fraction of the frame (`0.0`–`1.0`) before rejecting full-frame lighting flashes. |
| `PIXEL_DIFF_THRESHOLD` | `24` | Global default for per-pixel brightness change (`0`–`255`) required between `0.5s` frames. |
| `MOTION_CONFIRM_FRAMES` | `2` | Global default for number of motion frames required within `MOTION_CONFIRM_WINDOW` to start recording. |
| `MOTION_CONFIRM_WINDOW` | `2.0` | Global default for the confirmation time window (in seconds) used to debounce single-frame exposure spikes. |

## Motion Threshold Calibration (`calibrate.py`)

ArgoNVR includes an interactive CLI calibration tool that connects to your camera's motion source (`sub_url` if configured, otherwise `url`) using the same auto-detected FFmpeg RTSP socket timeout (`RTSP_IO_TIMEOUT_SECONDS`) and runs the exact same grayscale, spatial blur, temporal frame difference, and per-pixel deadband (`pixel_diff_threshold`) filter pipeline used by `argonvr.py`.

1. **Run the calibration script:**

   ```bash
   python3 calibrate.py
   ```

2. **Select a camera & test deadband:** Choose the camera number from the list (which displays active thresholds and motion source) and optionally enter a `pixel_diff_threshold` (`0`–`255`) to test during the session.

3. **Observe baseline noise:** Watch the live score for a few moments. Gradual sunlight shifts and sub-threshold sensor noise are zeroed out by the per-pixel LUT and should read `0.00000`.

4. **Trigger motion:** Walk in front of the camera and watch the ASCII bar, `Peak` score, and live status badge:
   * `⏳ HIT 1/2`: Frame exceeded `motion_threshold` and is awaiting confirmation within `motion_confirm_window`.
   * `🚨 TRIGGER`: Multi-frame motion confirmed (recording would start in `argonvr.py`).
   * `⚡ FLASH`: Frame exceeded `motion_max_threshold` and was rejected as a global exposure or IR cut-filter flip.

5. **Save updated parameters:** Press `Ctrl+C` to stop. You can save new per-camera values for `motion_threshold`, `pixel_diff_threshold`, and `motion_confirm_frames` (or press `Enter` at any prompt to keep existing values). The script automatically backs up `argonvr.yaml` to `argonvr.yaml.bak` before saving.

## Running the System (Manual Start)

1. **Start the server and engine:**

   ```bash
   ./launch.sh
   ```

   `launch.sh` automatically detects a local virtual environment (`./.venv` or `./venv`) if present, starts `server.py` in the background, verifies that it initialized cleanly, and launches `argonvr.py` with signal traps to shut down both processes cleanly on `Ctrl+C`.

2. **Access the Dashboard:**
   Open your browser to `http://localhost:8000` (or `https://localhost:8000` if SSL is configured) and log in with the `WEB_USER` and `WEB_PASS` defined in `argonvr.yaml`.

## Running as a Background Service (Systemd)

### Recommended: Split Engine & Web Services

Installing the recording engine and web server as separate systemd units (`argonvr-engine.service` and `argonvr-web.service`) is recommended so that a web server restart or health-check recovery **never interrupts active camera recordings**:

* **`argonvr-engine.service`:** Runs `argonvr.py` with `ARGONVR_ENGINE_NOTIFY=1`, sending direct `READY=1` and `WATCHDOG=1` heartbeats from its asyncio loop and gracefully finalizing active captures on stop (`TimeoutStopSec=20`).
* **`argonvr-web.service`:** Runs `server.py` alongside `watchdog.py` (which polls `/health` and feeds systemd's watchdog), restarting only the web tier if it becomes unresponsive.

1. **Edit the Service Files:**
   Open `argonvr-engine.service` and `argonvr-web.service` and verify that `User`, `WorkingDirectory`, and `ExecStart` match your installation path. *(Note: Using the `⚠️ Reboot` button in the web UI requires the web service user to have passwordless `sudo reboot` privileges or run as `root`.)*

2. **Install the Services:**

   ```bash
   sudo cp argonvr-engine.service argonvr-web.service /etc/systemd/system/
   ```

3. **Enable and Start:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now argonvr-engine argonvr-web
   ```

4. **Managing the Services:**

   * **Stop services:** `sudo systemctl stop argonvr-web argonvr-engine`

   * **Restart only the web UI (keeps recordings running):** `sudo systemctl restart argonvr-web`

   * **Restart the recording engine:** `sudo systemctl restart argonvr-engine`

   * **View live logs:** `sudo journalctl -fu argonvr-engine -u argonvr-web`

### Legacy Combined Service (`argonvr.service`)

A single combined unit (`argonvr.service`) is also provided for legacy setups. It waits for `network-online.target`, runs `server.py`, `watchdog.py`, and `argonvr.py` together, and sets `ARGONVR_ENGINE_NOTIFY=0` so only `watchdog.py` sends systemd watchdog heartbeats:

```bash
sudo cp argonvr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now argonvr
```

## Directory Structure

* `web/`: Frontend Single-Page Application (`index.html`, `script.js`, `camera.js`, `videos.js`, local `hls.min.js`, `style.css`, `manifest.json`, and `sw.js`).

* `cameras/` (`BASE_DIR`): Ephemeral live stream workspace per camera containing `stream.m3u8`, optional `stream_sub.m3u8`, rolling epoch-numbered `.ts` segments, and `live.jpg` (only written on disk when `CONTINUOUS_LIVE_SNAPSHOTS` is `true`).

* `recordings/` (`STORE_DIR`): Persistent storage containing `encoder_worker.log`, exported videos, and per-camera subdirectories:

  * `videos/` (`VIDEO_DIR`): Exported MP4 videos and sidecar `.json` metadata files.

  * `<cam_id>/staging/`: Active in-progress raw `.ts` motion captures.

  * `<cam_id>/queued/`: Completed raw `.ts` captures awaiting VOD packaging.

  * `<cam_id>/<YYYYMMDD>/`: Daily subdirectories containing packaged VOD HLS playlists (`.m3u8`), 4-second segments (`_000.ts`), sprite sheets (`.jpg`), WebVTT maps (`.vtt`), and clip sidecar `.json` files *(legacy flat files directly in `<cam_id>/` remain supported)*.

  * `<cam_id>/`: Daily manifests (`history_YYYYMMDD.json`) and rotating logs (`pipeline.log`, `recording.log`).

*This project is designed for local home networks and requires basic knowledge of RTSP streams.*

----
This project is an experiment in using Google Gemini to generate
useful code when prompted by an experienced developer. The only
directly human-written content is this final section of this README.md
and the TODO.md and CHANGES.md files, plus occasional minor tweaks
like changing a comment to be more accurate, or the config values.

Everything else is Gemini output in response to my prompts.

As such, the code may be flawed and comments and directions
incorrect!
