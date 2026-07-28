const urlParams = new URLSearchParams(window.location.search);
const camId = urlParams.get('cam') || 'cam1';
const dateParam = urlParams.get('date');
const colorParam = urlParams.get('color');
let baseDir = './cameras';

// --- Global Metadata Cache ---
const vttCache = {}; // clipUrl -> Array of cue objects
const spriteImages = {}; // spriteUrl -> Preloaded Image object

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

function parseVTTTime(timeStr) {
    const parts = timeStr.split(':');
    const secParts = parts[2].split('.');
    return (parseInt(parts[0], 10) * 3600) +
        (parseInt(parts[1], 10) * 60) +
        parseInt(secParts[0], 10) +
        (parseInt(secParts[1], 10) / 1000);
}

function secondsToTimeStr(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseFilenameToSeconds(filename) {
    // Changed regex to look for .m3u8
    const match = filename.match(/_(\d{8})_(\d{2})(\d{2})(\d{2})\.m3u8/);
    if (!match) return null;
    const h = parseInt(match[2], 10);
    const m = parseInt(match[3], 10);
    const s = parseInt(match[4], 10);
    return (h * 3600) + (m * 60) + s;
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
let targetClipUrl = null;
let targetClipOffset = 0;

function getDayClips() {
    const clips = globalManifest[camId] || [];
    let parsed = clips.filter(c => parseFilenameToSeconds(c.filename) !== null)
        .sort((a,b) => parseFilenameToSeconds(a.filename) - parseFilenameToSeconds(b.filename));

    const scaleSelect = document.getElementById('fw-scale-select');
    if (scaleSelect && scaleSelect.value !== 'all' && parsed.length > 0) {
        const scaleHours = parseInt(scaleSelect.value, 10);
        const scaleSeconds = scaleHours * 3600;

        const lastClip = parsed[parsed.length - 1];
        const lastClipEnd = parseFilenameToSeconds(lastClip.filename) + (lastClip.duration || 0);
        const startTime = Math.max(0, lastClipEnd - scaleSeconds);

        parsed = parsed.filter(c => {
            const clipStart = parseFilenameToSeconds(c.filename);
            const clipEnd = clipStart + (c.duration || 0);
            return clipEnd > startTime;
        });
    }
    return parsed;
}

function handleScaleChange() {
    drawTimelineChunks();
    const dayClips = getDayClips();

    if (currentClipUrl) {
        const stillExists = dayClips.some(c => c.url === currentClipUrl);
        if (!stillExists) {
            if (currentDayString === getTodayString()) {
                fwGoLive();
            } else if (dayClips.length > 0) {
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
            fwVideo.dispatchEvent(new Event('timeupdate'));
        }
    }
}

// --- Canvas & Sprite Logic ---
function snapToCanvas() {
    if (fwVideo.readyState < 2 || !fwVideo.videoWidth) return;
    snapshotCanvas.width = fwVideo.videoWidth;
    snapshotCanvas.height = fwVideo.videoHeight;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(fwVideo, 0, 0, snapshotCanvas.width, snapshotCanvas.height);
    snapshotCanvas.style.display = 'block';
}

function renderSpriteFrame(clip, offset) {
    if (!clip) return false;

    const cues = vttCache[clip.url];
    const img = spriteImages[clip.sprite_url];

    if (cues && cues.length > 0 && img && img.complete && img.naturalWidth > 0) {
        let targetCue = cues[0];

        // Locate the correct sprite tile based on the VTT timestamps
        for (let i = 0; i < cues.length; i++) {
            if (offset >= cues[i].start && (i === cues.length - 1 || offset < cues[i+1].start)) {
                targetCue = cues[i];
                break;
            }
        }

        // Establish a fixed high-res aspect ratio canvas to keep scaling crisp
        snapshotCanvas.width = 1920;
        snapshotCanvas.height = 1080;
        const ctx = snapshotCanvas.getContext('2d');

        // Fill black background to prevent edge-bleeding
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, snapshotCanvas.width, snapshotCanvas.height);

        // Crop the 160x90 tile from the massive sprite sheet and stretch it over the canvas
        ctx.drawImage(img,
            targetCue.x, targetCue.y, targetCue.w, targetCue.h,
            0, 0, snapshotCanvas.width, snapshotCanvas.height
        );

        snapshotCanvas.style.display = 'block';
        return true;
    }
    return false;
}

// --- Video Sync Listeners ---
fwVideo.addEventListener('seeked', () => {
    if (targetClipUrl !== currentClipUrl) return;

    const performCatchUp = () => {
        if (currentClipUrl !== null && targetClipUrl === currentClipUrl) {
            if (Math.abs(fwVideo.currentTime - targetClipOffset) > 0.1) {
                fwVideo.currentTime = targetClipOffset;
            }
        }
    };

    if ('requestVideoFrameCallback' in fwVideo) {
        fwVideo.requestVideoFrameCallback(() => {
            snapshotCanvas.style.display = 'none';
            setTimeout(performCatchUp, 50);
        });
    } else {
        snapshotCanvas.style.display = 'none';
        setTimeout(performCatchUp, 50);
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

// --- Background Data Loaders ---
async function loadClipMetadata(clips) {
    const promises = clips.map(async clip => {
        const tasks = [];

        // 1. Wrap the image load in a Promise to track its completion
        if (clip.sprite_url && !spriteImages[clip.sprite_url]) {
            tasks.push(new Promise((resolve) => {
                const img = new Image();
                img.onload = resolve;
                img.onerror = resolve; // Resolve on error so a failed image doesn't block the UI
                img.src = clip.sprite_url;
                spriteImages[clip.sprite_url] = img;
            }));
        }

        // 2. Push the VTT fetch into the tasks array
        if (clip.vtt_url && !vttCache[clip.url]) {
            tasks.push((async () => {
                try {
                    const resp = await fetch(clip.vtt_url);
                    const text = await resp.text();
                    const cues = [];
                    const regex = /(\d{2}:\d{2}:\d{2}\.\d{3})\s-->\s(\d{2}:\d{2}:\d{2}\.\d{3})\s+.*?#xywh=(\d+),(\d+),(\d+),(\d+)/g;
                    let match;
                    while ((match = regex.exec(text)) !== null) {
                        cues.push({
                            start: parseVTTTime(match[1]),
                            end: parseVTTTime(match[2]),
                            x: parseInt(match[3], 10),
                            y: parseInt(match[4], 10),
                            w: parseInt(match[5], 10),
                            h: parseInt(match[6], 10)
                        });
                    }
                    vttCache[clip.url] = cues;
                } catch (e) {
                    console.error("Failed to load VTT for", clip.url, e);
                }
            })());
        }

        // Wait for both the image and the VTT for this specific clip to finish
        await Promise.all(tasks);
    });

    // Wait for all clips to complete their background loading
    await Promise.allSettled(promises);
}

async function fetchManifest() {
    try {
        const url = `/history?date=${currentDayString}&cam=${camId}`;
        const response = await fetch(url, { cache: 'no-store', credentials: 'include' });
        const newManifest = await response.json();

        Object.keys(newManifest).forEach(id => {
            newManifest[id].sort((a, b) => (parseFilenameToSeconds(a.filename) || 0) - (parseFilenameToSeconds(b.filename) || 0));
        });
        globalManifest = newManifest;

        // Reset the timeline color when pulling new data
        fwTimelineRegion.classList.remove('sprites-loaded');

        if (newManifest[camId]) {
            // Apply the green background once all metadata and sprites have successfully loaded
            loadClipMetadata(newManifest[camId]).then(() => {
                fwTimelineRegion.classList.add('sprites-loaded');
            });
        }

        drawTimelineChunks();
    } catch (e) {
        console.log("Could not load history manifest.");
    }
}

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

function fwGoLive() {
    fwTimeLabel.innerText = "LIVE";
    fwTimeLabel.style.color = "#4cd137";
    fwIndicator.style.left = '100%';

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

// --- Refactored Zero-Load Scrubber ---
function calculateScrubTarget(e) {
    const rect = fwTimelineRegion.getBoundingClientRect();
    let x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const scrubFraction = x / rect.width;

    const dayClips = getDayClips();
    if (dayClips.length === 0) return null;

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

    return {
        scrubFraction,
        selectedClip,
        offsetInClip,
        actualSec: parseFilenameToSeconds(selectedClip.filename) + offsetInClip
    };
}

function applyVideoScrub(selectedClip, offsetInClip) {
    targetClipUrl = selectedClip.url;
    targetClipOffset = offsetInClip;

    if (currentClipUrl === selectedClip.url) {
        // If we are scrubbing within the same clip, just seek.
        if (fwVideo.readyState > 1) {
            fwVideo.currentTime = targetClipOffset;
        }
    } else {
        currentClipUrl = selectedClip.url;

        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            if (fwHlsPlayer) {
                fwHlsPlayer.destroy();
            }

            fwHlsPlayer = new Hls({
                manifestLoadingMaxRetry: 5,
                xhrSetup: function(xhr) { xhr.withCredentials = true; }
            });

            fwHlsPlayer.loadSource(selectedClip.url);
            fwHlsPlayer.attachMedia(fwVideo);

            fwHlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
                if (currentClipUrl === selectedClip.url) {
                    fwVideo.currentTime = targetClipOffset;
                }
            });
        } else if (fwVideo.canPlayType('application/vnd.apple.mpegurl')) {
            // Native Safari fallback
            fwVideo.src = selectedClip.url;
            fwVideo.load();
            fwVideo.onloadedmetadata = () => {
                if (currentClipUrl === selectedClip.url) {
                    fwVideo.currentTime = targetClipOffset;
                }
            };
        }
    }
}

function updateFwTimelineFromEvent(e, isRelease = false) {
    const target = calculateScrubTarget(e);
    if (!target) return;

    if (currentDayString === getTodayString() && target.scrubFraction >= 0.99) {
        fwIndicator.style.left = '100%';
        fwTimeLabel.innerText = "LIVE";
        fwTimeLabel.style.color = "#4cd137";
        return;
    }

    fwIndicator.style.left = `${target.scrubFraction * 100}%`;
    fwTimeLabel.innerText = secondsToTimeStr(target.actualSec);
    fwTimeLabel.style.color = "#f39c12";

    if (!isRelease) {
        // Fast UI interaction: Draw the nearest I-Frame to the canvas and bypass the video file
        renderSpriteFrame(target.selectedClip, target.offsetInClip);
    } else {
        // load the HLS playlist
        applyVideoScrub(target.selectedClip, target.offsetInClip);
    }
}

fwTimelineRegion.addEventListener('pointerdown', (e) => {
    fwIsScrubbing = true;
    fwVideo.pause();
    fwTimelineRegion.setPointerCapture(e.pointerId);

    if (snapshotCanvas.style.display !== 'block') {
        snapToCanvas();
    }

    updateFwTimelineFromEvent(e, false);
});

fwTimelineRegion.addEventListener('pointermove', (e) => {
    if (fwIsScrubbing) {
        updateFwTimelineFromEvent(e, false);
    }
});

fwTimelineRegion.addEventListener('pointerup', (e) => {
    fwIsScrubbing = false;
    fwTimelineRegion.releasePointerCapture(e.pointerId);

    updateFwTimelineFromEvent(e, true);

    const rect = fwTimelineRegion.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    if (currentDayString === getTodayString() && (x / rect.width) >= 0.99) {
        fwGoLive();
        return;
    }

    // Unconditionally resume playback after dropping the scrubber
    setTimeout(() => {
        fwVideo.play().catch(e => {});
    }, 50);
});

document.addEventListener('DOMContentLoaded', async () => {
    await fetchManifest();

    if (dateParam && dateParam !== getTodayString()) {
        fwTimeLabel.innerText = "LOADING";
        setTimeout(() => updateFwTimelineFromEvent({ clientX: 0 }, true), 300);
    } else {
        fwGoLive();
    }
});