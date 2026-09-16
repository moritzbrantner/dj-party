import { validatePerformanceAction } from "./performance-transport.js";
import { sharedPlaybackSession } from "./shared-playback.js";
import { trackContentIdForFile } from "./track-identity.js";

const DECK_IDS = ["a", "b"];
const AUDIO_FILE_PATTERN = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const METADATA_POLL_MS = 50;
const MAX_METADATA_POLLS = 400;

export function installCollaborativePlayback(mixerModule, { coordinator = sharedPlaybackSession } = {}) {
  if (!mixerModule) {
    return null;
  }
  const adapter = new CollaborativePlaybackAdapter({ mixerModule, coordinator });
  void adapter.install();
  return adapter;
}

export class CollaborativePlaybackAdapter {
  declare abortController: any;
  declare applyingRemote: any;
  declare coordinator: any;
  declare mixerModule: any;
  declare performanceSuppression: any;
  declare status: any;
  declare trackContentIds: any;
  declare trackGenerations: any;
  declare unregisterPlayback: any;
  declare unsubscribers: any;
  constructor({ mixerModule, coordinator = sharedPlaybackSession }: { mixerModule?: any; coordinator?: any } = {}) {
    if (
      !mixerModule ||
      typeof mixerModule.captureDeckTransport !== "function" ||
      typeof mixerModule.applyDeckTransport !== "function" ||
      typeof mixerModule.subscribeDeckTransport !== "function"
    ) {
      throw new Error("Mixer playback bridge is incomplete");
    }
    this.mixerModule = mixerModule;
    this.coordinator = coordinator;
    this.trackContentIds = new Map(DECK_IDS.map((deckId) => [deckId, null]));
    this.trackGenerations = new Map(DECK_IDS.map((deckId) => [deckId, 0]));
    this.applyingRemote = new Set();
    this.performanceSuppression = new Map();
    this.unsubscribers = [];
    this.unregisterPlayback = null;
    this.abortController = new AbortController();
    this.status = null;
  }

