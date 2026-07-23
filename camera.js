const urlParams = new URLSearchParams(window.location.search);
const camId = urlParams.get('cam') || 'cam1';
const dateParam = urlParams.get('date');
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
const CAMERA_COLORS = ['#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#e74c3c', '#1abc9c', '#e84393'];

function getCameraColor(id) {
    const num = parseInt(id.replace(/\D/g, '')) || 1;
    return CAMERA_COLORS[(num - 1) % CAMERA_COLORS.length];
}

// UI Initialization
document.getElementById('cam-title').innerText = camId.toUpperCase();
document.getElementById('cam-title').style.color = getCameraColor(camId);

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
        });
        globalManifest = newManifest;

        drawTimelineChunks();
        setTimeout(() => startSequentialPreload(), 1500);
    } catch (e) {
        console.log("Could not load history manifest.");
    }
}

function startSequentialPreload() {
    const dayClips = getDayClips();
    preloadQueue = dayClips.filter(c => c.url && !c.isCached);
    if (!isPreloading) processPreloadQueue();
}

async function processPreloadQueue() {
    if (preloadQueue.length === 0) {
        isPreloading = false;
        return;
    }
    isPreloading = true;
    const clip = preloadQueue.shift();

    try {
        // We pass the abort signal so we can kill this request instantly if the user scrubs
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
        // Ignore AbortError, it's intentional
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
    } else {
        // We are crossing a file boundary.
        snapToCanvas(); // Freeze current frame

        clearTimeout(scrubDebounceTimer);
        // Wait 100ms before triggering a file load to prevent network thrashing
        scrubDebounceTimer = setTimeout(() => {
            currentClipUrl = selectedClip.url;
            fwVideo.src = selectedClip.url;
            fwVideo.onloadedmetadata = () => {
                fwVideo.currentTime = offsetInClip;
                fwVideo.onloadedmetadata = null;
            };
        }, 100);
    }
}

fwTimelineRegion.addEventListener('pointerdown', (e) => {
    fwIsScrubbing = true;

    // INSTANTLY kill any background caching to free up network bandwidth for scrubbing
    abortController.abort();
    abortController = new AbortController();

    fwVideo.pause();
    fwTimelineRegion.setPointerCapture(e.pointerId);
    updateFwTimelineFromEvent(e);
});

fwTimelineRegion.addEventListener('pointermove', (e) => {
    if (fwIsScrubbing) {
        updateFwTimelineFromEvent(e);
    }
});

fwTimelineRegion.addEventListener('pointerup', (e) => {
    fwIsScrubbing = false;
    fwTimelineRegion.releasePointerCapture(e.pointerId);

    if (!fwHlsPlayer && fwVideo.src) {
        fwVideo.play().catch(e=>{});

        // Restart caching operations safely in the background
        setTimeout(() => startSequentialPreload(), 1500);
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