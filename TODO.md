This is human-written.

## Bugs

1. Single camera view should show live camera whilst clips are loading.
1. When passing midnight, refresh the timeline to clear yesterday's heatmap items.
1. After the frontend has run for a while, refreshing or Reset causes some cameras to sometimes load slowly. Some cleanup not happening?

## Enhancements

1. Motion sensitivity should be set per-camera
1. history.json should be per-camera and per-day and include real clip length.
1. Single camera view should be able to scrub over loaded clips whilst others are still loading.
1. Possibly load clips in an even distribution so preview can happen earlier.

## Features

1. Turn frontend into Progressive Web App. (Work in Progress)

## Tech debt

1. Clean up unused popup CSS in style.css based on index.html
1. Clean up unused popup HTML in index.html.
1. Clean up unused popup Javascript in script.js based on index.html and style.css.
