// Extract target camera and date from URL
const urlParams = new URLSearchParams(window.location.search);
const camId = urlParams.get('cam') || 'cam1';
const dateParam = urlParams.get('date');

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
const fwOverlay = document.getElementById('fw-overlay');
const fwTimelineRegion = document.getElementById('fw-timeline-region');
const fwIndicator = document.getElementById('fw-timeline-indicator');
const fwTimeLabel = document.getElementById('fw-time-label');

let globalManifest = {};
let fwHlsPlayer = null;
let fwIsScrubbing = false;
let lastScrubUpdate = 0;
let fwPendingSeekTime = null;

// --- Seamless Transition Snapshot Canvas ---
let snapshotCanvas = null;
function getSnapshotCanvas() {
    if (!snapshotCanvas) {
        snapshotCanvas = document.createElement('canvas');
        snapshotCanvas.id = 'fw-snapshot';
        snapshotCanvas.style.position = 'absolute';
        snapshotCanvas.style.top = '0';
        snapshotCanvas.style.left = '0';
        snapshotCanvas.style.width = '100%';
        snapshotCanvas.style.height = '100%';
        snapshotCanvas.style.objectFit = 'contain';
        snapshotCanvas.style.zIndex = '5';
        snapshotCanvas.style.pointerEvents = 'none';
        snapshotCanvas.style.display = 'none';
        fwVideo.parentElement.appendChild(snapshotCanvas);
    }
    return snapshotCanvas;
}

// Only apply the next time update AFTER the browser has finished painting the current frame
fwVideo.addEventListener('seeked', () => {
    if (fwPendingSeekTime !== null) {
        const timeToSeek = fwPendingSeekTime;
        fwPendingSeekTime = null;
        fwVideo.currentTime = timeToSeek;
    }
});