  async install() {
    await this.#waitForDecks();
    if (this.abortController.signal.aborted) {
      return this;
    }
    this.#bindTrackIdentity();
    this.#bindLocalTransport();
    this.unregisterPlayback = this.coordinator.registerPlayback(this);
    this.coordinator.addEventListener("change", (event) => this.#renderStatus(event.detail), {
      signal: this.abortController.signal,
    });
    this.#installStatus();
    this.#renderStatus(this.coordinator.snapshot());
    return this;
  }

  captureState() {
    return Object.fromEntries(DECK_IDS.map((deckId) => [deckId, this.#sharedStateForDeck(deckId)]));
  }

  canApplyDeckState(deckId, state) {
    if (!DECK_IDS.includes(deckId) || this.trackContentIds.get(deckId) !== state?.trackContentId) {
      return false;
    }
    const local = this.mixerModule.captureDeckTransport(deckId);
    if (!local || !Number.isFinite(local.durationSeconds) || local.durationSeconds <= 0) {
      return false;
    }
    const tolerance = Math.max(0.25, state.durationSeconds * 0.001);
    return Math.abs(local.durationSeconds - state.durationSeconds) <= tolerance;
  }

  async applyDeckState(deckId, state, { elapsedMs = 0 } = {}) {
    if (!this.canApplyDeckState(deckId, state)) {
      return false;
    }
    const local = this.mixerModule.captureDeckTransport(deckId);
    if (!local || !Number.isFinite(local.playbackRate)) {
      return false;
    }

    // Playback-rate/tempo remains mixer authority. The remote rate is timing metadata
    // used only to project the host playhead through network transit time.
    const projectedPosition = projectSharedPosition(state, elapsedMs);
    if (projectedPosition === null) {
      return false;
    }
    const localAuthorityState = {
      ...state,
      positionSeconds: Math.min(projectedPosition, state.durationSeconds),
      playbackRate: local.playbackRate,
    };

    this.applyingRemote.add(deckId);
    try {
      return await this.mixerModule.applyDeckTransport(deckId, localAuthorityState, { elapsedMs: 0 });
    } finally {
      await nextTask();
      this.applyingRemote.delete(deckId);
    }
  }

  canApplyPerformanceAction(deckId, value) {
    const action = validatePerformanceAction(value);
    if (!action || !DECK_IDS.includes(deckId) || this.trackContentIds.get(deckId) !== action.trackContentId) {
      return false;
    }
    const local = this.mixerModule.captureDeckTransport(deckId);
    if (!local || !Number.isFinite(local.durationSeconds) || local.durationSeconds <= 0) {
      return false;
    }
    return action.kind !== "seek" || action.positionSeconds <= local.durationSeconds;
  }

  async applyPerformanceAction(deckId, value) {
    const action = validatePerformanceAction(value);
    if (
      !action ||
      !this.canApplyPerformanceAction(deckId, action) ||
      typeof this.mixerModule.applyDeckPerformanceAction !== "function"
    ) {
      return false;
    }

    this.applyingRemote.add(deckId);
    try {
      return (await this.mixerModule.applyDeckPerformanceAction(deckId, action)) === true;
    } finally {
      await nextTask();
      this.applyingRemote.delete(deckId);
    }
  }

  destroy() {
    this.abortController.abort();
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.unregisterPlayback?.();
    this.unregisterPlayback = null;
  }

  #bindLocalTransport() {
    for (const deckId of DECK_IDS) {
      const unsubscribe = this.mixerModule.subscribeDeckTransport(deckId, () => this.#localTransportChanged(deckId));
      this.unsubscribers.push(unsubscribe);
      if (typeof this.mixerModule.subscribeDeckPerformanceTransport === "function") {
        const unsubscribePerformance = this.mixerModule.subscribeDeckPerformanceTransport(deckId, (action) =>
          this.#localPerformanceChanged(deckId, action),
        );
        this.unsubscribers.push(unsubscribePerformance);
      }

      if (typeof document !== "undefined") {
        const signal = this.abortController.signal;
        for (const control of document.querySelectorAll(`#deck-${deckId}-loop-controls [data-loop-beats], #deck-${deckId}-loop-off`)) {
          control.addEventListener("click", () => this.#localTransportChanged(deckId), { signal });
        }
      }
    }
  }

  #localTransportChanged(deckId) {
    if (this.applyingRemote.has(deckId)) {
      return;
    }
    const state = this.#sharedStateForDeck(deckId);
    if (state) {
      const suppressed = this.performanceSuppression.get(deckId);
      this.performanceSuppression.delete(deckId);
      if (!suppressed || !sameSharedState(suppressed, state)) {
        this.coordinator.submitLocalDeckState(deckId, state);
      }
    }
    this.#renderStatus(this.coordinator.snapshot());
  }

  #localPerformanceChanged(deckId, value) {
    if (this.applyingRemote.has(deckId)) {
      return;
    }
    const trackContentId = this.trackContentIds.get(deckId);
    const state = this.#sharedStateForDeck(deckId);
    const action = validatePerformanceAction({ ...value, trackContentId });
    if (!state || !action || typeof this.coordinator.submitLocalPerformanceAction !== "function") {
      return;
    }
    const submitted = this.coordinator.submitLocalPerformanceAction(deckId, action) === true;
    if (submitted) {
      this.performanceSuppression.set(deckId, state);
    }
    this.#renderStatus(this.coordinator.snapshot());
  }

  #bindTrackIdentity() {
    if (typeof document === "undefined") {
      return;
    }
    const signal = this.abortController.signal;
    for (const deckId of DECK_IDS) {
      const fileInput = document.querySelector<HTMLInputElement>(`#deck-${deckId}-file`);
      const dropZone = document.querySelector(`#deck-${deckId}-drop-zone`);
      fileInput?.addEventListener(
        "change",
        () => {
          const [file] = fileInput.files ?? [];
          if (looksLikeAudio(file)) {
            void this.#identifyTrack(deckId, file);
          }
        },
        { signal, capture: true },
      );
      dropZone?.addEventListener(
        "drop",
        (event) => {
          const [file] = event.dataTransfer?.files ?? [];
          if (looksLikeAudio(file)) {
            void this.#identifyTrack(deckId, file);
          }
        },
        { signal, capture: true },
      );
      const [initial] = fileInput?.files ?? [];
      if (looksLikeAudio(initial)) {
        void this.#identifyTrack(deckId, initial);
      }
    }
  }

  async #identifyTrack(deckId, file) {
    const generation = (this.trackGenerations.get(deckId) ?? 0) + 1;
    this.trackGenerations.set(deckId, generation);
    // Clear synchronously in the capture phase so any pause/seek events emitted by
    // the existing deck loader cannot be attributed to the previous track.
    this.trackContentIds.set(deckId, null);
    this.performanceSuppression.delete(deckId);
    this.coordinator.refreshLocalTracks();

    const contentId = await trackContentIdForFile(file);
    if (this.trackGenerations.get(deckId) !== generation) {
      return;
    }
    if (!contentId) {
      this.coordinator.refreshLocalTracks();
      return;
    }

    this.trackContentIds.set(deckId, contentId);
    const ready = await this.#waitForTrackMetadata(deckId, generation);
    if (this.trackGenerations.get(deckId) !== generation) {
      return;
    }
    if (!ready) {
      this.trackContentIds.set(deckId, null);
    }
    this.coordinator.refreshLocalTracks();
    this.#renderStatus(this.coordinator.snapshot());
  }

  async #waitForTrackMetadata(deckId, generation) {
    for (let attempt = 0; attempt < MAX_METADATA_POLLS && !this.abortController.signal.aborted; attempt += 1) {
      if (this.trackGenerations.get(deckId) !== generation) {
        return false;
      }
      const local = this.mixerModule.captureDeckTransport(deckId);
      if (Number.isFinite(local?.durationSeconds) && local.durationSeconds > 0) {
        return true;
      }
      await delay(METADATA_POLL_MS);
    }
    return false;
  }

  #sharedStateForDeck(deckId) {
    const trackContentId = this.trackContentIds.get(deckId);
    if (!trackContentId) {
      return null;
    }
    const local = this.mixerModule.captureDeckTransport(deckId);
    if (
      !local ||
      !Number.isFinite(local.positionSeconds) ||
      !Number.isFinite(local.durationSeconds) ||
      !Number.isFinite(local.playbackRate) ||
      local.durationSeconds <= 0
    ) {
      return null;
    }
    const loop = local.loopActive ? local.loop : null;
    if (local.loopActive && !loop) {
      return null;
    }
    return {
      trackContentId,
      playing: Boolean(local.playing),
      positionSeconds: Math.min(Math.max(0, local.positionSeconds), local.durationSeconds),
      durationSeconds: local.durationSeconds,
      playbackRate: local.playbackRate,
      loop,
    };
  }

  async #waitForDecks() {
    while (!this.abortController.signal.aborted) {
      if (DECK_IDS.every((deckId) => this.mixerModule.captureDeckTransport(deckId))) {
        return true;
      }
      await nextFrame();
    }
    return false;
  }

  #installStatus() {
    if (typeof document === "undefined") {
      return;
    }
    const live = document.querySelector(".multiplayer-live");
    if (!live || document.querySelector("#shared-playback-status")) {
      this.status = document.querySelector("#shared-playback-status");
      return;
    }
    const output = document.createElement("output");
    output.id = "shared-playback-status";
    output.className = "multiplayer-peer-status";
    output.setAttribute("aria-live", "polite");
    output.textContent = "Shared playback inactive";
    live.append(output);
    this.status = output;
  }

  #renderStatus(snapshot) {
    if (!this.status) {
      return;
    }
    if (!snapshot?.active) {
      this.status.textContent = "Shared playback inactive";
      return;
    }
    if (snapshot.blockedDeckIds?.length) {
      this.status.textContent = `Shared playback needs matching track and beat grid on Deck ${snapshot.blockedDeckIds.join("/").toUpperCase()}`;
      return;
    }
    if (snapshot.role === "guest" && !snapshot.clockReady) {
      this.status.textContent = "Shared playback measuring host clock";
      return;
    }
    this.status.textContent = snapshot.ready
      ? `Shared playback aligned · sequence ${snapshot.canonicalSequence}`
      : "Shared playback waiting for host state";
  }
}

