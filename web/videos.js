(() => {
    let CAM_PALETTE = ['#3498db'];
    const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16];

    function computeHslToHex(h, s, l) {
        if (typeof hslToHex === 'function') {
            return hslToHex(h, s, l);
        }
        l /= 100;
        const a = (s * Math.min(l, 1 - l)) / 100;
        const f = n => {
            const k = (n + h / 30) % 12;
            const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
            return Math.abs(Math.round(255 * color)).toString(16).padStart(2, '0');
        };
        return `${f(0)}${f(8)}${f(4)}`;
    }

    function generateCamPalette(count) {
        const num = Math.max(1, parseInt(count, 10) || 1);
        const colors = [];
        for (let i = 0; i < num; i++) {
            const hue = num === 1 ? 0 : Math.floor((270 * i) / (num - 1));
            colors.push(`#${computeHslToHex(hue, 80, 55)}`);
        }
        CAM_PALETTE = colors;
        return CAM_PALETTE;
    }

    async function ensureDynamicCamPalette() {
        if (typeof CAMERA_COLORS !== 'undefined' && Array.isArray(CAMERA_COLORS) && CAMERA_COLORS.length > 0) {
            if (typeof activeCameras !== 'undefined' && activeCameras.length > CAMERA_COLORS.length) {
                generateCamPalette(activeCameras.length);
            } else {
                CAM_PALETTE = CAMERA_COLORS.slice();
            }
            if (CAM_PALETTE.length > 1 || (typeof activeCameras !== 'undefined' && activeCameras.length === 1)) {
                return;
            }
        }

        try {
            const response = await fetch('/cameracount', { cache: 'no-store', credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                const count = data.count || 1;
                generateCamPalette(count);
            }
        } catch (_) {
            // Fallback to existing CAM_PALETTE if /cameracount is temporarily unreachable
        }
    }

    function resolveCameraColor(camId) {
        if (!camId) return CAM_PALETTE[0] || '#3498db';
        if (typeof CAMERA_COLORS !== 'undefined' && Array.isArray(CAMERA_COLORS) && CAMERA_COLORS.length > 0) {
            CAM_PALETTE = CAMERA_COLORS;
        }
        if (typeof getCameraColor === 'function') {
            return getCameraColor(camId);
        }
        const num = parseInt(String(camId).replace(/\D/g, ''), 10) || 1;
        return CAM_PALETTE[(num - 1) % CAM_PALETTE.length];
    }

    // DOM Elements
    const dashboardView = document.getElementById('dashboard-view');
    const cameraView = document.getElementById('camera-view');
    const videosView = document.getElementById('videos-view');
    const toolbarToggleBtn = document.getElementById('toolbar-toggle');

    const btnOpenVideos = document.getElementById('btn-videos');
    const btnBack = document.getElementById('videos-btn-back');
    const btnRefresh = document.getElementById('videos-btn-refresh');
    const filterCamSelect = document.getElementById('videos-filter-cam');
    const sortSelect = document.getElementById('videos-sort-select');
    const summaryBadge = document.getElementById('videos-summary-badge');

    const videoStage = document.getElementById('videos-stage');
    const videoPlayer = document.getElementById('videos-player');
    const emptyOverlay = document.getElementById('videos-empty-overlay');
    const overlayText = document.getElementById('videos-overlay-text');

    const npCam = document.getElementById('np-cam');
    const npMeta = document.getElementById('np-meta');
    const npBtnDownload = document.getElementById('np-btn-download');
    const npBtnDelete = document.getElementById('np-btn-delete');

    const vpBtnPlay = document.getElementById('vp-btn-play');
    const vpBtnSkipBack = document.getElementById('vp-btn-skip-back');
    const vpBtnSkipFwd = document.getElementById('vp-btn-skip-fwd');
    const vpScrubber = document.getElementById('vp-scrubber');
    const vpTimeLabel = document.getElementById('vp-time-label');
    const vpSpeedSelect = document.getElementById('vp-speed-select');
    const vpBtnFullscreen = document.getElementById('vp-btn-fullscreen');

    let vpBtnPrevClip = document.getElementById('vp-btn-prev-clip');
    let vpBtnNextClip = document.getElementById('vp-btn-next-clip');

    // Remove mute button if present in markup (audio is never recorded)
    const legacyMuteBtn = document.getElementById('vp-btn-mute');
    if (legacyMuteBtn) {
        legacyMuteBtn.remove();
    }

    // Prevent transport time label from wrapping when displaying wall-clock time
    if (vpTimeLabel) {
        vpTimeLabel.style.whiteSpace = 'nowrap';
        vpTimeLabel.style.minWidth = 'max-content';
    }

    const videosListEl = document.getElementById('videos-list');

    const deleteModal = document.getElementById('videos-delete-modal');
    const deletePromptEl = document.getElementById('videos-delete-prompt');
    const deleteFilenameEl = document.getElementById('videos-delete-filename');
    const modalCancelBtn = document.getElementById('videos-modal-cancel');
    const modalConfirmBtn = document.getElementById('videos-modal-confirm');

    // State
    let allVideos = [];
    let activeFilename = null;
    let activeClipSegments = [];
    let pendingDeleteVideo = null;
    let isScrubbingVideo = false;
    let scrubberTicksEl = null;
    let scrubberTooltipEl = null;

    function initClipSkipButtons() {
        const baseBtnClass = (vpBtnSkipBack && vpBtnSkipBack.className)
            ? vpBtnSkipBack.className
            : 'ctrl-btn';

        if (!vpBtnPrevClip && vpBtnSkipBack && vpBtnSkipBack.parentNode) {
            vpBtnPrevClip = document.createElement('button');
            vpBtnPrevClip.type = 'button';
            vpBtnPrevClip.id = 'vp-btn-prev-clip';
            vpBtnPrevClip.className = baseBtnClass;
            vpBtnPrevClip.textContent = '⏮ Clip';
            vpBtnPrevClip.title = 'Previous stitched clip (Shift + Left Arrow)';
            vpBtnPrevClip.disabled = true;
            vpBtnPrevClip.style.whiteSpace = 'nowrap';
            vpBtnSkipBack.parentNode.insertBefore(vpBtnPrevClip, vpBtnSkipBack);
        }

        if (!vpBtnNextClip && vpBtnSkipFwd && vpBtnSkipFwd.parentNode) {
            vpBtnNextClip = document.createElement('button');
            vpBtnNextClip.type = 'button';
            vpBtnNextClip.id = 'vp-btn-next-clip';
            vpBtnNextClip.className = baseBtnClass;
            vpBtnNextClip.textContent = 'Clip ⏭';
            vpBtnNextClip.title = 'Next stitched clip (Shift + Right Arrow)';
            vpBtnNextClip.disabled = true;
            vpBtnNextClip.style.whiteSpace = 'nowrap';
            vpBtnSkipFwd.parentNode.insertBefore(vpBtnNextClip, vpBtnSkipFwd.nextSibling);
        }
    }

    function initScrubberTicksContainer() {
        if (!vpScrubber || !vpScrubber.parentNode) return;

        if (!document.getElementById('vp-scrubber-ticks-style')) {
            const styleEl = document.createElement('style');
            styleEl.id = 'vp-scrubber-ticks-style';
            styleEl.textContent = `
                .vp-scrubber-wrap {
                    position: relative;
                    flex: 1 1 auto;
                    display: flex;
                    align-items: center;
                    min-width: 80px;
                }
                .vp-scrubber-wrap > #vp-scrubber {
                    width: 100%;
                    flex: 1 1 auto;
                    margin: 0;
                    position: relative;
                    z-index: 2;
                }
                .vp-scrubber-ticks {
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                    z-index: 3;
                    overflow: visible;
                }
                .vp-scrubber-tick {
                    position: absolute;
                    top: 50%;
                    width: 2px;
                    height: 12px;
                    background: #ffcc00;
                    border-radius: 1px;
                    transform: translate(-50%, -50%);
                    box-shadow: 0 0 2px rgba(0, 0, 0, 0.9);
                    opacity: 0.92;
                    transition: transform 0.12s ease, background-color 0.12s ease;
                }
                .vp-scrubber-tick.active-hover {
                    background: #ffffff;
                    transform: translate(-50%, -50%) scaleY(1.35) scaleX(1.3);
                }
                .vp-scrubber-tooltip {
                    position: absolute;
                    bottom: calc(100% + 8px);
                    transform: translateX(-50%);
                    background: rgba(15, 18, 24, 0.94);
                    color: #f5f7fa;
                    border: 1px solid rgba(255, 204, 0, 0.45);
                    border-radius: 4px;
                    padding: 3px 7px;
                    font-size: 11px;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                    white-space: nowrap;
                    pointer-events: none;
                    z-index: 10;
                    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
                    opacity: 0;
                    transition: opacity 0.1s ease;
                }
                .vp-scrubber-tooltip.visible {
                    opacity: 1;
                }
                .vp-scrubber-tooltip.on-transition {
                    border-color: #ffcc00;
                    color: #ffcc00;
                }
            `;
            document.head.appendChild(styleEl);
        }

        let wrap = vpScrubber.parentNode;
        if (!wrap.classList.contains('vp-scrubber-wrap')) {
            wrap = document.createElement('div');
            wrap.className = 'vp-scrubber-wrap';
            vpScrubber.parentNode.insertBefore(wrap, vpScrubber);
            wrap.appendChild(vpScrubber);
        }

        scrubberTicksEl = wrap.querySelector('.vp-scrubber-ticks');
        if (!scrubberTicksEl) {
            scrubberTicksEl = document.createElement('div');
            scrubberTicksEl.className = 'vp-scrubber-ticks';
            wrap.appendChild(scrubberTicksEl);
        }

        scrubberTooltipEl = wrap.querySelector('.vp-scrubber-tooltip');
        if (!scrubberTooltipEl) {
            scrubberTooltipEl = document.createElement('div');
            scrubberTooltipEl.className = 'vp-scrubber-tooltip';
            wrap.appendChild(scrubberTooltipEl);
        }
    }

    function getEffectiveClipDuration() {
        const playerDur = videoPlayer ? videoPlayer.duration : 0;
        if (Number.isFinite(playerDur) && playerDur > 0) {
            return playerDur;
        }
        if (activeClipSegments && activeClipSegments.length > 0) {
            const lastSeg = activeClipSegments[activeClipSegments.length - 1];
            if (Number.isFinite(lastSeg.duration) && lastSeg.duration > 0) {
                return lastSeg.offset + lastSeg.duration;
            }
        }
        return 0;
    }

    function clearScrubberTicks() {
        if (scrubberTicksEl) {
            scrubberTicksEl.innerHTML = '';
        }
        if (scrubberTooltipEl) {
            scrubberTooltipEl.classList.remove('visible', 'on-transition');
        }
    }

    function renderScrubberTicks() {
        if (!scrubberTicksEl) return;
        scrubberTicksEl.innerHTML = '';

        if (!activeFilename || !activeClipSegments || activeClipSegments.length <= 1) {
            updateClipSkipButtonStates();
            return;
        }

        const totalDur = getEffectiveClipDuration();
        if (!Number.isFinite(totalDur) || totalDur <= 0) {
            updateClipSkipButtonStates();
            return;
        }

        for (let i = 1; i < activeClipSegments.length; i++) {
            const seg = activeClipSegments[i];
            if (!Number.isFinite(seg.offset) || seg.offset <= 0 || seg.offset >= totalDur) {
                continue;
            }

            const ratio = Math.max(0, Math.min(1, seg.offset / totalDur));
            const tick = document.createElement('span');
            tick.className = 'vp-scrubber-tick';
            tick.dataset.segIndex = String(seg.index);
            tick.dataset.offset = String(seg.offset);
            // Align with standard 14px range thumb center across the track width
            tick.style.left = `calc(7px + (100% - 14px) * ${ratio.toFixed(6)})`;
            scrubberTicksEl.appendChild(tick);
        }

        updateClipSkipButtonStates();
    }

    function updateScrubberHoverTooltip(clientX) {
        if (!scrubberTooltipEl || !vpScrubber || !activeFilename || vpScrubber.disabled) {
            return;
        }
        const totalDur = getEffectiveClipDuration();
        if (!Number.isFinite(totalDur) || totalDur <= 0) {
            scrubberTooltipEl.classList.remove('visible');
            return;
        }

        const rect = vpScrubber.getBoundingClientRect();
        if (rect.width <= 0) return;

        const thumbRadius = 7;
        const usableWidth = Math.max(1, rect.width - thumbRadius * 2);
        const relX = Math.max(0, Math.min(usableWidth, clientX - rect.left - thumbRadius));
        const ratio = relX / usableWidth;
        const hoverSec = ratio * totalDur;

        // Check if cursor is within ~6px of a stitched clip transition tick
        const snapToleranceSec = (6 / usableWidth) * totalDur;
        let snappedSeg = null;
        if (activeClipSegments.length > 1) {
            for (let i = 1; i < activeClipSegments.length; i++) {
                const seg = activeClipSegments[i];
                if (Math.abs(hoverSec - seg.offset) <= snapToleranceSec) {
                    snappedSeg = seg;
                    break;
                }
            }
        }

        if (scrubberTicksEl) {
            const ticks = scrubberTicksEl.querySelectorAll('.vp-scrubber-tick');
            ticks.forEach((t) => {
                t.classList.toggle(
                    'active-hover',
                    Boolean(snappedSeg && Number(t.dataset.segIndex) === snappedSeg.index)
                );
            });
        }

        const targetSec = snappedSeg ? snappedSeg.offset : hoverSec;
        const resolved = resolveRecordingTimeAtPosition(targetSec);
        const relClock = formatDurationClock(targetSec);

        if (snappedSeg && resolved) {
            scrubberTooltipEl.textContent = `⏭ Clip ${snappedSeg.index}/${activeClipSegments.length} • ${resolved.clockStr} (${relClock})`;
            scrubberTooltipEl.classList.add('on-transition');
        } else if (resolved) {
            const clipBadge = resolved.totalSegments > 1
                ? `Clip ${resolved.segment.index}/${resolved.totalSegments} • `
                : '';
            scrubberTooltipEl.textContent = `${clipBadge}${resolved.clockStr} (${relClock})`;
            scrubberTooltipEl.classList.remove('on-transition');
        } else {
            scrubberTooltipEl.textContent = relClock;
            scrubberTooltipEl.classList.remove('on-transition');
        }

        const clampedPx = Math.max(24, Math.min(rect.width - 24, clientX - rect.left));
        scrubberTooltipEl.style.left = `${clampedPx}px`;
        scrubberTooltipEl.classList.add('visible');
    }

    initClipSkipButtons();
    initScrubberTicksContainer();

    function initPlaybackSpeedOptions() {
        if (!vpSpeedSelect) return;
        const previousRate = parseFloat(vpSpeedSelect.value) || 1;
        const selectedRate = PLAYBACK_SPEEDS.includes(previousRate) ? previousRate : 1;

        vpSpeedSelect.innerHTML = '';
        PLAYBACK_SPEEDS.forEach((rate) => {
            const opt = document.createElement('option');
            opt.value = String(rate);
            opt.textContent = `${rate}x`;
            if (rate === selectedRate) {
                opt.selected = true;
            }
            vpSpeedSelect.appendChild(opt);
        });
    }

    function applyPlaybackSpeed() {
        if (!videoPlayer || !vpSpeedSelect) return;
        const rate = parseFloat(vpSpeedSelect.value) || 1;
        try {
            videoPlayer.defaultPlaybackRate = rate;
            videoPlayer.playbackRate = rate;
        } catch (err) {
            console.warn(`Playback rate ${rate}x not supported, falling back to 1x:`, err);
            videoPlayer.defaultPlaybackRate = 1;
            videoPlayer.playbackRate = 1;
            vpSpeedSelect.value = '1';
        }
    }

    initPlaybackSpeedOptions();

    function formatSecondsAsClock(secSinceMidnight) {
        const total = ((Math.floor(secSinceMidnight) % 86400) + 86400) % 86400;
        const hrs = Math.floor(total / 3600);
        const mins = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function parseTimeStringToSeconds(timeStr, filenameHint) {
        if (!timeStr) return null;
        const match = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!match) return null;

        const hrs = parseInt(match[1], 10);
        const mins = parseInt(match[2], 10);
        let secs = match[3] !== undefined ? parseInt(match[3], 10) : null;

        if (secs === null && filenameHint) {
            const hhmm = `${String(hrs).padStart(2, '0')}${String(mins).padStart(2, '0')}`;
            const fnMatch = String(filenameHint).match(new RegExp(`(?:^|[_\\-T])${hhmm}(\\d{2})(?:[_\\-.]|$)`));
            if (fnMatch) {
                const parsedSec = parseInt(fnMatch[1], 10);
                if (parsedSec >= 0 && parsedSec < 60) {
                    secs = parsedSec;
                }
            }
        }

        if (hrs >= 0 && hrs < 24 && mins >= 0 && mins < 60) {
            return (hrs * 3600) + (mins * 60) + (secs || 0);
        }
        return null;
    }

    function buildClipSegments(video) {
        if (!video) return [];

        // 1. Multi-segment array provided by /api/video/list or sidecar .json
        if (Array.isArray(video.segments) && video.segments.length > 0) {
            let runningOffset = 0;
            const mapped = [];
            video.segments.forEach((seg, idx) => {
                const startSeconds = parseTimeStringToSeconds(
                    seg.startTime || seg.start,
                    seg.filename || video.filename
                );
                const dur = Number(seg.duration) || 0;
                const offset = Number.isFinite(Number(seg.offset)) ? Number(seg.offset) : runningOffset;
                if (startSeconds !== null && dur > 0) {
                    mapped.push({
                        index: idx + 1,
                        offset,
                        duration: dur,
                        startSeconds,
                        date: seg.date || video.date || null,
                        filename: seg.filename || null
                    });
                }
                runningOffset = offset + dur;
            });
            if (mapped.length > 0) {
                mapped.sort((a, b) => a.offset - b.offset);
                mapped.forEach((seg, i) => {
                    seg.index = i + 1;
                });
                return mapped;
            }
        }

        // 2. Fallback: single continuous clip starting at video.startTime
        let singleStart = parseTimeStringToSeconds(video.startTime, video.filename);
        if (singleStart === null && video.filename) {
            const fnMatch = String(video.filename).match(/(?:19|20)\d{6}[_\-T](\d{2})(\d{2})(\d{2})/);
            if (fnMatch) {
                const hrs = parseInt(fnMatch[1], 10);
                const mins = parseInt(fnMatch[2], 10);
                const secs = parseInt(fnMatch[3], 10);
                if (hrs < 24 && mins < 60 && secs < 60) {
                    singleStart = (hrs * 3600) + (mins * 60) + secs;
                }
            }
        }

        if (singleStart !== null) {
            return [{
                index: 1,
                offset: 0,
                duration: Infinity,
                startSeconds: singleStart,
                date: video.date || null,
                filename: video.filename || null
            }];
        }

        return [];
    }

    async function maybeFetchSidecarSegments(video) {
        if (!video || !video.filename || (Array.isArray(video.segments) && video.segments.length > 0)) {
            return;
        }
        const targetFilename = video.filename;
        const baseName = targetFilename.replace(/\.[^/.]+$/, '');
        const candidateUrls = [];
        if (video.sidecarUrl) {
            candidateUrls.push(video.sidecarUrl);
        }
        candidateUrls.push(`/api/video/stream?file=${encodeURIComponent(baseName + '.json')}`);

        for (const url of candidateUrls) {
            try {
                const resp = await fetch(url, { credentials: 'include', cache: 'no-store' });
                if (!resp.ok) continue;
                const sidecar = await resp.json();
                if (sidecar && Array.isArray(sidecar.segments) && sidecar.segments.length > 0) {
                    video.segments = sidecar.segments;
                    if (activeFilename === targetFilename) {
                        activeClipSegments = buildClipSegments(video);
                        renderScrubberTicks();
                        updateScrubberAndTime();
                    }
                    break;
                }
            } catch (_) {
                // Ignore if sidecar endpoint is not exposed separately
            }
        }
    }

    function getCurrentSegmentIndex(elapsedSeconds) {
        if (!activeClipSegments || activeClipSegments.length === 0) return -1;
        const pos = Number.isFinite(elapsedSeconds) && elapsedSeconds > 0 ? elapsedSeconds : 0;
        let idx = 0;
        for (let i = 0; i < activeClipSegments.length; i++) {
            if (pos >= activeClipSegments[i].offset - 0.05) {
                idx = i;
            } else {
                break;
            }
        }
        return idx;
    }

    function updateClipSkipButtonStates() {
        if (!vpBtnPrevClip && !vpBtnNextClip) return;

        const hasMultipleClips = Boolean(
            activeFilename && activeClipSegments && activeClipSegments.length > 1
        );

        if (!hasMultipleClips) {
            const disabledReason = activeFilename
                ? 'Single-clip video (no stitched clip transitions)'
                : 'Select a video to play';
            if (vpBtnPrevClip) {
                vpBtnPrevClip.disabled = true;
                vpBtnPrevClip.title = disabledReason;
            }
            if (vpBtnNextClip) {
                vpBtnNextClip.disabled = true;
                vpBtnNextClip.title = disabledReason;
            }
            return;
        }

        const cur = videoPlayer.currentTime || 0;
        const curIdx = getCurrentSegmentIndex(cur);
        const curSeg = activeClipSegments[curIdx] || activeClipSegments[0];
        const elapsedInSeg = Math.max(0, cur - curSeg.offset);
        const totalClips = activeClipSegments.length;

        if (vpBtnPrevClip) {
            const canGoPrev = curIdx > 0 || elapsedInSeg > 0.5;
            vpBtnPrevClip.disabled = !canGoPrev;
            if (elapsedInSeg > 2.0 || curIdx === 0) {
                vpBtnPrevClip.title = `Restart Clip ${curSeg.index}/${totalClips} (${formatSecondsAsClock(curSeg.startSeconds)}) • Shift+Left`;
            } else {
                const prevSeg = activeClipSegments[curIdx - 1];
                vpBtnPrevClip.title = `Previous: Clip ${prevSeg.index}/${totalClips} (${formatSecondsAsClock(prevSeg.startSeconds)}) • Shift+Left`;
            }
        }

        if (vpBtnNextClip) {
            const hasNext = curIdx >= 0 && curIdx < totalClips - 1;
            vpBtnNextClip.disabled = !hasNext;
            if (hasNext) {
                const nextSeg = activeClipSegments[curIdx + 1];
                vpBtnNextClip.title = `Next: Clip ${nextSeg.index}/${totalClips} (${formatSecondsAsClock(nextSeg.startSeconds)}) • Shift+Right`;
            } else {
                vpBtnNextClip.title = `Playing final clip (${totalClips}/${totalClips})`;
            }
        }
    }

    function skipToPrevClip() {
        if (!activeFilename || !activeClipSegments || activeClipSegments.length <= 1) return;
        const cur = videoPlayer.currentTime || 0;
        const curIdx = getCurrentSegmentIndex(cur);
        if (curIdx < 0) return;

        const curSeg = activeClipSegments[curIdx];
        const elapsedInSeg = cur - curSeg.offset;

        // If more than 2 seconds into the current clip, rewind to the start of the current clip;
        // otherwise jump to the start of the previous stitched clip.
        const targetSeg = (elapsedInSeg > 2.0 || curIdx === 0)
            ? curSeg
            : activeClipSegments[curIdx - 1];

        videoPlayer.currentTime = Math.max(0, targetSeg.offset);
        updateScrubberAndTime();
    }

    function skipToNextClip() {
        if (!activeFilename || !activeClipSegments || activeClipSegments.length <= 1) return;
        const cur = videoPlayer.currentTime || 0;
        const curIdx = getCurrentSegmentIndex(cur);
        if (curIdx < 0 || curIdx >= activeClipSegments.length - 1) return;

        const nextSeg = activeClipSegments[curIdx + 1];
        const dur = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : Infinity;
        videoPlayer.currentTime = Math.min(dur, nextSeg.offset);
        updateScrubberAndTime();
    }

    function resolveRecordingTimeAtPosition(elapsedSeconds) {
        if (!activeClipSegments || activeClipSegments.length === 0) return null;
        const pos = Number.isFinite(elapsedSeconds) && elapsedSeconds > 0 ? elapsedSeconds : 0;

        let activeSeg = activeClipSegments[0];
        for (let i = 0; i < activeClipSegments.length; i++) {
            const seg = activeClipSegments[i];
            if (pos >= seg.offset) {
                activeSeg = seg;
            } else {
                break;
            }
        }

        const rawSegElapsed = Math.max(0, pos - activeSeg.offset);
        const clampedSegElapsed = Number.isFinite(activeSeg.duration)
            ? Math.min(activeSeg.duration, rawSegElapsed)
            : rawSegElapsed;

        const clockStr = formatSecondsAsClock(activeSeg.startSeconds + Math.floor(clampedSegElapsed));

        return {
            clockStr,
            segment: activeSeg,
            totalSegments: activeClipSegments.length
        };
    }

    function formatTimeLabelText(elapsedSec, durationSec) {
        const relText = `${formatDurationClock(elapsedSec)} / ${formatDurationClock(durationSec)}`;
        const resolved = resolveRecordingTimeAtPosition(elapsedSec);
        if (!resolved) {
            if (vpTimeLabel) vpTimeLabel.removeAttribute('title');
            return relText;
        }

        if (vpTimeLabel) {
            const datePart = resolved.segment.date ? `${formatDateStr(resolved.segment.date)} ` : '';
            const segPart = resolved.totalSegments > 1
                ? ` (Clip ${resolved.segment.index} of ${resolved.totalSegments})`
                : '';
            vpTimeLabel.title = `Recorded at ${datePart}${resolved.clockStr}${segPart}`;
        }

        return `${resolved.clockStr}  •  ${relText}`;
    }

    function formatCamLabel(camId) {
        if (!camId) return 'CLIP';
        const match = String(camId).match(/^cam(\d+)$/i);
        if (match) return `CAM ${match[1]}`;
        return String(camId).toUpperCase();
    }

    function formatDateStr(dateRaw) {
        if (!dateRaw || String(dateRaw).length !== 8) return dateRaw || 'Unknown Date';
        const s = String(dateRaw);
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    }

    function formatVideoWindow(video, separator = '  •  ') {
        if (video.date && video.startTime && video.endTime) {
            if (video.endDate && video.endDate !== video.date) {
                return `${formatDateStr(video.date)} ${video.startTime} – ${formatDateStr(video.endDate)} ${video.endTime}`;
            }
            return `${formatDateStr(video.date)}${separator}${video.startTime} – ${video.endTime}`;
        }
        return video.filename;
    }

    function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
        return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    function formatDurationClock(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '00:00';
        const total = Math.floor(sec);
        const hrs = Math.floor(total / 3600);
        const mins = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        if (hrs > 0) {
            return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function pauseDashboardActivity() {
        if (typeof isSingleCameraOpen !== 'undefined') {
            isSingleCameraOpen = true;
        }
        if (cameraView && !cameraView.classList.contains('hidden') && typeof window.stopCameraView === 'function') {
            try { window.stopCameraView(); } catch (_) {}
        }
        if (typeof activeCameras !== 'undefined' && Array.isArray(activeCameras)) {
            activeCameras.forEach((id) => {
                if (typeof destroyHlsPlayer === 'function') {
                    try { destroyHlsPlayer(id); } catch (_) {}
                } else {
                    if (typeof clearCameraReconnectTimer === 'function') clearCameraReconnectTimer(id);
                    if (typeof clearCameraStaggerTimer === 'function') clearCameraStaggerTimer(id);
                    if (typeof stopCameraSnapshotLoop === 'function') stopCameraSnapshotLoop(id);
                    if (typeof hlsPlayers !== 'undefined' && hlsPlayers[id]) {
                        try { hlsPlayers[id].stopLoad(); } catch (_) {}
                    }
                }
                const videoEl = document.getElementById(`video-${id}`);
                if (videoEl) {
                    delete videoEl.dataset.clipUrl;
                    try {
                        videoEl.pause();
                        videoEl.removeAttribute('src');
                        videoEl.load();
                    } catch (_) {}
                }
            });
        }
    }

    function resumeDashboardActivity() {
        if (typeof isSingleCameraOpen !== 'undefined') {
            isSingleCameraOpen = false;
        }
        if (typeof isLive !== 'undefined' && isLive && typeof returnToLive === 'function') {
            returnToLive();
        } else if (typeof updateCamerasToScrubber === 'function' && typeof scrubber !== 'undefined' && scrubber) {
            updateCamerasToScrubber(parseInt(scrubber.value, 10), false);
        }
    }

    async function openVideosView(pushHistory = true) {
        if (!videosView) return;
        pauseDashboardActivity();

        const calPopup = document.getElementById('calendar-popup');
        if (calPopup) calPopup.classList.remove('visible');

        if (dashboardView) dashboardView.classList.add('hidden');
        if (cameraView) cameraView.classList.add('hidden');
        videosView.classList.remove('hidden');

        if (toolbarToggleBtn) {
            toolbarToggleBtn.style.display = 'none';
        }

        if (pushHistory && (!history.state || history.state.view !== 'videos')) {
            history.pushState({ view: 'videos' }, '', '#videos');
        }

        await ensureDynamicCamPalette();
        await fetchVideosList();
    }

    function closeVideosView(fromPopState = false) {
        if (!videosView || videosView.classList.contains('hidden')) return;

        closeDeleteModal();
        stopAndClearPlayer();

        videosView.classList.add('hidden');
        if (dashboardView) dashboardView.classList.remove('hidden');

        if (toolbarToggleBtn) {
            toolbarToggleBtn.style.display = '';
        }

        resumeDashboardActivity();

        if (!fromPopState && window.location.hash === '#videos') {
            history.back();
        }
    }

    function stopAndClearPlayer() {
        activeFilename = null;
        activeClipSegments = [];
        clearScrubberTicks();
        try {
            videoPlayer.pause();
            videoPlayer.removeAttribute('src');
            videoPlayer.load();
        } catch (_) {}

        emptyOverlay.classList.remove('hidden');
        overlayText.textContent = 'Select a recorded video to play';

        npCam.textContent = 'No Video Selected';
        npCam.style.color = '#bbb';
        npCam.style.borderColor = 'transparent';
        npMeta.textContent = 'Choose a video from the list to begin playback';

        npBtnDownload.href = '#';
        npBtnDownload.removeAttribute('download');
        npBtnDownload.classList.add('disabled');
        npBtnDelete.disabled = true;

        setTransportControlsEnabled(false);
        updatePlayButtonStates();
        vpScrubber.value = 0;
        vpTimeLabel.textContent = '00:00 / 00:00';
        vpTimeLabel.removeAttribute('title');
    }

    function setTransportControlsEnabled(enabled) {
        vpBtnPlay.disabled = !enabled;
        vpBtnSkipBack.disabled = !enabled;
        vpBtnSkipFwd.disabled = !enabled;
        vpScrubber.disabled = !enabled;
        vpSpeedSelect.disabled = !enabled;
        vpBtnFullscreen.disabled = !enabled;
        updateClipSkipButtonStates();
    }

    async function fetchVideosList() {
        btnRefresh.disabled = true;
        try {
            await ensureDynamicCamPalette();
            const response = await fetch('/api/video/list', {
                credentials: 'include',
                headers: { 'Cache-Control': 'no-cache' }
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            allVideos = Array.isArray(data.videos) ? data.videos : [];
            populateCameraFilter();
            renderVideosList();

            if (activeFilename) {
                const currentObj = allVideos.find(v => v.filename === activeFilename);
                if (!currentObj) {
                    stopAndClearPlayer();
                } else {
                    activeClipSegments = buildClipSegments(currentObj);
                    renderScrubberTicks();
                    updateScrubberAndTime();
                    maybeFetchSidecarSegments(currentObj);
                }
            }
        } catch (err) {
            console.error('Failed to fetch videos list:', err);
            videosListEl.innerHTML = '';
            const errDiv = document.createElement('div');
            errDiv.className = 'videos-list-empty';
            errDiv.textContent = `Unable to load recorded videos (${err.message}).`;
            videosListEl.appendChild(errDiv);
        } finally {
            btnRefresh.disabled = false;
        }
    }

    function populateCameraFilter() {
        const previousVal = filterCamSelect.value;
        const camIds = Array.from(
            new Set(allVideos.map(v => v.camId).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        filterCamSelect.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.textContent = 'All Cameras';
        filterCamSelect.appendChild(allOpt);

        camIds.forEach((camId) => {
            const opt = document.createElement('option');
            opt.value = camId;
            opt.textContent = formatCamLabel(camId);
            filterCamSelect.appendChild(opt);
        });

        if (camIds.includes(previousVal)) {
            filterCamSelect.value = previousVal;
        } else {
            filterCamSelect.value = 'all';
        }
    }

    function getFilteredAndSortedVideos() {
        const camFilter = filterCamSelect.value;
        const sortBy = sortSelect.value;

        const filtered = allVideos.filter((v) => {
            if (camFilter === 'all') return true;
            return v.camId === camFilter;
        });

        filtered.sort((a, b) => {
            if (sortBy === 'oldest') {
                return (a.mtime - b.mtime) || a.filename.localeCompare(b.filename);
            }
            if (sortBy === 'largest') {
                return (b.size - a.size) || (b.mtime - a.mtime);
            }
            if (sortBy === 'smallest') {
                return (a.size - b.size) || (b.mtime - a.mtime);
            }
            return (b.mtime - a.mtime) || b.filename.localeCompare(a.filename);
        });

        return filtered;
    }

    function updateSummaryBadge(filteredVideos = null) {
        const filtered = Array.isArray(filteredVideos) ? filteredVideos : getFilteredAndSortedVideos();
        const totalBytes = filtered.reduce((acc, v) => acc + (Number(v.size) || 0), 0);
        const countLabel = filtered.length === 1 ? '1 video' : `${filtered.length} videos`;
        summaryBadge.textContent = `${countLabel} • ${formatBytes(totalBytes)}`;
    }

    function renderVideosList() {
        const videos = getFilteredAndSortedVideos();
        updateSummaryBadge(videos);
        videosListEl.innerHTML = '';

        if (videos.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'videos-list-empty';
            emptyEl.textContent = allVideos.length === 0
                ? 'No recorded videos found. Use "Create Video" in any camera view to generate MP4 clips.'
                : 'No recorded videos match the selected camera filter.';
            videosListEl.appendChild(emptyEl);
            return;
        }

        const isPlaying = !videoPlayer.paused && !videoPlayer.ended;

        videos.forEach((video) => {
            const isSelected = video.filename === activeFilename;
            const camColor = resolveCameraColor(video.camId);

            const card = document.createElement('div');
            card.className = `video-item-card${isSelected ? ' active' : ''}`;
            card.dataset.filename = video.filename;
            card.style.setProperty('--item-cam-color', camColor);

            // Top Row: Camera badge + File size
            const topRow = document.createElement('div');
            topRow.className = 'video-item-top';

            const camBadge = document.createElement('span');
            camBadge.className = 'video-item-cam-badge';
            camBadge.textContent = formatCamLabel(video.camId);

            const sizeSpan = document.createElement('span');
            sizeSpan.className = 'video-item-size';
            sizeSpan.textContent = formatBytes(video.size);

            topRow.appendChild(camBadge);
            topRow.appendChild(sizeSpan);

            // Middle Row: Date & Time Window
            const windowRow = document.createElement('div');
            windowRow.className = 'video-item-window';
            windowRow.textContent = formatVideoWindow(video, '  •  ');

            // Sub-metadata: Created timestamp & filename
            const subMeta = document.createElement('div');
            subMeta.className = 'video-item-submeta';
            const createdSpan = document.createElement('span');
            const clipCount = Number.isFinite(Number(video.segmentCount))
                ? Number(video.segmentCount)
                : (Array.isArray(video.segments) ? video.segments.length : 0);
            const segCount = clipCount > 1 ? ` • ${clipCount} clips` : '';
            createdSpan.textContent = `Created: ${video.createdAt || 'Unknown'}${segCount}`;
            subMeta.appendChild(createdSpan);

            const fileRow = document.createElement('div');
            fileRow.className = 'video-item-filename';
            fileRow.textContent = video.filename;

            // Actions Row: Play/Pause, Download, Delete
            const actionsRow = document.createElement('div');
            actionsRow.className = 'video-item-actions';

            const itemPlayBtn = document.createElement('button');
            itemPlayBtn.type = 'button';
            const itemPlaying = isSelected && isPlaying;
            itemPlayBtn.className = `ctrl-btn item-play-btn${itemPlaying ? ' playing' : ''}`;
            itemPlayBtn.textContent = itemPlaying ? '⏸ Pause' : '▶ Play';
            itemPlayBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleSelectOrToggleVideo(video);
            });

            const itemDownloadLink = document.createElement('a');
            itemDownloadLink.className = 'ctrl-btn download-video-btn';
            itemDownloadLink.href = video.downloadUrl || `/api/video/stream?file=${encodeURIComponent(video.filename)}&download=1`;
            itemDownloadLink.setAttribute('download', video.filename);
            itemDownloadLink.textContent = '⬇ Download';
            itemDownloadLink.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            const itemDeleteBtn = document.createElement('button');
            itemDeleteBtn.type = 'button';
            itemDeleteBtn.className = 'ctrl-btn delete-video-btn';
            itemDeleteBtn.textContent = '🗑️ Delete';
            itemDeleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openDeleteModal(video);
            });

            actionsRow.appendChild(itemPlayBtn);
            actionsRow.appendChild(itemDownloadLink);
            actionsRow.appendChild(itemDeleteBtn);

            card.appendChild(topRow);
            card.appendChild(windowRow);
            card.appendChild(subMeta);
            card.appendChild(fileRow);
            card.appendChild(actionsRow);

            card.addEventListener('click', () => {
                if (activeFilename !== video.filename) {
                    loadAndPlayVideo(video);
                } else {
                    togglePlayPause();
                }
            });

            videosListEl.appendChild(card);
        });
    }

    function handleSelectOrToggleVideo(video) {
        if (!video) return;
        if (activeFilename === video.filename) {
            togglePlayPause();
        } else {
            loadAndPlayVideo(video);
        }
    }

    function loadAndPlayVideo(video) {
        if (!video) return;
        activeFilename = video.filename;
        activeClipSegments = buildClipSegments(video);
        renderScrubberTicks();
        maybeFetchSidecarSegments(video);

        const streamUrl = video.streamUrl || `/api/video/stream?file=${encodeURIComponent(video.filename)}`;
        const downloadUrl = video.downloadUrl || `/api/video/stream?file=${encodeURIComponent(video.filename)}&download=1`;
        const camColor = resolveCameraColor(video.camId);

        emptyOverlay.classList.add('hidden');
        videoPlayer.muted = true;
        videoPlayer.src = streamUrl;
        applyPlaybackSpeed();

        npCam.textContent = formatCamLabel(video.camId);
        npCam.style.color = camColor;
        npMeta.textContent = `${formatVideoWindow(video, ' ')} (${formatBytes(video.size)})`;

        npBtnDownload.href = downloadUrl;
        npBtnDownload.setAttribute('download', video.filename);
        npBtnDownload.classList.remove('disabled');
        npBtnDelete.disabled = false;

        setTransportControlsEnabled(true);
        vpScrubber.value = 0;
        vpTimeLabel.textContent = formatTimeLabelText(0, 0);

        videoPlayer.play().catch((err) => {
            console.warn('Playback did not auto-start:', err);
            updatePlayButtonStates();
        });

        updatePlayButtonStates();
    }

    function togglePlayPause() {
        if (!activeFilename) return;
        if (videoPlayer.paused || videoPlayer.ended) {
            if (videoPlayer.ended) {
                videoPlayer.currentTime = 0;
            }
            videoPlayer.play().catch((err) => {
                console.warn('Error playing video:', err);
            });
        } else {
            videoPlayer.pause();
        }
    }

    function updatePlayButtonStates() {
        const isPlaying = Boolean(activeFilename && !videoPlayer.paused && !videoPlayer.ended);

        if (isPlaying) {
            vpBtnPlay.textContent = '⏸ Pause';
            vpBtnPlay.classList.add('playing');
        } else {
            vpBtnPlay.textContent = '▶ Play';
            vpBtnPlay.classList.remove('playing');
        }

        const cards = videosListEl.querySelectorAll('.video-item-card');
        cards.forEach((card) => {
            const isCardActive = card.dataset.filename === activeFilename;
            card.classList.toggle('active', isCardActive);
            const btn = card.querySelector('.item-play-btn');
            if (btn) {
                const cardPlaying = isCardActive && isPlaying;
                btn.textContent = cardPlaying ? '⏸ Pause' : '▶ Play';
                btn.classList.toggle('playing', cardPlaying);
            }
        });
    }

    function updateScrubberAndTime() {
        const cur = videoPlayer.currentTime || 0;
        const dur = videoPlayer.duration;
        if (!isScrubbingVideo && Number.isFinite(dur) && dur > 0) {
            vpScrubber.value = Math.min(1000, Math.round((cur / dur) * 1000));
        }
        vpTimeLabel.textContent = formatTimeLabelText(cur, dur);
        updateClipSkipButtonStates();
    }

    function openDeleteModal(video) {
        if (!video) return;
        pendingDeleteVideo = video;
        const dateLabel = (video.endDate && video.endDate !== video.date)
            ? `${formatDateStr(video.date)} to ${formatDateStr(video.endDate)}`
            : formatDateStr(video.date);
        const label = video.camId ? `${formatCamLabel(video.camId)} (${dateLabel})` : video.filename;
        deletePromptEl.textContent = `Are you sure you want to permanently delete this recorded clip from ${label}?`;
        deleteFilenameEl.textContent = `${video.filename} (${formatBytes(video.size)})`;
        modalConfirmBtn.disabled = false;
        modalConfirmBtn.textContent = '🗑️ Delete';
        deleteModal.classList.remove('hidden');
    }

    function closeDeleteModal() {
        pendingDeleteVideo = null;
        if (deleteModal) {
            deleteModal.classList.add('hidden');
        }
    }

    async function confirmDeleteVideo() {
        if (!pendingDeleteVideo) return;
        const target = pendingDeleteVideo;
        modalConfirmBtn.disabled = true;
        modalConfirmBtn.textContent = 'Deleting...';

        try {
            const response = await fetch(`/api/video/delete?file=${encodeURIComponent(target.filename)}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            if (!response.ok) {
                const errPayload = await response.json().catch(() => ({}));
                throw new Error(errPayload.error || `HTTP ${response.status}`);
            }

            allVideos = allVideos.filter(v => v.filename !== target.filename);
            if (activeFilename === target.filename) {
                stopAndClearPlayer();
            }

            closeDeleteModal();
            populateCameraFilter();
            renderVideosList();
        } catch (err) {
            console.error('Failed to delete video:', err);
            alert(`Failed to delete video: ${err.message}`);
            modalConfirmBtn.disabled = false;
            modalConfirmBtn.textContent = '🗑️ Delete';
        }
    }

    // Event Listeners
    if (btnOpenVideos) {
        btnOpenVideos.addEventListener('click', () => openVideosView(true));
    }

    if (btnBack) {
        btnBack.addEventListener('click', () => closeVideosView(false));
    }

    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => fetchVideosList());
    }

    if (filterCamSelect) {
        filterCamSelect.addEventListener('change', () => renderVideosList());
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', () => renderVideosList());
    }

    if (videoStage) {
        videoStage.addEventListener('click', () => {
            if (activeFilename) {
                togglePlayPause();
            }
        });
    }

    if (vpBtnPlay) {
        vpBtnPlay.addEventListener('click', () => togglePlayPause());
    }

    if (vpBtnPrevClip) {
        vpBtnPrevClip.addEventListener('click', () => skipToPrevClip());
    }

    if (vpBtnSkipBack) {
        vpBtnSkipBack.addEventListener('click', () => {
            if (!activeFilename) return;
            videoPlayer.currentTime = Math.max(0, (videoPlayer.currentTime || 0) - 10);
        });
    }

    if (vpBtnSkipFwd) {
        vpBtnSkipFwd.addEventListener('click', () => {
            if (!activeFilename) return;
            const dur = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : Infinity;
            videoPlayer.currentTime = Math.min(dur, (videoPlayer.currentTime || 0) + 10);
        });
    }

    if (vpBtnNextClip) {
        vpBtnNextClip.addEventListener('click', () => skipToNextClip());
    }

    if (vpScrubber) {
        vpScrubber.addEventListener('input', () => {
            isScrubbingVideo = true;
            const dur = videoPlayer.duration;
            if (Number.isFinite(dur) && dur > 0) {
                const targetTime = (Number(vpScrubber.value) / 1000) * dur;
                vpTimeLabel.textContent = formatTimeLabelText(targetTime, dur);

                const rect = vpScrubber.getBoundingClientRect();
                const ratio = Number(vpScrubber.value) / 1000;
                updateScrubberHoverTooltip(rect.left + 7 + (rect.width - 14) * ratio);
            }
        });

        vpScrubber.addEventListener('change', () => {
            const dur = videoPlayer.duration;
            if (Number.isFinite(dur) && dur > 0) {
                videoPlayer.currentTime = (Number(vpScrubber.value) / 1000) * dur;
            }
            isScrubbingVideo = false;
        });

        vpScrubber.addEventListener('mousemove', (e) => {
            updateScrubberHoverTooltip(e.clientX);
        });

        vpScrubber.addEventListener('mouseleave', () => {
            if (scrubberTooltipEl) {
                scrubberTooltipEl.classList.remove('visible', 'on-transition');
            }
            if (scrubberTicksEl) {
                scrubberTicksEl.querySelectorAll('.vp-scrubber-tick.active-hover').forEach((t) => {
                    t.classList.remove('active-hover');
                });
            }
        });
    }

    if (vpSpeedSelect) {
        vpSpeedSelect.addEventListener('change', () => {
            applyPlaybackSpeed();
        });
    }

    if (vpBtnFullscreen) {
        vpBtnFullscreen.addEventListener('click', () => {
            const targetEl = videoStage || videoPlayer;
            if (!document.fullscreenElement) {
                if (targetEl.requestFullscreen) {
                    targetEl.requestFullscreen().catch(() => {});
                } else if (videoPlayer.webkitEnterFullscreen) {
                    videoPlayer.webkitEnterFullscreen();
                }
            } else if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            }
        });
    }

    if (npBtnDelete) {
        npBtnDelete.addEventListener('click', () => {
            const currentVideo = allVideos.find(v => v.filename === activeFilename);
            if (currentVideo) {
                openDeleteModal(currentVideo);
            }
        });
    }

    if (modalCancelBtn) {
        modalCancelBtn.addEventListener('click', () => closeDeleteModal());
    }

    if (modalConfirmBtn) {
        modalConfirmBtn.addEventListener('click', () => confirmDeleteVideo());
    }

    if (deleteModal) {
        deleteModal.addEventListener('click', (e) => {
            if (e.target === deleteModal) {
                closeDeleteModal();
            }
        });
    }

    // Video Element Events
    if (videoPlayer) {
        videoPlayer.addEventListener('play', updatePlayButtonStates);
        videoPlayer.addEventListener('pause', updatePlayButtonStates);
        videoPlayer.addEventListener('ended', () => {
            updatePlayButtonStates();
            updateScrubberAndTime();
        });
        videoPlayer.addEventListener('loadedmetadata', () => {
            applyPlaybackSpeed();
            renderScrubberTicks();
            updateScrubberAndTime();
        });
        videoPlayer.addEventListener('durationchange', () => {
            renderScrubberTicks();
            updateScrubberAndTime();
        });
        videoPlayer.addEventListener('timeupdate', updateScrubberAndTime);
        videoPlayer.addEventListener('error', () => {
            if (!activeFilename) return;
            emptyOverlay.classList.remove('hidden');
            overlayText.textContent = 'Error loading or playing the selected video file.';
            updatePlayButtonStates();
        });
    }

    // Keyboard Shortcuts & History Navigation
    window.addEventListener('keydown', (e) => {
        if (!videosView || videosView.classList.contains('hidden')) return;

        if (e.key === 'Escape') {
            if (deleteModal && !deleteModal.classList.contains('hidden')) {
                closeDeleteModal();
            } else {
                closeVideosView(false);
            }
            return;
        }

        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') return;

        if (e.code === 'Space' && activeFilename) {
            e.preventDefault();
            togglePlayPause();
        } else if (e.key === 'ArrowLeft' && activeFilename) {
            e.preventDefault();
            if (e.shiftKey) {
                skipToPrevClip();
            } else {
                videoPlayer.currentTime = Math.max(0, (videoPlayer.currentTime || 0) - 5);
            }
        } else if (e.key === 'ArrowRight' && activeFilename) {
            e.preventDefault();
            if (e.shiftKey) {
                skipToNextClip();
            } else {
                const dur = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : Infinity;
                videoPlayer.currentTime = Math.min(dur, (videoPlayer.currentTime || 0) + 5);
            }
        }
    });

    window.addEventListener('popstate', () => {
        if (window.location.hash === '#videos') {
            openVideosView(false);
        } else if (videosView && !videosView.classList.contains('hidden')) {
            closeVideosView(true);
        }
    });
})();