function secondsToTimeStr(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseFilenameToSeconds(filename) {
    const match = filename.match(/_(\d{8})_(\d{2})(\d{2})(\d{2})\.mp4/);
    if (!match) return null;
    if (match[1] !== currentDayString) return null;

    const h = parseInt(match[2], 10);
    const m = parseInt(match[3], 10);
    const s = parseInt(match[4], 10);
    return (h * 3600) + (m * 60) + s;
}

function extractTimeFromFilename(filename) {
    const match = filename.match(/_(\d{8})_(\d{2})(\d{2})(\d{2})\.mp4/);
    if (!match) return null;
    return (parseInt(match[2], 10) * 3600) + (parseInt(match[3], 10) * 60) + parseInt(match[4], 10);
}

// --- Manifest Logic ---
async function fetchManifest() {
    try {
        const url = `/history?date=${currentDayString}&cam=${camId}`;

        const response = await fetch(url, { cache: 'no-store', credentials: 'include' });
        const newManifest = await response.json();

        Object.keys(newManifest).forEach(id => {
            const clips = newManifest[id];
            clips.sort((a, b) => (extractTimeFromFilename(a.filename) || 0) - (extractTimeFromFilename(b.filename) || 0));

            for (let i = 0; i < clips.length; i++) {
                const clip = clips[i];
                if (!clip.duration) {
                    let guessedDur = 60;
                    if (i < clips.length - 1) {
                        const matchA = clip.filename.match(/_(\d{8})_/);
                        const matchB = clips[i+1].filename.match(/_(\d{8})_/);
                        if (matchA && matchB && matchA[1] === matchB[1]) {
                            const aTime = extractTimeFromFilename(clip.filename);
                            const bTime = extractTimeFromFilename(clips[i+1].filename);
                            if (aTime !== null && bTime !== null) {
                                const delta = bTime - aTime;
                                if (delta > 0 && delta <= 60) guessedDur = delta;
                            }
                        }
                    }
                    clip.duration = guessedDur;
                }
            }
        });
        globalManifest = newManifest;

        const dayClips = (globalManifest[camId] || []).filter(c => parseFilenameToSeconds(c.filename) !== null);

        // Draw timeline immediately so the user sees the grey track structure
        drawTimelineChunks();

        // Delay background preloading by 2.5 seconds so HLS can connect without contention
        setTimeout(() => {
            startDistributedPreload(dayClips);
        }, 2500);

    } catch (e) {
        console.log("Could not load history manifest.");
    }
}

// --- Background Caching Manager ---
let preloadQueue = [];
let isPreloading = false;

// Bisection algorithm to generate an evenly distributed sequence of indices
function getDistributedIndices(length) {
    if (length <= 0) return [];
    if (length === 1) return [0];

    const indices = [0, length - 1];
    const queue = [{start: 0, end: length - 1}];

    while(queue.length > 0) {
        const {start, end} = queue.shift();
        if (end - start > 1) {
            const mid = Math.floor((start + end) / 2);
            if (!indices.includes(mid)) {
                indices.push(mid);
                // Queue up the two new subdivisions (halves -> quarters -> eighths)
                queue.push({start: start, end: mid});
                queue.push({start: mid, end: end});
            }
        }
    }
    return indices;
}

function startDistributedPreload(clips) {
    // Only queue clips that aren't already cached
    const toPreload = clips.filter(c => c.url && !c.isCached);
    if (toPreload.length === 0) return;

    const distribution = getDistributedIndices(toPreload.length);
    preloadQueue = distribution.map(i => toPreload[i]);

    if (!isPreloading) {
        processPreloadQueue();
    }
}

async function processPreloadQueue() {
    if (preloadQueue.length === 0) {
        isPreloading = false;
        return;
    }

    isPreloading = true;
    const clip = preloadQueue.shift();

    // Check again in case native scrubbing cached it while it was waiting in the queue
    if (!clip.isCached) {
        try {
            // Fetch one at a time. The 'priority: low' flag tells modern browsers 
            // to yield this connection if user-initiated media requests occur.
            const response = await fetch(clip.url, {
                cache: 'force-cache',
                priority: 'low'
            });

            if (response.ok || response.status === 304 || response.status === 206) {
                clip.isCached = true;
                drawTimelineChunks();
            }
        } catch (e) {
            console.log(`Failed to pre-cache: ${clip.filename}`);
        }
    }

    // 500ms delay to let the browser connection pool breathe
    setTimeout(processPreloadQueue, 500);
}

// --- Timeline Visualizer ---
function drawTimelineChunks() {
    document.querySelectorAll('.fw-timeline-chunk').forEach(el => el.remove());

    const clips = globalManifest[camId] || [];
    const dayClips = clips.filter(c => parseFilenameToSeconds(c.filename) !== null)
        .sort((a,b) => parseFilenameToSeconds(a.filename) - parseFilenameToSeconds(b.filename));

    if (dayClips.length === 0) return;

    const totalDuration = dayClips.reduce((sum, c) => sum + (c.duration || 60), 0);
    let accum = 0;

    dayClips.forEach(clip => {
        const startPct = (accum / totalDuration) * 100;
        const widthPct = ((clip.duration || 60) / totalDuration) * 100;

        const chunk = document.createElement('div');
        chunk.className = 'fw-timeline-chunk';
        chunk.style.left = `${startPct}%`;
        chunk.style.width = `${widthPct}%`;
        chunk.style.backgroundColor = clip.isCached ? 'rgba(46, 204, 113, 0.6)' : 'rgba(255, 255, 255, 0.15)';

        fwTimelineRegion.insertBefore(chunk, fwIndicator);
        accum += (clip.duration || 60);
    });
}

// --- Video Stream Logic ---
function fwGoLive() {
    fwTimeLabel.innerText = "LIVE";
    fwTimeLabel.style.color = "#4cd137";
    fwIndicator.style.left = '100%';

    if (snapshotCanvas) snapshotCanvas.style.display = 'none';

    if (fwHlsPlayer) {
        fwHlsPlayer.destroy();
        fwHlsPlayer = null;
    }

    fwVideo.pause();
    fwVideo.removeAttribute('src');
    fwVideo.currentTime = 0;
    fwVideo.load();

    fwOverlay.style.display = 'none';
    fwVideo.style.display = 'block';

    const freshPlaylistUrl = `./cameras/${camId}/stream.m3u8?t=${Date.now()}`;

    if (Hls.isSupported()) {
        fwHlsPlayer = new Hls({
            maxMaxBufferLength: 600,
            maxBufferLength: 600,
            maxBufferSize: 150 * 1024 * 1024,
            liveDurationInfinity: true,
            backBufferLength: Infinity,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 10,
            xhrSetup: function(xhr) { xhr.withCredentials = true; }
        });

        fwHlsPlayer.attachMedia(fwVideo);

        fwHlsPlayer.on(Hls.Events.MEDIA_ATTACHED, () => {
            fwHlsPlayer.loadSource(freshPlaylistUrl);
        });

        fwHlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
            fwVideo.play().catch(e => console.error("Live play error:", e));
        });
    } else if (fwVideo.canPlayType('application/vnd.apple.mpegurl')) {
        fwVideo.src = freshPlaylistUrl;
        fwVideo.play().catch(e => {});
    }
}

