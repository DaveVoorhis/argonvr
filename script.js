function runEasterEgg() {
	const brand = document.getElementById('brand-text');
	if (!brand) return;
	if (Math.random() < 0.15) {
		const originalText = brand.innerText;
		brand.innerText = (originalText === "ArgoNVR") ? "ArgonVR" : "ArgoNVR";
		setTimeout(() => { brand.innerText = originalText; }, 3000);
	}
}
setInterval(runEasterEgg, 10000);

const CAMERA_COLORS = [
	'#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#e74c3c', '#1abc9c', '#e84393'
];

function getCameraColor(camId) {
	const num = parseInt(camId.replace(/\D/g, '')) || 1;
	return CAMERA_COLORS[(num - 1) % CAMERA_COLORS.length];
}

let globalManifest = {};
const hlsPlayers = {};
const activeCameras = [];

let isLive = true;
let isPlayingHistory = false;
let playbackInterval = null;
let liveSyncInterval = null;
let currentDayString = "";

let availableDates = new Set();
let calViewDate = new Date();

const scrubber = document.getElementById('scrubber');
const timeLabel = document.getElementById('time-label');
const playBtn = document.getElementById('btn-play');
const liveBtn = document.getElementById('btn-live');
const dateDisplay = document.getElementById('global-date');
const zoomSlider = document.getElementById('zoom-slider');
const timelineContent = document.getElementById('timeline-content');
const timelineViewport = document.getElementById('timeline-viewport');

function adjustZoom(direction) {
	const currentVal = parseInt(zoomSlider.value, 10);
	const newVal = currentVal + direction;
	if (newVal >= parseInt(zoomSlider.min, 10) && newVal <= parseInt(zoomSlider.max, 10)) {
		zoomSlider.value = newVal;
		zoomSlider.dispatchEvent(new Event('input'));
	}
}

function renderTimelineRuler() {
	const ruler = document.getElementById('timeline-ruler');
	ruler.innerHTML = '';

	for (let sec = 0; sec <= 86400; sec += 300) {
		const isHour = (sec % 3600 === 0);
		const leftPct = (sec / 86400) * 100;

		const tick = document.createElement('div');
		tick.className = `ruler-tick ${isHour ? 'hour' : 'five-min'}`;
		tick.style.left = `${leftPct}%`;

		ruler.appendChild(tick);
	}
}

function centerViewportOnScrubber() {
	const viewportWidth = timelineViewport.clientWidth;
	const currentVal = parseInt(scrubber.value, 10);
	const scrubberPct = currentVal / 86400;
	const newScrubberX = scrubberPct * timelineContent.clientWidth;
	timelineViewport.scrollLeft = newScrubberX - (viewportWidth / 2);
}

zoomSlider.addEventListener('input', () => {
	const zoomLevel = parseFloat(zoomSlider.value);
	timelineContent.style.width = `${zoomLevel * 100}%`;
	centerViewportOnScrubber();
});

function getTodayString() {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	const dd = String(now.getDate()).padStart(2, '0');
	return `${yyyy}${mm}${dd}`;
}

function setDate(dateObj) {
	const yyyy = dateObj.getFullYear();
	const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
	const dd = String(dateObj.getDate()).padStart(2, '0');
	currentDayString = `${yyyy}${mm}${dd}`;
	dateDisplay.innerHTML = `<span>${dd}/${mm}/${yyyy}</span> 📅`;

	renderTimelineHeatmap();

	if (activeCameras.length > 0) {
		if (isPlayingHistory) playBtn.click();

		if (currentDayString === getTodayString()) {
			returnToLive();
		} else {
			isLive = false;
			liveBtn.innerText = "Go Live";
			playBtn.disabled = false;
			liveBtn.classList.remove('active');
			if (liveSyncInterval) clearInterval(liveSyncInterval);

			timeLabel.style.color = "#f39c12";
			activeCameras.forEach(camId => {
				if (hlsPlayers[camId]) hlsPlayers[camId].detachMedia();
			});

			scrubber.value = 43200;
			timeLabel.innerText = secondsToTimeStr(43200);
			updateCamerasToScrubber(43200, true);
			setTimeout(centerViewportOnScrubber, 50);
		}
	}
}

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

