function runEasterEgg() {
	const brand = document.getElementById('brand-text');
	if (!brand) return;
	if (Math.random() < 0.15) {
		brand.innerText = "ArgonVR";
		setTimeout(() => { brand.innerText = "ArgoNVR"; }, 3000);
	}
}
setInterval(runEasterEgg, 10000);

let CAMERA_COLORS = ['#3498db'];
window.cameraSubStreams = {};
window.cameraSubStreamFailed = {};
window.cameraSubStreamFailCount = {};
const cameraSubStreamHealTimers = {};

function hslToHex(h, s, l) {
	l /= 100;
	const a = (s * Math.min(l, 1 - l)) / 100;
	const f = n => {
		const k = (n + h / 30) % 12;
		const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
		return Math.abs(Math.round(255 * color)).toString(16).padStart(2, '0');
	};
	return `${f(0)}${f(8)}${f(4)}`;
}

function getCameraColor(camId) {
	const num = parseInt(camId.replace(/\D/g, '')) || 1;
	return CAMERA_COLORS[(num - 1) % CAMERA_COLORS.length];
}

// --- Dynamic Network Speed & Latency Monitor ---
const networkMonitor = {
	tier: 'high', // 'high' | 'medium' | 'low'
	modeOverride: sessionStorage.getItem('argonvr_net_mode') || 'auto', // 'auto' | 'low' | 'medium' | 'high'
	rttMs: 60,
	downlinkMbps: 10.0,
	stallCount: 0,
	lastStallTs: 0,
	lastTierChangeTs: 0,
	suppressPenaltiesUntil: 0,
	listeners: new Set(),
	badgeEl: null,

	init() {
		const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
		if (conn) {
			if (typeof conn.rtt === 'number' && conn.rtt > 0) this.rttMs = conn.rtt;
			if (typeof conn.downlink === 'number' && conn.downlink > 0) this.downlinkMbps = Math.max(this.downlinkMbps, conn.downlink);
			conn.addEventListener('change', () => {
				if (typeof conn.rtt === 'number' && conn.rtt > 0) {
					this.rttMs = Math.round((this.rttMs * 0.5) + (conn.rtt * 0.5));
				}
				if (typeof conn.downlink === 'number' && conn.downlink > 0) {
					this.downlinkMbps = (this.downlinkMbps * 0.5) + (conn.downlink * 0.5);
				}
				this.evaluateTier();
			});
		}

		this.createBadge();
		this.evaluateTier();
		this.probeLatency();

		setInterval(() => {
			if (document.visibilityState === 'visible') {
				this.probeLatency();
			}
		}, 15000);
	},

	resetAfterWake(graceMs = 10000) {
		this.suppressPenaltiesUntil = performance.now() + graceMs;
		this.stallCount = 0;
		this.downlinkMbps = Math.max(this.downlinkMbps, 8.0);
		this.rttMs = Math.min(this.rttMs, 100);
		if (this.modeOverride === 'auto' && this.tier !== 'high') {
			this.tier = 'high';
			this.lastTierChangeTs = performance.now();
		}
		this.updateBadgeUI();
	},

	createBadge() {
		if (this.badgeEl) return;
		const badge = document.createElement('button');
		badge.id = 'net-quality-badge';
		badge.type = 'button';
		badge.title = 'Click to cycle Bandwidth Mode (Auto / Low Data / High Quality)';
		badge.style.cssText = [
			'background: rgba(20, 25, 35, 0.85)',
			'color: #ecf0f1',
			'border: 1px solid rgba(255, 255, 255, 0.2)',
			'border-radius: 4px',
			'padding: 3px 8px',
			'font-size: 11px',
			'font-family: monospace',
			'cursor: pointer',
			'margin-left: 8px',
			'white-space: nowrap',
			'transition: border-color 0.2s, color 0.2s'
		].join(';');

		badge.addEventListener('click', (e) => {
			e.stopPropagation();
			const order = ['auto', 'low', 'high'];
			const nextIdx = (order.indexOf(this.modeOverride) + 1) % order.length;
			this.modeOverride = order[nextIdx];
			sessionStorage.setItem('argonvr_net_mode', this.modeOverride);
			this.stallCount = 0;
			this.lastTierChangeTs = 0;
			this.evaluateTier(true);
		});

		const dateEl = document.getElementById('global-date');
		if (dateEl && dateEl.parentNode) {
			dateEl.parentNode.insertBefore(badge, dateEl.nextSibling);
		} else {
			document.body.appendChild(badge);
		}
		this.badgeEl = badge;
		this.updateBadgeUI();
	},

	updateBadgeUI() {
		if (!this.badgeEl) return;
		const colors = {
			high: '#2ecc71',
			medium: '#f39c12',
			low: '#e67e22'
		};
		const color = colors[this.tier] || '#3498db';
		const modeLabel = this.modeOverride === 'auto' ? `AUTO:${this.tier.toUpperCase()}` : `LOCK:${this.modeOverride.toUpperCase()}`;
		const mbpsStr = this.downlinkMbps >= 10 ? Math.round(this.downlinkMbps) : this.downlinkMbps.toFixed(1);
		this.badgeEl.style.borderColor = color;
		this.badgeEl.style.color = color;
		this.badgeEl.innerText = `${modeLabel} ${Math.round(this.rttMs)}ms ${mbpsStr}M`;
	},

	async probeLatency() {
		const start = performance.now();
		try {
			const resp = await fetch(`/health?ping=${Date.now()}`, {
				method: 'GET',
				cache: 'no-store',
				credentials: 'include'
			});
			if (resp.ok) {
				const elapsed = performance.now() - start;
				const inGrace = performance.now() < this.suppressPenaltiesUntil;
				if (!inGrace || elapsed < this.rttMs) {
					this.rttMs = (this.rttMs * 0.7) + (elapsed * 0.3);
				}
				// Gradually decay accumulated stall count over time when server is reachable
				if (elapsed < 250 && this.stallCount > 0) {
					this.stallCount = Math.max(0, this.stallCount - 0.5);
				}
				this.evaluateTier();
			}
		} catch (e) {
			if (performance.now() >= this.suppressPenaltiesUntil) {
				this.rttMs = Math.min(2000, this.rttMs * 1.35);
				this.evaluateTier();
			}
		}
	},

	recordSample(bytes, durationMs) {
		if (!bytes || bytes < 16384 || !durationMs || durationMs <= 2) return;

		const netDurationMs = Math.max(5, durationMs - (this.rttMs * 0.25));
		const activeStreamCount = Math.max(1, Object.keys(hlsPlayers).length);
		const concurrencyFactor = activeStreamCount > 1 ? Math.min(2.5, 1 + ((activeStreamCount - 1) * 0.35)) : 1;
		const rawMbps = ((bytes * 8) / (netDurationMs / 1000)) / 1000000;
		const sampleMbps = Math.max(0.2, Math.min(100, rawMbps * concurrencyFactor));

		const inGrace = performance.now() < this.suppressPenaltiesUntil;
		// Small segments (< 64 KB) on low-motion VBR or sub-streams are latency-bound; never let them drag downlink down
		if ((bytes < 65536 || inGrace) && sampleMbps < this.downlinkMbps) {
			return;
		}

		this.downlinkMbps = (this.downlinkMbps * 0.75) + (sampleMbps * 0.25);
		if (sampleMbps > 2.5 && this.stallCount > 0) {
			this.stallCount = Math.max(0, this.stallCount - 0.5);
		}
		this.evaluateTier();
	},

	recordStall() {
		const now = performance.now();
		if (now < this.suppressPenaltiesUntil) return;
		if (!document.hasFocus && document.visibilityState === 'hidden') return;
		// Coalesce simultaneous stalls across multiple cameras into a single network event
		if (now - this.lastStallTs < 4000) return;

		this.lastStallTs = now;
		this.stallCount = Math.min(5, this.stallCount + 1);
		this.downlinkMbps = Math.max(1.0, this.downlinkMbps * 0.8);
		this.evaluateTier();
	},

	evaluateTier(forceNotify = false) {
		let nextTier = this.tier;

		if (this.modeOverride !== 'auto') {
			nextTier = this.modeOverride;
		} else {
			const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
			const saveData = Boolean(conn && conn.saveData);
			const effType = conn ? conn.effectiveType : '';

			if (saveData || effType === 'slow-2g' || effType === '2g' || effType === '3g') {
				nextTier = 'low';
			} else if (this.tier === 'high') {
				if (this.downlinkMbps < 1.6 || this.rttMs > 380 || this.stallCount >= 3) {
					nextTier = 'low';
				} else if (
					this.downlinkMbps < 4.5 ||
					this.rttMs > 160 ||
					this.stallCount >= 2 ||
					(window.innerWidth <= 800 && this.downlinkMbps < 7.0)
				) {
					nextTier = 'medium';
				}
			} else if (this.tier === 'medium') {
				if (this.downlinkMbps < 1.6 || this.rttMs > 380 || this.stallCount >= 3) {
					nextTier = 'low';
				} else if (
					this.downlinkMbps >= 6.5 &&
					this.rttMs <= 115 &&
					this.stallCount < 1 &&
					(window.innerWidth > 800 || this.downlinkMbps >= 9.0)
				) {
					nextTier = 'high';
				}
			} else if (this.tier === 'low') {
				// Hysteresis: require clear recovery before leaving 'low'
				if (this.downlinkMbps >= 7.0 && this.rttMs <= 115 && this.stallCount === 0) {
					nextTier = 'high';
				} else if (this.downlinkMbps >= 3.2 && this.rttMs <= 220 && this.stallCount <= 1) {
					nextTier = 'medium';
				}
			}
		}

		const now = performance.now();
		const changed = nextTier !== this.tier;

		if (changed && !forceNotify && this.modeOverride === 'auto') {
			// Prevent rapid tier oscillation (minimum 12s between automatic tier transitions)
			if (this.lastTierChangeTs > 0 && (now - this.lastTierChangeTs) < 12000) {
				this.updateBadgeUI();
				return;
			}
		}

		if (changed) {
			this.tier = nextTier;
			this.lastTierChangeTs = now;
		}
		this.updateBadgeUI();

		if (changed || forceNotify) {
			this.listeners.forEach(fn => {
				try { fn(this.tier, forceNotify); } catch (e) {}
			});
		}
	},

	onChange(fn) {
		this.listeners.add(fn);
	},

	hasSubStream(camId) {
		return Boolean(window.cameraSubStreams && window.cameraSubStreams[camId] && !window.cameraSubStreamFailed[camId]);
	},

	clearSubStreamFailure(camId) {
		window.cameraSubStreamFailCount[camId] = 0;
		delete window.cameraSubStreamFailed[camId];
		if (cameraSubStreamHealTimers[camId]) {
			clearTimeout(cameraSubStreamHealTimers[camId]);
			delete cameraSubStreamHealTimers[camId];
		}
	},

	markSubStreamFailure(camId) {
		window.cameraSubStreamFailCount[camId] = (window.cameraSubStreamFailCount[camId] || 0) + 1;
		if (window.cameraSubStreamFailCount[camId] >= 2) {
			window.cameraSubStreamFailed[camId] = true;
			if (cameraSubStreamHealTimers[camId]) {
				clearTimeout(cameraSubStreamHealTimers[camId]);
			}
			// Auto-heal after 60s in case the sub-stream pipeline was merely restarting
			cameraSubStreamHealTimers[camId] = setTimeout(() => {
				delete cameraSubStreamHealTimers[camId];
				delete window.cameraSubStreamFailed[camId];
				window.cameraSubStreamFailCount[camId] = 0;
			}, 60000);
			return true;
		}
		return false;
	},

	shouldUseSubStream(camId, isSingleView = false) {
		if (!this.hasSubStream(camId)) return false;
		if (isSingleView) {
			return this.tier === 'low' || this.tier === 'medium';
		}
		return this.tier !== 'high' || window.innerWidth <= 800 || activeCameras.length > 2;
	},

	getLiveStreamUrl(baseDirPath, camId, isSingleView = false) {
		const playlist = this.shouldUseSubStream(camId, isSingleView) ? 'stream_sub.m3u8' : 'stream.m3u8';
		return `${baseDirPath}/${camId}/${playlist}?t=${Date.now()}`;
	},

	shouldUseSnapshotGrid(cameraCount) {
		if (this.tier === 'low') return true;
		return this.tier === 'medium' && (window.innerWidth <= 800 || cameraCount >= 4);
	},

	getSnapshotIntervalMs() {
		if (this.tier === 'low') {
			return Math.max(1500, Math.min(4000, Math.round(this.rttMs * 4.5)));
		}
		return Math.max(1000, Math.min(2500, Math.round(this.rttMs * 3)));
	},

	getHlsConfig(isLiveStream = true, isSingleView = false) {
		const isLow = this.tier === 'low';
		const isMed = this.tier === 'medium';

		const config = {
			manifestLoadingMaxRetry: 6,
			levelLoadingMaxRetry: 6,
			fragLoadingMaxRetry: 6,
			backBufferLength: isLow ? 4 : (isMed ? 8 : 15),
			maxBufferLength: isLow ? (isSingleView ? 6 : 4) : (isMed ? 10 : 18),
			maxMaxBufferLength: isLow ? (isSingleView ? 12 : 6) : (isMed ? 20 : 30),
			maxBufferSize: isLow ? 6 * 1000 * 1000 : (isMed ? 15 * 1000 * 1000 : 25 * 1000 * 1000),
			xhrSetup: function(xhr) {
				xhr.withCredentials = true;
			}
		};

		if (isLiveStream) {
			config.liveDurationInfinity = true;
			config.liveSyncDurationCount = isLow ? 3 : (isMed ? 3 : 2);
			config.liveMaxLatencyDurationCount = isLow ? 10 : 7;
			config.maxLiveSyncPlaybackRate = 1.15;
		}

		return config;
	},

	attachHlsTelemetry(hls, camId = null) {
		if (!hls || typeof Hls === 'undefined') return;
		hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
			if (camId && hlsPlayers[camId] && hlsPlayers[camId] !== hls) return;
			const stats = (data && data.frag && data.frag.stats) || (data && data.stats);
			if (stats && stats.loading) {
				const bytes = stats.total || stats.loaded || 0;
				const dur = stats.loading.end - stats.loading.start;
				this.recordSample(bytes, dur);
			}
		});
		hls.on(Hls.Events.ERROR, (event, data) => {
			if (camId && hlsPlayers[camId] && hlsPlayers[camId] !== hls) return;
			if (data && data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
				this.recordStall();
			}
		});
	}
};

