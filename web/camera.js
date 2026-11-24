// SPA Isolation Wrapper
(function() {

    let camId = 'cam1';
    let dateParam = null;
    let colorParam = null;

    // vttCache, spriteImages, baseDir, and window.networkMonitor inherit cleanly from script.js global scope
    const vttInFlight = new Map();
    const failedSprites = new Set();
    const chunkElByUrl = new Map();

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

    function parseClipFilenameMeta(filename) {
        if (typeof filename !== 'string') return null;
        const match = filename.match(/_(\d{8})_(\d{2})(\d{2})(\d{2})\.(?:m3u8|ts|mp4)$/i);
        if (!match) return null;
        const dateStr = match[1];
        const h = parseInt(match[2], 10);
        const m = parseInt(match[3], 10);
        const s = parseInt(match[4], 10);
        return {
            date: dateStr,
            timeTag: `${match[2]}${match[3]}${match[4]}`,
            seconds: (h * 3600) + (m * 60) + s
        };
    }

    function addSecondsToClipMeta(meta, addSec) {
        if (!meta) return null;
        const delta = Math.max(0, Math.round(Number(addSec) || 0));
        const totalSec = meta.seconds + delta;
        const dayCarry = Math.floor(totalSec / 86400);
        const endSecOfDay = totalSec % 86400;
        let endDateStr = meta.date;

        if (dayCarry > 0 && meta.date && meta.date.length === 8) {
            const y = parseInt(meta.date.slice(0, 4), 10);
            const mo = parseInt(meta.date.slice(4, 6), 10) - 1;
            const d = parseInt(meta.date.slice(6, 8), 10);
            const dt = new Date(Date.UTC(y, mo, d + dayCarry));
            const yy = dt.getUTCFullYear();
            const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(dt.getUTCDate()).padStart(2, '0');
            endDateStr = `${yy}${mm}${dd}`;
        }

        return {
            date: endDateStr,
            seconds: endSecOfDay
        };
    }

    function parseFilenameToSeconds(filename) {
        const meta = parseClipFilenameMeta(filename);
        return meta ? meta.seconds : null;
    }

    const fwVideo = document.getElementById('fw-video');
    const snapshotCanvas = document.getElementById('snapshot-canvas');
    const fwOverlay = document.getElementById('fw-overlay');
    const fwTimelineRegion = document.getElementById('fw-timeline-region');
    const fwIndicator = document.getElementById('fw-timeline-indicator');
    const fwTimeLabel = document.getElementById('fw-time-label');

    const fwBackBtn = document.getElementById('fw-btn-back');
    const fwLiveBtn = document.getElementById('fw-btn-live');
    const fwCreateVideoBtn = document.getElementById('fw-btn-create-video');
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
    let cachedDayClips = [];
    let cachedDayClipsKey = '';
    let cachedDayTotalDuration = 0;
    let fwReconnectTimer = null;

    // Video generation button state & timers
    let isCreatingVideo = false;
    let createVideoTickTimer = null;
    let createVideoResetTimer = null;
    let createVideoAbortController = null;

    function invalidateDayClipsCache() {
        cachedDayClipsKey = '';
    }

    function clearFwReconnectTimer() {
        if (fwReconnectTimer) {
            clearTimeout(fwReconnectTimer);
            fwReconnectTimer = null;
        }
    }

    function scheduleFwReconnect(delayMs = 2500) {
        if (fwReconnectTimer || !isViewActive || fwTimeLabel.innerText !== "LIVE" || fwIsScrubbing) return;
        fwReconnectTimer = setTimeout(() => {
            fwReconnectTimer = null;
            if (isViewActive && fwTimeLabel.innerText === "LIVE" && !fwIsScrubbing && document.visibilityState === "visible") {
                fwGoLive();
            }
        }, delayMs);
    }

    function clearCreateVideoTimers() {
        if (createVideoTickTimer) {
            clearInterval(createVideoTickTimer);
            createVideoTickTimer = null;
        }
        if (createVideoResetTimer) {
            clearTimeout(createVideoResetTimer);
            createVideoResetTimer = null;
        }
    }

    function setCreateVideoBtnVisual(state, labelText) {
        if (!fwCreateVideoBtn) return;

        if (state === 'creating') {
            fwCreateVideoBtn.style.setProperty('background-color', '#e67e22', 'important');
            fwCreateVideoBtn.style.setProperty('color', '#ffffff', 'important');
            fwCreateVideoBtn.style.cursor = 'wait';
            fwCreateVideoBtn.textContent = labelText || '⏳ Creating...';
        } else if (state === 'success') {
            fwCreateVideoBtn.style.setProperty('background-color', '#27ae60', 'important');
            fwCreateVideoBtn.style.setProperty('color', '#ffffff', 'important');
            fwCreateVideoBtn.style.cursor = 'default';
            fwCreateVideoBtn.textContent = labelText || '✅ Video Ready!';
        } else if (state === 'error') {
            fwCreateVideoBtn.style.setProperty('background-color', '#c0392b', 'important');
            fwCreateVideoBtn.style.setProperty('color', '#ffffff', 'important');
            fwCreateVideoBtn.style.cursor = 'default';
            fwCreateVideoBtn.textContent = labelText || '❌ Failed';
        } else {
            fwCreateVideoBtn.style.removeProperty('background-color');
            fwCreateVideoBtn.style.removeProperty('color');
            fwCreateVideoBtn.style.cursor = '';
            fwCreateVideoBtn.textContent = 'Create Video';
        }
    }

    function abortableSleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            const timer = setTimeout(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    async function waitForVideoFile(filename, maxWaitMs = 300000, signal = null) {
        if (!filename) {
            throw new Error('Server did not return a target video filename');
        }

        const statusUrl = `/api/video/status?file=${encodeURIComponent(filename)}`;
        const probeUrl = `/api/video/stream?file=${encodeURIComponent(filename)}`;
        const deadline = Date.now() + maxWaitMs;

        while (Date.now() < deadline) {
            await abortableSleep(1500, signal);
            if (signal && signal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            try {
                const statusResp = await fetch(statusUrl, {
                    method: 'GET',
                    credentials: 'include',
                    cache: 'no-store',
                    signal
                });

                if (statusResp.ok) {
                    const statusData = await statusResp.json();
                    if (statusData.status === 'ready') {
                        return true;
                    }
                    if (statusData.status === 'failed') {
                        throw new Error(statusData.error || 'Video creation failed on server');
                    }
                    continue;
                }

                // Fallback for older servers without /api/video/status
                if (statusResp.status === 404) {
                    const resp = await fetch(probeUrl, {
                        method: 'GET',
                        credentials: 'include',
                        cache: 'no-store',
                        signal,
                        headers: {
                            'Range': 'bytes=0-0'
                        }
                    });

                    if (resp.status === 206 || resp.status === 200) {
                        return true;
                    }
                }
            } catch (e) {
                if (e && e.name === 'AbortError') throw e;
                if (e && e.message && e.message.toLowerCase().includes('video creation failed')) throw e;
                if (e && e.message && e.message.toLowerCase().includes('ffmpeg')) throw e;
                // Ignore transient network errors while polling
            }
        }
        throw new Error('Timed out waiting for video file to become available');
    }

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
        clearFwReconnectTimer();
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
        for (let i = clips.length - 1; i >= 0; i--) {
            const c = clips[i];
            const startSec = c._startSec !== undefined ? c._startSec : parseFilenameToSeconds(c.filename);
            if (startSec !== null) {
                return startSec + (Number(c.duration) || 0);
            }
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
        const key = `${camId}|${currentDayString}|${timelineStartSec}|${timelineEndSec}|${clips.length}`;
        if (key === cachedDayClipsKey) {
            return cachedDayClips;
        }

        const parsed = clips.filter(c => {
            const clipStart = c._startSec !== undefined ? c._startSec : parseFilenameToSeconds(c.filename);
            if (clipStart === null) return false;
            const clipEnd = (c._endSec !== undefined && c._endSec !== null)
                ? c._endSec
                : clipStart + (Number(c.duration) || 0);
            return clipEnd > timelineStartSec && clipStart < timelineEndSec;
        });

        let totalDur = 0;
        for (let i = 0; i < parsed.length; i++) {
            totalDur += Number(parsed[i].duration) || 0;
        }
        cachedDayClips = parsed;
        cachedDayTotalDuration = totalDur;
        cachedDayClipsKey = key;
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

    async function handleCreateVideo() {
        if (isCreatingVideo) return;

        const dayClips = getDayClips();
        if (dayClips.length === 0) {
            alert("No recorded clips in the currently displayed history range.");
            return;
        }

        isCreatingVideo = true;
        clearCreateVideoTimers();
        if (createVideoAbortController) {
            try { createVideoAbortController.abort(); } catch (e) {}
        }
        createVideoAbortController = new AbortController();
        const abortSignal = createVideoAbortController.signal;

        const firstClip = dayClips[0];
        const lastClip = dayClips[dayClips.length - 1];
        const firstMeta = parseClipFilenameMeta(firstClip.filename);
        const lastMeta = parseClipFilenameMeta(lastClip.filename);
        const lastDurationSec = Number(lastClip.duration) || 0;
        const lastEndMeta = addSecondsToClipMeta(lastMeta, lastDurationSec);

        const clipStartDate = firstMeta ? firstMeta.date : currentDayString;
        const clipEndDate = lastEndMeta ? lastEndMeta.date : clipStartDate;
        const clipStartSec = firstMeta ? firstMeta.seconds : timelineStartSec;
        const clipEndSec = lastEndMeta ? lastEndMeta.seconds : timelineEndSec;

        const payload = {
            camId: camId,
            date: clipStartDate,
            startDate: clipStartDate,
            endDate: clipEndDate,
            startSec: clipStartSec,
            endSec: clipEndSec,
            lastClipDuration: lastDurationSec,
            clips: dayClips.map(c => c.filename)
        };

        const startedAt = Date.now();
        setCreateVideoBtnVisual('creating', '⏳ Creating (0s)...');

        createVideoTickTimer = setInterval(() => {
            const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
            setCreateVideoBtnVisual('creating', `⏳ Creating (${elapsedSec}s)...`);
        }, 1000);

        try {
            const response = await fetch('/api/video/create', {
                method: 'POST',
                credentials: 'include',
                signal: abortSignal,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Server returned ${response.status}`);
            }

            const data = await response.json();
            await waitForVideoFile(data.filename, 300000, abortSignal);

            clearCreateVideoTimers();
            createVideoAbortController = null;
            isCreatingVideo = false;
            setCreateVideoBtnVisual('success', '✅ Video Ready!');

            createVideoResetTimer = setTimeout(() => {
                setCreateVideoBtnVisual('idle');
            }, 3500);
        } catch (err) {
            clearCreateVideoTimers();
            createVideoAbortController = null;
            isCreatingVideo = false;
            if (err && err.name === 'AbortError') {
                setCreateVideoBtnVisual('idle');
                return;
            }
            console.error("Failed to complete video creation:", err);
            setCreateVideoBtnVisual('error', '❌ Failed');

            createVideoResetTimer = setTimeout(() => {
                setCreateVideoBtnVisual('idle');
            }, 3500);
        }
    }

    if (fwBackBtn) {
        fwBackBtn.addEventListener('click', () => {
            if (window.closeCameraPage) {
                window.closeCameraPage();
            }
        });
    }

    if (fwLiveBtn) {
        fwLiveBtn.addEventListener('click', fwGoLive);
    }

    if (fwCreateVideoBtn) {
        fwCreateVideoBtn.addEventListener('click', handleCreateVideo);
    }

    if (scaleSelect) {
        scaleSelect.addEventListener('change', handleScaleChange);
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
            const lastStart = lastClip._startSec !== undefined ? lastClip._startSec : parseFilenameToSeconds(lastClip.filename);
            return (lastStart || 0) + (Number(lastClip.duration) || 0);
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
        const totalDuration = cachedDayTotalDuration > 0
            ? cachedDayTotalDuration
            : clips.reduce((sum, c) => sum + (c.duration || 0), 0);
        const targetOffset = (indicatorPct / 100) * totalDuration;

        const firstClipSeconds = clips[0]._startSec !== undefined ? clips[0]._startSec : parseFilenameToSeconds(clips[0].filename);
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
            const startSec = playingClip._startSec !== undefined ? playingClip._startSec : parseFilenameToSeconds(playingClip.filename);
            const absoluteSeconds = (startSec || 0) + fwVideo.currentTime;
            fwTimeLabel.innerText = secondsToTimeStr(absoluteSeconds);
            fwTimeLabel.classList.remove('time-live', 'time-scrub');

            const totalDuration = cachedDayTotalDuration;
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
            c._index = i;
        });

        while (isViewActive && session === currentLoadSession) {
            const netTier = getNetTier();

            if (netTier === 'low' && fwTimeLabel.innerText === "LIVE" && !fwIsScrubbing && !priorityClipUrl) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const batchSize = netTier === 'low' ? 1 : (netTier === 'medium' ? 2 : 4);
            const maxBudget = netTier === 'low' ? 26 : 72;
            let allComplete = true;

            for (const clip of clips) {
                const hasVtt = !clip.vtt_url || Boolean(vttCache[clip.url]);
                const hasSprite = !clip.sprite_url ||
                    failedSprites.has(clip.sprite_url) ||
                    Boolean(spriteImages[clip.sprite_url] && spriteImages[clip.sprite_url].complete);

                if (hasVtt && hasSprite) {
                    const chunkEl = chunkElByUrl.get(clip.url);
                    if (chunkEl && !chunkEl.classList.contains('chunk-loaded')) {
                        chunkEl.classList.add('chunk-loaded');
                    }
                } else {
                    allComplete = false;
                }
            }

            if (allComplete) break;

            const playheadTime = getPlayheadAbsoluteSeconds(clips);
            const getClipCenter = (c) => {
                const s = c._startSec !== undefined ? c._startSec : (parseFilenameToSeconds(c.filename) || 0);
                return s + ((Number(c.duration) || 0) / 2);
            };

            // Select a bounded target set within cache budget to prevent OOM & eviction thrash
            const targetSet = new Set();
            if (priorityClipUrl) {
                const prioClip = clips.find(c => c.url === priorityClipUrl);
                if (prioClip) targetSet.add(prioClip);
            }

            if (netTier === 'high' && clips.length <= maxBudget) {
                for (const c of clips) targetSet.add(c);
            } else {
                const overviewTarget = netTier === 'low' ? 0 : (netTier === 'medium' ? 12 : 20);
                if (overviewTarget > 0 && clips.length > 0) {
                    const stride = Math.max(1, Math.ceil(clips.length / overviewTarget));
                    for (let i = 0; i < clips.length && targetSet.size < maxBudget; i += stride) {
                        targetSet.add(clips[i]);
                    }
                }

                const radiusSec = netTier === 'low' ? 180 : (netTier === 'medium' ? 900 : 3600);
                const nearby = clips
                    .map(c => ({ clip: c, dist: Math.abs(getClipCenter(c) - playheadTime) }))
                    .filter(item => item.dist <= radiusSec)
                    .sort((a, b) => a.dist - b.dist);

                for (const item of nearby) {
                    if (targetSet.size >= maxBudget) break;
                    targetSet.add(item.clip);
                }
            }

            const protectedSprites = new Set();
            const protectedClips = new Set();
            for (const c of targetSet) {
                if (c.sprite_url) protectedSprites.add(c.sprite_url);
                if (c.url) protectedClips.add(c.url);
            }

            let pendingClips = Array.from(targetSet).filter(c =>
                (c.sprite_url && !failedSprites.has(c.sprite_url) && (!spriteImages[c.sprite_url] || !spriteImages[c.sprite_url].complete)) ||
                (c.vtt_url && !vttCache[c.url])
            );

            if (pendingClips.length === 0) {
                await new Promise(r => setTimeout(r, 600));
                continue;
            }

            pendingClips.sort((a, b) => {
                if (a.url === priorityClipUrl) return -1;
                if (b.url === priorityClipUrl) return 1;

                const aDist = Math.abs(getClipCenter(a) - playheadTime);
                const bDist = Math.abs(getClipCenter(b) - playheadTime);

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

            if (typeof window.evictMediaCaches === 'function') {
                window.evictMediaCaches(protectedSprites, protectedClips);
            }

            const batch = pendingClips.slice(0, batchSize);
            const batchPromises = [];

            for (const targetClip of batch) {
                if (targetClip.url === priorityClipUrl) {
                    priorityClipUrl = null;
                }

                if (targetClip.sprite_url && !failedSprites.has(targetClip.sprite_url)) {
                    if (!spriteImages[targetClip.sprite_url]) {
                        const img = new Image();
                        const p = new Promise(resolve => {
                            img.onload = resolve;
                            img.onerror = () => {
                                failedSprites.add(targetClip.sprite_url);
                                delete spriteImages[targetClip.sprite_url];
                                resolve();
                            };
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
                const list = newManifest[id] || [];
                list.forEach(c => {
                    const s = parseFilenameToSeconds(c.filename);
                    c._startSec = s;
                    c._endSec = s !== null ? s + (Number(c.duration) || 0) : null;
                });
                list.sort((a, b) => (a._startSec !== null ? a._startSec : -1) - (b._startSec !== null ? b._startSec : -1));
            });
            globalManifest = newManifest;
            invalidateDayClipsCache();

            updateSliderMaxBounds();
            handleScaleChange();

        } catch (e) {
            console.log("Could not load history manifest.");
        }
    }

    function drawTimelineChunks() {
        document.querySelectorAll('.fw-timeline-chunk').forEach(el => el.remove());
        chunkElByUrl.clear();
        const dayClips = getDayClips();
        if (dayClips.length === 0) return;

        const totalDuration = cachedDayTotalDuration;
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

            const hasVtt = !clip.vtt_url || Boolean(vttCache[clip.url]);
            const hasSprite = !clip.sprite_url ||
                failedSprites.has(clip.sprite_url) ||
                Boolean(spriteImages[clip.sprite_url]?.complete);
            if (hasVtt && hasSprite) {
                chunk.classList.add('chunk-loaded');
            }

            chunkElByUrl.set(clip.url, chunk);
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
            const hls = new Hls(getAdaptiveSingleHlsConfig(true));
            let networkRecoveryCount = 0;
            let mediaRecoveryCount = 0;
            let lastMediaRecoveryTs = 0;

            fwHlsPlayer = hls;
            attachSingleHlsTelemetry(hls);

            hls.attachMedia(fwVideo);
            hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                if (fwHlsPlayer !== hls) return;
                hls.loadSource(freshPlaylistUrl);
            });
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                if (fwHlsPlayer !== hls) return;
                networkRecoveryCount = 0;
                mediaRecoveryCount = 0;
                if (activeLiveSubStream && window.networkMonitor) {
                    window.networkMonitor.clearSubStreamFailure(camId);
                }
                fwVideo.play().catch(e => {});
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (fwHlsPlayer !== hls) return;
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
                            networkRecoveryCount++;
                            if (networkRecoveryCount <= 2) {
                                hls.startLoad();
                            } else {
                                destroyFwHlsPlayer();
                                scheduleFwReconnect(2500);
                            }
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR: {
                            const now = performance.now();
                            if (now - lastMediaRecoveryTs > 15000) {
                                mediaRecoveryCount = 0;
                            }
                            mediaRecoveryCount++;
                            lastMediaRecoveryTs = now;
                            if (mediaRecoveryCount === 1) {
                                hls.recoverMediaError();
                            } else if (mediaRecoveryCount === 2) {
                                hls.swapAudioCodec();
                                hls.recoverMediaError();
                            } else {
                                destroyFwHlsPlayer();
                                scheduleFwReconnect(2500);
                            }
                            break;
                        }
                        default:
                            destroyFwHlsPlayer();
                            scheduleFwReconnect(2500);
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
                } else {
                    scheduleFwReconnect(2500);
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

        const totalDuration = cachedDayTotalDuration;
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
            actualSec: (selectedClip._startSec !== undefined ? selectedClip._startSec : parseFilenameToSeconds(selectedClip.filename)) + offsetInClip
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
        if (!fwVideo) return;

        if (!fwHlsPlayer && !fwVideo.canPlayType('application/vnd.apple.mpegurl')) {
            if (!fwReconnectTimer) {
                fwGoLive();
            }
            return;
        }

        if (fwVideo.paused) {
            fwWatchdogFreezeCount++;
            fwVideo.play().catch(() => {});
            if (fwWatchdogFreezeCount >= 2) {
                console.warn(`[Watchdog] Single camera ${camId} remained paused in live mode. Resetting...`);
                fwWatchdogFreezeCount = 0;
                fwGoLive();
            }
            return;
        }

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
        failedSprites.clear();
        invalidateDayClipsCache();

        if (window.networkMonitor && typeof window.networkMonitor.clearSubStreamFailure === 'function') {
            window.networkMonitor.clearSubStreamFailure(camId);
        }

        const camTitleEl = document.getElementById('cam-title');
        if (colorParam) {
            camTitleEl.style.setProperty('--cam-color', `#${colorParam}`);
        } else {
            camTitleEl.style.removeProperty('--cam-color');
        }
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
        chunkElByUrl.clear();
        invalidateDayClipsCache();

        if (createVideoAbortController) {
            try { createVideoAbortController.abort(); } catch (e) {}
            createVideoAbortController = null;
        }
        clearCreateVideoTimers();
        isCreatingVideo = false;
        setCreateVideoBtnVisual('idle');

        if (fwVideo) {
            fwVideo.pause();
            fwVideo.removeAttribute('src');
            fwVideo.load();
        }
        destroyFwHlsPlayer();
        snapshotCanvas.classList.remove('visible');
    };

})(); // End SPA Isolation Wrapper