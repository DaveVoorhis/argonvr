import yaml
import subprocess
import re
import sys
import shutil

CONFIG_FILE = 'argonvr.yaml'

def load_config():
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        print(f"❌ Could not find {CONFIG_FILE}")
        sys.exit(1)

def save_config(config):
    shutil.copy(CONFIG_FILE, CONFIG_FILE + '.bak')  # Create a quick backup
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    print(f"✅ Saved updated configuration to {CONFIG_FILE}")

def iter_lines_cr_lf(stream):
    """Yields lines split on either CR or LF from a binary stream without buffering lag."""
    buffer = b""
    while True:
        chunk = stream.read1(1024) if hasattr(stream, 'read1') else stream.read(256)
        if not chunk:
            if buffer:
                yield buffer.decode('utf-8', errors='ignore')
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

            yield line.decode('utf-8', errors='ignore')

def main():
    config = load_config()
    cameras = config.get('CAMERAS', {})

    if not cameras:
        print("❌ No cameras found in configuration.")
        sys.exit(1)

    print("\n--- ArgoNVR Calibration Tool ---")
    cam_ids = list(cameras.keys())
    for idx, cam_id in enumerate(cam_ids):
        cam_cfg = cameras[cam_id]
        current_threshold = cam_cfg.get('motion_threshold', 'N/A')
        stream_type = "sub_url" if cam_cfg.get('sub_url') else "url"
        print(f"[{idx + 1}] {cam_id} (Current Threshold: {current_threshold}, Motion Source: {stream_type})")

    try:
        selection = int(input("\nSelect a camera to calibrate (number): ")) - 1
        if selection < 0 or selection >= len(cam_ids):
            raise ValueError
    except ValueError:
        print("❌ Invalid selection.")
        sys.exit(1)

    selected_cam = cam_ids[selection]
    cam_cfg = cameras[selected_cam]
    sub_rtsp_url = cam_cfg.get('sub_url')
    rtsp_url = sub_rtsp_url if sub_rtsp_url else cam_cfg['url']
    stream_label = "sub-stream (sub_url)" if sub_rtsp_url else "main stream (url)"
    current_threshold = cam_cfg.get('motion_threshold', 0.01)

    print(f"\n📡 Connecting to {selected_cam} via {stream_label}...")
    print("👀 Watch the output below. Walk in front of the camera to see the score spike.")
    print("🛑 Press Ctrl+C when you are ready to set the new threshold.\n")

    cmd = [
        "ffmpeg", "-nostats", "-rtsp_transport", "tcp", "-i", rtsp_url,
        "-map", "0:v", "-an",
        "-vf", "fps=2,scale=320:-2,select='gte(scene,0)',metadata=mode=print",
        "-f", "null", "-"
    ]

    proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)

    peak_score = 0.0
    error_log = []

    try:
        for line in iter_lines_cr_lf(proc.stderr):
            stripped = line.strip()
            if not stripped:
                continue

            # Keep a rolling buffer of the last 15 lines of stderr in case FFmpeg crashes
            error_log.append(stripped)
            if len(error_log) > 15:
                error_log.pop(0)

            # Parse the scene score out of FFmpeg's metadata output
            match = re.search(r'lavfi\.scene_score=([0-9.]+)', stripped)
            if match:
                score = float(match.group(1))
                if score > peak_score:
                    peak_score = score

                bar_length = int(score * 1000)
                bar = '█' * min(bar_length, 50)
                trigger_marker = "🚨 TRIGGER" if score > float(current_threshold) else "          "

                sys.stdout.write(f"\rScore: {score:.5f} | Peak: {peak_score:.5f} | {trigger_marker} | {bar}".ljust(100))
                sys.stdout.flush()

        # If we reach this point without a KeyboardInterrupt, FFmpeg crashed or lost connection.
        proc.wait()
        if proc.returncode != 0:
            print(f"\n\n❌ FFmpeg exited unexpectedly (Exit Code: {proc.returncode}).")
            print("Last FFmpeg output:")
            print("\n".join(error_log))
            sys.exit(1)

    except KeyboardInterrupt:
        # User hit Ctrl+C to stop calibrating
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

        print("\n\n🛑 Calibration stopped.")
        print(f"Highest observed score during this session: {peak_score:.5f}")

        new_thresh_input = input(f"\nEnter new threshold for {selected_cam} (or press Enter to keep {current_threshold}): ")

        if new_thresh_input.strip():
            try:
                new_thresh = float(new_thresh_input)
                config['CAMERAS'][selected_cam]['motion_threshold'] = new_thresh
                save_config(config)
            except ValueError:
                print("❌ Invalid number entered. Configuration not saved.")
        else:
            print("Keep existing threshold selected. Exiting.")

if __name__ == "__main__":
    main()