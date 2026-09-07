import {
  HotCueBank,
  locate_beat_position,
  plan_beat_jump,
  plan_phase_sync,
} from "./pkg/dj_party.js";

const HOT_CUE_SLOTS = [1, 2, 3, 4];

export class PerformanceControls {
  constructor(deck, getOtherDeck) {
    this.deck = deck;
    this.getOtherDeck = getOtherDeck;
    this.hotCues = new HotCueBank();

    this.phaseSyncButton = document.querySelector(`#deck-${deck.id}-phase-sync`);
    this.beatPosition = document.querySelector(`#deck-${deck.id}-beat-position`);
    this.hotCueControls = document.querySelector(`#deck-${deck.id}-hot-cue-controls`);
    this.hotCueButtons = [...this.hotCueControls.querySelectorAll("[data-hot-cue]")];
    this.hotCueClear = document.querySelector(`#deck-${deck.id}-hot-cues-clear`);
    this.hotCueStatus = document.querySelector(`#deck-${deck.id}-hot-cue-status`);
    this.beatJumpControls = document.querySelector(`#deck-${deck.id}-beat-jump-controls`);
    this.beatJumpButtons = [...this.beatJumpControls.querySelectorAll("[data-beat-jump]")];
    this.beatJumpStatus = document.querySelector(`#deck-${deck.id}-beat-jump-status`);

    this.bindEvents();
    this.refreshAvailability();
    this.updatePositionReadout();
  }

  bindEvents() {
    this.phaseSyncButton.addEventListener("click", () => this.phaseSync());

    for (const button of this.hotCueButtons) {
      button.addEventListener("click", () => {
        const slot = Number(button.dataset.hotCue);
        if (this.hotCues.has_cue(slot)) {
          this.jumpToHotCue(slot);
        } else {
          this.setHotCue(slot);
        }
      });
    }

    this.hotCueClear.addEventListener("click", () => {
      this.hotCues.clear_all();
      this.hotCueStatus.textContent = "Hot cues cleared";
      this.refreshHotCueButtons();
      this.deck.drawWaveform();
    });

    for (const button of this.beatJumpButtons) {
      button.addEventListener("click", () => this.beatJump(Number(button.dataset.beatJump)));
    }
  }

  reset() {
    this.hotCues.clear_all();
    this.hotCueStatus.textContent = "Beat grid required";
    this.beatJumpStatus.textContent = "Beat grid required";
    this.refreshAvailability();
    this.updatePositionReadout();
  }

  refreshAvailability() {
    const beatReady = this.deck.beats.length >= 2;
    const other = this.getOtherDeck();
    const phaseReady =
      beatReady &&
      this.deck.baseBpm !== null &&
      other?.baseBpm !== null &&
      other?.beats.length >= 2;

    this.phaseSyncButton.disabled = !phaseReady;
    for (const button of this.hotCueButtons) {
      button.disabled = !beatReady;
    }
    for (const button of this.beatJumpButtons) {
      button.disabled = !beatReady;
    }

    if (!beatReady) {
      this.hotCueStatus.textContent = "Beat grid required";
      this.beatJumpStatus.textContent = "Beat grid required";
    } else {
      if (!HOT_CUE_SLOTS.some((slot) => this.hotCues.has_cue(slot))) {
        this.hotCueStatus.textContent = "Tap an empty slot to set it on the nearest beat";
      }
      this.beatJumpStatus.textContent = "Preserves fractional beat phase";
    }

    this.refreshHotCueButtons();
    this.updatePositionReadout();
  }

  refreshHotCueButtons() {
    let cueCount = 0;
    for (const button of this.hotCueButtons) {
      const slot = Number(button.dataset.hotCue);
      const isSet = this.hotCues.has_cue(slot);
      button.classList.toggle("is-set", isSet);
      button.setAttribute("aria-pressed", String(isSet));
      if (isSet) {
        cueCount += 1;
        button.title = `Hot cue ${slot} at ${formatTimePrecise(this.hotCues.seconds(slot))}`;
      } else {
        button.title = `Set hot cue ${slot} on the nearest analyzed beat`;
      }
    }
    this.hotCueClear.disabled = cueCount === 0;
  }

