import { AudioOutputRouter, outputDeviceLabel } from "./output-routing.js";
import { PerformanceControls } from "./performance.js";
import init, {
  CuePoint,
  Mixer,
  MonitorMixer,
  effective_bpm,
  plan_beat_loop,
  plan_sync,
  playback_rate_for_tempo,
  tempo_percent_for_rate,
} from "./pkg/dj_party.js";

const state = {
  audioContext: null,
  decodeContext: null,
  mixer: null,
  monitor: null,
  outputRouter: null,
  monitoringReady: false,
  outputLabels: {
    master: "System default",
    headphones: null,
  },
  decks: new Map(),
  analysisWorker: null,
  nextAnalysisRequestId: 0,
};

class Deck {
  constructor(id, mixerLevelSetter, mixerGainGetter) {
    this.id = id;
    this.mixerLevelSetter = mixerLevelSetter;
    this.mixerGainGetter = mixerGainGetter;
    this.audio = new Audio();
    this.audio.preload = "metadata";
    this.cue = new CuePoint();
    this.sourceNode = null;
    this.gainNode = null;
    this.cueGainNode = null;
    this.objectUrl = null;
    this.analysisRequestId = 0;
    this.waveformData = null;
    this.beats = new Float64Array();
    this.downbeats = new Float64Array();
    this.baseBpm = null;
    this.activeLoop = null;
    this.animationFrame = null;

    this.fileInput = document.querySelector(`#deck-${id}-file`);
    this.dropZone = document.querySelector(`#deck-${id}-drop-zone`);
    this.title = document.querySelector(`#deck-${id}-title`);
    this.current = document.querySelector(`#deck-${id}-current`);
    this.duration = document.querySelector(`#deck-${id}-duration`);
    this.seek = document.querySelector(`#deck-${id}-seek`);
    this.playButton = document.querySelector(`#deck-${id}-play`);
    this.restartButton = document.querySelector(`#deck-${id}-restart`);
    this.setCueButton = document.querySelector(`#deck-${id}-set-cue`);
    this.cueButton = document.querySelector(`#deck-${id}-cue`);
    this.cueTime = document.querySelector(`#deck-${id}-cue-time`);
    this.monitorCueButton = document.querySelector(`#deck-${id}-monitor-cue`);
    this.level = document.querySelector(`#deck-${id}-level`);
    this.levelValue = document.querySelector(`#deck-${id}-level-value`);
    this.deckState = document.querySelector(`#deck-${id}-state`);
    this.platter = document.querySelector(`#deck-${id}-platter`);
    this.waveform = document.querySelector(`#deck-${id}-waveform`);
    this.bpm = document.querySelector(`#deck-${id}-bpm`);
    this.analysisStatus = document.querySelector(`#deck-${id}-analysis-status`);
    this.tempo = document.querySelector(`#deck-${id}-tempo`);
    this.tempoValue = document.querySelector(`#deck-${id}-tempo-value`);
    this.effectiveBpm = document.querySelector(`#deck-${id}-effective-bpm`);
    this.keyLock = document.querySelector(`#deck-${id}-key-lock`);
    this.syncButton = document.querySelector(`#deck-${id}-sync`);
    this.timingStatus = document.querySelector(`#deck-${id}-timing-status`);
    this.loopControls = document.querySelector(`#deck-${id}-loop-controls`);
    this.loopButtons = [...this.loopControls.querySelectorAll("[data-loop-beats]")];
    this.loopOffButton = document.querySelector(`#deck-${id}-loop-off`);
    this.loopStatus = document.querySelector(`#deck-${id}-loop-status`);
    this.performance = new PerformanceControls(
      this,
      () => state.decks.get(this.id === "a" ? "b" : "a"),
    );

    setPitchPreservation(this.audio, true);
    this.resizeObserver = new ResizeObserver(() => this.drawWaveform());
    this.resizeObserver.observe(this.waveform);
    this.bindEvents();
    this.drawWaveform();
    this.updateTimingReadout();
    this.updateLoopAvailability();
  }

