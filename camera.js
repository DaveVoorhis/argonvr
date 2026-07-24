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

// Tracks precise mouse intent for asynchronous seek catch-ups
let targetClipUrl = null;
let targetClipOffset = 0;

// --- Network & Debounce Management ---
let scrubDebounceTimer = null;
let lastSrcChangeTime = 0;

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
    let parsed = clips.filter(c => parseFilenameToSeconds(c.filename) !== null)
        .sort((a,b) => parseFilenameToSeconds(a.filename) - parseFilenameToSeconds(b.filename));

    const scaleSelect = document.getElementById('fw-scale-select');
    if (scaleSelect && scaleSelect.value !== 'all' && parsed.length > 0) {
        const scaleHours = parseInt(scaleSelect.value, 10);
        const scaleSeconds = scaleHours * 3600;

        // Anchor the window to the end of the latest available clip
        const lastClip = parsed[parsed.length - 1];
        const lastClipEnd = parseFilenameToSeconds(lastClip.filename) + (lastClip.duration || 0);

        // Floor it at 0 to strictly prevent bleeding into the previous calendar day
        const startTime = Math.max(0, lastClipEnd - scaleSeconds);

        parsed = parsed.filter(c => {
            const clipStart = parseFilenameToSeconds(c.filename);
            const clipEnd = clipStart + (c.duration || 0);
            return clipEnd > startTime;
        });
    }

    return parsed;
}

// Timeline scale change handler
function handleScaleChange() {
    drawTimelineChunks();

    const dayClips = getDayClips();

    // If we're currently playing a recorded clip, check if it just got filtered out
    if (currentClipUrl) {
        const stillExists = dayClips.some(c => c.url === currentClipUrl);
        if (!stillExists) {
            if (currentDayString === getTodayString()) {
                fwGoLive();
            } else if (dayClips.length > 0) {
                // If viewing a past day, just jump to the oldest clip in the new window
                const first = dayClips[0];
                currentClipUrl = first.url;
                fwVideo.src = first.url;
                fwVideo.currentTime = 0;
                fwVideo.play().catch(e=>{});
            } else {
                fwVideo.pause();
                fwVideo.removeAttribute('src');
                fwVideo.load();
            }
        } else {
            // Force a timeupdate to recalibrate the orange indicator line visually
            fwVideo.dispatchEvent(new Event('timeupdate'));
        }
    }
}

// --- Canvas Snapshot Logic ---
function snapToCanvas() {
    if (fwVideo.readyState < 2 || !fwVideo.videoWidth) return;

    snapshotCanvas.width = fwVideo.videoWidth;
    snapshotCanvas.height = fwVideo.videoHeight;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(fwVideo, 0, 0, snapshotCanvas.width, snapshotCanvas.height);
    snapshotCanvas.style.display = 'block';
}

fwVideo.addEventListener('seeked', () => {
    if (targetClipUrl !== currentClipUrl) return;

    if (currentClipUrl !== null && targetClipUrl === currentClipUrl) {
        if (Math.abs(fwVideo.currentTime - targetClipOffset) > 0.1) {
            fwVideo.currentTime = targetClipOffset;
            return;
        }
    }

    if (snapshotCanvas.style.display === 'block') {
        if ('requestVideoFrameCallback' in fwVideo) {
            fwVideo.requestVideoFrameCallback(() => {
                snapshotCanvas.style.display = 'none';
            });
        } else {
            setTimeout(() => { snapshotCanvas.style.display = 'none'; }, 30);
        }
    }
});

fwVideo.addEventListener('playing', () => {
    if (snapshotCanvas.style.display === 'block') {
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

fwVideo.addEventListener('timeupdate', () => {
    if (fwIsScrubbing || !currentClipUrl) return;

    const dayClips = getDayClips();
    if (dayClips.length === 0) return;

    let accumOffset = 0;
    let playingClip = null;

    for (let clip of dayClips) {
        if (clip.url === currentClipUrl) {
            playingClip = clip;
            break;
        }
        accumOffset += clip.duration;
    }

    if (playingClip) {
        const absoluteSeconds = parseFilenameToSeconds(playingClip.filename) + fwVideo.currentTime;
        fwTimeLabel.innerText = secondsToTimeStr(absoluteSeconds);
        fwTimeLabel.style.color = "";

        const totalDuration = dayClips.reduce((sum, c) => sum + c.duration, 0);
        const progressPercentage = ((accumOffset + fwVideo.currentTime) / totalDuration) * 100;
        fwIndicator.style.left = `${progressPercentage}%`;
    }
});

// --- Manifest Logic ---
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
    } catch (e) {
        console.log("Could not load history manifest.");
    }
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
        chunk.style.backgroundColor = 'rgba(255, 255, 255, 0.25)';

        fwTimelineRegion.insertBefore(chunk, fwIndicator);
        accum += clip.duration;
    });
}

