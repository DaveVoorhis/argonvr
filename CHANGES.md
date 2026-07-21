This is human-written.

## Bugs Fixed

1. Popup camera did not default to Live display when main display is Live.
2. Pressing "Go Live" on Live display sometimes does not show Live display.

## Enhancements

1. Added `copy` option for ENCODING in config, for when cam natively encodes as H264. Significantly reduces CPU load.
2. Single camera display is full screen. 
3. When scrubbing the camera popup, clips load and display during scrub.
4. Single camera view shows live camera whilst clips are loading.
5. Single camera view can scrub over loaded clips whilst others are still loading.
6. Preloads clips in an even distribution so preview can happen earlier.
7. History now obtained via endpoint rather than explicit path, to avoid deviating from config.
8. Count of cameras now obtained via endpoint rather than polled until error.

## Features
