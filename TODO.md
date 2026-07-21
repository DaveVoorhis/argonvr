This is human-written.

## Bugs

1. When passing midnight, refresh the timeline to clear yesterday's heatmap items.
1. After the frontend has run for a while, refreshing or Reset causes some cameras to sometimes load slowly. Some cleanup not happening?

## Enhancements

1. Motion sensitivity should be set per-camera
1. Camera colour should be set per-camera, or set as an even spectrum of colours going from red (1st camera) to violet (last camera).
1. history.json should be per-camera and per-day and include real clip length.
1. Consider dynamically appending motion to a per-camera "all day" .mp4 for review in the single-camera view presumably with non-motion periods stretched from the end of the last motion clip, or at least coalescing multiple short clips into one longer one. Not sure what effect this will have on time display, though...

## Features

1. Turn frontend into Progressive Web App. (Work in Progress)