// --- Live Stream Logic ---
function fwGoLive() {
    fwTimeLabel.innerText = "LIVE";
    fwTimeLabel.style.color = "#4cd137";
    fwIndicator.style.left = '100%';

    if (scrubDebounceTimer) {
        clearTimeout(scrubDebounceTimer);
        scrubDebounceTimer = null;
    }

    fwVideo.onloadedmetadata = null;
    targetClipUrl = null;

    if (snapshotCanvas.style.display !== 'block') {
        snapToCanvas();
    }

    if (fwHlsPlayer) {
        fwHlsPlayer.destroy();
        fwHlsPlayer = null;
    }

    currentClipUrl = null;
    fwVideo.pause();
    fwVideo.removeAttribute('src');
    fwVideo.load();

    try { fwVideo.currentTime = 0; } catch(e){}

    fwOverlay.style.display = 'none';
    fwVideo.muted = true;

    const freshPlaylistUrl = `${baseDir}/${camId}/stream.m3u8?t=${Date.now()}`;

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        fwHlsPlayer = new Hls({
            xhrSetup: function(xhr) { xhr.withCredentials = true; },
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 10
        });

        fwHlsPlayer.attachMedia(fwVideo);
        fwHlsPlayer.on(Hls.Events.MEDIA_ATTACHED, () => fwHlsPlayer.loadSource(freshPlaylistUrl));
        fwHlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => fwVideo.play().catch(e=>{}));

        fwHlsPlayer.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        fwHlsPlayer.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        fwHlsPlayer.recoverMediaError();
                        break;
                    default:
                        fwHlsPlayer.destroy();
                        break;
                }
            }
        });
    } else if (fwVideo.canPlayType('application/vnd.apple.mpegurl')) {
        fwVideo.src = freshPlaylistUrl;
        fwVideo.play().catch(e=>{});
    }
}

// --- Highly Optimized Scrubber ---
function updateFwTimelineFromEvent(e) {
    const rect = fwTimelineRegion.getBoundingClientRect();
    let x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const scrubFraction = x / rect.width;

    if (currentDayString === getTodayString() && scrubFraction >= 0.99) {
        fwIndicator.style.left = '100%';

        if (currentClipUrl !== null) {
            if (scrubDebounceTimer) {
                clearTimeout(scrubDebounceTimer);
                scrubDebounceTimer = null;
            }
            fwGoLive();
        }
        return;
    }

    fwIndicator.style.left = `${scrubFraction * 100}%`;

    const dayClips = getDayClips();
    if (dayClips.length === 0) return;

    const totalDuration = dayClips.reduce((sum, c) => sum + c.duration, 0);
    const targetSeconds = scrubFraction * totalDuration;

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

    targetClipUrl = selectedClip.url;
    targetClipOffset = offsetInClip;

    if (currentClipUrl === selectedClip.url) {
        if (fwVideo.readyState > 1 && !fwVideo.seeking) {
            fwVideo.currentTime = targetClipOffset;
        }

        if (scrubDebounceTimer) {
            clearTimeout(scrubDebounceTimer);
            scrubDebounceTimer = null;
        }
    } else {
        if (snapshotCanvas.style.display !== 'block') {
            snapToCanvas();
        }

        if (fwHlsPlayer) {
            fwHlsPlayer.destroy();
            fwHlsPlayer = null;
            fwOverlay.style.display = 'none';
        }

        const executeSrcChange = () => {
            scrubDebounceTimer = null;
            lastSrcChangeTime = Date.now();
            currentClipUrl = selectedClip.url;
            fwVideo.src = selectedClip.url;

            fwVideo.onloadedmetadata = () => {
                if (currentClipUrl === selectedClip.url) {
                    fwVideo.currentTime = targetClipOffset;
                }
            };
        };

        const now = Date.now();
        if (now - lastSrcChangeTime > 150) {
            clearTimeout(scrubDebounceTimer);
            executeSrcChange();
        } else {
            clearTimeout(scrubDebounceTimer);
            scrubDebounceTimer = setTimeout(executeSrcChange, 150 - (now - lastSrcChangeTime));
        }
    }
}

fwTimelineRegion.addEventListener('pointerdown', (e) => {
    fwIsScrubbing = true;
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