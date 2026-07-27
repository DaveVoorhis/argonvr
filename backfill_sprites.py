import os
import json
import math
import datetime
import subprocess
import configparser

config = configparser.ConfigParser()
config.read('argonvr.cfg')

STORE_DIR = config['SETTINGS'].get('STORE_DIR', './recordings') if 'SETTINGS' in config else './recordings'

def format_vtt_time(seconds):
    """Formats raw seconds into WebVTT timestamp format."""
    td = datetime.timedelta(seconds=float(seconds))
    hours, remainder = divmod(td.seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    milliseconds = td.microseconds // 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"

def get_video_duration(filepath):
    try:
        cmd = [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", filepath
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        return round(float(proc.stdout.strip()), 2)
    except Exception:
        return 0.0

def generate_sprite_and_vtt(mp4_filepath, output_dir, base_name):
    """Extracts I-frames into a single JPEG sprite sheet and generates a WebVTT map."""
    jpg_filepath = os.path.join(output_dir, f"{base_name}.jpg")
    vtt_filepath = os.path.join(output_dir, f"{base_name}.vtt")

    try:
        # 1. Get raw frame data
        cmd_probe = [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=pkt_pts_time,pkt_dts_time,pict_type",
            "-of", "json", mp4_filepath
        ]
        proc = subprocess.run(cmd_probe, capture_output=True, text=True)
        probe_data = json.loads(proc.stdout)
        frames = probe_data.get('frames', [])

        # 2. Safely parse timestamps, falling back to DTS if PTS is "N/A"
        valid_i_frames = []
        for f in frames:
            if f.get('pict_type') == 'I':
                pts = f.get('pkt_pts_time', 'N/A')
                if pts == 'N/A':
                    pts = f.get('pkt_dts_time', 'N/A')

                if pts != 'N/A':
                    try:
                        valid_i_frames.append(float(pts))
                    except ValueError:
                        pass

        if not valid_i_frames:
            print(f"  [!] Skipped {base_name}: No valid float timestamps found.")
            return

        num_frames = len(valid_i_frames)
        cols = 5
        rows = math.ceil(num_frames / cols)
        width = 160
        height = 90

        # 3. Generate Sprite Sheet
        cmd_ffmpeg = [
            "ffmpeg", "-i", mp4_filepath,
            "-vf", f"select='eq(pict_type,I)',scale={width}:{height},tile={cols}x{rows}",
            "-frames:v", "1", "-y", jpg_filepath
        ]
        subprocess.run(cmd_ffmpeg, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        # 4. Generate WebVTT
        with open(vtt_filepath, 'w') as vtt_file:
            vtt_file.write("WEBVTT\n\n")

            for i in range(num_frames):
                col = i % cols
                row = i // cols
                x = col * width
                y = row * height

                start_time = valid_i_frames[i]
                end_time = valid_i_frames[i+1] if i + 1 < num_frames else start_time + 5.0

                vtt_file.write(f"{format_vtt_time(start_time)} --> {format_vtt_time(end_time)}\n")
                vtt_file.write(f"{base_name}.jpg#xywh={x},{y},{width},{height}\n\n")

        print(f"  [+] Generated Sprite ({num_frames} tiles) & VTT for {base_name}")

    except Exception as e:
        print(f"  [X] Failed to process {base_name}: {e}")
        # Clean up corrupted files so they don't break the JSON checks
        if os.path.exists(jpg_filepath): os.remove(jpg_filepath)
        if os.path.exists(vtt_filepath): os.remove(vtt_filepath)

def update_history_manifest(cam_id):
    cam_path = os.path.join(STORE_DIR, cam_id)
    if not os.path.isdir(cam_path):
        return

    daily_files = {}
    for f in os.listdir(cam_path):
        if f.endswith('.mp4'):
            try:
                parts = f.split('_')
                if len(parts) >= 2:
                    date_str = parts[1]
                    if date_str not in daily_files:
                        daily_files[date_str] = []
                    daily_files[date_str].append(f)
            except IndexError:
                continue

    active_dates = set()
    for date_str, files in daily_files.items():
        manifest_name = f"history_{date_str}.json"
        active_dates.add(manifest_name)
        manifest_path = os.path.join(cam_path, manifest_name)

        manifest_data = []
        for f in files:
            base_name = f[:-4]
            jpg_filename = f"{base_name}.jpg"
            vtt_filename = f"{base_name}.vtt"

            has_sprite = os.path.exists(os.path.join(cam_path, jpg_filename))
            has_vtt = os.path.exists(os.path.join(cam_path, vtt_filename))
            filepath = os.path.join(cam_path, f)

            manifest_data.append({
                "filename": f,
                "url": f"./{os.path.basename(STORE_DIR)}/{cam_id}/{f}",
                "duration": get_video_duration(filepath),
                "sprite_url": f"./{os.path.basename(STORE_DIR)}/{cam_id}/{jpg_filename}" if has_sprite else None,
                "vtt_url": f"./{os.path.basename(STORE_DIR)}/{cam_id}/{vtt_filename}" if has_vtt else None
            })

        manifest_data.sort(key=lambda x: x['filename'], reverse=True)

        with open(manifest_path, 'w') as mf:
            json.dump(manifest_data, mf, indent=2)

        print(f"  [√] Wrote {manifest_name} ({len(files)} clips)")

    for f in os.listdir(cam_path):
        if f.startswith('history_') and f.endswith('.json') and f not in active_dates:
            try:
                os.remove(os.path.join(cam_path, f))
                print(f"  [-] Removed orphaned manifest {f}")
            except OSError:
                pass

def main():
    if not os.path.exists(STORE_DIR):
        print(f"Error: Storage directory '{STORE_DIR}' not found.")
        return

    print(f"🚀 Starting Backfill Job on '{STORE_DIR}'...")
    cameras = [d for d in os.listdir(STORE_DIR) if os.path.isdir(os.path.join(STORE_DIR, d))]

    for cam_id in cameras:
        cam_dir = os.path.join(STORE_DIR, cam_id)
        print(f"\n📂 Processing Camera: {cam_id}")

        mp4_files = [f for f in os.listdir(cam_dir) if f.endswith('.mp4')]
        mp4_files.sort()

        if not mp4_files:
            continue

        processed_count = 0
        skipped_count = 0

        for index, mp4_filename in enumerate(mp4_files):
            base_name = mp4_filename[:-4]
            mp4_filepath = os.path.join(cam_dir, mp4_filename)
            jpg_filepath = os.path.join(cam_dir, f"{base_name}.jpg")
            vtt_filepath = os.path.join(cam_dir, f"{base_name}.vtt")

            # Reprocess if either the JPG or the VTT is missing
            if not os.path.exists(jpg_filepath) or not os.path.exists(vtt_filepath):
                print(f"  [{index + 1}/{len(mp4_files)}] Processing {mp4_filename}...")
                generate_sprite_and_vtt(mp4_filepath, cam_dir, base_name)
                processed_count += 1
            else:
                skipped_count += 1

        print(f"  Done extracting. (Generated: {processed_count}, Skipped: {skipped_count})")
        print(f"  Rebuilding JSON manifests for {cam_id}...")
        update_history_manifest(cam_id)

    print("\n✅ Backfill Job Complete!")

if __name__ == "__main__":
    main()