async function fetchManifest() {
	try {
		const url = `/history?date=${currentDayString}&cam=all`;

		const response = await fetch(url, { cache: 'no-store', credentials: 'include' });
		const newManifest = await response.json();

		Object.keys(newManifest).forEach(camId => {
			const clips = newManifest[camId];

			clips.sort((a, b) => {
				return (extractTimeFromFilename(a.filename) || 0) - (extractTimeFromFilename(b.filename) || 0);
			});

			for (let i = 0; i < clips.length; i++) {
				const clip = clips[i];

				if (globalManifest[camId]) {
					const existingClip = globalManifest[camId].find(c => c.filename === clip.filename);
					if (existingClip && existingClip.duration) {
						clip.duration = existingClip.duration;
					}
				}

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
								if (delta > 0 && delta <= 60) {
									guessedDur = delta;
								}
							}
						}
					}
					clip.duration = guessedDur;
				}
			}
		});

		globalManifest = newManifest;

		availableDates.clear();
		Object.values(globalManifest).forEach(clips => {
			clips.forEach(clip => {
				const match = clip.filename.match(/_(\d{8})_/);
				if (match) availableDates.add(match[1]);
			});
		});

		renderTimelineHeatmap();
		if (document.getElementById('calendar-popup').classList.contains('visible')) {
			renderCalendar();
		}
	} catch (e) {
		console.log("Could not load history manifest. Likely an auth issue.");
	}
}

function renderTimelineHeatmap() {
	const heatmap = document.getElementById('heatmap');
	heatmap.innerHTML = '';

	const cams = Object.keys(globalManifest);
	const numCams = cams.length || 1;

	cams.forEach((camId, index) => {
		const clips = globalManifest[camId];
		const camColor = getCameraColor(camId);

		clips.forEach(clip => {
			const startSec = parseFilenameToSeconds(clip.filename);
			if (startSec === null) return;

			const clipDuration = clip.duration || 60;

			const leftPct = (startSec / 86400) * 100;
			const widthPct = (clipDuration / 86400) * 100;

			const tick = document.createElement('div');
			tick.className = 'heatmap-tick';
			tick.style.left = `${leftPct}%`;
			tick.style.width = `${widthPct}%`;
			tick.style.backgroundColor = camColor;

			const laneHeight = 100 / numCams;
			tick.style.top = `${index * laneHeight}%`;
			tick.style.height = `${laneHeight}%`;

			heatmap.appendChild(tick);
		});
	});
}

function toggleCalendar() {
	const popup = document.getElementById('calendar-popup');
	popup.classList.toggle('visible');
	if (popup.classList.contains('visible')) {
		const y = parseInt(currentDayString.substring(0,4));
		const m = parseInt(currentDayString.substring(4,6)) - 1;
		calViewDate = new Date(y, m, 1);
		renderCalendar();
	}
}

function changeMonth(delta) {
	calViewDate.setMonth(calViewDate.getMonth() + delta);
	renderCalendar();
}

function renderCalendar() {
	const label = document.getElementById('cal-month-label');
	const grid = document.getElementById('cal-grid');

	label.innerText = calViewDate.toLocaleString('default', { month: 'long', year: 'numeric' });

	const year = calViewDate.getFullYear();
	const month = calViewDate.getMonth();
	const firstDay = new Date(year, month, 1).getDay();
	const daysInMonth = new Date(year, month + 1, 0).getDate();

	let html = `
		<div class="cal-day-header">Su</div><div class="cal-day-header">Mo</div><div class="cal-day-header">Tu</div>
		<div class="cal-day-header">We</div><div class="cal-day-header">Th</div><div class="cal-day-header">Fr</div><div class="cal-day-header">Sa</div>
	`;

	for (let i = 0; i < firstDay; i++) {
		html += `<div class="cal-day empty"></div>`;
	}

	for (let day = 1; day <= daysInMonth; day++) {
		const dateStr = `${year}${String(month + 1).padStart(2, '0')}${String(day).padStart(2, '0')}`;
		const hasVideo = availableDates.has(dateStr);
		const isActive = (dateStr === currentDayString);

		let classes = "cal-day";
		if (hasVideo) classes += " has-video";
		if (isActive) classes += " active-day";

		html += `<div class="${classes}" onclick="selectDateFromCalendar('${dateStr}')">${day}</div>`;
	}
	grid.innerHTML = html;
}