window.networkMonitor = networkMonitor;

// --- Global State & Caches ---
let globalManifest = {};
const hlsPlayers = {};
const cameraReconnectTimers = {};
const cameraStaggerTimers = {};
const cameraSnapshotTimers = {};
const cameraSnapshotInFlight = {};
const cameraSnapshotEtags = {};
const cameraSnapshotFailed = {};
const cameraSnapshot404Count = {};
const cameraSnapshotHealTimers = {};
const cameraModeGeneration = {};
const cameraLiveMode = {}; // 'snapshot' | 'hls-sub' | 'hls-main' | 'none'
const visibleCameras = new Set();
let cardIntersectionObserver = null;
let manifestFetchInFlight = false;

const activeCameras = [];
let vttCache = {};
let spriteImages = {};

let baseDir = './cameras';

let isLive = true;
let isPlayingHistory = false;
let isScrubbing = false;
let isSingleCameraOpen = false;
let playbackInterval = null;
let liveSyncInterval = null;
let currentDayString = "";
let scrubRafId = null;
let scrubMetadataDebounceTimer = null;

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

function bumpCameraGeneration(camId) {
	cameraModeGeneration[camId] = (cameraModeGeneration[camId] || 0) + 1;
	return cameraModeGeneration[camId];
}

function setCameraState(camId, state) {
	const card = document.getElementById(`card-${camId}`);
	if (card) {
		card.classList.remove('state-video', 'state-canvas', 'state-overlay');
		card.classList.add(`state-${state}`);
	}
}

