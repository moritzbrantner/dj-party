import { sharedPlaybackSession } from "./shared-playback.js";
import { trackContentIdForFile } from "./track-identity.js";

const DECK_IDS = ["a", "b"];

export async function installCollaborativePlayback(mixerModule, { coordinator = sharedPlaybackSession } = {}) {
  if (!mixerModule) {
    return null;
  }
  const adapter = new CollaborativePlaybackAdapter({ mixerModule, coordinator });
  await adapter.install();
  return adapter;
}

export class CollaborativePlaybackAdapter {
  constructor({ mixerModule, coordinator = sharedPlaybackSession } = {}) {
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
    if (!local || local.loopActive || !Number.isFinite(local.durationSeconds) || local.durationSeconds <= 0) {
      return false;
    }
    const tolerance = Math.max(0.25, state.durationSeconds * 0.001);
    return Math.abs(local.durationSeconds - state.durationSeconds) <= tolerance;
  }

  async applyDeckState(deckId, state, { elapsedMs = 0 } = {}) {
    if (!this.canApplyDeckState(deckId, state)) {
      return false;
    }
    this.applyingRemote.add(deckId);
    try {
      return await this.mixerModule.applyDeckTransport(deckId, state, { elapsedMs });
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
      const unsubscribe = this.mixerModule.subscribeDeckTransport(deckId, () => {
        if (this.applyingRemote.has(deckId)) {
          return;
        }
        const state = this.#sharedStateForDeck(deckId);
        if (state) {
          this.coordinator.submitLocalDeckState(deckId, state);
        }
        this.#renderStatus(this.coordinator.snapshot());
      });
      this.unsubscribers.push(unsubscribe);
    }
  }

  #bindTrackIdentity() {
    if (typeof document === "undefined") {
      return;
    }
    const signal = this.abortController.signal;
    for (const deckId of DECK_IDS) {
      const fileInput = document.querySelector(`#deck-${deckId}-file`);
      const dropZone = document.querySelector(`#deck-${deckId}-drop-zone`);
      fileInput?.addEventListener(
        "change",
        () => {
          const [file] = fileInput.files ?? [];
          if (file) {
            void this.#identifyTrack(deckId, file);
          }
        },
        { signal },
      );
      dropZone?.addEventListener(
        "drop",
        (event) => {
          const [file] = event.dataTransfer?.files ?? [];
          if (file) {
            void this.#identifyTrack(deckId, file);
          }
        },
        { signal },
      );
      const [initial] = fileInput?.files ?? [];
      if (initial) {
        void this.#identifyTrack(deckId, initial);
      }
    }
  }

  async #identifyTrack(deckId, file) {
    const generation = (this.trackGenerations.get(deckId) ?? 0) + 1;
    this.trackGenerations.set(deckId, generation);
    this.trackContentIds.set(deckId, null);
    this.coordinator.refreshLocalTracks();
    const contentId = await trackContentIdForFile(file);
    if (this.trackGenerations.get(deckId) !== generation) {
      return;
    }
    this.trackContentIds.set(deckId, contentId);
    this.coordinator.refreshLocalTracks();
    this.#renderStatus(this.coordinator.snapshot());
  }

  #sharedStateForDeck(deckId) {
    const trackContentId = this.trackContentIds.get(deckId);
    if (!trackContentId) {
      return null;
    }
    const local = this.mixerModule.captureDeckTransport(deckId);
    if (
      !local ||
      local.loopActive ||
      !Number.isFinite(local.positionSeconds) ||
      !Number.isFinite(local.durationSeconds) ||
      !Number.isFinite(local.playbackRate) ||
      local.durationSeconds <= 0
    ) {
      return null;
    }
    return {
      trackContentId,
      playing: Boolean(local.playing),
      positionSeconds: Math.min(Math.max(0, local.positionSeconds), local.durationSeconds),
      durationSeconds: local.durationSeconds,
      playbackRate: local.playbackRate,
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
    const localLoop = DECK_IDS.some((deckId) => this.mixerModule.captureDeckTransport(deckId)?.loopActive);
    if (localLoop) {
      this.status.textContent = "Shared playback paused while a local beat loop is active";
      return;
    }
    if (snapshot.blockedDeckIds?.length) {
      this.status.textContent = `Shared playback needs matching track on Deck ${snapshot.blockedDeckIds.join("/").toUpperCase()}`;
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

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
