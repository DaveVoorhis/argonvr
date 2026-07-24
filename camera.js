const urlParams = new URLSearchParams(window.location.search);
const camId = urlParams.get('cam') || 'cam1';
const dateParam = urlParams.get('date');
const colorParam = urlParams.get('color');
let baseDir = './cameras';

// --- Helper Functions ---
function getTodayString() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
}

const currentDayString = dateParam || getTodayString();

function getCameraColor() {
    return colorParam ? '#' + colorParam : '#3498db';
}

// UI Initialization
document.getElementById('cam-title').innerText = camId.toUpperCase();
document.getElementById('cam-title').style.color = getCameraColor();

const fwVideo = document.getElementById('fw-video');
const snapshotCanvas = document.getElementById('snapshot-canvas');
const fwOverlay = document.getElementById('fw-overlay');
const fwTimelineRegion = document.getElementById('fw-timeline-region');
const fwIndicator = document.getElementById('fw-timeline-indicator');
const fwTimeLabel = document.getElementById('fw-time-label');

let globalManifest = {};
let fwHlsPlayer = null;
let fwIsScrubbing = false;
let currentClipUrl = null;

// --- Network Management ---
let preloadQueue = [];
let isPreloading = false;
let abortController = new AbortController();
let scrubDebounceTimer = null;
let scrubMoveQueueTimer = null;
let lastSrcChangeTime = 0; // Tracks the last time we switched video sources