function clearCameraReconnectTimer(camId) {
	if (cameraReconnectTimers[camId]) {
		clearTimeout(cameraReconnectTimers[camId]);
		delete cameraReconnectTimers[camId];
	}
}

function clearCameraStaggerTimer(camId) {
	if (cameraStaggerTimers[camId]) {
		clearTimeout(cameraStaggerTimers[camId]);
		delete cameraStaggerTimers[camId];
	}
}

function stopCameraSnapshotLoop(camId) {
	if (cameraSnapshotTimers[camId]) {
		clearTimeout(cameraSnapshotTimers[camId]);
		delete cameraSnapshotTimers[camId];
	}
	delete cameraSnapshotInFlight[camId];
}

function cleanupVideoElementListeners(videoEl) {
	if (!videoEl) return;
	if (videoEl._onVideoReady) {
		videoEl.removeEventListener('seeked', videoEl._onVideoReady);
		videoEl.removeEventListener('playing', videoEl._onVideoReady);
		videoEl._onVideoReady = null;
	}
	videoEl.onloadedmetadata = null;
	videoEl.onerror = null;
}

function destroyHlsPlayer(camId) {
	bumpCameraGeneration(camId);
	clearCameraReconnectTimer(camId);
	clearCameraStaggerTimer(camId);
	stopCameraSnapshotLoop(camId);
	cameraLiveMode[camId] = 'none';

	const videoEl = document.getElementById(`video-${camId}`);
	cleanupVideoElementListeners(videoEl);

	if (hlsPlayers[camId]) {
		const hls = hlsPlayers[camId];
		delete hlsPlayers[camId];
		try {
			if (typeof Hls !== 'undefined' && hls.off) {
				hls.off(Hls.Events.MANIFEST_PARSED);
				hls.off(Hls.Events.FRAG_BUFFERED);
				hls.off(Hls.Events.FRAG_LOADED);
				hls.off(Hls.Events.ERROR);
			}
			hls.stopLoad();
			hls.detachMedia();
			hls.destroy();
		} catch (e) {}
	}
}

function isCameraVisibleInViewport(camId) {
	if (visibleCameras.size === 0) return true;
	return visibleCameras.has(camId);
}

function getDesiredCameraLiveMode(camId) {
	if (networkMonitor.shouldUseSnapshotGrid(activeCameras.length) && !cameraSnapshotFailed[camId]) {
		return 'snapshot';
	}
	return networkMonitor.shouldUseSubStream(camId, false) ? 'hls-sub' : 'hls-main';
}

async function fetchAndRenderLiveSnapshot(camId) {
	if (!isLive || isSingleCameraOpen || document.visibilityState === 'hidden') return;
	if (!networkMonitor.shouldUseSnapshotGrid(activeCameras.length) || cameraSnapshotFailed[camId]) return;

	const gen = cameraModeGeneration[camId] || 0;
	cameraLiveMode[camId] = 'snapshot';

	if (!isCameraVisibleInViewport(camId)) {
		cameraSnapshotTimers[camId] = setTimeout(() => fetchAndRenderLiveSnapshot(camId), 1000);
		return;
	}

	if (cameraSnapshotInFlight[camId]) return;
	cameraSnapshotInFlight[camId] = true;

	const startTs = performance.now();
	const headers = {};
	if (cameraSnapshotEtags[camId]) {
		headers['If-None-Match'] = cameraSnapshotEtags[camId];
	}

	try {
		const resp = await fetch(`${baseDir}/${camId}/live.jpg`, {
			method: 'GET',
			credentials: 'include',
			cache: 'no-cache',
			headers
		});

		if (
			gen !== (cameraModeGeneration[camId] || 0) ||
			!isLive ||
			isSingleCameraOpen ||
			!networkMonitor.shouldUseSnapshotGrid(activeCameras.length) ||
			cameraSnapshotFailed[camId]
		) {
			return;
		}

		if (resp.status === 304) {
			cameraSnapshot404Count[camId] = 0;
			setCameraState(camId, 'canvas');
		} else if (resp.ok) {
			cameraSnapshot404Count[camId] = 0;
			const etag = resp.headers.get('ETag');
			if (etag) cameraSnapshotEtags[camId] = etag;

			const blob = await resp.blob();
			const elapsed = performance.now() - startTs;

			if (
				gen !== (cameraModeGeneration[camId] || 0) ||
				!isLive ||
				isSingleCameraOpen ||
				!networkMonitor.shouldUseSnapshotGrid(activeCameras.length) ||
				cameraSnapshotFailed[camId]
			) {
				return;
			}

			const canvas = document.getElementById(`canvas-${camId}`);
			if (canvas && blob.size > 0) {
				if ('createImageBitmap' in window) {
					const bmp = await createImageBitmap(blob);
					if (
						gen !== (cameraModeGeneration[camId] || 0) ||
						!isLive ||
						isSingleCameraOpen ||
						!networkMonitor.shouldUseSnapshotGrid(activeCameras.length)
					) {
						bmp.close();
						return;
					}
					if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
						canvas.width = bmp.width;
						canvas.height = bmp.height;
					}
					const ctx = canvas.getContext('2d');
					ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
					bmp.close();
					setCameraState(camId, 'canvas');
				} else {
					await new Promise((resolve) => {
						const url = URL.createObjectURL(blob);
						const img = new Image();
						img.onload = () => {
							if (
								gen === (cameraModeGeneration[camId] || 0) &&
								isLive &&
								!isSingleCameraOpen &&
								networkMonitor.shouldUseSnapshotGrid(activeCameras.length)
							) {
								if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
									canvas.width = img.naturalWidth;
									canvas.height = img.naturalHeight;
								}
								canvas.getContext('2d').drawImage(img, 0, 0);
								setCameraState(camId, 'canvas');
							}
							URL.revokeObjectURL(url);
							resolve();
						};
						img.onerror = () => {
							URL.revokeObjectURL(url);
							resolve();
						};
						img.src = url;
					});
				}
			}

			// Record throughput sample AFTER rendering so a tier promotion cannot race with setCameraState('canvas')
			networkMonitor.recordSample(blob.size, elapsed);
		} else if (resp.status === 404) {
			// Require 5 consecutive 404s so transient FFmpeg restarts never lock out snapshot mode
			cameraSnapshot404Count[camId] = (cameraSnapshot404Count[camId] || 0) + 1;
			if (cameraSnapshot404Count[camId] >= 5) {
				cameraSnapshotFailed[camId] = true;
				if (cameraSnapshotHealTimers[camId]) {
					clearTimeout(cameraSnapshotHealTimers[camId]);
				}
				cameraSnapshotHealTimers[camId] = setTimeout(() => {
					delete cameraSnapshotHealTimers[camId];
					delete cameraSnapshotFailed[camId];
					cameraSnapshot404Count[camId] = 0;
				}, 60000);
				delete cameraSnapshotInFlight[camId];
				startHlsLiveForCamera(camId);
				return;
			}
		}
	} catch (e) {
		// Network glitch; retry on next cycle
	} finally {
		delete cameraSnapshotInFlight[camId];
	}

	if (
		gen === (cameraModeGeneration[camId] || 0) &&
		isLive &&
		!isSingleCameraOpen &&
		document.visibilityState === 'visible' &&
		networkMonitor.shouldUseSnapshotGrid(activeCameras.length) &&
		!cameraSnapshotFailed[camId]
	) {
		cameraSnapshotTimers[camId] = setTimeout(() => {
			fetchAndRenderLiveSnapshot(camId);
		}, networkMonitor.getSnapshotIntervalMs());
	}
}

