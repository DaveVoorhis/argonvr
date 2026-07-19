# ArgoNVR

ArgoNVR is a lightweight, self-hosted Network Video Recorder (NVR) designed to run on low-power hardware (such as a Raspberry Pi). It captures RTSP streams, performs real-time motion detection, and manages a searchable timeline of video recordings.

## Features

* **Unified Pipeline:** Simultaneously handles live browser HLS streaming and background motion-triggered recording.
* **Smart Motion Detection:** Records only when motion is detected, preserving disk space.
* **Timeline Interface:** A sleek web dashboard with a heatmap-enabled timeline to browse, scrub, and watch recordings.
* **Secure:** Basic HTTP authentication to restrict access to your camera feeds.
* **Hardware Accelerated:** Uses efficient hardware-based encoding (e.g., `h264_v4l2m2m` for Linux/Raspberry Pi).

## Requirements

* **Python 3.8+**: Required for the backend engine and web server.
* **FFmpeg**: Must be installed and available in your system's PATH. This is used for stream processing, motion detection, and video recording.
* **OS**: Developed and tested on Linux (ideal for Raspberry Pi/Debian-based systems).

## How to Configure

1. **Copy the example configuration:**
   ```bash
   cp argonvr.cfg.example argonvr.cfg
   ```

2. **Edit `argonvr.cfg`:**
   Open the file and update the `[CAMERAS]` section with your RTSP camera URLs and the `[SETTINGS]` section with your desired username, password, and configuration paths.

## Running the System (Manual Start)

Ensure you have `ffmpeg` installed on your system.

1. **Start the system:**
   Run the provided launch script:
   ```bash
   ./launch.sh
   ```

2. **Access the Dashboard:**
   Open your browser and navigate to `http://localhost:8000`. You will be prompted to log in using the credentials you defined in `argonvr.cfg`.

## Running as a Background Service (Systemd)

To ensure ArgoNVR starts automatically on boot and runs continuously in the background, you can set it up as a systemd service.

1. **Edit the Service File:**
   Open the provided `argonvr.service` file and update the `WorkingDirectory` and `ExecStart` paths to match the exact directory where your ArgoNVR project is located.

2. **Install the Service:**
   Copy the modified file into the systemd directory:
   ```bash
   sudo cp argonvr.service /etc/systemd/system/
   ```

3. **Enable and Start:**
   Reload the systemd daemon, enable the service to start on boot, and launch it:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable argonvr
   sudo systemctl start argonvr
   ```

4. **Managing the Service:**
   You can easily control the NVR engine using standard systemctl commands:
   * **Stop the service:** `sudo systemctl stop argonvr`
   * **Restart the service:** `sudo systemctl restart argonvr`
   * **View live logs:** `sudo journalctl -fu argonvr`

## Directory Structure

* /cameras: Contains live HLS streams and logs.
* /recordings: Contains the saved `.mp4` clips and the `history.json` manifest.

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
incorrect. For example, the text above currently states, "Developed
and tested on Linux ..."

Actually, it was developed and tested on MacOS. I use it under Linux
on a Raspberry Pi 5.