  bindEvents() {
    this.fileInput.addEventListener("change", () => {
      const [file] = this.fileInput.files;
      if (file) {
        this.loadFile(file);
      }
    });

    for (const eventName of ["dragenter", "dragover"]) {
      this.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        this.dropZone.classList.add("is-dragging");
      });
    }

    for (const eventName of ["dragleave", "drop"]) {
      this.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        this.dropZone.classList.remove("is-dragging");
      });
    }

    this.dropZone.addEventListener("drop", (event) => {
      const [file] = event.dataTransfer?.files ?? [];
      if (file) {
        this.loadFile(file);
      }
    });

    this.playButton.addEventListener("click", async () => {
      if (this.audio.paused) {
        await this.play();
      } else {
        this.audio.pause();
      }
    });

    this.restartButton.addEventListener("click", () => {
      this.audio.currentTime = 0;
      this.updateProgress();
    });

    this.setCueButton.addEventListener("click", () => {
      if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) {
        return;
      }

      const cueSeconds = Math.min(this.audio.currentTime, this.audio.duration);
      if (this.cue.set_seconds(cueSeconds)) {
        this.cueButton.disabled = false;
        this.cueTime.textContent = formatTime(cueSeconds);
        this.drawWaveform();
      }
    });

    this.cueButton.addEventListener("click", () => {
      if (!this.cue.has_cue()) {
        return;
      }

      this.audio.currentTime = Math.min(this.cue.seconds(), this.audio.duration || this.cue.seconds());
      this.enforceLoop();
      this.updateProgress();
    });

    this.monitorCueButton.addEventListener("click", () => {
      if (!state.monitoringReady) {
        return;
      }

      if (this.id === "a") {
        state.monitor.set_deck_a_cue(!state.monitor.deck_a_cue_enabled());
      } else {
        state.monitor.set_deck_b_cue(!state.monitor.deck_b_cue_enabled());
      }
      updateMonitorCueButtons();
      applyMonitoringGains();
    });

    this.seek.addEventListener("input", () => {
      if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) {
        return;
      }

      this.audio.currentTime = (Number(this.seek.value) / 1000) * this.audio.duration;
      this.enforceLoop();
      this.updateProgress();
    });

    this.waveform.addEventListener("pointerdown", (event) => {
      if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) {
        return;
      }

      const bounds = this.waveform.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
      this.audio.currentTime = fraction * this.audio.duration;
      this.enforceLoop();
      this.updateProgress();
    });

    this.level.addEventListener("input", () => {
      const level = Number(this.level.value) / 100;
      this.mixerLevelSetter(level);
      this.levelValue.textContent = `${this.level.value}%`;
      applyMixerGains();
    });

    this.tempo.addEventListener("input", () => {
      const rate = playback_rate_for_tempo(Number(this.tempo.value));
      this.setPlaybackRate(rate);
      this.timingStatus.textContent = "Manual tempo";
      refreshSyncButtons();
    });

    this.keyLock.addEventListener("change", () => {
      setPitchPreservation(this.audio, this.keyLock.checked);
      this.timingStatus.textContent = this.keyLock.checked
        ? "Key locked while tempo changes"
        : "Pitch follows tempo";
    });

    this.syncButton.addEventListener("click", () => this.syncToOtherDeck());

    for (const button of this.loopButtons) {
      button.addEventListener("click", () => this.activateBeatLoop(Number(button.dataset.loopBeats)));
    }

    this.loopOffButton.addEventListener("click", () => this.disableLoop());

    this.audio.addEventListener("loadedmetadata", () => {
      this.duration.textContent = formatTime(this.audio.duration);
      this.seek.disabled = false;
      this.setCueButton.disabled = false;
      this.deckState.textContent = "Ready";
      this.drawWaveform();
    });

    this.audio.addEventListener("durationchange", () => {
      this.duration.textContent = formatTime(this.audio.duration);
      this.drawWaveform();
    });

    this.audio.addEventListener("timeupdate", () => this.updateProgress());

    this.audio.addEventListener("play", () => {
      this.playButton.textContent = "Ⅱ Pause";
      this.deckState.textContent = "Playing";
      this.platter.classList.add("is-playing");
      this.startPlaybackAnimation();
    });

    this.audio.addEventListener("pause", () => {
      this.playButton.textContent = "▶ Play";
      this.deckState.textContent = this.audio.ended ? "Ended" : "Paused";
      this.platter.classList.remove("is-playing");
      this.stopPlaybackAnimation();
    });

    this.audio.addEventListener("ended", () => {
      this.playButton.textContent = "▶ Play";
      this.deckState.textContent = "Ended";
      this.platter.classList.remove("is-playing");
      this.stopPlaybackAnimation();
      this.updateProgress();
    });

    this.audio.addEventListener("error", () => {
      this.deckState.textContent = "Audio error";
      this.playButton.disabled = true;
      this.restartButton.disabled = true;
      this.setCueButton.disabled = true;
    });
  }

  loadFile(file) {
    const looksLikeAudio = file.type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name);
    if (!looksLikeAudio) {
      this.deckState.textContent = "Unsupported file";
      return;
    }

    this.audio.pause();
    this.audio.currentTime = 0;
    this.setPlaybackRate(1.0);
    this.analysisRequestId = ++state.nextAnalysisRequestId;
    this.waveformData = null;
    this.beats = new Float64Array();
    this.downbeats = new Float64Array();
    this.baseBpm = null;
    this.cue.clear();
    this.disableLoop();
    this.performance.reset();

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }

    this.objectUrl = URL.createObjectURL(file);
    this.audio.src = this.objectUrl;
    this.audio.load();

    this.title.textContent = stripExtension(file.name);
    this.current.textContent = "0:00";
    this.duration.textContent = "0:00";
    this.seek.value = "0";
    this.seek.disabled = true;
    this.playButton.disabled = false;
    this.restartButton.disabled = false;
    this.setCueButton.disabled = true;
    this.cueButton.disabled = true;
    this.cueTime.textContent = "—";
    this.bpm.textContent = "—";
    this.analysisStatus.textContent = "Decoding track…";
    this.timingStatus.textContent = "Waiting for BPM analysis";
    this.deckState.textContent = "Loading";
    this.platter.classList.remove("is-playing");
    this.updateTimingReadout();
    this.updateLoopAvailability();
    refreshSyncButtons();
    this.drawWaveform();

    void this.analyzeFile(file, this.analysisRequestId);
  }

  async analyzeFile(file, requestId) {
    try {
      const context = getDecodeContext();
      const encoded = await file.arrayBuffer();
      const buffer = await context.decodeAudioData(encoded);
      if (requestId !== this.analysisRequestId) {
        return;
      }

      const mono = mixToMono(buffer);
      this.analysisStatus.textContent = "Analyzing rhythm…";
      state.analysisWorker.postMessage(
        {
          type: "analyze",
          deckId: this.id,
          requestId,
          samples: mono,
          sampleRate: buffer.sampleRate,
        },
        [mono.buffer],
      );
    } catch (error) {
      if (requestId !== this.analysisRequestId) {
        return;
      }
      console.error(`Could not analyze deck ${this.id.toUpperCase()}`, error);
      this.analysisStatus.textContent = "Analysis unavailable";
    }
  }

  applyAnalysis(message) {
    if (message.requestId !== this.analysisRequestId) {
      return;
    }

    this.waveformData = message.extrema;
    this.beats = message.beats;
    this.downbeats = message.downbeats;
    this.baseBpm = Number.isFinite(message.bpm) ? message.bpm : null;
    this.bpm.textContent = this.baseBpm === null ? "—" : this.baseBpm.toFixed(1);

    if (this.baseBpm !== null) {
      const confidence = Math.round(Math.max(0, Math.min(1, message.confidence)) * 100);
      this.analysisStatus.textContent = message.analysisLimited
        ? `Rhythm ${confidence}% · first 15 min analyzed`
        : `Rhythm confidence ${confidence}%`;
      this.timingStatus.textContent = "Tempo ready";
    } else {
      this.analysisStatus.textContent = "No stable tempo detected";
      this.timingStatus.textContent = "Sync unavailable without BPM";
    }

    this.updateTimingReadout();
    this.updateLoopAvailability();
    this.performance.refreshAvailability();
    refreshSyncButtons();
    this.drawWaveform();
  }

  applyAnalysisError(message) {
    if (message.requestId !== this.analysisRequestId) {
      return;
    }

    console.error(`Rhythm analysis failed for deck ${this.id.toUpperCase()}: ${message.message}`);
    this.baseBpm = null;
    this.analysisStatus.textContent = "Analysis unavailable";
    this.timingStatus.textContent = "Timing controls need analysis";
    this.updateTimingReadout();
    this.updateLoopAvailability();
    this.performance.refreshAvailability();
    refreshSyncButtons();
  }

  async play() {
    await ensureAudioContext();
    this.ensureAudioGraph();
    applyMixerGains();
    applyMonitoringGains();

    try {
      await this.audio.play();
    } catch (error) {
      console.error(`Could not play deck ${this.id.toUpperCase()}`, error);
      this.deckState.textContent = "Playback blocked";
    }
  }

  ensureAudioGraph() {
    if (this.sourceNode || !state.audioContext) {
      return;
    }

    const cueDestination = state.outputRouter.cueDestination();
    const masterMonitorInput = state.outputRouter.masterMonitorInput();
    if (!cueDestination || !masterMonitorInput) {
      throw new Error("Monitoring graph was not initialized with the playback AudioContext");
    }

    this.sourceNode = state.audioContext.createMediaElementSource(this.audio);
    this.gainNode = state.audioContext.createGain();
    this.cueGainNode = state.audioContext.createGain();
    this.cueGainNode.gain.value = 0;

    this.sourceNode.connect(this.gainNode);
    this.sourceNode.connect(this.cueGainNode);
    this.gainNode.connect(state.audioContext.destination);
    this.gainNode.connect(masterMonitorInput);
    this.cueGainNode.connect(cueDestination);
  }

  applyGain() {
    if (!this.gainNode || !state.audioContext) {
      return;
    }

    const gain = this.mixerGainGetter();
    this.gainNode.gain.setTargetAtTime(gain, state.audioContext.currentTime, 0.012);
  }

  applyCueGain() {
    if (!this.cueGainNode || !state.audioContext) {
      return;
    }

    const gain = this.id === "a" ? state.monitor.deck_a_cue_gain() : state.monitor.deck_b_cue_gain();
    this.cueGainNode.gain.setTargetAtTime(gain, state.audioContext.currentTime, 0.012);
  }

  setPlaybackRate(rate) {
    const tempoPercent = tempo_percent_for_rate(rate);
    const normalizedRate = playback_rate_for_tempo(tempoPercent);
    this.audio.playbackRate = normalizedRate;
    this.tempo.value = tempoPercent.toFixed(1);
    this.tempoValue.textContent = formatTempoPercent(tempoPercent);
    this.updateTimingReadout();
  }

  updateTimingReadout() {
    const bpm = this.baseBpm === null ? Number.NaN : effective_bpm(this.baseBpm, this.audio.playbackRate);
    this.effectiveBpm.textContent = Number.isFinite(bpm) ? `${bpm.toFixed(1)} BPM` : "— BPM";
  }

  syncToOtherDeck() {
    const otherDeck = state.decks.get(this.id === "a" ? "b" : "a");
    if (this.baseBpm === null || otherDeck?.baseBpm === null || !otherDeck) {
      return;
    }

    const plan = plan_sync(this.baseBpm, otherDeck.baseBpm, otherDeck.audio.playbackRate);
    try {
      if (!plan.valid()) {
        this.timingStatus.textContent = "Sync unavailable";
        return;
      }

      this.setPlaybackRate(plan.playback_rate());
      this.timingStatus.textContent = plan.limited()
        ? `Closest BPM match · target ${plan.target_bpm().toFixed(1)} BPM`
        : `BPM synced to Deck ${otherDeck.id.toUpperCase()} · ${plan.target_bpm().toFixed(1)} BPM`;
    } finally {
      plan.free();
    }
  }

  activateBeatLoop(beatCount) {
    if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) {
      return;
    }

    const plan = plan_beat_loop(this.beats, this.audio.currentTime, beatCount, this.audio.duration);
    try {
      if (!plan.valid()) {
        this.loopStatus.textContent = "No complete analyzed beat window here";
        return;
      }

      this.activeLoop = {
        start: plan.start_seconds(),
        end: plan.end_seconds(),
        beatCount: plan.beat_count(),
      };
      this.audio.currentTime = this.activeLoop.start;
      this.loopOffButton.disabled = false;
      this.loopStatus.textContent = `${beatCount}-beat loop · ${formatTimePrecise(this.activeLoop.start)}–${formatTimePrecise(this.activeLoop.end)}`;
      for (const button of this.loopButtons) {
        button.classList.toggle("is-active", Number(button.dataset.loopBeats) === beatCount);
      }
      this.updateProgress();
    } finally {
      plan.free();
    }
  }

  disableLoop() {
    this.activeLoop = null;
    this.loopOffButton.disabled = true;
    this.loopStatus.textContent = "Loop off";
    for (const button of this.loopButtons) {
      button.classList.remove("is-active");
    }
    this.drawWaveform();
  }

  updateLoopAvailability() {
    const available = this.beats.length >= 2;
    for (const button of this.loopButtons) {
      const beatCount = Number(button.dataset.loopBeats);
      button.disabled = !available || this.beats.length <= beatCount;
    }
    if (!available && !this.activeLoop) {
      this.loopStatus.textContent = "Beat grid required";
    } else if (!this.activeLoop) {
      this.loopStatus.textContent = "Loop off";
    }
  }

  enforceLoop() {
    if (!this.activeLoop) {
      return;
    }

    const { start, end } = this.activeLoop;
    const span = end - start;
    if (!Number.isFinite(span) || span <= 0) {
      this.disableLoop();
      return;
    }

    const current = this.audio.currentTime;
    if (current < start) {
      this.audio.currentTime = start;
    } else if (current >= end) {
      this.audio.currentTime = start + ((current - end) % span);
    }
  }

  startPlaybackAnimation() {
    if (this.animationFrame !== null) {
      return;
    }

    const frame = () => {
      this.animationFrame = null;
      if (this.audio.paused) {
        return;
      }

      this.enforceLoop();
      this.updateProgress();
      this.animationFrame = requestAnimationFrame(frame);
    };

    this.animationFrame = requestAnimationFrame(frame);
  }

  stopPlaybackAnimation() {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  updateProgress() {
    this.current.textContent = formatTime(this.audio.currentTime);
    this.performance.updatePositionReadout();

    if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) {
      this.seek.value = "0";
      this.drawWaveform();
      return;
    }

    const progress = Math.round((this.audio.currentTime / this.audio.duration) * 1000);
    this.seek.value = String(progress);
    this.drawWaveform();
  }

  drawWaveform() {
    const bounds = this.waveform.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const pixelRatio = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(width * pixelRatio));
    const targetHeight = Math.max(1, Math.round(height * pixelRatio));

    if (this.waveform.width !== targetWidth || this.waveform.height !== targetHeight) {
      this.waveform.width = targetWidth;
      this.waveform.height = targetHeight;
    }

    const context = this.waveform.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const rootStyle = getComputedStyle(document.documentElement);
    const accent = rootStyle.getPropertyValue(this.id === "a" ? "--accent-a" : "--accent-b").trim();
    const mixAccent = rootStyle.getPropertyValue("--accent-mix").trim();
    const center = height / 2;

    context.strokeStyle = "rgba(255, 255, 255, 0.10)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, center);
    context.lineTo(width, center);
    context.stroke();

    const duration = Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0;
    if (duration > 0 && this.activeLoop) {
      const startX = (this.activeLoop.start / duration) * width;
      const endX = (this.activeLoop.end / duration) * width;
      context.fillStyle = mixAccent;
      context.globalAlpha = 0.1;
      context.fillRect(startX, 0, Math.max(1, endX - startX), height);
      context.globalAlpha = 0.75;
      context.strokeStyle = mixAccent;
      context.lineWidth = 1.5;
      for (const x of [startX, endX]) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      context.globalAlpha = 1;
    }

    if (duration > 0) {
      context.strokeStyle = accent;
      context.globalAlpha = 0.22;
      context.lineWidth = 1;
      for (const beat of this.beats) {
        const x = (beat / duration) * width;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }

      context.globalAlpha = 0.5;
      context.lineWidth = 1.5;
      for (const downbeat of this.downbeats) {
        const x = (downbeat / duration) * width;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      context.globalAlpha = 1;
    }

    if (this.waveformData?.length >= 2) {
      const points = Math.floor(this.waveformData.length / 2);
      context.strokeStyle = accent;
      context.lineWidth = Math.max(1, width / points + 0.2);
      context.globalAlpha = 0.9;
      context.beginPath();
      for (let index = 0; index < points; index += 1) {
        const minimum = this.waveformData[index * 2];
        const maximum = this.waveformData[index * 2 + 1];
        const x = ((index + 0.5) / points) * width;
        context.moveTo(x, center - maximum * center * 0.88);
        context.lineTo(x, center - minimum * center * 0.88);
      }
      context.stroke();
      context.globalAlpha = 1;
    }

    this.performance.drawMarkers(context, width, height, duration, accent);

    if (duration > 0 && this.cue.has_cue()) {
      const cueX = (this.cue.seconds() / duration) * width;
      context.strokeStyle = mixAccent;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(cueX, 0);
      context.lineTo(cueX, height);
      context.stroke();
    }

    if (duration > 0) {
      const playheadX = (this.audio.currentTime / duration) * width;
      context.strokeStyle = "rgba(255, 255, 255, 0.92)";
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(playheadX, 0);
      context.lineTo(playheadX, height);
      context.stroke();
    }
  }

  destroy() {
    this.stopPlaybackAnimation();
    this.resizeObserver.disconnect();
    this.performance.destroy();
    this.sourceNode?.disconnect();
    this.gainNode?.disconnect();
    this.cueGainNode?.disconnect();
    this.cue.free();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

function stripExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, "") || fileName;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = String(wholeSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatTimePrecise(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00.0";
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${remainder}`;
}

function formatTempoPercent(value) {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  return `${normalized > 0 ? "+" : ""}${normalized.toFixed(1)}%`;
}

function setPitchPreservation(audio, enabled) {
  if ("preservesPitch" in audio) {
    audio.preservesPitch = enabled;
  }
  if ("mozPreservesPitch" in audio) {
    audio.mozPreservesPitch = enabled;
  }
  if ("webkitPreservesPitch" in audio) {
    audio.webkitPreservesPitch = enabled;
  }
}

function getDecodeContext() {
  if (!state.decodeContext) {
    state.decodeContext = new AudioContext({ latencyHint: "playback" });
  }
  return state.decodeContext;
}

function mixToMono(buffer) {
  const mono = new Float32Array(buffer.length);
  if (buffer.numberOfChannels === 0) {
    return mono;
  }

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    const scale = 1 / buffer.numberOfChannels;
    for (let index = 0; index < samples.length; index += 1) {
      mono[index] += samples[index] * scale;
    }
  }

  return mono;
}

async function ensureAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext({ latencyHint: "interactive" });
    state.outputRouter.attachContext(state.audioContext);
  }

  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }
}

function applyMixerGains() {
  const deckA = state.decks.get("a");
  const deckB = state.decks.get("b");

  deckA?.applyGain();
  deckB?.applyGain();

  document.querySelector("#gain-a").textContent = state.mixer.deck_a_gain().toFixed(3);
  document.querySelector("#gain-b").textContent = state.mixer.deck_b_gain().toFixed(3);
}

function applyMonitoringGains() {
  state.outputRouter.setMasterMonitorGain(state.monitor.master_gain());
  state.decks.get("a")?.applyCueGain();
  state.decks.get("b")?.applyCueGain();
}

function refreshSyncButtons() {
  const deckA = state.decks.get("a");
  const deckB = state.decks.get("b");
  if (!deckA || !deckB) {
    return;
  }

  const ready = deckA.baseBpm !== null && deckB.baseBpm !== null;
  deckA.syncButton.disabled = !ready;
  deckB.syncButton.disabled = !ready;
  deckA.performance.refreshAvailability();
  deckB.performance.refreshAvailability();
}

function bindCrossfader() {
  const crossfader = document.querySelector("#crossfader");
  const output = document.querySelector("#crossfader-value");

  crossfader.addEventListener("input", () => {
    const value = Number(crossfader.value);
    state.mixer.set_crossfader(value / 100);
    output.textContent = describeCrossfader(value);
    applyMixerGains();
  });
}

function installMonitoringUi() {
  if (!document.querySelector('link[data-monitoring-styles]')) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./monitoring.css", import.meta.url).href;
    stylesheet.dataset.monitoringStyles = "true";
    document.head.append(stylesheet);
  }

  for (const id of ["a", "b"]) {
    const cueRow = document.querySelector(`#deck-${id}-cue`)?.closest(".cue-row");
    cueRow?.insertAdjacentHTML(
      "afterend",
      `<div class="monitor-cue-row">
        <span>Pre-fader monitor</span>
        <button id="deck-${id}-monitor-cue" class="mini-button monitor-cue-button" type="button" aria-pressed="false" disabled>
          Headphones: off
        </button>
      </div>`,
    );
  }

  const engineNote = document.querySelector(".mixer-center .engine-note");
  engineNote?.insertAdjacentHTML(
    "beforebegin",
    `<section class="monitoring-panel" aria-label="Headphone monitoring">
      <div class="monitoring-heading">
        <strong>Headphone monitoring</strong>
        <output id="monitor-routing-status" class="monitor-routing-status" aria-live="polite">
          Checking browser output routing…
        </output>
      </div>
      <div class="monitor-routing-actions">
        <button id="choose-headphones" class="mini-button" type="button">Choose headphones</button>
        <button id="choose-master-output" class="mini-button" type="button">Choose master output</button>
      </div>
      <label class="monitor-control" for="monitor-mix">
        <span class="monitor-control-heading"><span>Cue ↔ Master</span><output id="monitor-mix-value">Cue</output></span>
        <input id="monitor-mix" type="range" min="0" max="100" value="0" disabled />
      </label>
      <label class="monitor-control" for="monitor-level">
        <span class="monitor-control-heading"><span>Headphone level</span><output id="monitor-level-value">75%</output></span>
        <input id="monitor-level" type="range" min="0" max="100" value="75" disabled />
      </label>
      <p class="monitor-note">
        Deck cue is pre-fader. Master monitoring follows the Rust-owned deck gains and crossfader. Separate outputs require secure browser audio-output APIs.
      </p>
    </section>`,
  );
}