function selectDateFromCalendar(dateStr) {
	const y = parseInt(dateStr.substring(0,4));
	const m = parseInt(dateStr.substring(4,6)) - 1;
	const d = parseInt(dateStr.substring(6,8));
	setDate(new Date(y, m, d));
	toggleCalendar();
}

function selectQuickDate(keyword) {
	const d = new Date();
	if (keyword === 'yesterday') d.setDate(d.getDate() - 1);
	setDate(d);
	toggleCalendar();
}

function findClipForCamera(camId, targetSeconds) {
	const clips = globalManifest[camId] || [];
	for (let clipRef of clips) {
		const startSec = parseFilenameToSeconds(clipRef.filename);
		if (startSec === null) continue;

		const clipDuration = clipRef.duration || 60;
		const endSec = startSec + clipDuration;

		if (targetSeconds >= startSec && targetSeconds <= endSec) {
			return { manifestRef: clipRef, offset: targetSeconds - startSec };
		}
	}
	return null;
}

function updateCamerasToScrubber(targetSeconds, isManualScrub = false) {
	activeCameras.forEach(camId => {
		const videoEl = document.getElementById(`video-${camId}`);
		const overlay = document.getElementById(`overlay-${camId}`);
		const matchData = findClipForCamera(camId, targetSeconds);

		if (matchData) {
			const manifestRef = matchData.manifestRef;
			const offset = matchData.offset;

			if (!videoEl.src.includes(manifestRef.url.replace('./', ''))) {
				videoEl.src = manifestRef.url;
				videoEl.style.display = 'block';
				overlay.style.display = 'none';

				videoEl.onloadedmetadata = () => {
					if (!manifestRef.duration && videoEl.duration > 0 && videoEl.duration !== Infinity) {
						manifestRef.duration = videoEl.duration;
						renderTimelineHeatmap();
					}

					videoEl.currentTime = offset;
					if (isPlayingHistory) videoEl.play().catch(e => {});
				};
			} else {
				if (videoEl.readyState > 0 && offset > videoEl.duration) {
					videoEl.style.display = 'none';
					overlay.style.display = 'flex';
				} else {
					videoEl.style.display = 'block';
					overlay.style.display = 'none';

					const drift = Math.abs(videoEl.currentTime - offset);
					if (isManualScrub || drift > 3) {
						videoEl.currentTime = offset;
					}

					if (isPlayingHistory && videoEl.paused) {
						videoEl.play().catch(e => {});
					} else if (!isPlayingHistory && !videoEl.paused) {
						videoEl.pause();
					}
				}
			}
		} else {
			videoEl.src = "";
			videoEl.style.display = 'block';
			overlay.style.display = 'flex';
		}
	});
}

function openCameraPage(camId) {
	window.location.href = `camera.html?cam=${camId}&date=${currentDayString}`;
}