// --- Smart Scrubber Logic ---
function updateFwTimelineFromEvent(e) {
    const rect = fwTimelineRegion.getBoundingClientRect();
    let x = e.clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    const pct = x / rect.width;

    fwIndicator.style.left = `${pct * 100}%`;

    const clips = globalManifest[camId] || [];
    const dayClips = clips.filter(c => parseFilenameToSeconds(c.filename) !== null)
        .sort((a,b) => parseFilenameToSeconds(a.filename) - parseFilenameToSeconds(b.filename));

    if (dayClips.length === 0) {
        fwTimeLabel.innerText = "NO DATA";
        fwTimeLabel.style.color = "#666";
        return;
    }

    const totalDuration = dayClips.reduce((sum, c) => sum + (c.duration || 60), 0);
    const targetContinuousSeconds = pct * totalDuration;

    let accum = 0;
    let selectedClip = dayClips[dayClips.length - 1];
    let offsetInClip = (selectedClip.duration || 60);

    for (let clip of dayClips) {
        let dur = clip.duration || 60;
        if (targetContinuousSeconds <= accum + dur) {
            selectedClip = clip;
            offsetInClip = targetContinuousSeconds - accum;
            break;
        }
        accum += dur;
    }

    const realStartSec = parseFilenameToSeconds(selectedClip.filename);
    const actualDaySec = realStartSec + offsetInClip;

    fwTimeLabel.innerText = secondsToTimeStr(actualDaySec);
    fwTimeLabel.style.color = "#f39c12";

    if (fwHlsPlayer) {
        fwHlsPlayer.destroy();
        fwHlsPlayer = null;
        drawTimelineChunks();
    }

    if (!fwVideo.src.includes(selectedClip.url.replace('./', ''))) {
        // Capture snapshot to prevent black flash
        const snap = getSnapshotCanvas();
        try {
            // readyState >= 2 ensures we don't draw a blank frame if scrubbing extremely fast
            if (fwVideo.readyState >= 2 && fwVideo.videoWidth > 0) {
                snap.width = fwVideo.videoWidth;
                snap.height = fwVideo.videoHeight;
                const ctx = snap.getContext('2d');
                ctx.drawImage(fwVideo, 0, 0, snap.width, snap.height);
                snap.style.display = 'block';
            }
        } catch (err) {
            snap.style.display = 'none';
        }

        fwPendingSeekTime = null;
        fwVideo.src = selectedClip.url;
        fwVideo.style.display = 'block';
        fwOverlay.style.display = 'none';

        fwVideo.onloadedmetadata = () => {
            if (fwVideo.duration > 0 && fwVideo.duration !== Infinity) {
                selectedClip.duration = fwVideo.duration;
            }
            const safeOffset = Math.min(offsetInClip, selectedClip.duration);
            fwVideo.currentTime = safeOffset;
        };

        // --- THE FIX: Rock-solid snapshot removal ---
        const removeSnapshot = () => {
            // Double requestAnimationFrame forces the browser to wait until 
            // the new video frame is physically painted to the monitor.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    snap.style.display = 'none';
                });
            });
            fwVideo.removeEventListener('seeked', removeSnapshot);
            fwVideo.removeEventListener('playing', removeSnapshot);
        };

        // Listen for 'seeked' instead of 'timeupdate'
        fwVideo.addEventListener('seeked', removeSnapshot);
        fwVideo.addEventListener('playing', removeSnapshot);

        if (!fwIsScrubbing) {
            fwVideo.play().catch(e=>{});
        } else {
            fwVideo.pause();
        }
    } else {
        fwVideo.style.display = 'block';
        fwOverlay.style.display = 'none';
        const safeOffset = Math.min(offsetInClip, selectedClip.duration);

        if (Math.abs(fwVideo.currentTime - safeOffset) > 0.5 || fwIsScrubbing) {
            if (fwVideo.seeking) {
                fwPendingSeekTime = safeOffset;
            } else {
                fwVideo.currentTime = safeOffset;
            }
        }
    }
}

fwTimelineRegion.addEventListener('pointerdown', (e) => {
    fwIsScrubbing = true;
    fwTimelineRegion.setPointerCapture(e.pointerId);
    updateFwTimelineFromEvent(e);
});

fwTimelineRegion.addEventListener('pointermove', (e) => {
    if (fwIsScrubbing) {
        const now = Date.now();
        if (now - lastScrubUpdate > 60) {
            updateFwTimelineFromEvent(e);
            lastScrubUpdate = now;
        }
    }
});

fwTimelineRegion.addEventListener('pointerup', (e) => {
    fwIsScrubbing = false;
    fwTimelineRegion.releasePointerCapture(e.pointerId);

    if (snapshotCanvas) snapshotCanvas.style.display = 'none';

    if (!fwHlsPlayer && fwVideo.src) {
        fwVideo.play().catch(e=>{});
    }
});

// Start up
document.addEventListener('DOMContentLoaded', async () => {
    await fetchManifest();

    if (dateParam && dateParam !== getTodayString()) {
        fwHlsPlayer = null;
        fwTimeLabel.innerText = "LOADING";

        setTimeout(() => {
            const mockEvent = { clientX: fwTimelineRegion.getBoundingClientRect().left };
            updateFwTimelineFromEvent(mockEvent);
        }, 300);
    } else {
        fwGoLive();
    }
});