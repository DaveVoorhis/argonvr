// SPA Isolation Wrapper
(function() {

    let camId = 'cam1';
    let dateParam = null;
    let colorParam = null;

    // vttCache, spriteImages, baseDir, and window.networkMonitor inherit cleanly from script.js global scope
    const vttInFlight = new Map();

    // Helper Functions
    function getTodayString() {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        return `${yyyy}${mm}${dd}`;
    }

    let currentDayString = getTodayString();

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
    let isViewActive = false;
    let currentClipUrl = null;
    let targetClipUrl = null;
    let targetClipOffset = -1;
    let currentLoadSession = 0;
    let pointerScrubRafId = null;
    let priorityClipUrl = null;
    let activeLiveSubStream = false;

    let timelineStartSec = 0;
    let timelineEndSec = 86400;

    function getNetTier() {
        return (window.networkMonitor && window.networkMonitor.tier) ? window.networkMonitor.tier : 'high';
    }

    function getAdaptiveSingleHlsConfig(isLiveStream) {
        if (window.networkMonitor && typeof window.networkMonitor.getHlsConfig === 'function') {
            return window.networkMonitor.getHlsConfig(isLiveStream, true);
        }
        return {
            manifestLoadingMaxRetry: 5,
            xhrSetup: function(xhr) { xhr.withCredentials = true; },
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 10
        };
    }

    function attachSingleHlsTelemetry(hls) {
        if (window.networkMonitor && typeof window.networkMonitor.attachHlsTelemetry === 'function') {
            window.networkMonitor.attachHlsTelemetry(hls);
        }
    }

    function updateCameraHeaderBadge(isLiveMode = false) {
        const titleEl = document.getElementById('cam-title');
        if (!titleEl) return;
        const hasSub = Boolean(window.cameraSubStreams && window.cameraSubStreams[camId]);
        if (isLiveMode && hasSub) {
            titleEl.innerText = `${camId.toUpperCase()} (${activeLiveSubStream ? 'SD' : 'HD'})`;
        } else {
            titleEl.innerText = camId.toUpperCase();
        }
    }

    function destroyFwHlsPlayer() {
        if (fwHlsPlayer) {
            try {
                fwHlsPlayer.stopLoad();
                fwHlsPlayer.detachMedia();
                fwHlsPlayer.destroy();
            } catch (e) {}
            fwHlsPlayer = null;
        }
    }

    // Automatically switch between SD sub-stream and HD main stream when network tier changes during LIVE view
    if (window.networkMonitor && typeof window.networkMonitor.onChange === 'function') {
        window.networkMonitor.onChange(() => {
            if (!isViewActive || document.visibilityState === 'hidden') return;
            if (fwTimeLabel.innerText === "LIVE" && !fwIsScrubbing) {
                const shouldSub = window.networkMonitor.shouldUseSubStream(camId, true);
                if (shouldSub !== activeLiveSubStream) {
                    fwGoLive();
                }
            }
        });
    }

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
                    currentClipUrl = null;
                    applyVideoScrub(first, 0);
                    setTimeout(() => fwVideo.play().catch(e => {}), 50);
                } else {
                    destroyFwHlsPlayer();
                    currentClipUrl = null;
                    fwVideo.pause();
                    fwVideo.removeAttribute('src');
                    fwVideo.load();
                    fwOverlay.classList.remove('hidden');
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
        if (snapshotCanvas.width !== fwVideo.videoWidth || snapshotCanvas.height !== fwVideo.videoHeight) {
            snapshotCanvas.width = fwVideo.videoWidth;
            snapshotCanvas.height = fwVideo.videoHeight;
        }
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

            if (snapshotCanvas.width !== targetCue.w || snapshotCanvas.height !== targetCue.h) {
                snapshotCanvas.width = targetCue.w;
                snapshotCanvas.height = targetCue.h;
            }
            const ctx = snapshotCanvas.getContext('2d');

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
        fwOverlay.classList.add('hidden');
        if (snapshotCanvas.classList.contains('visible')) {
            snapshotCanvas.classList.remove('visible');
        }
    });

    fwVideo.addEventListener('ended', () => {
        const dayClips = getDayClips();
        const currentIndex = dayClips.findIndex(c => c.url === currentClipUrl);
        if (currentIndex >= 0 && currentIndex < dayClips.length - 1) {
            const nextClip = dayClips[currentIndex + 1];
            applyVideoScrub(nextClip, 0);
            setTimeout(() => fwVideo.play().catch(e => {}), 50);
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
            if (totalDuration > 0) {
                const progressPercentage = ((accumOffset + fwVideo.currentTime) / totalDuration) * 100;
                fwIndicator.style.left = `${progressPercentage}%`;
            }
        }
    });

    // --- Adaptive Background Data Loader ---
    async function loadClipMetadata(clips) {
        const session = ++currentLoadSession;

        if (currentDayString === getTodayString() && fwTimeLabel.innerText === "LIVE") {
            await new Promise(r => setTimeout(r, 800));
        }

        clips.forEach((c, i) => {
            if (c._index === undefined) c._index = i;
        });

        while (isViewActive && session === currentLoadSession) {
            const netTier = getNetTier();

            if (netTier === 'low' && fwTimeLabel.innerText === "LIVE" && !fwIsScrubbing && !priorityClipUrl) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const batchSize = netTier === 'low' ? 1 : (netTier === 'medium' ? 2 : 4);
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

            const playheadTime = getPlayheadAbsoluteSeconds(clips);

            let pendingClips = clips.filter(c =>
                (c.sprite_url && (!spriteImages[c.sprite_url] || !spriteImages[c.sprite_url].complete)) ||
                (c.vtt_url && !vttCache[c.url])
            );

            if (netTier === 'low') {
                pendingClips = pendingClips.filter(c => {
                    if (c.url === priorityClipUrl) return true;
                    const center = parseFilenameToSeconds(c.filename) + ((c.duration || 0) / 2);
                    return Math.abs(center - playheadTime) <= 180;
                });
            } else if (netTier === 'medium') {
                pendingClips = pendingClips.filter(c => {
                    if (c.url === priorityClipUrl || c._index % 10 === 0) return true;
                    const center = parseFilenameToSeconds(c.filename) + ((c.duration || 0) / 2);
                    return Math.abs(center - playheadTime) <= 900;
                });
            }

            if (pendingClips.length === 0) {
                await new Promise(r => setTimeout(r, 400));
                continue;
            }

            pendingClips.sort((a, b) => {
                if (a.url === priorityClipUrl) return -1;
                if (b.url === priorityClipUrl) return 1;

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

            const batch = pendingClips.slice(0, batchSize);
            const batchPromises = [];

            for (const targetClip of batch) {
                if (targetClip.url === priorityClipUrl) {
                    priorityClipUrl = null;
                }

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
                                const resp = await fetch(targetClip.vtt_url, { credentials: 'include' });
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
                await new Promise(r => setTimeout(r, 150));
            }
        }
    }

    async function fetchManifest() {
        try {
            const url = `/history?date=${currentDayString}&cam=${camId}`;
            const response = await fetch(url, { cache: 'no-cache', credentials: 'include' });
            if (!response.ok) return;
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
        if (totalDuration <= 0) return;
        let accum = 0;

        const frag = document.createDocumentFragment();
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

            frag.appendChild(chunk);
            accum += clip.duration;
        });
        fwTimelineRegion.insertBefore(frag, fwIndicator);
    }

    function fwGoLive() {
        fwTimeLabel.innerText = "LIVE";
        fwTimeLabel.classList.remove('time-scrub');
        fwTimeLabel.classList.add('time-live');
        fwIndicator.style.left = '100%';

        fwVideo.onloadedmetadata = null;
        targetClipUrl = null;
        fwWatchdogLastTime = -1;
        fwWatchdogFreezeCount = 0;

        if (!snapshotCanvas.classList.contains('visible')) {
            snapToCanvas();
        }

        destroyFwHlsPlayer();
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

        activeLiveSubStream = Boolean(
            window.networkMonitor && window.networkMonitor.shouldUseSubStream(camId, true)
        );
        updateCameraHeaderBadge(true);

        const freshPlaylistUrl = window.networkMonitor
            ? window.networkMonitor.getLiveStreamUrl(baseDir, camId, true)
            : `${baseDir}/${camId}/stream.m3u8?t=${Date.now()}`;

        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            fwHlsPlayer = new Hls(getAdaptiveSingleHlsConfig(true));
            attachSingleHlsTelemetry(fwHlsPlayer);

            fwHlsPlayer.attachMedia(fwVideo);
            fwHlsPlayer.on(Hls.Events.MEDIA_ATTACHED, () => fwHlsPlayer.loadSource(freshPlaylistUrl));
            fwHlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
                if (activeLiveSubStream && window.networkMonitor) {
                    window.networkMonitor.clearSubStreamFailure(camId);
                }
                fwVideo.play().catch(e => {});
            });

            fwHlsPlayer.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    if (activeLiveSubStream && data.type === Hls.ErrorTypes.NETWORK_ERROR && window.networkMonitor) {
                        const lockedOut = window.networkMonitor.markSubStreamFailure(camId);
                        if (lockedOut) {
                            console.warn(`[SubStream] Single view sub-stream failed for ${camId}, falling back to HD stream.`);
                            fwGoLive();
                            return;
                        }
                    }
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            fwHlsPlayer.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            fwHlsPlayer.recoverMediaError();
                            break;
                        default:
                            destroyFwHlsPlayer();
                            break;
                    }
                }
            });
        } else if (fwVideo.canPlayType('application/vnd.apple.mpegurl')) {
            fwVideo.src = freshPlaylistUrl;
            fwVideo.onloadedmetadata = () => {
                if (activeLiveSubStream && window.networkMonitor) {
                    window.networkMonitor.clearSubStreamFailure(camId);
                }
            };
            fwVideo.onerror = () => {
                if (activeLiveSubStream && window.networkMonitor) {
                    window.networkMonitor.markSubStreamFailure(camId);
                    fwGoLive();
                }
            };
            fwVideo.play().catch(e=>{});
        }
    }

    function calculateScrubTarget(e) {
        const rect = fwTimelineRegion.getBoundingClientRect();
        if (rect.width <= 0) return null;
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
        activeLiveSubStream = false;
        updateCameraHeaderBadge(false);
        fwOverlay.classList.add('hidden');

        if (currentClipUrl === selectedClip.url) {
            if (fwVideo.readyState > 1) {
                fwVideo.currentTime = targetClipOffset;
            }
        } else {
            currentClipUrl = selectedClip.url;

            if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                destroyFwHlsPlayer();

                fwHlsPlayer = new Hls(getAdaptiveSingleHlsConfig(false));
                attachSingleHlsTelemetry(fwHlsPlayer);

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
        if (!target) {
            if (isRelease && fwTimeLabel.innerText !== "LIVE") {
                fwOverlay.classList.remove('hidden');
            }
            return;
        }

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

        priorityClipUrl = target.selectedClip.url;

        if (!isRelease) {
            renderSpriteFrame(target.selectedClip, target.offsetInClip);
        } else {
            applyVideoScrub(target.selectedClip, target.offsetInClip);
        }
    }

    function finishPointerScrub(e) {
        if (!fwIsScrubbing) return;
        fwIsScrubbing = false;
        if (pointerScrubRafId) {
            cancelAnimationFrame(pointerScrubRafId);
            pointerScrubRafId = null;
        }
        try {
            fwTimelineRegion.releasePointerCapture(e.pointerId);
        } catch (err) {}

        updateFwTimelineFromEvent(e, true);

        const rect = fwTimelineRegion.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));

        const isAtNow = isEndSliderAtNow();

        if (isAtNow && rect.width > 0 && (x / rect.width) >= 0.99) {
            fwGoLive();
        } else {
            setTimeout(() => {
                fwVideo.play().catch(err => {});
            }, 50);
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
            const clientX = e.clientX;
            if (pointerScrubRafId) cancelAnimationFrame(pointerScrubRafId);
            pointerScrubRafId = requestAnimationFrame(() => {
                pointerScrubRafId = null;
                updateFwTimelineFromEvent({ clientX }, false);
            });
        }
    });

    fwTimelineRegion.addEventListener('pointerup', finishPointerScrub);
    fwTimelineRegion.addEventListener('pointercancel', finishPointerScrub);

    window.addEventListener('resize', () => {
        if (!fwIsScrubbing) updateSliderLabels();
    });

    // Live freeze watchdog & visibility handling for Single-Camera View
    let fwWatchdogLastTime = -1;
    let fwWatchdogFreezeCount = 0;

    setInterval(() => {
        if (!isViewActive || document.visibilityState === "hidden") return;
        if (fwTimeLabel.innerText !== "LIVE" || fwIsScrubbing) return;
        if (!fwVideo || fwVideo.paused) return;

        if (fwVideo.currentTime === fwWatchdogLastTime) {
            fwWatchdogFreezeCount++;
            if (fwWatchdogFreezeCount >= 2) {
                console.warn(`[Watchdog] Single camera ${camId} appears frozen. Resetting...`);
                if (window.networkMonitor) window.networkMonitor.recordStall();
                fwWatchdogFreezeCount = 0;
                fwGoLive();
            }
        } else {
            fwWatchdogFreezeCount = 0;
        }
        fwWatchdogLastTime = fwVideo.currentTime;
    }, 4000);

    document.addEventListener("visibilitychange", () => {
        if (!isViewActive) return;
        if (document.visibilityState === "visible") {
            if (fwTimeLabel.innerText === "LIVE") {
                fwGoLive();
            } else {
                fetchManifest();
            }
        } else if (document.visibilityState === "hidden") {
            if (fwVideo && !fwVideo.paused) {
                fwVideo.pause();
            }
            if (fwTimeLabel.innerText === "LIVE") {
                destroyFwHlsPlayer();
            }
        }
    });

    // SPA Initialization & Cleanup Hooks Exposed to Global Scope
    window.initCameraView = async function(selectedCamId, selectedDate, selectedColor) {
        camId = selectedCamId;
        dateParam = selectedDate;
        colorParam = selectedColor;
        currentDayString = dateParam || getTodayString();
        isViewActive = true;
        activeLiveSubStream = false;

        if (window.networkMonitor && typeof window.networkMonitor.clearSubStreamFailure === 'function') {
            window.networkMonitor.clearSubStreamFailure(camId);
        }

        document.getElementById('cam-title').style.color = colorParam ? '#' + colorParam : '#3498db';
        updateCameraHeaderBadge(false);

        fwIsScrubbing = false;
        currentClipUrl = null;
        targetClipUrl = null;
        targetClipOffset = -1;

        destroyFwHlsPlayer();

        await fetchManifest();

        if (!isViewActive) return;

        if (dateParam && dateParam !== getTodayString()) {
            fwTimeLabel.innerText = "LOADING";
            setTimeout(() => {
                if (isViewActive) {
                    updateFwTimelineFromEvent({ clientX: 0 }, true);
                    setTimeout(() => fwVideo.play().catch(e => {}), 50);
                }
            }, 300);
        } else {
            fwGoLive();
        }
    };

    window.stopCameraView = function() {
        isViewActive = false;
        currentLoadSession++;
        fwIsScrubbing = false;
        currentClipUrl = null;
        targetClipUrl = null;
        targetClipOffset = -1;
        activeLiveSubStream = false;

        if (fwVideo) {
            fwVideo.pause();
            fwVideo.removeAttribute('src');
            fwVideo.load();
        }
        destroyFwHlsPlayer();
        snapshotCanvas.classList.remove('visible');
    };

    window.fwGoLive = fwGoLive;
    window.handleScaleChange = handleScaleChange;

})(); // End SPA Isolation Wrapper