function returnToLive() {
	if (liveSyncInterval) clearInterval(liveSyncInterval);

	isLive = true;
	isPlayingHistory = false;
	if (playbackInterval) clearInterval(playbackInterval);

	playBtn.innerText = "▶ Play";
	playBtn.disabled = true;

	liveBtn.innerText = "Reset";
	liveBtn.classList.add('active');

	timeLabel.innerText = "LIVE";
	timeLabel.style.color = "#4cd137";

	const setScrubberToNow = () => {
		const d = new Date();
		const curSec = (d.getHours() * 3600) + (d.getMinutes() * 60) + d.getSeconds();
		scrubber.value = curSec;
		return curSec;
	};

	setScrubberToNow();
	setTimeout(centerViewportOnScrubber, 50);

	liveSyncInterval = setInterval(() => {
		if (!isLive) return;

		if (currentDayString !== "" && currentDayString !== getTodayString()) {
			setDate(new Date());
			return;
		}

		const curSec = setScrubberToNow();

		const scrubberX = (curSec / 86400) * timelineContent.clientWidth;
		const viewLeft = timelineViewport.scrollLeft;
		const viewRight = viewLeft + timelineViewport.clientWidth;

		if (scrubberX > viewRight - 50 || scrubberX < viewLeft) {
			timelineViewport.scrollLeft = scrubberX - timelineViewport.clientWidth / 2;
		}
	}, 1000);

	if (currentDayString !== getTodayString()) {
		setDate(new Date());
		return;
	}

	activeCameras.forEach(camId => {
		const videoEl = document.getElementById(`video-${camId}`);
		const overlay = document.getElementById(`overlay-${camId}`);

		videoEl.style.display = 'block';
		overlay.style.display = 'none';

		videoEl.pause();
		videoEl.removeAttribute('src');
		videoEl.load();

		if (hlsPlayers[camId]) hlsPlayers[camId].destroy();

		const freshPlaylistUrl = `./cameras/${camId}/stream.m3u8?t=${Date.now()}`;

		if (Hls.isSupported()) {
			const hls = new Hls({
				liveDurationInfinity: true,
				manifestLoadingMaxRetry: 5,
				xhrSetup: function(xhr) {
					xhr.withCredentials = true;
				}
			});
			hlsPlayers[camId] = hls;
			hls.loadSource(freshPlaylistUrl);
			hls.attachMedia(videoEl);
			hls.on(Hls.Events.MANIFEST_PARSED, () => videoEl.play().catch(e => {}));
		} else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
			videoEl.src = freshPlaylistUrl;
			videoEl.play().catch(e => {});
		}
	});
}

scrubber.addEventListener('input', (e) => {
	if (isLive) {
		isLive = false;
		liveBtn.innerText = "Go Live";
		playBtn.disabled = false;
		liveBtn.classList.remove('active');
		if (liveSyncInterval) clearInterval(liveSyncInterval);

		timeLabel.style.color = "#f39c12";
		activeCameras.forEach(camId => {
			if (hlsPlayers[camId]) hlsPlayers[camId].detachMedia();
		});
		fetchManifest();
	}
	const targetSeconds = parseInt(e.target.value, 10);
	timeLabel.innerText = secondsToTimeStr(targetSeconds);
	if (isPlayingHistory) playBtn.click();

	updateCamerasToScrubber(targetSeconds, true);

	const scrubberX = (targetSeconds / 86400) * timelineContent.clientWidth;
	const buffer = 50;
	if (scrubberX < timelineViewport.scrollLeft + buffer) {
		timelineViewport.scrollLeft = scrubberX - buffer;
	} else if (scrubberX > timelineViewport.scrollLeft + timelineViewport.clientWidth - buffer) {
		timelineViewport.scrollLeft = scrubberX - timelineViewport.clientWidth + buffer;
	}
});

playBtn.addEventListener('click', () => {
	if (isLive) return;

	isPlayingHistory = !isPlayingHistory;
	if (isPlayingHistory) {
		playBtn.innerText = "⏸ Pause";
		playbackInterval = setInterval(() => {
			let currentVal = parseInt(scrubber.value, 10);
			if (currentVal >= 86399) {
				returnToLive();
			} else {
				currentVal += 1;
				scrubber.value = currentVal;
				timeLabel.innerText = secondsToTimeStr(currentVal);

				updateCamerasToScrubber(currentVal, false);

				const scrubberX = (currentVal / 86400) * timelineContent.clientWidth;
				if (scrubberX < timelineViewport.scrollLeft || scrubberX > timelineViewport.scrollLeft + timelineViewport.clientWidth) {
					timelineViewport.scrollLeft = scrubberX - timelineViewport.clientWidth / 2;
				}
			}
		}, 1000);
	} else {
		playBtn.innerText = "▶ Play";
		clearInterval(playbackInterval);
		activeCameras.forEach(camId => {
			document.getElementById(`video-${camId}`).pause();
		});
	}
});

