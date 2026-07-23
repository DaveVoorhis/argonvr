This is human-written.

## Bugs

1. After the frontend has run for a while, refreshing or Reset causes some cameras to sometimes load slowly. Some cleanup not happening?
2. After server.py has run for 12 hours or so, it locks up.
3. Calendar popup only indicates there are clips for current day and doesn't immediately update timeline when day is changed.

## Enhancements

1. Motion sensitivity should be set per-camera
1. Consider dynamically appending motion to a per-camera "all day" .mp4 for review in the single-camera view presumably with non-motion periods stretched from the end of the last motion clip, or at least coalescing multiple short clips into one longer one. Not sure what effect this will have on time display, though...

## Features

1. Turn frontend into Progressive Web App. (Work in Progress)
