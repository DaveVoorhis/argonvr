import yaml
import subprocess
import re
import sys
import shutil

CONFIG_FILE = 'argonvr.yaml'

def load_config():
    try:
        with open(CONFIG_FILE, 'r') as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        print(f"❌ Could not find {CONFIG_FILE}")
        sys.exit(1)

def save_config(config):
    shutil.copy(CONFIG_FILE, CONFIG_FILE + '.bak') # Create a quick backup
    with open(CONFIG_FILE, 'w') as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    print(f"✅ Saved updated configuration to {CONFIG_FILE}")

def main():
    config = load_config()
    cameras = config.get('CAMERAS', {})

    if not cameras:
        print("❌ No cameras found in configuration.")
        sys.exit(1)

    print("\n--- ArgoNVR Calibration Tool ---")
    cam_ids = list(cameras.keys())
    for idx, cam_id in enumerate(cam_ids):
        current_threshold = cameras[cam_id].get('motion_threshold', 'N/A')
        print(f"[{idx + 1}] {cam_id} (Current Threshold: {current_threshold})")

    try:
        selection = int(input("\nSelect a camera to calibrate (number): ")) - 1
        if selection < 0 or selection >= len(cam_ids):
            raise ValueError
    except ValueError:
        print("❌ Invalid selection.")
        sys.exit(1)

    selected_cam = cam_ids[selection]
    rtsp_url = cameras[selected_cam]['url']
    current_threshold = cameras[selected_cam].get('motion_threshold', 0.01)

    print(f"\n📡 Connecting to {selected_cam}...")
    print("👀 Watch the output below. Walk in front of the camera to see the score spike.")
    print("🛑 Press Ctrl+C when you are ready to set the new threshold.\n")

    # Added -nostats to prevent FFmpeg's carriage returns from jamming Python's read buffer
    # Swapped showinfo for metadata=mode=print to match your ArgoNVR engine
    cmd = [
        "ffmpeg", "-nostats", "-rtsp_transport", "tcp", "-i", rtsp_url,
        "-map", "0:v", "-an",
        "-vf", "fps=2,scale=320:-1,select='gte(scene,0)',metadata=mode=print",
        "-f", "null", "-"
    ]

    proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True, universal_newlines=True)

    peak_score = 0.0
    error_log = []

    try:
        for line in proc.stderr:
            # Keep a rolling buffer of the last 15 lines of stderr in case FFmpeg crashes
            error_log.append(line.strip())
            if len(error_log) > 15:
                error_log.pop(0)

            # Parse the scene score out of FFmpeg's showinfo output
            match = re.search(r'lavfi\.scene_score=([0-9.]+)', line)
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