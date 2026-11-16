(() => {
    let CAM_PALETTE = ['#3498db'];

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
    const vpBtnMute = document.getElementById('vp-btn-mute');
    const vpBtnFullscreen = document.getElementById('vp-btn-fullscreen');

    const videosListEl = document.getElementById('videos-list');

    const deleteModal = document.getElementById('videos-delete-modal');
    const deletePromptEl = document.getElementById('videos-delete-prompt');
    const deleteFilenameEl = document.getElementById('videos-delete-filename');
    const modalCancelBtn = document.getElementById('videos-modal-cancel');
    const modalConfirmBtn = document.getElementById('videos-modal-confirm');

    // State
    let allVideos = [];
    let activeFilename = null;
    let pendingDeleteVideo = null;
    let isScrubbingVideo = false;

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
        if (typeof activeCameras !== 'undefined' && Array.isArray(activeCameras)) {
            activeCameras.forEach((id) => {
                if (typeof clearCameraReconnectTimer === 'function') clearCameraReconnectTimer(id);
                if (typeof clearCameraStaggerTimer === 'function') clearCameraStaggerTimer(id);
                if (typeof stopCameraSnapshotLoop === 'function') stopCameraSnapshotLoop(id);
                const videoEl = document.getElementById(`video-${id}`);
                if (videoEl && !videoEl.paused) {
                    try { videoEl.pause(); } catch (_) {}
                }
                if (typeof hlsPlayers !== 'undefined' && hlsPlayers[id]) {
                    try { hlsPlayers[id].stopLoad(); } catch (_) {}
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
    }

    function setTransportControlsEnabled(enabled) {
        vpBtnPlay.disabled = !enabled;
        vpBtnSkipBack.disabled = !enabled;
        vpBtnSkipFwd.disabled = !enabled;
        vpScrubber.disabled = !enabled;
        vpSpeedSelect.disabled = !enabled;
        vpBtnMute.disabled = !enabled;
        vpBtnFullscreen.disabled = !enabled;
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
            updateSummaryBadge();
            renderVideosList();

            if (activeFilename && !allVideos.some(v => v.filename === activeFilename)) {
                stopAndClearPlayer();
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

    function updateSummaryBadge() {
        const filtered = getFilteredAndSortedVideos();
        const totalBytes = filtered.reduce((acc, v) => acc + (Number(v.size) || 0), 0);
        const countLabel = filtered.length === 1 ? '1 video' : `${filtered.length} videos`;
        summaryBadge.textContent = `${countLabel} • ${formatBytes(totalBytes)}`;
    }

    function renderVideosList() {
        updateSummaryBadge();
        const videos = getFilteredAndSortedVideos();
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
            if (video.date && video.startTime && video.endTime) {
                windowRow.textContent = `${formatDateStr(video.date)}  •  ${video.startTime} – ${video.endTime}`;
            } else {
                windowRow.textContent = video.filename;
            }

            // Sub-metadata: Created timestamp & filename
            const subMeta = document.createElement('div');
            subMeta.className = 'video-item-submeta';
            const createdSpan = document.createElement('span');
            createdSpan.textContent = `Created: ${video.createdAt || 'Unknown'}`;
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

        const streamUrl = video.streamUrl || `/api/video/stream?file=${encodeURIComponent(video.filename)}`;
        const downloadUrl = video.downloadUrl || `/api/video/stream?file=${encodeURIComponent(video.filename)}&download=1`;
        const camColor = resolveCameraColor(video.camId);

        emptyOverlay.classList.add('hidden');
        videoPlayer.src = streamUrl;
        videoPlayer.playbackRate = parseFloat(vpSpeedSelect.value) || 1;

        npCam.textContent = formatCamLabel(video.camId);
        npCam.style.color = camColor;
        if (video.date && video.startTime && video.endTime) {
            npMeta.textContent = `${formatDateStr(video.date)} ${video.startTime}–${video.endTime} (${formatBytes(video.size)})`;
        } else {
            npMeta.textContent = `${video.filename} (${formatBytes(video.size)})`;
        }

        npBtnDownload.href = downloadUrl;
        npBtnDownload.setAttribute('download', video.filename);
        npBtnDownload.classList.remove('disabled');
        npBtnDelete.disabled = false;

        setTransportControlsEnabled(true);
        vpScrubber.value = 0;
        vpTimeLabel.textContent = '00:00 / 00:00';

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
        vpTimeLabel.textContent = `${formatDurationClock(cur)} / ${formatDurationClock(dur)}`;
    }

    function openDeleteModal(video) {
        if (!video) return;
        pendingDeleteVideo = video;
        const label = video.camId ? `${formatCamLabel(video.camId)} (${formatDateStr(video.date)})` : video.filename;
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

    if (vpScrubber) {
        vpScrubber.addEventListener('input', () => {
            isScrubbingVideo = true;
            const dur = videoPlayer.duration;
            if (Number.isFinite(dur) && dur > 0) {
                const targetTime = (Number(vpScrubber.value) / 1000) * dur;
                vpTimeLabel.textContent = `${formatDurationClock(targetTime)} / ${formatDurationClock(dur)}`;
            }
        });

        vpScrubber.addEventListener('change', () => {
            const dur = videoPlayer.duration;
            if (Number.isFinite(dur) && dur > 0) {
                videoPlayer.currentTime = (Number(vpScrubber.value) / 1000) * dur;
            }
            isScrubbingVideo = false;
        });
    }

    if (vpSpeedSelect) {
        vpSpeedSelect.addEventListener('change', () => {
            videoPlayer.playbackRate = parseFloat(vpSpeedSelect.value) || 1;
        });
    }

    if (vpBtnMute) {
        vpBtnMute.addEventListener('click', () => {
            videoPlayer.muted = !videoPlayer.muted;
            vpBtnMute.textContent = videoPlayer.muted ? '🔇' : '🔊';
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
        videoPlayer.addEventListener('loadedmetadata', updateScrubberAndTime);
        videoPlayer.addEventListener('durationchange', updateScrubberAndTime);
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
            videoPlayer.currentTime = Math.max(0, (videoPlayer.currentTime || 0) - 5);
        } else if (e.key === 'ArrowRight' && activeFilename) {
            e.preventDefault();
            const dur = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : Infinity;
            videoPlayer.currentTime = Math.min(dur, (videoPlayer.currentTime || 0) + 5);
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