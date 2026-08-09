const urlParams = new URLSearchParams(window.location.search);
const camId = urlParams.get('cam') || 'cam1';
const dateParam = urlParams.get('date');
const colorParam = urlParams.get('color');
let baseDir = './cameras';

// --- Global Metadata Cache ---
const vttCache = {};
const spriteImages = {};
const vttInFlight = new Map();

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

function secondsToHHMM(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseFilenameToSeconds(filename) {
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

const scaleSelect = document.getElementById('fw-scale-select');
const startSlider = document.getElementById('fw-start-slider');
const endSlider = document.getElementById('fw-end-slider');
const startVal = document.getElementById('start-val');
const endVal = document.getElementById('end-val');

let globalManifest = {};
let fwHlsPlayer = null;
let fwIsScrubbing = false;
let currentClipUrl = null;
let targetClipUrl = null;
let targetClipOffset = -1;
let currentLoadSession = 0;

let timelineStartSec = 0;
let timelineEndSec = 86400;

// --- Range & Boundary Logic ---
function getMaxSecOfTheDay() {
    if (currentDayString === getTodayString()) {
        const now = new Date();
        return (now.getHours() * 3600) + (now.getMinutes() * 60) + now.getSeconds();
    }
    const clips = globalManifest[camId] || [];
    let parsed = clips.filter(c => parseFilenameToSeconds(c.filename) !== null)
        .sort((a,b) => parseFilenameToSeconds(a.filename) - parseFilenameToSeconds(b.filename));

    if (parsed.length > 0) {
        const lastClip = parsed[parsed.length - 1];
        return parseFilenameToSeconds(lastClip.filename) + (lastClip.duration || 0);
    }
    return 86400;
}

function updateSliderMaxBounds() {
    const maxSec = getMaxSecOfTheDay();
    startSlider.max = maxSec;
    endSlider.max = maxSec;
}

function isEndSliderAtNow() {
    if (currentDayString !== getTodayString()) return false;
    const val = parseInt(endSlider.value, 10);
    const max = parseInt(endSlider.max, 10);
    return val >= (max - 60);
}

function updateSliderLabels() {
    startVal.innerText = secondsToHHMM(startSlider.value);
    if (isEndSliderAtNow()) {
        endVal.innerText = "NOW";
    } else {
        endVal.innerText = secondsToHHMM(endSlider.value);
    }
}

function getDayClips() {
    const clips = globalManifest[camId] || [];
    let parsed = clips.filter(c => parseFilenameToSeconds(c.filename) !== null)
        .sort((a,b) => parseFilenameToSeconds(a.filename) - parseFilenameToSeconds(b.filename));

    parsed = parsed.filter(c => {
        const clipStart = parseFilenameToSeconds(c.filename);
        const clipEnd = clipStart + (c.duration || 0);
        return clipEnd > timelineStartSec && clipStart < timelineEndSec;
    });

    return parsed;
}

function applyTimelineRange() {
    drawTimelineChunks();
    const dayClips = getDayClips();

    loadClipMetadata(dayClips);

    if (currentClipUrl) {
        const stillExists = dayClips.some(c => c.url === currentClipUrl);
        if (!stillExists) {
            if (isEndSliderAtNow()) {
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

function handleScaleChange() {
    const val = scaleSelect.value;
    const maxSec = getMaxSecOfTheDay();

    if (val === 'all') {
        timelineStartSec = 0;
        timelineEndSec = maxSec;
    } else if (val !== 'custom') {
        const scaleSeconds = parseInt(val, 10) * 3600;
        timelineEndSec = maxSec;
        timelineStartSec = Math.max(0, timelineEndSec - scaleSeconds);
    }

    startSlider.value = timelineStartSec;
    endSlider.value = timelineEndSec;
    updateSliderLabels();
    applyTimelineRange();
}

// Slider Interactivity Hooks
startSlider.addEventListener('input', () => {
    if (parseInt(startSlider.value, 10) >= parseInt(endSlider.value, 10)) {
        startSlider.value = parseInt(endSlider.value, 10) - 60;
    }
    updateSliderLabels();
});

startSlider.addEventListener('change', () => {
    timelineStartSec = parseInt(startSlider.value, 10);
    scaleSelect.value = 'custom';
    applyTimelineRange();
});

endSlider.addEventListener('input', () => {
    if (parseInt(endSlider.value, 10) <= parseInt(startSlider.value, 10)) {
        endSlider.value = parseInt(startSlider.value, 10) + 60;
    }
    updateSliderLabels();
});

endSlider.addEventListener('change', () => {
    if (isEndSliderAtNow()) {
        fwGoLive();
    } else {
        timelineEndSec = parseInt(endSlider.value, 10);
        scaleSelect.value = 'custom';
        applyTimelineRange();
    }
});

function getPlayheadAbsoluteSeconds(clips) {
    if (!clips || clips.length === 0) return 0;

    if (fwTimeLabel.innerText === "LIVE") {
        const lastClip = clips[clips.length - 1];
        return parseFilenameToSeconds(lastClip.filename) + (lastClip.duration || 0);
    }

    if (fwTimeLabel.innerText && fwTimeLabel.innerText !== "LOADING") {
        const parts = fwTimeLabel.innerText.split(':');
        if (parts.length === 3) {
            return (parseInt(parts[0], 10) * 3600) +
                (parseInt(parts[1], 10) * 60) +
                parseInt(parts[2], 10);
        }
    }

    const leftStyle = fwIndicator.style.left;
    const indicatorPct = leftStyle ? parseFloat(leftStyle) : 100;
    const totalDuration = clips.reduce((sum, c) => sum + (c.duration || 0), 0);
    const targetOffset = (indicatorPct / 100) * totalDuration;

    const firstClipSeconds = parseFilenameToSeconds(clips[0].filename);
    return firstClipSeconds + targetOffset;
}

// --- Canvas & Sprite Logic ---
function snapToCanvas() {
    if (fwVideo.readyState < 2 || !fwVideo.videoWidth) return;
    snapshotCanvas.width = fwVideo.videoWidth;
    snapshotCanvas.height = fwVideo.videoHeight;
    const ctx = snapshotCanvas.getContext('2d');
    ctx.drawImage(fwVideo, 0, 0, snapshotCanvas.width, snapshotCanvas.height);
    snapshotCanvas.classList.add('visible');
}

function renderSpriteFrame(clip, offset) {
    if (!clip) return false;

    const cues = vttCache[clip.url];
    const img = spriteImages[clip.sprite_url];

    if (cues && cues.length > 0 && img && img.complete && img.naturalWidth > 0) {
        let targetCue = cues[0];

        for (let i = 0; i < cues.length; i++) {
            if (offset >= cues[i].start && (i === cues.length - 1 || offset < cues[i+1].start)) {
                targetCue = cues[i];
                break;
            }
        }

        snapshotCanvas.width = 1920;
        snapshotCanvas.height = 1080;
        const ctx = snapshotCanvas.getContext('2d');

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, snapshotCanvas.width, snapshotCanvas.height);
        ctx.drawImage(img,
            targetCue.x, targetCue.y, targetCue.w, targetCue.h,
            0, 0, snapshotCanvas.width, snapshotCanvas.height
        );

        snapshotCanvas.classList.add('visible');
        return true;
    }
    return false;
}

// --- Video Sync Listeners ---
fwVideo.addEventListener('seeked', () => {
    if (targetClipUrl !== currentClipUrl || targetClipOffset < 0) return;

    const performCatchUp = () => {
        if (currentClipUrl !== null && targetClipUrl === currentClipUrl) {
            if (targetClipOffset >= 0 && Math.abs(fwVideo.currentTime - targetClipOffset) > 0.1) {
                const target = targetClipOffset;
                targetClipOffset = -1;
                fwVideo.currentTime = target;
            } else {
                targetClipOffset = -1;
            }
        }
    };

    if ('requestVideoFrameCallback' in fwVideo) {
        fwVideo.requestVideoFrameCallback(() => {
            snapshotCanvas.classList.remove('visible');
            setTimeout(performCatchUp, 50);
        });
    } else {
        snapshotCanvas.classList.remove('visible');
        setTimeout(performCatchUp, 50);
    }
});

fwVideo.addEventListener('playing', () => {
    if (snapshotCanvas.classList.contains('visible')) {
        snapshotCanvas.classList.remove('visible');
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
        fwTimeLabel.classList.remove('time-live', 'time-scrub');

        const totalDuration = dayClips.reduce((sum, c) => sum + c.duration, 0);
        const progressPercentage = ((accumOffset + fwVideo.currentTime) / totalDuration) * 100;
        fwIndicator.style.left = `${progressPercentage}%`;
    }
});

// --- Background Data Loaders ---
async function loadClipMetadata(clips) {
    const session = ++currentLoadSession;

    if (currentDayString === getTodayString() && fwTimeLabel.innerText === "LIVE") {
        await new Promise(r => setTimeout(r, 800));
    }

    const PARALLEL_BATCH_SIZE = 4;

    clips.forEach((c, i) => {
        if (c._index === undefined) c._index = i;
    });

    while (true) {
        if (session !== currentLoadSession) break;

        let allComplete = true;

        for (const clip of clips) {
            const hasVtt = !!vttCache[clip.url];
            const hasSprite = spriteImages[clip.sprite_url] && spriteImages[clip.sprite_url].complete;

            if (hasVtt && hasSprite) {
                const chunkEl = document.querySelector(`.fw-timeline-chunk[data-url="${clip.url}"]`);
                if (chunkEl && !chunkEl.classList.contains('chunk-loaded')) {
                    chunkEl.classList.add('chunk-loaded');
                }
            } else {
                allComplete = false;
            }
        }

        if (allComplete) break;

        const pendingClips = clips.filter(c =>
            (c.sprite_url && (!spriteImages[c.sprite_url] || !spriteImages[c.sprite_url].complete)) ||
            (c.vtt_url && !vttCache[c.url])
        );

        if (pendingClips.length === 0) {
            await new Promise(r => setTimeout(r, 200));
            continue;
        }

        const playheadTime = getPlayheadAbsoluteSeconds(clips);
        pendingClips.sort((a, b) => {
            const aCenter = parseFilenameToSeconds(a.filename) + ((a.duration || 0) / 2);
            const bCenter = parseFilenameToSeconds(b.filename) + ((b.duration || 0) / 2);

            const aDist = Math.abs(aCenter - playheadTime);
            const bDist = Math.abs(bCenter - playheadTime);

            const getTier = (clip, dist) => {
                if (dist < 300) return 0;
                if (clip._index % 10 === 0) return 1;
                if (clip._index % 5 === 0) return 2;
                return 3;
            };

            const aTier = getTier(a, aDist);
            const bTier = getTier(b, bDist);

            if (aTier !== bTier) {
                return aTier - bTier;
            }
            return aDist - bDist;
        });

        const batch = pendingClips.slice(0, PARALLEL_BATCH_SIZE);
        const batchPromises = [];

        for (const targetClip of batch) {
            if (targetClip.sprite_url) {
                if (!spriteImages[targetClip.sprite_url]) {
                    const img = new Image();
                    const p = new Promise(resolve => {
                        img.onload = resolve;
                        img.onerror = resolve;
                    });
                    img.src = targetClip.sprite_url;
                    img._loadPromise = p;
                    spriteImages[targetClip.sprite_url] = img;
                    batchPromises.push(p);
                } else if (!spriteImages[targetClip.sprite_url].complete) {
                    if (spriteImages[targetClip.sprite_url]._loadPromise) {
                        batchPromises.push(spriteImages[targetClip.sprite_url]._loadPromise);
                    }
                }
            }

            if (targetClip.vtt_url && !vttCache[targetClip.url]) {
                if (!vttInFlight.has(targetClip.url)) {
                    const p = (async () => {
                        try {
                            const resp = await fetch(targetClip.vtt_url);
                            if (!resp.ok) throw new Error("Fetch failed");
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
                            vttCache[targetClip.url] = cues;
                        } catch (e) {
                            console.error("Failed to load VTT for", targetClip.url, e);
                            vttCache[targetClip.url] = [];
                        } finally {
                            vttInFlight.delete(targetClip.url);
                        }
                    })();

                    vttInFlight.set(targetClip.url, p);
                    batchPromises.push(p);
                } else {
                    batchPromises.push(vttInFlight.get(targetClip.url));
                }
            }
        }

        if (batchPromises.length > 0) {
            await Promise.allSettled(batchPromises);
        } else {
            await new Promise(r => setTimeout(r, 100));
        }
    }
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

        updateSliderMaxBounds();
        handleScaleChange();

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
        chunk.setAttribute('data-url', clip.url);
        chunk.style.left = `${startPct}%`;
        chunk.style.width = `${widthPct}%`;

        if (vttCache[clip.url] && spriteImages[clip.sprite_url]?.complete) {
            chunk.classList.add('chunk-loaded');
        }

        fwTimelineRegion.insertBefore(chunk, fwIndicator);
        accum += clip.duration;
    });
}

function fwGoLive() {
    fwTimeLabel.innerText = "LIVE";
    fwTimeLabel.classList.remove('time-scrub');
    fwTimeLabel.classList.add('time-live');
    fwIndicator.style.left = '100%';

    fwVideo.onloadedmetadata = null;
    targetClipUrl = null;

    if (!snapshotCanvas.classList.contains('visible')) {
        snapToCanvas();
    }

    if (fwHlsPlayer) {
        fwHlsPlayer.destroy();
        fwHlsPlayer = null;
    }

    currentClipUrl = null;

    updateSliderMaxBounds();
    const maxSec = getMaxSecOfTheDay();
    timelineEndSec = maxSec;

    if (scaleSelect.value !== 'custom' && scaleSelect.value !== 'all') {
        timelineStartSec = Math.max(0, timelineEndSec - (parseInt(scaleSelect.value, 10) * 3600));
    } else if (scaleSelect.value === 'all') {
        timelineStartSec = 0;
    } else {
        const currentSpan = parseInt(endSlider.value, 10) - parseInt(startSlider.value, 10);
        timelineStartSec = Math.max(0, maxSec - currentSpan);
    }

    startSlider.value = timelineStartSec;
    endSlider.value = timelineEndSec;
    updateSliderLabels();

    drawTimelineChunks();
    loadClipMetadata(getDayClips());

    fwVideo.pause();
    fwVideo.removeAttribute('src');
    fwVideo.load();

    try { fwVideo.currentTime = 0; } catch(e){}

    fwOverlay.classList.add('hidden');
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
    targetClipOffset = offsetInClip; // FIX: Ensure this resets smoothly on every new scrub

    if (currentClipUrl === selectedClip.url) {
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

    const isAtNow = isEndSliderAtNow();

    if (isAtNow && target.scrubFraction >= 0.99) {
        fwIndicator.style.left = '100%';
        fwTimeLabel.innerText = "LIVE";
        fwTimeLabel.classList.remove('time-scrub');
        fwTimeLabel.classList.add('time-live');
        return;
    }

    fwIndicator.style.left = `${target.scrubFraction * 100}%`;
    fwTimeLabel.innerText = secondsToTimeStr(target.actualSec);
    fwTimeLabel.classList.remove('time-live');
    fwTimeLabel.classList.add('time-scrub');

    if (!isRelease) {
        renderSpriteFrame(target.selectedClip, target.offsetInClip);
    } else {
        applyVideoScrub(target.selectedClip, target.offsetInClip);
    }
}

fwTimelineRegion.addEventListener('pointerdown', (e) => {
    fwIsScrubbing = true;
    fwVideo.pause();
    fwTimelineRegion.setPointerCapture(e.pointerId);

    if (!snapshotCanvas.classList.contains('visible')) {
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

    const isAtNow = isEndSliderAtNow();

    if (isAtNow && (x / rect.width) >= 0.99) {
        fwGoLive();
    } else {
        setTimeout(() => {
            fwVideo.play().catch(e => {});
        }, 50);
    }
});

window.addEventListener('resize', () => {
    if (!fwIsScrubbing) updateSliderLabels();
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