function handleStreamError(camId, hlsInstance, wasSubStream = false) {
	if (hlsInstance && hlsPlayers[camId] && hlsPlayers[camId] !== hlsInstance) {
		return;
	}

	if (hlsInstance) {
		try {
			hlsInstance.stopLoad();
			hlsInstance.detachMedia();
			hlsInstance.destroy();
		} catch (e) {}
		if (hlsPlayers[camId] === hlsInstance) {
			delete hlsPlayers[camId];
		}
	}
	cameraLiveMode[camId] = 'none';

	if (wasSubStream) {
		const lockedOut = networkMonitor.markSubStreamFailure(camId);
		if (lockedOut && isLive && !isSingleCameraOpen && document.visibilityState === "visible") {
			console.warn(`[SubStream] ${camId} sub-stream unavailable on dashboard, falling back to main stream.`);
			resetIndividualCamera(camId);
			return;
		}
	}

	if (isLive && !isSingleCameraOpen && !cameraReconnectTimers[camId]) {
		cameraReconnectTimers[camId] = setTimeout(() => {
			delete cameraReconnectTimers[camId];
			if (isLive && !isSingleCameraOpen && document.visibilityState === "visible") {
				resetIndividualCamera(camId);
			}
		}, 2500);
	}
}

async function fetchAvailableDates() {
	try {
		const response = await fetch('/available_dates', { credentials: 'include' });
		if (response.ok) {
			const dates = await response.json();
			dates.forEach(d => availableDates.add(d));
			const popup = document.getElementById('calendar-popup');
			if (popup && popup.classList.contains('visible')) {
				renderCalendar();
			}
		}
	} catch (e) {
		console.error("Could not load global calendar dates.");
	}
}

// --- VTT & Sprite Logic ---
function parseVTTTime(timeStr) {
	const parts = timeStr.split(':');
	const secParts = parts[2].split('.');
	return (parseInt(parts[0], 10) * 3600) +
		(parseInt(parts[1], 10) * 60) +
		parseInt(secParts[0], 10) +
		(parseInt(secParts[1], 10) / 1000);
}

const pendingMetadata = new Set();

async function ensureClipMetadata(clip) {
	if (!clip || pendingMetadata.has(clip.url)) return;

	const needsSprite = clip.sprite_url && !spriteImages[clip.sprite_url];
	const needsVtt = clip.vtt_url && !vttCache[clip.url];

	if (!needsSprite && !needsVtt) return;

	const maxSprites = networkMonitor.tier === 'low' ? 30 : 80;
	const spriteKeys = Object.keys(spriteImages);
	if (spriteKeys.length > maxSprites) {
		const evictCount = Math.min(20, spriteKeys.length - maxSprites + 5);
		for (let i = 0; i < evictCount; i++) {
			delete spriteImages[spriteKeys[i]];
		}
	}

	pendingMetadata.add(clip.url);
	const promises = [];

	if (needsSprite) {
		promises.push(new Promise((resolve) => {
			const img = new Image();
			img.onload = resolve;
			img.onerror = () => {
				delete spriteImages[clip.sprite_url];
				resolve();
			};
			img.src = clip.sprite_url;
			spriteImages[clip.sprite_url] = img;
		}));
	}

	if (needsVtt) {
		promises.push(
			fetch(clip.vtt_url, { credentials: 'include' })
				.then(resp => resp.text())
				.then(text => {
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
				})
				.catch(e => console.error("Failed to load VTT for", clip.url, e))
		);
	}

	await Promise.allSettled(promises);
	pendingMetadata.delete(clip.url);
}

