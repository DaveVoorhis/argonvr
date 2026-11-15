import yaml
import subprocess
import re
import sys
import shutil
import time

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
    print(f"✅ Saved updated configuration to {CONFIG_FILE} (backup at {CONFIG_FILE}.bak)")

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
    settings = config.get('SETTINGS', {})

    if not cameras:
        print("❌ No cameras found in configuration.")
        sys.exit(1)

    # Load global motion defaults from SETTINGS with sensible fallbacks
    default_motion_thresh = float(settings.get('MOTION_THRESHOLD', 0.01))
    default_max_thresh = float(settings.get('MOTION_MAX_THRESHOLD', 0.50))
    default_pixel_diff = int(settings.get('PIXEL_DIFF_THRESHOLD', 24))
    default_confirm_frames = int(settings.get('MOTION_CONFIRM_FRAMES', 2))
    default_confirm_window = float(settings.get('MOTION_CONFIRM_WINDOW', 2.0))

    print("\n--- ArgoNVR Calibration Tool ---")
    cam_ids = list(cameras.keys())
    for idx, cam_id in enumerate(cam_ids):
        cam_cfg = cameras[cam_id]
        thresh = cam_cfg.get('motion_threshold', default_motion_thresh)
        p_diff = cam_cfg.get('pixel_diff_threshold', default_pixel_diff)
        c_frames = cam_cfg.get('motion_confirm_frames', default_confirm_frames)
        stream_type = "sub_url" if cam_cfg.get('sub_url') else "url"
        print(
            f"[{idx + 1}] {cam_id} "
            f"(Threshold: {thresh}, Pixel Diff: {p_diff}, Confirm: {c_frames}f, Source: {stream_type})"
        )

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

    current_threshold = float(cam_cfg.get('motion_threshold', default_motion_thresh))
    current_max_threshold = float(cam_cfg.get('motion_max_threshold', default_max_thresh))
    current_pixel_diff = int(cam_cfg.get('pixel_diff_threshold', default_pixel_diff))
    current_confirm_frames = int(cam_cfg.get('motion_confirm_frames', default_confirm_frames))
    current_confirm_window = float(cam_cfg.get('motion_confirm_window', default_confirm_window))

    # Optional pre-run override for pixel_diff_threshold since it is compiled into the FFmpeg LUT filter
    p_diff_input = input(
        f"Enter pixel_diff_threshold (0-255) to test [Enter for {current_pixel_diff}]: "
    ).strip()
    if p_diff_input:
        try:
            test_pixel_diff = max(0, min(255, int(p_diff_input)))
        except ValueError:
            print(f"⚠️ Invalid integer, using {current_pixel_diff}.")
            test_pixel_diff = current_pixel_diff
    else:
        test_pixel_diff = current_pixel_diff

    print(f"\n📡 Connecting to {selected_cam} via {stream_label}...")
    print(
        f"⚙️  Active Parameters: motion_threshold={current_threshold}, "
        f"motion_max_threshold={current_max_threshold}, "
        f"pixel_diff_threshold={test_pixel_diff}, "
        f"confirm={current_confirm_frames} frames / {current_confirm_window}s"
    )
    print("👀 Watch the output below. Slow sunlight shifts should read 0.00000.")
    print("🚶 Walk in front of the camera to see the score spike and confirm trigger.")
    print("🛑 Press Ctrl+C when you are ready to save updated settings.\n")

    vf_graph = (
        f"fps=2,scale=320:-2,"
        f"format=gray,avgblur=sizeX=3:sizeY=3,"
        f"tblend=all_mode=difference,"
        f"lut=c0='if(gt(val,{test_pixel_diff}),255,0)',"
        f"select='gte(scene,0)',metadata=mode=print"
    )

    cmd = [
        "ffmpeg", "-nostats", "-rtsp_transport", "tcp", "-i", rtsp_url,
        "-map", "0:v", "-an",
        "-vf", vf_graph,
        "-f", "null", "-"
    ]

    proc = subprocess.Popen(cmd, stderr=subprocess.PIPE)

    peak_score = 0.0
    error_log = []
    motion_hit_times = []

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
                now = time.time()
                score = float(match.group(1))

                # Prune old hits outside the confirmation window
                motion_hit_times = [
                    t for t in motion_hit_times
                    if (now - t) <= current_confirm_window
                ]

                if score > current_max_threshold:
                    status_marker = "⚡ FLASH  "
                elif score >= current_threshold:
                    if score > peak_score:
                        peak_score = score
                    motion_hit_times.append(now)
                    hits = len(motion_hit_times)
                    if hits >= current_confirm_frames:
                        status_marker = "🚨 TRIGGER"
                    else:
                        status_marker = f"⏳ HIT {hits}/{current_confirm_frames}"
                else:
                    if score > peak_score:
                        peak_score = score
                    status_marker = "          "

                bar_length = int(score * 1000)
                bar = '█' * min(bar_length, 45)

                sys.stdout.write(
                    f"\rScore: {score:.5f} | Peak: {peak_score:.5f} | {status_marker} | {bar}".ljust(105)
                )
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
        print(f"Highest observed valid score during this session: {peak_score:.5f}\n")

        changed = False

        new_thresh_input = input(
            f"Enter new motion_threshold for {selected_cam} [Enter to keep {current_threshold}]: "
        ).strip()
        if new_thresh_input:
            try:
                config['CAMERAS'][selected_cam]['motion_threshold'] = float(new_thresh_input)
                changed = True
            except ValueError:
                print("❌ Invalid motion_threshold entered; keeping previous value.")

        new_pdiff_input = input(
            f"Save pixel_diff_threshold for {selected_cam}? [Enter for {test_pixel_diff}, or type 0-255]: "
        ).strip()
        if new_pdiff_input:
            try:
                val = max(0, min(255, int(new_pdiff_input)))
                config['CAMERAS'][selected_cam]['pixel_diff_threshold'] = val
                changed = True
            except ValueError:
                print("❌ Invalid pixel_diff_threshold entered; skipping.")
        elif test_pixel_diff != current_pixel_diff:
            config['CAMERAS'][selected_cam]['pixel_diff_threshold'] = test_pixel_diff
            changed = True

        new_confirm_input = input(
            f"Enter new motion_confirm_frames for {selected_cam} [Enter to keep {current_confirm_frames}]: "
        ).strip()
        if new_confirm_input:
            try:
                config['CAMERAS'][selected_cam]['motion_confirm_frames'] = max(1, int(new_confirm_input))
                changed = True
            except ValueError:
                print("❌ Invalid motion_confirm_frames entered; skipping.")

        if changed:
            save_config(config)
        else:
            print("No configuration changes made. Exiting.")

if __name__ == "__main__":
    main()