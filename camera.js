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
        const response = await fetch('./recordings/history.json', { cache: 'no-store', credentials: 'include' });
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

        // Trigger background caching immediately on load
        const dayClips = (globalManifest[camId] || []).filter(c => parseFilenameToSeconds(c.filename) !== null);
        preloadDayClips(dayClips);
        drawTimelineChunks();

    } catch (e) {
        console.log("Could not load history manifest.");
    }
}

// --- Background Caching ---
function preloadDayClips(clips) {
    clips.forEach(clip => {
        if (clip.url) {
            fetch(clip.url, { cache: 'force-cache' })
                .then(response => {
                    if (response.ok || response.status === 304 || response.status === 206) {
                        clip.isCached = true;
                        drawTimelineChunks(); 
                    }
                })
                .catch(() => {
                    console.log(`Failed to pre-cache: ${clip.filename}`);
                });
        }
    });
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
            if (fwVideo.videoWidth > 0 && fwVideo.videoHeight > 0) {
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

        const removeSnapshot = () => {
            snap.style.display = 'none';
            fwVideo.removeEventListener('timeupdate', removeSnapshot);
        };
        fwVideo.addEventListener('timeupdate', removeSnapshot);

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