liveBtn.addEventListener('click', () => {
	if (isLive) {
		returnToLive();
	} else {
		returnToLive();
	}
});

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		if (isLive) {
			returnToLive();
		} else {
			fetchManifest();
		}
	}
});

document.addEventListener('click', (e) => {
	const popup = document.getElementById('calendar-popup');
	const dateBtn = document.getElementById('global-date');
	if (popup.classList.contains('visible') && !popup.contains(e.target) && !dateBtn.contains(e.target)) {
		popup.classList.remove('visible');
	}
});

function adjustGridLayout() {
	const grid = document.getElementById('grid');
	const count = activeCameras.length;
	if (count === 0) return;

	if (window.innerWidth <= 800) {
		grid.style.gridTemplateColumns = '1fr';
		grid.style.gridTemplateRows = `repeat(${count}, 250px)`;
		grid.style.overflowY = 'auto';
		return;
	}

	grid.style.overflowY = 'hidden';
	let cols, rows;
	if (count === 1) { cols = 1; rows = 1; }
	else if (count === 2) { cols = 2; rows = 1; }
	else if (count <= 4) { cols = 2; rows = 2; }
	else if (count <= 6) { cols = 3; rows = 2; }
	else if (count <= 9) { cols = 3; rows = 3; }
	else if (count <= 12) { cols = 4; rows = 3; }
	else {
		cols = Math.ceil(Math.sqrt(count));
		rows = Math.ceil(count / cols);
	}
	grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
	grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
}

window.addEventListener('resize', adjustGridLayout);

function createCameraDOM(camId, streamPath) {
	const grid = document.getElementById('grid');
	const card = document.createElement('div');
	card.className = 'camera-card';

	const camColor = getCameraColor(camId);
	card.style.borderTop = `4px solid ${camColor}`;

	card.innerHTML = `
		<div class="camera-header">
			<span class="camera-title" style="color: ${camColor}; text-shadow: 1px 1px 2px black;">${camId}</span>
		</div>
		<video id="video-${camId}" muted playsinline></video>
		<div class="no-video-overlay" id="overlay-${camId}">
			<div>No Motion Detected</div>
		</div>
	`;

	card.addEventListener('click', () => openCameraPage(camId));

	grid.appendChild(card);
	activeCameras.push(camId);
	adjustGridLayout();

	const videoElement = document.getElementById(`video-${camId}`);

	if (Hls.isSupported()) {
		const hls = new Hls({
			liveDurationInfinity: true,
			manifestLoadingMaxRetry: 5,
			xhrSetup: function(xhr) {
				xhr.withCredentials = true;
			}
		});
		hlsPlayers[camId] = hls;
		hls.loadSource(streamPath);
		hls.attachMedia(videoElement);
		hls.on(Hls.Events.MANIFEST_PARSED, () => videoElement.play().catch(e => {}));
	} else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
		videoElement.src = streamPath;
		videoElement.addEventListener('loadedmetadata', () => videoElement.play().catch(e => {}));
	}
}

async function discoverCameras() {
	try {
		const response = await fetch('/cameracount', { cache: 'no-store', credentials: 'include' });
		if (response.ok) {
			const data = await response.json();
			const count = data.count || 1;
			for (let index = 1; index <= count; index++) {
				const camId = `cam${index}`;
				const streamPath = `./cameras/${camId}/stream.m3u8`;
				createCameraDOM(camId, streamPath);
			}
		} else {
			setTimeout(discoverCameras, 2000);
		}
	} catch (error) {
		setTimeout(discoverCameras, 2000);
	}
}

document.addEventListener('DOMContentLoaded', () => {
	renderTimelineRuler();
	returnToLive();
	fetchManifest();
	setInterval(fetchManifest, 30000);
	discoverCameras();
});