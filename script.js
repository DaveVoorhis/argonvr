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

// Floating Window State
let fwHlsPlayer = null;
let activeModalCamId = null;

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
		const response = await fetch('./recordings/history.json', { cache: 'no-store', credentials: 'include' });
		const newManifest = await response.json();
		
		Object.keys(newManifest).forEach(camId => {
			const clips = newManifest[camId];
			
			// 1. Sort clips strictly by time
			clips.sort((a, b) => {
				return (extractTimeFromFilename(a.filename) || 0) - (extractTimeFromFilename(b.filename) || 0);
			});
			
			for (let i = 0; i < clips.length; i++) {
				const clip = clips[i];
				
				// 2. Preserve known exact durations from previous loads
				if (globalManifest[camId]) {
					const existingClip = globalManifest[camId].find(c => c.filename === clip.filename);
					if (existingClip && existingClip.duration) {
						clip.duration = existingClip.duration;
					}
				}
				
				// 3. Heuristic: calculate duration based on the gap to the next clip
				if (!clip.duration) {
					let guessedDur = 60; // Default fallback
					if (i < clips.length - 1) {
						const matchA = clip.filename.match(/_(\d{8})_/);
						const matchB = clips[i+1].filename.match(/_(\d{8})_/);
						
						// Ensure they are on the same day before comparing
						if (matchA && matchB && matchA[1] === matchB[1]) {
							const aTime = extractTimeFromFilename(clip.filename);
							const bTime = extractTimeFromFilename(clips[i+1].filename);
							if (aTime !== null && bTime !== null) {
								const delta = bTime - aTime;
								// If the next clip starts within 60s, use the exact delta
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

// Updates Floating Window Gapless Indicator from external seconds
function updateFwIndicatorFromSeconds(actualSec) {
	if (!activeModalCamId) return;
	const clips = globalManifest[activeModalCamId] || [];
	const dayClips = clips.filter(c => parseFilenameToSeconds(c.filename) !== null)
						  .sort((a,b) => parseFilenameToSeconds(a.filename) - parseFilenameToSeconds(b.filename));

	if (dayClips.length === 0) return;
	const totalDuration = dayClips.reduce((sum, c) => sum + (c.duration || 60), 0);
	if (totalDuration === 0) return;

	let accum = 0;
	let found = false;
	let continuousSec = 0;

	for (let clip of dayClips) {
		let startSec = parseFilenameToSeconds(clip.filename);
		let dur = clip.duration || 60;
		let endSec = startSec + dur;

		if (actualSec >= startSec && actualSec <= endSec) {
			continuousSec = accum + (actualSec - startSec);
			found = true;
			break;
		}
		accum += dur;
	}

	if (found) {
		const pct = continuousSec / totalDuration;
		document.getElementById('fw-timeline-indicator').style.left = `${pct * 100}%`;
		document.getElementById('fw-time-label').innerText = secondsToTimeStr(actualSec);
		document.getElementById('fw-time-label').style.color = "#f39c12";
	} else {
		document.getElementById('fw-time-label').innerText = "NO DATA";
		document.getElementById('fw-time-label').style.color = "#666";
	}
}

function updateCamerasToScrubber(targetSeconds, isManualScrub = false) {
	activeCameras.forEach(camId => {
		const videoEl = document.getElementById(`video-${camId}`);
		const overlay = document.getElementById(`overlay-${camId}`);
		const matchData = findClipForCamera(camId, targetSeconds);
		
		const isModal = (activeModalCamId === camId);
		const fwVideo = isModal ? document.getElementById('fw-video') : null;
		const fwOverlay = isModal ? document.getElementById('fw-overlay') : null;

		if (matchData) {
			const manifestRef = matchData.manifestRef;
			const offset = matchData.offset;

			if (!videoEl.src.includes(manifestRef.url.replace('./', ''))) {
				videoEl.src = manifestRef.url;
				videoEl.style.display = 'block';
				overlay.style.display = 'none';
				
				if (isModal) {
					fwVideo.src = manifestRef.url;
					fwVideo.style.display = 'block';
					fwOverlay.style.display = 'none';
					updateFwIndicatorFromSeconds(targetSeconds);
				}
				
				videoEl.onloadedmetadata = () => {
					if (!manifestRef.duration && videoEl.duration > 0 && videoEl.duration !== Infinity) {
						manifestRef.duration = videoEl.duration;
						renderTimelineHeatmap(); 
					}
					
					videoEl.currentTime = offset;
					if (isPlayingHistory) videoEl.play().catch(e => {});
					
					if (isModal) {
						fwVideo.currentTime = offset;
						if (isPlayingHistory) fwVideo.play().catch(e=>{});
					}
				};
			} else {
				if (videoEl.readyState > 0 && offset > videoEl.duration) {
					videoEl.style.display = 'none';
					overlay.style.display = 'flex';
					if (isModal) {
						fwVideo.style.display = 'none';
						fwOverlay.style.display = 'flex';
					}
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
					
					if (isModal) {
						fwVideo.style.display = 'block';
						fwOverlay.style.display = 'none';
						if (isManualScrub || drift > 3) fwVideo.currentTime = offset;
						if (isPlayingHistory && fwVideo.paused) fwVideo.play().catch(e=>{});
						else if (!isPlayingHistory && !fwVideo.paused) fwVideo.pause();
						updateFwIndicatorFromSeconds(targetSeconds);
					}
				}
			}
		} else {
			videoEl.src = "";
			videoEl.style.display = 'block'; 
			overlay.style.display = 'flex';
			if (isModal) {
				fwVideo.src = "";
				fwVideo.style.display = 'block';
				fwOverlay.style.display = 'flex';
				document.getElementById('fw-time-label').innerText = "NO DATA";
				document.getElementById('fw-time-label').style.color = "#666";
			}
		}
	});
}

// --- Floating Window Custom Timeline Logic ---
const fwTimelineRegion = document.getElementById('fw-timeline-region');
const fwIndicator = document.getElementById('fw-timeline-indicator');
const fwTimeLabel = document.getElementById('fw-time-label');
let fwIsScrubbing = false;

function updateFwTimelineFromEvent(e) {
	if (!activeModalCamId) return;

	const rect = fwTimelineRegion.getBoundingClientRect();
	let x = e.clientX - rect.left;
	x = Math.max(0, Math.min(x, rect.width)); 
	const pct = x / rect.width;

	fwIndicator.style.left = `${pct * 100}%`;

	const clips = globalManifest[activeModalCamId] || [];
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
	}

	const fwVideo = document.getElementById('fw-video');
	const fwOverlay = document.getElementById('fw-overlay');

	if (!fwVideo.src.includes(selectedClip.url.replace('./', ''))) {
		fwVideo.src = selectedClip.url;
		fwVideo.style.display = 'block';
		fwOverlay.style.display = 'none';

		fwVideo.onloadedmetadata = () => {
			// Instantly update with the true duration once known
			if (fwVideo.duration > 0 && fwVideo.duration !== Infinity) {
				selectedClip.duration = fwVideo.duration;
			}
			
			// Clamp the scrubber to the actual end of the video
			const safeOffset = Math.min(offsetInClip, selectedClip.duration);
			fwVideo.currentTime = safeOffset;
			
			if (!fwIsScrubbing && isPlayingHistory) fwVideo.play().catch(e=>{});
			else fwVideo.pause();
		};
	} else {
		fwVideo.style.display = 'block';
		fwOverlay.style.display = 'none';
		const safeOffset = Math.min(offsetInClip, selectedClip.duration);
		if (Math.abs(fwVideo.currentTime - safeOffset) > 0.5 || fwIsScrubbing) {
			fwVideo.currentTime = safeOffset;
		}
	}
}

fwTimelineRegion.addEventListener('pointerdown', (e) => {
	fwIsScrubbing = true;
	fwTimelineRegion.setPointerCapture(e.pointerId);
	updateFwTimelineFromEvent(e);
});

fwTimelineRegion.addEventListener('pointermove', (e) => {
	if (!fwIsScrubbing) return;
	updateFwTimelineFromEvent(e);
});

fwTimelineRegion.addEventListener('pointerup', (e) => {
	fwIsScrubbing = false;
	fwTimelineRegion.releasePointerCapture(e.pointerId);
	const fwVideo = document.getElementById('fw-video');
	if (isPlayingHistory && fwVideo.src) {
		fwVideo.play().catch(e=>{});
	}
});

function fwGoLive() {
	if (!activeModalCamId) return;
	const fwVideo = document.getElementById('fw-video');
	const fwOverlay = document.getElementById('fw-overlay');
	
	fwTimeLabel.innerText = "LIVE";
	fwTimeLabel.style.color = "#4cd137";
	fwIndicator.style.left = '100%'; 

	// 1. Pause global playback if it's running so it doesn't try to overwrite this video
	if (isPlayingHistory) {
		document.getElementById('btn-play').click();
	}

	// 2. Destroy HLS instance
	if (fwHlsPlayer) {
		fwHlsPlayer.destroy();
		fwHlsPlayer = null;
	}
	
	// 3. HARD RESET the video element (The Fix)
	fwVideo.pause();
	fwVideo.removeAttribute('src');
	fwVideo.currentTime = 0; // Force reset the playhead so the live stream doesn't stall
	fwVideo.load();
	
	fwOverlay.style.display = 'none';
	fwVideo.style.display = 'block';
	const freshPlaylistUrl = `./cameras/${activeModalCamId}/stream.m3u8?t=${Date.now()}`;
	
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
		
		// Standard, proven attach sequence
		fwHlsPlayer.loadSource(freshPlaylistUrl);
		fwHlsPlayer.attachMedia(fwVideo);
		
		// Ensure playback triggers as soon as the live manifest is ready
		fwHlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
			fwVideo.play().catch(e => console.error("Playback failed:", e));
		});
	} else if (fwVideo.canPlayType('application/vnd.apple.mpegurl')) {
		fwVideo.src = freshPlaylistUrl;
		fwVideo.play().catch(e => {});
	}
}

// --- Floating Window General API ---
function openFloatingWindow(camId) {
	activeModalCamId = camId;
	const fw = document.getElementById('floating-window');
	const title = document.getElementById('fw-title');
	const fwVideo = document.getElementById('fw-video');
	const fwOverlay = document.getElementById('fw-overlay');
	
	title.innerText = camId.toUpperCase();
	title.style.color = getCameraColor(camId);
	
	if (fw.style.display === 'none') {
		fw.style.display = 'flex';
		// Increased from 640x400 to 720x480 for a better initial layout
		const startWidth = window.innerWidth <= 800 ? window.innerWidth * 0.9 : 720; 
		const startHeight = window.innerWidth <= 800 ? window.innerHeight * 0.4 : 480;
		fw.style.width = `${startWidth}px`;
		fw.style.height = `${startHeight}px`;
		fw.style.left = `${(window.innerWidth - startWidth) / 2}px`;
		fw.style.top = `${(window.innerHeight - startHeight) / 2}px`;
	}
	
	if (isLive) {
		fwGoLive();
	} else {
		const gridVideo = document.getElementById(`video-${camId}`);
		const gridOverlay = document.getElementById(`overlay-${camId}`);
		
		if (fwHlsPlayer) {
			fwHlsPlayer.destroy();
			fwHlsPlayer = null;
		}
		
		if (gridOverlay.style.display === 'flex') {
			fwOverlay.style.display = 'flex';
			fwVideo.style.display = 'none';
			fwVideo.src = "";
			fwTimeLabel.innerText = "NO DATA";
			fwTimeLabel.style.color = "#666";
		} else {
			fwOverlay.style.display = 'none';
			fwVideo.style.display = 'block';
			fwVideo.src = gridVideo.src;
			fwVideo.currentTime = gridVideo.currentTime;
			if (isPlayingHistory) fwVideo.play().catch(e=>{});
			
			const currentSec = parseInt(scrubber.value, 10);
			updateFwIndicatorFromSeconds(currentSec);
		}
	}
}

function closeFloatingWindow() {
	activeModalCamId = null;
	document.getElementById('floating-window').style.display = 'none';
	const fwVideo = document.getElementById('fw-video');
	fwVideo.pause();
	fwVideo.removeAttribute('src');
	if (fwHlsPlayer) {
		fwHlsPlayer.destroy();
		fwHlsPlayer = null;
	}
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
		const curSec = setScrubberToNow();

		const scrubberX = (curSec / 86400) * timelineContent.clientWidth;
		const viewLeft = timelineViewport.scrollLeft;
		const viewRight = viewLeft + timelineViewport.clientWidth;
		
		if (scrubberX > viewRight - 50 || scrubberX < viewLeft) {
			timelineViewport.scrollLeft = scrubberX - timelineViewport.clientWidth / 2;
		}
	}, 1000);

	if (activeModalCamId) {
		openFloatingWindow(activeModalCamId);
	}

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
		if (activeModalCamId) {
			document.getElementById('fw-video').pause();
		}
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
	
	card.addEventListener('click', () => openFloatingWindow(camId));
	
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
	const maxCameras = 10;
	let foundCount = 0;
	for (let index = 1; index <= maxCameras; index++) {
		const camId = `cam${index}`;
		const streamPath = `./cameras/${camId}/stream.m3u8`;
		try {
			const response = await fetch(streamPath, { method: 'HEAD', cache: 'no-store', credentials: 'include' });
			if (response.ok) {
				createCameraDOM(camId, streamPath);
				foundCount++;
			}
		} catch (error) {}
	}
	if (foundCount === 0) setTimeout(discoverCameras, 2000);
}  

// --- Real-Time Scrubbing and Buffering Logic ---
const fwVideo = document.getElementById('fw-video');
const fwTimelineIndicator = document.getElementById('fw-timeline-indicator');

let isScrubbingPopup = false;
let lastSeekTime = 0; 

// 1. Draw the green bars reliably
function updateBufferIndicators() {
	const duration = fwVideo.duration;
	if (!duration || !isFinite(duration) || isNaN(duration)) return;

	// Remove old green bars
	document.querySelectorAll('.fw-buffered-region').forEach(el => el.remove());
	
	// Draw new green bars
	for (let i = 0; i < fwVideo.buffered.length; i++) {
		try {
			const start = fwVideo.buffered.start(i);
			const end = fwVideo.buffered.end(i);
			
			const startPct = (start / duration) * 100;
			const widthPct = ((end - start) / duration) * 100;

			const bufferDiv = document.createElement('div');
			bufferDiv.className = 'fw-buffered-region';
			bufferDiv.style.left = `${startPct}%`;
			bufferDiv.style.width = `${widthPct}%`;
			
			fwTimelineRegion.insertBefore(bufferDiv, fwTimelineIndicator);
		} catch (e) {} // Ignore browser parse errors
	}
}

// Poll the buffer 4 times a second
setInterval(updateBufferIndicators, 250);

// 2. Helper to check if a specific timestamp is loaded and green
function isTimeBuffered(timeSeconds) {
	for (let i = 0; i < fwVideo.buffered.length; i++) {
		// Add a small 0.5s safety margin to the edges of the buffer
		if (timeSeconds >= fwVideo.buffered.start(i) && timeSeconds <= (fwVideo.buffered.end(i) - 0.5)) {
			return true;
		}
	}
	return false;
}

// 3. The Smart Scrubber
function handleTimelineInteraction(e, force = false) {
	const rect = fwTimelineRegion.getBoundingClientRect();
	let x = e.clientX - rect.left;
	x = Math.max(0, Math.min(x, rect.width));
	const percent = x / rect.width;
	
	// Always move the orange scrubber UI instantly
	fwTimelineIndicator.style.left = `${percent * 100}%`;
	
	if (fwVideo.duration) {
		const targetTime = percent * fwVideo.duration;
		const now = Date.now();
		
		if (force) {
			// Always seek when the user clicks or releases the mouse
			fwVideo.currentTime = targetTime;
		} else if (now - lastSeekTime > 60) { // Throttled to ~15 FPS
			// ONLY seek while dragging IF the data is already downloaded (green)
			// This prevents the HLS stream from blacking out and stalling!
			if (isTimeBuffered(targetTime)) {
				fwVideo.currentTime = targetTime;
				lastSeekTime = now;
			}
		}
	}
}

fwTimelineRegion.addEventListener('pointerdown', (e) => {
	isScrubbingPopup = true;
	fwTimelineRegion.setPointerCapture(e.pointerId);
	fwVideo.pause(); // Pause playback while interacting
	handleTimelineInteraction(e, true); // Force initial click
});

fwTimelineRegion.addEventListener('pointermove', (e) => {
	if (isScrubbingPopup) {
		handleTimelineInteraction(e, false); // Smart seek while dragging
	}
});

fwTimelineRegion.addEventListener('pointerup', (e) => {
	if (isScrubbingPopup) {
		handleTimelineInteraction(e, true); // Force final seek on release
	}
	isScrubbingPopup = false;
	fwTimelineRegion.releasePointerCapture(e.pointerId);
});
		
// --- Pointer Dragging Logic for the Floating Window ---
const fw = document.getElementById('floating-window');
const fwHeader = document.getElementById('fw-header');
let isDragging = false, dragStartX, dragStartY, initialLeft, initialTop;

fwHeader.addEventListener('pointerdown', (e) => {
	if (e.target.classList.contains('fw-close')) return; 
	isDragging = true;
	dragStartX = e.clientX;
	dragStartY = e.clientY;
	initialLeft = fw.offsetLeft;
	initialTop = fw.offsetTop;
	fwHeader.setPointerCapture(e.pointerId);
	document.body.style.userSelect = 'none';
});

fwHeader.addEventListener('pointermove', (e) => {
	if (!isDragging) return;
	fw.style.left = `${initialLeft + (e.clientX - dragStartX)}px`;
	fw.style.top = `${initialTop + (e.clientY - dragStartY)}px`;
});

fwHeader.addEventListener('pointerup', (e) => {
	isDragging = false;
	fwHeader.releasePointerCapture(e.pointerId);
	document.body.style.userSelect = '';
});

// --- Initial Setup and Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    // Initialize App
    renderTimelineRuler();
    returnToLive(); 
    fetchManifest(); 
    setInterval(fetchManifest, 30000); 
    discoverCameras();
    setInterval(runEasterEgg, 10000);
});
