This is human-written.

## Bugs Fixed

1. Popup camera did not default to Live display when main display is Live.
2. Pressing "Go Live" on Live display sometimes does not show Live display.
3. When passing midnight, refresh the timeline to clear yesterday's heatmap items.
4. Improved server.py to avoid resource starvation due to connection breakage.
5. After server.py has run for 12 hours or so, it locks up. Server watchdog added to address this.
6. Calendar popup only indicates there are clips for current day and doesn't immediately update timeline when day is changed. Fixed.
7. Camera colour passed from script.js to camera.js.

## Enhancements

1. Added `copy` option for ENCODING in config, for when cam natively encodes as H264. Significantly reduces CPU load.
2. Single camera display is full screen. 
3. When scrubbing the camera popup, clips load and display during scrub.
4. Single camera view shows live camera whilst clips are loading.
5. Single camera view can scrub over loaded clips whilst others are still loading.
6. Preloads clips in an even distribution so preview can happen earlier.
7. History now obtained via endpoint rather than explicit path, to avoid deviating from config.
8. Count of cameras now obtained via endpoint rather than polled until error.
9. History returned by /history is per-camera and per-day and include real clip length.
10. Camera colour now set as an even spectrum of colours going from red (1st camera) to violet (last camera).
11. Frontend detects connection failure and resets to allow for server reboots, connection outage etc.
12. Improved rapid-load single-camera timeline scrubbing.
13. Single camera display now has selectable scale: 1 hour, 2 hour, etc.

## Features