function renderSpriteFrame(camId, clip, offset) {
	if (!clip) return false;

	const cues = vttCache[clip.url];
	const img = spriteImages[clip.sprite_url];
	const canvas = document.getElementById(`canvas-${camId}`);

	if (canvas && cues && cues.length > 0 && img && img.complete && img.naturalWidth > 0) {
		let targetCue = cues[0];

		for (let i = 0; i < cues.length; i++) {
			if (offset >= cues[i].start && (i === cues.length - 1 || offset < cues[i + 1].start)) {
				targetCue = cues[i];
				break;
			}
		}

		if (canvas.width !== targetCue.w || canvas.height !== targetCue.h) {
			canvas.width = targetCue.w;
			canvas.height = targetCue.h;
		}
		const ctx = canvas.getContext('2d');

		ctx.drawImage(img,
			targetCue.x, targetCue.y, targetCue.w, targetCue.h,
			0, 0, canvas.width, canvas.height
		);

		return true;
	}
	return false;
}

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

	const frag = document.createDocumentFragment();
	for (let sec = 0; sec <= 86400; sec += 300) {
		const isHour = (sec % 3600 === 0);
		const leftPct = (sec / 86400) * 100;

		const tick = document.createElement('div');
		tick.className = `ruler-tick ${isHour ? 'hour' : 'five-min'}`;
		tick.style.left = `${leftPct}%`;

		frag.appendChild(tick);
	}
	ruler.appendChild(frag);
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
	const nextDayString = `${yyyy}${mm}${dd}`;

	if (currentDayString && currentDayString !== nextDayString) {
		spriteImages = {};
		vttCache = {};
	}

	currentDayString = nextDayString;
	dateDisplay.innerHTML = `<span>${dd}/${mm}/${yyyy}</span> 📅`;

	globalManifest = {};
	renderTimelineHeatmap();

	fetchManifest();

	if (activeCameras.length > 0) {
		if (isPlayingHistory) playBtn.click();

		if (currentDayString === getTodayString()) {
			returnToLive();
		} else {
			isLive = false;
			liveBtn.innerText = "Go Live";
			playBtn.disabled = false;
			liveBtn.classList.remove('active');
			if (liveSyncInterval) {
				clearInterval(liveSyncInterval);
				liveSyncInterval = null;
			}

			timeLabel.classList.add('history');

			activeCameras.forEach(camId => {
				destroyHlsPlayer(camId);
			});

			scrubber.value = 43200;
			timeLabel.innerText = secondsToTimeStr(43200);
			updateCamerasToScrubber(43200, false);
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
	const match = filename.match(/_(\d{8})_(\d{2})(\d{2})(\d{2})\.m3u8/);
	if (!match) return null;

	const h = parseInt(match[2], 10);
	const m = parseInt(match[3], 10);
	const s = parseInt(match[4], 10);
	return (h * 3600) + (m * 60) + s;
}

async function fetchManifest(camId = null) {
	if (activeCameras.length === 0) return;
	if (!camId && manifestFetchInFlight) return;
	if (!camId) manifestFetchInFlight = true;

	try {
		const url = camId
			? `/history?date=${currentDayString}&cam=${camId}`
			: `/history?date=${currentDayString}`;

		const response = await fetch(url, { cache: 'no-cache', credentials: 'include' });
		if (!response.ok) return;
		const allData = await response.json();

		Object.keys(allData).forEach(cam => {
			let clips = allData[cam] || [];
			clips.sort((a, b) => (parseFilenameToSeconds(a.filename) || 0) - (parseFilenameToSeconds(b.filename) || 0));

			globalManifest[cam] = clips;

			clips.forEach(clip => {
				const match = clip.filename.match(/_(\d{8})_/);
				if (match) availableDates.add(match[1]);
			});
		});

		renderTimelineHeatmap();
		const calPopup = document.getElementById('calendar-popup');
		if (calPopup && calPopup.classList.contains('visible')) {
			renderCalendar();
		}
	} catch (e) {
		console.log(`Could not load history manifest${camId ? ' for ' + camId : ''}. Likely an auth issue.`);
	} finally {
		if (!camId) manifestFetchInFlight = false;
	}
}

function renderTimelineHeatmap() {
	const heatmap = document.getElementById('heatmap');
	heatmap.innerHTML = '';

	const numCams = activeCameras.length || 1;
	const frag = document.createDocumentFragment();

	activeCameras.forEach((camId, index) => {
		const clips = globalManifest[camId] || [];
		const camColor = getCameraColor(camId);
		const laneHeight = 100 / numCams;
		const topPct = index * laneHeight;

		clips.forEach(clip => {
			const startSec = parseFilenameToSeconds(clip.filename);
			if (startSec === null) return;

			const clipDuration = clip.duration;

			const leftPct = (startSec / 86400) * 100;
			const widthPct = (clipDuration / 86400) * 100;

			const tick = document.createElement('div');
			tick.className = 'heatmap-tick';
			tick.style.left = `${leftPct}%`;
			tick.style.width = `${widthPct}%`;
			tick.style.backgroundColor = camColor;
			tick.style.top = `${topPct}%`;
			tick.style.height = `${laneHeight}%`;

			frag.appendChild(tick);
		});
	});

	heatmap.appendChild(frag);
}

function toggleCalendar() {
	const popup = document.getElementById('calendar-popup');
	popup.classList.toggle('visible');
	if (popup.classList.contains('visible')) {
		const y = parseInt(currentDayString.substring(0, 4));
		const m = parseInt(currentDayString.substring(4, 6)) - 1;
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
	const y = parseInt(dateStr.substring(0, 4));
	const m = parseInt(dateStr.substring(4, 6)) - 1;
	const d = parseInt(dateStr.substring(6, 8));
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

		const clipDuration = clipRef.duration;
		const endSec = startSec + clipDuration;

		if (targetSeconds >= startSec && targetSeconds <= endSec) {
			return { manifestRef: clipRef, offset: targetSeconds - startSec };
		}
	}
	return null;
}

function updateCamerasToScrubber(targetSeconds, isDragging = false) {
	if (scrubMetadataDebounceTimer) {
		clearTimeout(scrubMetadataDebounceTimer);
		scrubMetadataDebounceTimer = null;
	}

	const pendingClipsToFetch = [];

	activeCameras.forEach(camId => {
		const videoEl = document.getElementById(`video-${camId}`);
		if (!videoEl) return;

		const matchData = findClipForCamera(camId, targetSeconds);

		if (matchData) {
			const manifestRef = matchData.manifestRef;
			const offset = matchData.offset;

			const hasSprite = renderSpriteFrame(camId, manifestRef, offset);

			if (isDragging) {
				if (hasSprite) {
					setCameraState(camId, 'canvas');
				} else {
					videoEl.pause();
					if (isCameraVisibleInViewport(camId)) {
						pendingClipsToFetch.push({ camId, manifestRef, offset });
					}
				}
			} else {
				const gen = cameraModeGeneration[camId] || 0;
				ensureClipMetadata(manifestRef).then(() => {
					if (
						gen === (cameraModeGeneration[camId] || 0) &&
						!isLive &&
						!isPlayingHistory &&
						videoEl.readyState < 2
					) {
						if (renderSpriteFrame(camId, manifestRef, offset)) {
							setCameraState(camId, 'canvas');
						}
					}
				});

				const useSpriteOnlyOnDashboard =
					(networkMonitor.tier === 'low' && activeCameras.length > 1) ||
					!isCameraVisibleInViewport(camId);

				if (useSpriteOnlyOnDashboard && hasSprite) {
					destroyHlsPlayer(camId);
					setCameraState(camId, 'canvas');
					return;
				}

				const activeUrl = videoEl.dataset.clipUrl || "";
				const srcChanged = activeUrl !== manifestRef.url;
				const drift = srcChanged ? 0 : Math.abs(videoEl.currentTime - offset);
				const needsSeek = srcChanged || drift > 1.0;

				if (needsSeek) {
					if (hasSprite) {
						setCameraState(camId, 'canvas');
					} else {
						setCameraState(camId, 'video');
					}

					cleanupVideoElementListeners(videoEl);

					const onVideoReady = () => {
						if (!isLive) {
							setCameraState(camId, 'video');
						}
						videoEl.removeEventListener('seeked', onVideoReady);
						videoEl.removeEventListener('playing', onVideoReady);
						videoEl._onVideoReady = null;
					};
					videoEl._onVideoReady = onVideoReady;

					videoEl.addEventListener('seeked', onVideoReady);
					videoEl.addEventListener('playing', onVideoReady);

					if (srcChanged) {
						videoEl.dataset.clipUrl = manifestRef.url;

						if (Hls.isSupported()) {
							destroyHlsPlayer(camId);
							videoEl._onVideoReady = onVideoReady;
							videoEl.addEventListener('seeked', onVideoReady);
							videoEl.addEventListener('playing', onVideoReady);

							const hls = new Hls(networkMonitor.getHlsConfig(false, false));
							networkMonitor.attachHlsTelemetry(hls, camId);
							hlsPlayers[camId] = hls;
							hls.loadSource(manifestRef.url);
							hls.attachMedia(videoEl);

							hls.on(Hls.Events.MANIFEST_PARSED, () => {
								if (hlsPlayers[camId] !== hls) return;
								videoEl.currentTime = offset;
								if (isPlayingHistory) videoEl.play().catch(e => {});
							});
						} else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
							videoEl.src = manifestRef.url;
							videoEl.load();
							videoEl.onloadedmetadata = () => {
								videoEl.currentTime = offset;
								if (isPlayingHistory) videoEl.play().catch(e => {});
							};
						}
					} else {
						videoEl.currentTime = offset;
						if (isPlayingHistory && videoEl.paused) {
							videoEl.play().catch(e => {});
						}
					}
				} else {
					setCameraState(camId, 'video');

					if (isPlayingHistory && videoEl.paused) {
						videoEl.play().catch(e => {});
					} else if (!isPlayingHistory && !videoEl.paused) {
						videoEl.pause();
					}
				}
			}
		} else {
			setCameraState(camId, 'overlay');
			destroyHlsPlayer(camId);
			if (videoEl.dataset.clipUrl || videoEl.hasAttribute('src')) {
				delete videoEl.dataset.clipUrl;
				videoEl.pause();
				videoEl.removeAttribute('src');
				videoEl.load();
			}
		}
	});

	if (isDragging && pendingClipsToFetch.length > 0) {
		const debounceMs = networkMonitor.tier === 'low' ? 280 : 140;
		scrubMetadataDebounceTimer = setTimeout(() => {
			pendingClipsToFetch.forEach(({ camId, manifestRef, offset }) => {
				ensureClipMetadata(manifestRef).then(() => {
					if (isScrubbing && renderSpriteFrame(camId, manifestRef, offset)) {
						setCameraState(camId, 'canvas');
					}
				});
			});
		}, debounceMs);
	}
}