function secondsToTimeStr(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseFilenameToSeconds(filename) {
    const match = filename.match(/_(\d{8})_(\d{2})(\d{2})(\d{2})\.mp4/);
    if (!match) return null;
    const h = parseInt(match[2], 10);
    const m = parseInt(match[3], 10);
    const s = parseInt(match[4], 10);
    return (h * 3600) + (m * 60) + s;
}

function getDayClips() {
    const clips = globalManifest[camId] || [];
    return clips.filter(c => parseFilenameToSeconds(c.filename) !== null)
        .sort((a,b) => parseFilenameToSeconds(a.filename) - parseFilenameToSeconds(b.filename));
}

// --- Canvas Snapshot Logic ---
function snapToCanvas() {
    if (!fwVideo.videoWidth) return;
    snapshotCanvas.width = fwVideo.videoWidth;
    snapshotCanvas.height = fwVideo.videoHeight;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(fwVideo, 0, 0, snapshotCanvas.width, snapshotCanvas.height);
    snapshotCanvas.style.display = 'block';
}

fwVideo.addEventListener('seeked', () => {
    // If scrubbing, keep updating the canvas to create a smooth visual scrubbing effect
    if (fwIsScrubbing) snapToCanvas();
});

fwVideo.addEventListener('canplay', () => {
    // Once the new clip is actually loaded and ready to show frames, drop the canvas
    if (!fwIsScrubbing) {
        snapshotCanvas.style.display = 'none';
    }
});

fwVideo.addEventListener('ended', () => {
    const dayClips = getDayClips();
    const currentIndex = dayClips.findIndex(c => c.url === currentClipUrl);
    if (currentIndex >= 0 && currentIndex < dayClips.length - 1) {
        const nextClip = dayClips[currentIndex + 1];
        currentClipUrl = nextClip.url;
        fwVideo.src = nextClip.url;
        fwVideo.play().catch(e=>{});

        // Re-center preloading around the newly playing clip
        recenterPreload();
    }
});

// --- Manifest & Preloading Logic ---
async function fetchManifest() {
    try {
        const url = `/history?date=${currentDayString}&cam=${camId}`;
        const response = await fetch(url, { cache: 'no-store', credentials: 'include' });
        const newManifest = await response.json();

        Object.keys(newManifest).forEach(id => {
            newManifest[id].sort((a, b) => (parseFilenameToSeconds(a.filename) || 0) - (parseFilenameToSeconds(b.filename) || 0));

            // Preserve existing cached states across manifest updates
            if (globalManifest[id]) {
                const oldClipMap = new Map(globalManifest[id].map(c => [c.url, c.isCached]));
                newManifest[id].forEach(c => {
                    if (oldClipMap.get(c.url)) {
                        c.isCached = true;
                    }
                });
            }
        });
        globalManifest = newManifest;

        drawTimelineChunks();
        setTimeout(() => startSequentialPreload(), 1500);
    } catch (e) {
        console.log("Could not load history manifest.");
    }
}

function getCurrentClipIndex(dayClips) {
    if (dayClips.length === 0) return 0;

    // Prioritize scrubber visual indicator position if available
    const indicatorLeft = fwIndicator.style.left;
    let pct = null;

    if (indicatorLeft && indicatorLeft.includes('%')) {
        pct = parseFloat(indicatorLeft) / 100;
    } else if (currentClipUrl) {
        const idx = dayClips.findIndex(c => c.url === currentClipUrl);
        if (idx !== -1) return idx;
    }

    if (pct === null) return 0;

    const totalDuration = dayClips.reduce((sum, c) => sum + c.duration, 0);
    const targetSeconds = pct * totalDuration;

    let accum = 0;
    for (let i = 0; i < dayClips.length; i++) {
        const clip = dayClips[i];
        if (targetSeconds <= accum + clip.duration) {
            return i;
        }
        accum += clip.duration;
    }
    return dayClips.length - 1;
}

function startSequentialPreload() {
    const dayClips = getDayClips();
    if (dayClips.length === 0) return;

    const centerIdx = getCurrentClipIndex(dayClips);
    const orderedIndices = [];
    const maxLen = dayClips.length;

    // Add center first, then radiate outward (right, left, right, left...)
    orderedIndices.push(centerIdx);
    let offset = 1;

    while (orderedIndices.length < maxLen) {
        const right = centerIdx + offset;
        const left = centerIdx - offset;

        if (right < maxLen) {
            orderedIndices.push(right);
        }
        if (left >= 0) {
            orderedIndices.push(left);
        }
        offset++;
    }

    // Filter out already cached clips so we don't re-download them,
    // but keep existing cached clips intact on the timeline.
    preloadQueue = orderedIndices
        .map(i => dayClips[i])
        .filter(c => c && c.url && !c.isCached);

    if (!isPreloading) processPreloadQueue();
}

function recenterPreload() {
    abortController.abort();
    abortController = new AbortController();
    startSequentialPreload();
}

async function processPreloadQueue() {
    if (preloadQueue.length === 0) {
        isPreloading = false;
        return;
    }
    isPreloading = true;
    const clip = preloadQueue.shift();

    // Skip if already cached in the meantime
    if (clip.isCached) {
        processPreloadQueue();
        return;
    }

    try {
        const response = await fetch(clip.url, {
            cache: 'force-cache',
            priority: 'low',
            signal: abortController.signal
        });
        if (response.ok || response.status === 206) {
            clip.isCached = true;
            drawTimelineChunks();
        }
    } catch (e) {
        // Ignore AbortError, it's intentional when shifting focus
    }

    // Pause briefly to let the main video breathe, then continue
    setTimeout(processPreloadQueue, 300);
}

// --- Timeline Visualizer ---
function drawTimelineChunks() {
    document.querySelectorAll('.fw-timeline-chunk').forEach(el => el.remove());
    const dayClips = getDayClips();
    if (dayClips.length === 0) return;

    const totalDuration = dayClips.reduce((sum, c) => sum + c.duration, 0);
    let accum = 0;

    dayClips.forEach(clip => {
        const startPct = (accum / totalDuration) * 100;
        const widthPct = (clip.duration / totalDuration) * 100;

        const chunk = document.createElement('div');
        chunk.className = 'fw-timeline-chunk';
        chunk.style.left = `${startPct}%`;
        chunk.style.width = `${widthPct}%`;
        chunk.style.backgroundColor = clip.isCached ? 'rgba(46, 204, 113, 0.6)' : 'rgba(255, 255, 255, 0.15)';

        fwTimelineRegion.insertBefore(chunk, fwIndicator);
        accum += clip.duration;
    });
}

// --- Live Stream Logic ---
function fwGoLive() {
    fwTimeLabel.innerText = "LIVE";
    fwTimeLabel.style.color = "#4cd137";
    fwIndicator.style.left = '100%';

    if (fwHlsPlayer) {
        fwHlsPlayer.destroy();
        fwHlsPlayer = null;
    }

    currentClipUrl = null;
    fwVideo.pause();
    fwVideo.removeAttribute('src');
    fwVideo.load();
    fwOverlay.style.display = 'none';
    snapshotCanvas.style.display = 'none';

    const freshPlaylistUrl = `${baseDir}/${camId}/stream.m3u8?t=${Date.now()}`;

    if (Hls.isSupported()) {
        fwHlsPlayer = new Hls({ xhrSetup: function(xhr) { xhr.withCredentials = true; } });
        fwHlsPlayer.attachMedia(fwVideo);
        fwHlsPlayer.on(Hls.Events.MEDIA_ATTACHED, () => fwHlsPlayer.loadSource(freshPlaylistUrl));
        fwHlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => fwVideo.play().catch(e => {}));
    } else if (fwVideo.canPlayType('application/vnd.apple.mpegurl')) {
        fwVideo.src = freshPlaylistUrl;
        fwVideo.play().catch(e => {});
    }
}