function sameSharedState(left, right) {
  if (!left || !right) {
    return false;
  }
  const sameLoop =
    left.loop === right.loop ||
    (left.loop &&
      right.loop &&
      left.loop.beatCount === right.loop.beatCount &&
      Math.abs(left.loop.startSeconds - right.loop.startSeconds) < 1e-6 &&
      Math.abs(left.loop.endSeconds - right.loop.endSeconds) < 1e-6);
  return (
    left.trackContentId === right.trackContentId &&
    left.playing === right.playing &&
    Math.abs(left.positionSeconds - right.positionSeconds) < 0.1 &&
    Math.abs(left.durationSeconds - right.durationSeconds) < 1e-6 &&
    Math.abs(left.playbackRate - right.playbackRate) < 1e-6 &&
    Boolean(sameLoop)
  );
}

function projectSharedPosition(state, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 10_000) {
    return null;
  }
  if (!state.playing) {
    return state.positionSeconds;
  }
  const advanced = state.positionSeconds + (elapsedMs / 1000) * state.playbackRate;
  if (!state.loop) {
    return Math.min(advanced, state.durationSeconds);
  }
  const span = state.loop.endSeconds - state.loop.startSeconds;
  if (!Number.isFinite(span) || span <= 0) {
    return null;
  }
  const offset = ((advanced - state.loop.startSeconds) % span + span) % span;
  return state.loop.startSeconds + offset;
}

function looksLikeAudio(file) {
  return Boolean(file && (String(file.type ?? "").startsWith("audio/") || AUDIO_FILE_PATTERN.test(String(file.name ?? ""))));
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function nextTask() {
  return delay(0);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