function bindMonitoring() {
  const chooseHeadphones = document.querySelector("#choose-headphones");
  const chooseMaster = document.querySelector("#choose-master-output");
  const mix = document.querySelector("#monitor-mix");
  const mixValue = document.querySelector("#monitor-mix-value");
  const level = document.querySelector("#monitor-level");
  const levelValue = document.querySelector("#monitor-level-value");

  chooseHeadphones.disabled = !state.outputRouter.supportsOutputSelection();
  chooseMaster.disabled = !state.outputRouter.supportsMasterOutputSelection();
  if (!state.outputRouter.supportsMasterOutputSelection()) {
    chooseMaster.title = "This browser keeps the master on the system default output";
  }

  chooseHeadphones.addEventListener("click", async () => {
    try {
      const device = await state.outputRouter.selectOutput();
      await ensureAudioContext();
      await state.outputRouter.useHeadphoneOutput(device);
      state.monitoringReady = true;
      state.outputLabels.headphones = outputDeviceLabel(device, "Selected headphones");
      setMonitoringControlsEnabled(true);
      renderRoutingStatus();
      applyMonitoringGains();
    } catch (error) {
      console.error("Could not select headphone output", error);
      renderRoutingStatus(describeOutputError(error, "Headphone output selection failed"));
    }
  });

  chooseMaster.addEventListener("click", async () => {
    try {
      const device = await state.outputRouter.selectOutput();
      await ensureAudioContext();
      await state.outputRouter.useMasterOutput(device);
      state.outputLabels.master = outputDeviceLabel(device, "Selected master output");
      renderRoutingStatus();
    } catch (error) {
      console.error("Could not select master output", error);
      renderRoutingStatus(describeOutputError(error, "Master output selection failed"));
    }
  });

  mix.addEventListener("input", () => {
    const value = Number(mix.value);
    state.monitor.set_mix(value / 100);
    mixValue.textContent = describeMonitorMix(value);
    applyMonitoringGains();
  });

  level.addEventListener("input", () => {
    state.monitor.set_level(Number(level.value) / 100);
    levelValue.textContent = `${level.value}%`;
    applyMonitoringGains();
  });

  state.outputRouter.addEventListener("headphoneoutputlost", () => {
    state.monitoringReady = false;
    state.outputLabels.headphones = null;
    state.monitor.set_deck_a_cue(false);
    state.monitor.set_deck_b_cue(false);
    setMonitoringControlsEnabled(false);
    updateMonitorCueButtons();
    applyMonitoringGains();
    renderRoutingStatus("Headphone output disconnected; cue routing stopped");
  });

  state.outputRouter.addEventListener("masteroutputlost", () => {
    state.outputLabels.master = "System default";
    renderRoutingStatus("Selected master output disconnected; browser fallback applies");
  });

  setMonitoringControlsEnabled(false);
  updateMonitorCueButtons();
  renderRoutingStatus();
}

