This is human-written.

## Bugs

1. Popup camera display does not default to Live display when main display is Live.
1. Pressing "Go Live" on Live display does not show Live display.
1. When passing midnight, refresh the timeline to clear yesterday's heatmap items.
1. After the frontend has run for a while, refreshing or Reset causes some cameras to sometimes load slowly. Some cleanup not happening?

## Enhancements

1. When scrubbing the camera popup, clips should load during scrub. Maybe preload and show as green in timeline bar?
1. Saved clips are large and many. Can they be smaller and/or fewer?
1. Motion sensitivity should be set per-camera
1. history.json should be per-camera and per-day and include real clip length.

## Features

1. Turn frontend into Progressive Web App.
1. Perhaps camera popup should be full screen?