// --- SPA Navigational Hooks ---
function openCameraPage(camId) {
	const hexColor = getCameraColor(camId).replace('#', '');
	isSingleCameraOpen = true;

	// 1. Swap Views
	document.getElementById('dashboard-view').style.display = 'none';
	document.getElementById('camera-view').style.display = 'flex';

	// 2. Pause and stop loading dashboard HLS players and snapshot loops to free up network/CPU
	activeCameras.forEach(id => {
		clearCameraReconnectTimer(id);
		clearCameraStaggerTimer(id);
		stopCameraSnapshotLoop(id);
		const videoEl = document.getElementById(`video-${id}`);
		if (videoEl && !videoEl.paused) {
			videoEl.pause();
		}
		if (hlsPlayers[id]) {
			hlsPlayers[id].stopLoad();
		}
	});

	// 3. Initialize single camera view
	if (window.initCameraView) {
		window.initCameraView(camId, currentDayString, hexColor);
	}
}

window.closeCameraPage = function() {
	isSingleCameraOpen = false;
	document.getElementById('camera-view').style.display = 'none';
	document.getElementById('dashboard-view').style.display = 'flex';

	if (window.stopCameraView) {
		window.stopCameraView();
	}

	if (isLive) {
		returnToLive();
	} else {
		updateCamerasToScrubber(parseInt(scrubber.value, 10), false);
	}
};

function startHlsLiveForCamera(camId) {
	const videoEl = document.getElementById(`video-${camId}`);
	if (!videoEl) return;

	const hadNativeSrc = videoEl.hasAttribute('src') && !hlsPlayers[camId];
	destroyHlsPlayer(camId);
	delete videoEl.dataset.clipUrl;

	setCameraState(camId, 'video');
	cameraWatchdog.lastTime[camId] = -1;
	cameraWatchdog.freezeCount[camId] = 0;

	videoEl.muted = true;
	videoEl.playsInline = true;
	videoEl.autoplay = true;

	if (hadNativeSrc) {
		videoEl.pause();
		videoEl.removeAttribute('src');
		videoEl.load();
	}

	if (window.innerWidth <= 800 && !isCameraVisibleInViewport(camId)) {
		return;
	}

	const usingSubStream = networkMonitor.shouldUseSubStream(camId, false);
	cameraLiveMode[camId] = usingSubStream ? 'hls-sub' : 'hls-main';
	const freshPlaylistUrl = networkMonitor.getLiveStreamUrl(baseDir, camId, false);

	if (Hls.isSupported()) {
		const hls = new Hls(networkMonitor.getHlsConfig(true, false));
		let mediaRecoveryCount = 0;
		let lastMediaRecoveryTs = 0;

		networkMonitor.attachHlsTelemetry(hls, camId);
		hlsPlayers[camId] = hls;
		hls.attachMedia(videoEl);

		hls.on(Hls.Events.MEDIA_ATTACHED, () => {
			if (hlsPlayers[camId] !== hls) return;
			hls.loadSource(freshPlaylistUrl);
		});

		hls.on(Hls.Events.MANIFEST_PARSED, () => {
			if (hlsPlayers[camId] !== hls) return;
			if (usingSubStream) {
				networkMonitor.clearSubStreamFailure(camId);
			}
			setCameraState(camId, 'video');
			videoEl.play().catch(e => {});
		});

		hls.on(Hls.Events.FRAG_BUFFERED, () => {
			if (hlsPlayers[camId] !== hls || !isLive || isSingleCameraOpen) return;
			setCameraState(camId, 'video');
			if (videoEl.paused && document.visibilityState === 'visible') {
				videoEl.play().catch(e => {});
			}
		});

		hls.on(Hls.Events.ERROR, (event, data) => {
			if (hlsPlayers[camId] !== hls) return;
			if (data.fatal) {
				if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
					const now = performance.now();
					if (now - lastMediaRecoveryTs > 15000) {
						mediaRecoveryCount = 0;
					}
					mediaRecoveryCount++;
					lastMediaRecoveryTs = now;

					if (mediaRecoveryCount === 1) {
						hls.recoverMediaError();
						setTimeout(() => {
							if (hlsPlayers[camId] === hls && isLive) {
								videoEl.play().catch(e => {});
							}
						}, 150);
					} else if (mediaRecoveryCount === 2) {
						hls.swapAudioCodec();
						hls.recoverMediaError();
						setTimeout(() => {
							if (hlsPlayers[camId] === hls && isLive) {
								videoEl.play().catch(e => {});
							}
						}, 150);
					} else {
						handleStreamError(camId, hls, usingSubStream);
					}
				} else {
					handleStreamError(camId, hls, usingSubStream);
				}
			}
		});

	} else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
		videoEl.src = freshPlaylistUrl;
		videoEl.onloadedmetadata = () => {
			if (usingSubStream) {
				networkMonitor.clearSubStreamFailure(camId);
			}
			setCameraState(camId, 'video');
			videoEl.play().catch(e => {});
		};
		videoEl.onerror = () => handleStreamError(camId, null, usingSubStream);
	}
}

function resetIndividualCamera(camId) {
	const videoEl = document.getElementById(`video-${camId}`);
	if (!videoEl) return;

	if (isLive && networkMonitor.shouldUseSnapshotGrid(activeCameras.length) && !cameraSnapshotFailed[camId]) {
		destroyHlsPlayer(camId);
		delete videoEl.dataset.clipUrl;
		if (videoEl.hasAttribute('src')) {
			videoEl.pause();
			videoEl.removeAttribute('src');
			videoEl.load();
		}
		fetchAndRenderLiveSnapshot(camId);
		return;
	}

	startHlsLiveForCamera(camId);
}

function reconcileCamerasForNetworkTier(forceResetAll = false) {
	if (!isLive || isSingleCameraOpen || document.visibilityState !== 'visible') return;

	activeCameras.forEach((camId, idx) => {
		const desiredMode = getDesiredCameraLiveMode(camId);
		const currentMode = cameraLiveMode[camId] || 'none';
		const videoEl = document.getElementById(`video-${camId}`);

		if (!forceResetAll && desiredMode === currentMode) {
			if (desiredMode === 'snapshot') {
				if (!cameraSnapshotTimers[camId] && !cameraSnapshotInFlight[camId]) {
					fetchAndRenderLiveSnapshot(camId);
				}
				return;
			}
			if (hlsPlayers[camId] && videoEl) {
				setCameraState(camId, 'video');
				if (videoEl.paused) {
					videoEl.play().catch(e => {});
				}
				return;
			}
		}

		clearCameraStaggerTimer(camId);
		const delay = idx * 60;
		if (delay === 0) {
			resetIndividualCamera(camId);
		} else {
			cameraStaggerTimers[camId] = setTimeout(() => {
				delete cameraStaggerTimers[camId];
				if (isLive && !isSingleCameraOpen && document.visibilityState === 'visible') {
					resetIndividualCamera(camId);
				}
			}, delay);
		}
	});
}