function setMonitoringControlsEnabled(enabled) {
  document.querySelector("#monitor-mix").disabled = !enabled;
  document.querySelector("#monitor-level").disabled = !enabled;
  for (const deck of state.decks.values()) {
    deck.monitorCueButton.disabled = !enabled;
  }
}

function updateMonitorCueButtons() {
  for (const deck of state.decks.values()) {
    const enabled = deck.id === "a" ? state.monitor.deck_a_cue_enabled() : state.monitor.deck_b_cue_enabled();
    deck.monitorCueButton.setAttribute("aria-pressed", String(enabled));
    deck.monitorCueButton.textContent = enabled ? "Headphones: on" : "Headphones: off";
  }
}

function renderRoutingStatus(override = null) {
  const output = document.querySelector("#monitor-routing-status");
  if (override) {
    output.textContent = override;
    return;
  }

  if (!state.outputRouter.supportsOutputSelection()) {
    output.textContent = "Separate headphone output selection is unavailable in this browser; master playback is unchanged.";
    return;
  }

  const headphones = state.outputLabels.headphones ?? "not selected";
  output.textContent = `Master: ${state.outputLabels.master} · Headphones: ${headphones}`;
}

function describeOutputError(error, fallback) {
  if (error?.name === "NotAllowedError") {
    return "Audio output selection was not granted";
  }
  if (error?.name === "NotFoundError") {
    return "No selectable audio output was found";
  }
  return fallback;
}