// --- Highly Optimized Scrubber ---
function updateFwTimelineFromEvent(e) {
    const rect = fwTimelineRegion.getBoundingClientRect();
    let x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    fwIndicator.style.left = `${(x / rect.width) * 100}%`;

    const dayClips = getDayClips();
    if (dayClips.length === 0) return;

    const totalDuration = dayClips.reduce((sum, c) => sum + c.duration, 0);
    const targetSeconds = (x / rect.width) * totalDuration;

    let accum = 0;
    let selectedClip = dayClips[dayClips.length - 1];
    let offsetInClip = selectedClip.duration;

    for (let clip of dayClips) {
        if (targetSeconds <= accum + clip.duration) {
            selectedClip = clip;
            offsetInClip = targetSeconds - accum;
            break;
        }
        accum += clip.duration;
    }

    const actualSec = parseFilenameToSeconds(selectedClip.filename) + offsetInClip;
    fwTimeLabel.innerText = secondsToTimeStr(actualSec);
    fwTimeLabel.style.color = "#f39c12";

    if (fwHlsPlayer) {
        fwHlsPlayer.destroy();
        fwHlsPlayer = null;
    }
    fwOverlay.style.display = 'none';

    // Core Logic: Are we staying within the same file or switching?
    if (currentClipUrl === selectedClip.url) {
        fwVideo.currentTime = offsetInClip;

        // If we moved back into the currently loaded file, cancel any pending cross-file switches
        if (scrubDebounceTimer) {
            clearTimeout(scrubDebounceTimer);
            scrubDebounceTimer = null;
        }
    } else {
        // We are crossing a file boundary.
        snapToCanvas(); // Freeze current frame

        const loadNewClip = () => {
            scrubDebounceTimer = null;
            lastSrcChangeTime = Date.now();
            currentClipUrl = selectedClip.url;
            fwVideo.src = selectedClip.url;
            fwVideo.onloadedmetadata = () => {
                fwVideo.currentTime = offsetInClip;
                fwVideo.onloadedmetadata = null;
            };
        };

        const now = Date.now();
        if (now - lastSrcChangeTime > 100) {
            // Throttle window is open: Execute the file switch immediately
            clearTimeout(scrubDebounceTimer);
            loadNewClip();
        } else {
            // Throttle window is closed: Queue it up for the trailing edge.
            // Clearing existing timers guarantees we only load the very last clip you stopped on.
            clearTimeout(scrubDebounceTimer);
            scrubDebounceTimer = setTimeout(loadNewClip, 100 - (now - lastSrcChangeTime));
        }
    }
}

fwTimelineRegion.addEventListener('pointerdown', (e) => {
    fwIsScrubbing = true;
    fwVideo.pause();
    fwTimelineRegion.setPointerCapture(e.pointerId);
    updateFwTimelineFromEvent(e);
    recenterPreload();
});

fwTimelineRegion.addEventListener('pointermove', (e) => {
    if (fwIsScrubbing) {
        updateFwTimelineFromEvent(e);

        // Dynamically re-center preloading as the scrubber drags, throttled to prevent thrashing
        if (!scrubMoveQueueTimer) {
            scrubMoveQueueTimer = setTimeout(() => {
                recenterPreload();
                scrubMoveQueueTimer = null;
            }, 200);
        }
    }
});

fwTimelineRegion.addEventListener('pointerup', (e) => {
    fwIsScrubbing = false;
    fwTimelineRegion.releasePointerCapture(e.pointerId);

    if (scrubMoveQueueTimer) {
        clearTimeout(scrubMoveQueueTimer);
        scrubMoveQueueTimer = null;
    }
    recenterPreload();

    if (!fwHlsPlayer && fwVideo.src) {
        fwVideo.play().catch(e=>{});
    }
});

// Start up
document.addEventListener('DOMContentLoaded', async () => {
    await fetchManifest();

    if (dateParam && dateParam !== getTodayString()) {
        fwTimeLabel.innerText = "LOADING";
        setTimeout(() => updateFwTimelineFromEvent({ clientX: 0 }), 300);
    } else {
        fwGoLive();
    }
});