function returnToLive() {
	if (liveSyncInterval) {
		clearInterval(liveSyncInterval);
		liveSyncInterval = null;
	}

	isLive = true;
	isPlayingHistory = false;
	isScrubbing = false;
	if (playbackInterval) {
		clearInterval(playbackInterval);
		playbackInterval = null;
	}

	networkMonitor.resetAfterWake(10000);

	playBtn.innerText = "▶ Play";
	playBtn.disabled = true;

	liveBtn.innerText = "Reset";
	liveBtn.classList.add('active');

	timeLabel.innerText = "LIVE";
	timeLabel.classList.remove('history');

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

	if (!isSingleCameraOpen) {
		activeCameras.forEach((camId, idx) => {
			delete cameraSnapshotFailed[camId];
			cameraSnapshot404Count[camId] = 0;
			networkMonitor.clearSubStreamFailure(camId);
			clearCameraStaggerTimer(camId);

			const delay = idx * 80;
			if (delay === 0) {
				resetIndividualCamera(camId);
			} else {
				cameraStaggerTimers[camId] = setTimeout(() => {
					delete cameraStaggerTimers[camId];
					if (isLive && !isSingleCameraOpen && document.visibilityState === 'visible') {
						resetIndividualCamera(camId);
					}
				}, delay);
			}
		});
	}
}

scrubber.addEventListener('input', (e) => {
	if (isLive) {
		isLive = false;
		liveBtn.innerText = "Go Live";
		playBtn.disabled = false;
		liveBtn.classList.remove('active');
		if (liveSyncInterval) {
			clearInterval(liveSyncInterval);
			liveSyncInterval = null;
		}

		timeLabel.classList.add('history');
		activeCameras.forEach(camId => {
			destroyHlsPlayer(camId);
		});

		fetchManifest();
	}

	isScrubbing = true;
	const targetSeconds = parseInt(e.target.value, 10);
	timeLabel.innerText = secondsToTimeStr(targetSeconds);

	if (scrubRafId) cancelAnimationFrame(scrubRafId);
	scrubRafId = requestAnimationFrame(() => {
		scrubRafId = null;
		updateCamerasToScrubber(targetSeconds, true);
	});

	const scrubberX = (targetSeconds / 86400) * timelineContent.clientWidth;
	const buffer = 50;
	if (scrubberX < timelineViewport.scrollLeft + buffer) {
		timelineViewport.scrollLeft = scrubberX - buffer;
	} else if (scrubberX > timelineViewport.scrollLeft + timelineViewport.clientWidth - buffer) {
		timelineViewport.scrollLeft = scrubberX - timelineViewport.clientWidth + buffer;
	}
});

scrubber.addEventListener('change', (e) => {
	isScrubbing = false;
	if (scrubRafId) {
		cancelAnimationFrame(scrubRafId);
		scrubRafId = null;
	}
	const targetSeconds = parseInt(e.target.value, 10);
	updateCamerasToScrubber(targetSeconds, false);
});

playBtn.addEventListener('click', () => {
	if (isLive) return;

	isPlayingHistory = !isPlayingHistory;
	if (isPlayingHistory) {
		playBtn.innerText = "⏸ Pause";
		if (playbackInterval) clearInterval(playbackInterval);
		playbackInterval = setInterval(() => {
			if (isScrubbing) return;

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
		if (playbackInterval) {
			clearInterval(playbackInterval);
			playbackInterval = null;
		}
		activeCameras.forEach(camId => {
			const videoEl = document.getElementById(`video-${camId}`);
			if (videoEl) videoEl.pause();
		});
	}
});

liveBtn.addEventListener('click', () => {
	returnToLive();
});

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		networkMonitor.resetAfterWake(10000);
		if (!isSingleCameraOpen) {
			if (isLive) {
				returnToLive();
			} else {
				fetchManifest();
			}
		}
	} else if (document.visibilityState === "hidden") {
		if (liveSyncInterval) {
			clearInterval(liveSyncInterval);
			liveSyncInterval = null;
		}
		if (playbackInterval) {
			clearInterval(playbackInterval);
			playbackInterval = null;
		}
		if (isPlayingHistory) {
			isPlayingHistory = false;
			playBtn.innerText = "▶ Play";
		}

		activeCameras.forEach(camId => {
			const videoEl = document.getElementById(`video-${camId}`);
			if (videoEl && !videoEl.paused) {
				videoEl.pause();
			}
			destroyHlsPlayer(camId);
		});
	}
});

// Handle returning from another desktop application when the browser tab stayed 'visible'
window.addEventListener("focus", () => {
	if (document.visibilityState !== "visible" || isSingleCameraOpen || !isLive) return;
	networkMonitor.resetAfterWake(8000);

	activeCameras.forEach(camId => {
		if (!isCameraVisibleInViewport(camId)) return;
		const desiredMode = getDesiredCameraLiveMode(camId);
		if (desiredMode === 'snapshot') {
			if (!cameraSnapshotTimers[camId] && !cameraSnapshotInFlight[camId]) {
				fetchAndRenderLiveSnapshot(camId);
			}
			return;
		}

		const videoEl = document.getElementById(`video-${camId}`);
		const hls = hlsPlayers[camId];
		if (!hls || !videoEl || videoEl.error) {
			resetIndividualCamera(camId);
			return;
		}

		setCameraState(camId, 'video');
		if (hls.liveSyncPosition && videoEl.currentTime > 0 && (hls.liveSyncPosition - videoEl.currentTime) > 12) {
			videoEl.currentTime = hls.liveSyncPosition;
		}
		if (videoEl.paused) {
			videoEl.play().catch(() => {
				resetIndividualCamera(camId);
			});
		}
	});
});