  setHotCue(slot) {
    const duration = this.deck.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const set = this.hotCues.set_quantized(
      slot,
      this.deck.beats,
      this.deck.audio.currentTime,
      duration,
    );
    if (!set) {
      this.hotCueStatus.textContent = "No verified beat here to quantize the cue";
      return;
    }

    this.hotCueStatus.textContent = `Hot cue ${slot} · ${formatTimePrecise(this.hotCues.seconds(slot))}`;
    this.refreshHotCueButtons();
    this.deck.drawWaveform();
  }

  jumpToHotCue(slot) {
    if (!this.hotCues.has_cue(slot)) {
      return;
    }
    const seconds = this.hotCues.seconds(slot);
    this.seekTransportTarget(seconds);
    this.hotCueStatus.textContent = `Jumped to hot cue ${slot}`;
  }

  beatJump(delta) {
    const duration = this.deck.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const plan = plan_beat_jump(this.deck.beats, this.deck.audio.currentTime, delta, duration);
    try {
      if (!plan.valid()) {
        this.beatJumpStatus.textContent = "Jump would leave the verified beat grid";
        return;
      }

      this.seekTransportTarget(plan.target_seconds());
      this.beatJumpStatus.textContent = `${delta > 0 ? "+" : ""}${delta} beats`;
    } finally {
      plan.free();
    }
  }

  phaseSync() {
    const other = this.getOtherDeck();
    if (!other || this.deck.baseBpm === null || other.baseBpm === null) {
      return;
    }

    const duration = this.deck.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const plan = plan_phase_sync(
      this.deck.baseBpm,
      this.deck.beats,
      this.deck.downbeats,
      this.deck.audio.currentTime,
      duration,
      other.baseBpm,
      other.audio.playbackRate,
      other.beats,
      other.downbeats,
      other.audio.currentTime,
    );

    try {
      if (!plan.valid()) {
        this.deck.timingStatus.textContent = "Phase sync unavailable outside the verified beat grid";
        return;
      }

      this.deck.setPlaybackRate(plan.playback_rate());
      this.seekTransportTarget(plan.target_seconds());
      const alignment = plan.bar_aligned() ? "bar + beat phase" : "beat phase";
      this.deck.timingStatus.textContent = plan.limited()
        ? `Rate-limited ${alignment} match · will drift from ${plan.target_bpm().toFixed(1)} BPM`
        : `Phase synced to Deck ${other.id.toUpperCase()} · ${alignment}`;
    } finally {
      plan.free();
    }
  }

  seekTransportTarget(seconds) {
    if (!Number.isFinite(seconds)) {
      return;
    }

    if (
      this.deck.activeLoop &&
      (seconds < this.deck.activeLoop.start || seconds >= this.deck.activeLoop.end)
    ) {
      this.deck.disableLoop();
    }
    this.deck.audio.currentTime = Math.min(Math.max(0, seconds), this.deck.audio.duration || seconds);
    this.deck.updateProgress();
  }

  updatePositionReadout() {
    if (this.deck.beats.length < 2) {
      this.beatPosition.textContent = "Bar — · Beat — · Phase —";
      return;
    }

    const position = locate_beat_position(
      this.deck.beats,
      this.deck.downbeats,
      this.deck.audio.currentTime,
    );
    try {
      if (!position.valid()) {
        this.beatPosition.textContent = "Outside analyzed beat grid";
        return;
      }

      const phase = Math.round(position.phase() * 100);
      if (position.bar_index() > 0 && position.beat_in_bar() > 0) {
        this.beatPosition.textContent = `Bar ${position.bar_index()} · Beat ${position.beat_in_bar()}/4 · Phase ${phase}%`;
      } else {
        this.beatPosition.textContent = `Beat ${position.beat_index()} · Phase ${phase}%`;
      }
    } finally {
      position.free();
    }
  }

  drawMarkers(context, width, height, duration, accent) {
    if (!(duration > 0)) {
      return;
    }

    context.save();
    context.font = "600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const slot of HOT_CUE_SLOTS) {
      if (!this.hotCues.has_cue(slot)) {
        continue;
      }
      const seconds = this.hotCues.seconds(slot);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration) {
        continue;
      }
      const x = (seconds / duration) * width;
      context.strokeStyle = accent;
      context.globalAlpha = 0.9;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
      context.globalAlpha = 1;
      context.fillStyle = "rgba(10, 10, 12, 0.9)";
      context.fillRect(x - 8, 3, 16, 15);
      context.fillStyle = accent;
      context.fillText(String(slot), x, 5);
    }
    context.restore();
  }

  destroy() {
    this.hotCues.free();
  }
}

function formatTimePrecise(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00.0";
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${remainder}`;
}