function describeMonitorMix(value) {
  if (value <= 0) {
    return "Cue";
  }
  if (value >= 100) {
    return "Master";
  }
  return `${value}% Master`;
}

function bindAnalysisWorker() {
  state.analysisWorker = new Worker(new URL("./analysis-worker.js", import.meta.url), { type: "module" });
  state.analysisWorker.addEventListener("message", (event) => {
    const message = event.data ?? {};
    const deck = state.decks.get(message.deckId);
    if (!deck) {
      return;
    }

    if (message.type === "analysis-result") {
      deck.applyAnalysis(message);
    } else if (message.type === "analysis-error") {
      deck.applyAnalysisError(message);
    }
  });

  state.analysisWorker.addEventListener("error", (error) => {
    console.error("Track analysis worker failed", error);
    for (const deck of state.decks.values()) {
      deck.analysisStatus.textContent = "Analysis worker unavailable";
      deck.timingStatus.textContent = "Timing controls need analysis";
      deck.performance.refreshAvailability();
    }
  });
}

function describeCrossfader(value) {
  if (value === 0) {
    return "Center";
  }

  return `${Math.abs(value)}% toward ${value < 0 ? "A" : "B"}`;
}

async function start() {
  await init();
  state.mixer = new Mixer();
  state.monitor = new MonitorMixer();
  state.outputRouter = new AudioOutputRouter();
  installMonitoringUi();

  state.decks.set(
    "a",
    new Deck(
      "a",
      (value) => state.mixer.set_deck_a_level(value),
      () => state.mixer.deck_a_gain(),
    ),
  );
  state.decks.set(
    "b",
    new Deck(
      "b",
      (value) => state.mixer.set_deck_b_level(value),
      () => state.mixer.deck_b_gain(),
    ),
  );

  bindAnalysisWorker();
  bindCrossfader();
  bindMonitoring();
  refreshSyncButtons();
  applyMixerGains();
  applyMonitoringGains();
}

start().catch((error) => {
  console.error("DJ Party failed to initialize", error);
  const sessionStatus = document.querySelector(".session-status");
  sessionStatus.textContent = "Mixer engine unavailable";
});

window.addEventListener("beforeunload", () => {
  state.analysisWorker?.terminate();
  state.outputRouter?.destroy();
  state.decodeContext?.close();
  state.audioContext?.close();
  state.monitor?.free();
  for (const deck of state.decks.values()) {
    deck.destroy();
  }
});