document.addEventListener('click', (e) => {
	const popup = document.getElementById('calendar-popup');
	const dateBtn = document.getElementById('global-date');
	if (popup && dateBtn && popup.classList.contains('visible') && !popup.contains(e.target) && !dateBtn.contains(e.target)) {
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

function ensureIntersectionObserver() {
	if (cardIntersectionObserver || !('IntersectionObserver' in window)) return;
	cardIntersectionObserver = new IntersectionObserver((entries) => {
		entries.forEach(entry => {
			const cardId = entry.target.id || '';
			const camId = cardId.replace('card-', '');
			if (!camId) return;

			if (entry.isIntersecting) {
				visibleCameras.add(camId);
				if (isLive && !isSingleCameraOpen && document.visibilityState === 'visible') {
					if (networkMonitor.shouldUseSnapshotGrid(activeCameras.length) && !cameraSnapshotFailed[camId]) {
						if (!cameraSnapshotTimers[camId] && !cameraSnapshotInFlight[camId]) {
							fetchAndRenderLiveSnapshot(camId);
						}
					} else if (!hlsPlayers[camId]) {
						startHlsLiveForCamera(camId);
					} else {
						const videoEl = document.getElementById(`video-${camId}`);
						setCameraState(camId, 'video');
						hlsPlayers[camId].startLoad();
						if (videoEl && videoEl.paused) videoEl.play().catch(e => {});
					}
				}
			} else {
				visibleCameras.delete(camId);
				if (window.innerWidth <= 800 && isLive && !isSingleCameraOpen) {
					stopCameraSnapshotLoop(camId);
					if (hlsPlayers[camId]) {
						hlsPlayers[camId].stopLoad();
						const videoEl = document.getElementById(`video-${camId}`);
						if (videoEl && !videoEl.paused) videoEl.pause();
					}
				}
			}
		});
	}, {
		root: null,
		rootMargin: '120px 0px',
		threshold: 0.05
	});
}

function createCameraDOM(camId) {
	ensureIntersectionObserver();
	const grid = document.getElementById('grid');
	const card = document.createElement('div');
	card.className = 'camera-card state-video';
	card.id = `card-${camId}`;

	const camColor = getCameraColor(camId);

	card.innerHTML = `
       <div class="camera-header">
          <span class="camera-title" style="color: ${camColor};">${camId}</span>
       </div>
       <canvas id="canvas-${camId}" class="snapshot-canvas"></canvas>
       <video id="video-${camId}" muted playsinline autoplay preload="none"></video>
       <div class="no-video-overlay" id="overlay-${camId}">
          <div>No Motion Detected</div>
       </div>
    `;

	card.addEventListener('click', () => openCameraPage(camId));

	grid.appendChild(card);
	activeCameras.push(camId);
	visibleCameras.add(camId);
	if (cardIntersectionObserver) {
		cardIntersectionObserver.observe(card);
	}
	adjustGridLayout();

	resetIndividualCamera(camId);
}

async function discoverCameras() {
	try {
		const response = await fetch('/cameracount', { cache: 'no-store', credentials: 'include' });
		if (response.ok) {
			const data = await response.json();
			const count = data.count || 1;
			if (data.subStreams) {
				window.cameraSubStreams = data.subStreams;
			}

			CAMERA_COLORS = [];
			for (let i = 0; i < count; i++) {
				const hue = count === 1 ? 0 : Math.floor((270 * i) / (count - 1));
				CAMERA_COLORS.push(`#${hslToHex(hue, 80, 55)}`);
			}

			for (let index = 1; index <= count; index++) {
				const camId = `cam${index}`;
				createCameraDOM(camId);
			}

			fetchManifest();
		} else {
			setTimeout(discoverCameras, 2000);
		}
	} catch (error) {
		setTimeout(discoverCameras, 2000);
	}
}

const cameraWatchdog = {
	lastTime: {},
	freezeCount: {}
};

setInterval(() => {
	if (!isLive || isSingleCameraOpen || document.visibilityState === "hidden") return;

	activeCameras.forEach(camId => {
		if (!isCameraVisibleInViewport(camId)) return;

		// Ensure snapshot loop stays alive when in snapshot grid mode
		if (networkMonitor.shouldUseSnapshotGrid(activeCameras.length) && !cameraSnapshotFailed[camId]) {
			if (!cameraSnapshotTimers[camId] && !cameraSnapshotInFlight[camId]) {
				fetchAndRenderLiveSnapshot(camId);
			}
			return;
		}

		const videoEl = document.getElementById(`video-${camId}`);
		if (!videoEl) return;

		// Ensure card is displaying the video element when in HLS mode
		setCameraState(camId, 'video');

		if (cameraWatchdog.lastTime[camId] === undefined) {
			cameraWatchdog.lastTime[camId] = -1;
		}
		if (cameraWatchdog.freezeCount[camId] === undefined) {
			cameraWatchdog.freezeCount[camId] = 0;
		}

		// If the player is missing and not waiting on a reconnect/stagger timer, restart it
		if (!hlsPlayers[camId] && !videoEl.canPlayType('application/vnd.apple.mpegurl')) {
			if (!cameraReconnectTimers[camId] && !cameraStaggerTimers[camId]) {
				resetIndividualCamera(camId);
			}
			return;
		}

		// Do not ignore paused live videos; attempt to resume first, then reset if still stuck
		if (videoEl.paused) {
			cameraWatchdog.freezeCount[camId]++;
			videoEl.play().catch(e => {});
			if (cameraWatchdog.freezeCount[camId] >= 2) {
				console.warn(`[Watchdog] Camera ${camId} remained paused in live mode. Resetting individually...`);
				resetIndividualCamera(camId);
				cameraWatchdog.freezeCount[camId] = 0;
			}
			return;
		}

		if (videoEl.currentTime === cameraWatchdog.lastTime[camId]) {
			cameraWatchdog.freezeCount[camId]++;

			if (cameraWatchdog.freezeCount[camId] >= 2) {
				console.warn(`[Watchdog] Camera ${camId} appears frozen. Resetting individually...`);
				networkMonitor.recordStall();
				resetIndividualCamera(camId);
				cameraWatchdog.freezeCount[camId] = 0;
			}
		} else {
			cameraWatchdog.freezeCount[camId] = 0;
		}

		cameraWatchdog.lastTime[camId] = videoEl.currentTime;
	});
}, 4000);

document.addEventListener('DOMContentLoaded', async () => {
	networkMonitor.init();

	networkMonitor.onChange((tier, forced) => {
		if (isLive && !isSingleCameraOpen && document.visibilityState === 'visible') {
			reconcileCamerasForNetworkTier(Boolean(forced));
		}
	});

	try {
		const response = await fetch('/basedir', { credentials: 'include' });
		if (response.ok) {
			const data = await response.json();
			baseDir = data.baseDir || './cameras';
			if (data.subStreams) {
				window.cameraSubStreams = data.subStreams;
			}
		}
	} catch (e) {
		console.error("Failed to load base configuration:", e);
	}

	fetchAvailableDates();
	renderTimelineRuler();
	returnToLive();

	setInterval(() => {
		if (document.visibilityState === "visible") {
			fetchManifest();
		}
	}, 30000);

	discoverCameras();

	// Setup toolbar toggle
	const toggleBtn = document.getElementById('toolbar-toggle');
	const iconHide = document.getElementById('icon-hide');
	const iconShow = document.getElementById('icon-show');

	if (toggleBtn) {
		toggleBtn.addEventListener('click', () => {
			document.body.classList.toggle('toolbars-hidden');
			const isHidden = document.body.classList.contains('toolbars-hidden');

			if (isHidden) {
				iconHide.style.display = 'none';
				iconShow.style.display = 'block';
			} else {
				iconHide.style.display = 'block';
				iconShow.style.display = 'none';
			}

			window.dispatchEvent(new Event('resize'));

			if (!isHidden) {
				setTimeout(centerViewportOnScrubber, 50);
			}
		});
	}

	// Reboot button logic
	const rebootBtn = document.getElementById('btn-reboot');
	if (rebootBtn) {
		rebootBtn.addEventListener('click', () => {
			if (confirm("Are you sure you want to reboot the system?")) {
				fetch('/api/system/reboot', {
					method: 'POST',
					credentials: 'include',
					headers: {
						'Content-Type': 'application/json'
					}
				})
					.then(response => {
						if (!response.ok) {
							throw new Error('Reboot request failed');
						}
						alert("System is rebooting...");
					})
					.catch(err => {
						console.error(err);
						alert("Failed to initiate reboot.");
					});
			}
		});
	}
});