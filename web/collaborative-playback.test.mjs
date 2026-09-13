import assert from "node:assert/strict";
import test from "node:test";

import { CollaborativePlaybackAdapter } from "./collaborative-playback.js";

const TRACK_A = "a".repeat(64);
const TRACK_B = "b".repeat(64);

if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, { detail } = {}) {
      super(type);
      this.detail = detail;
    }
  };
}

test("adapter exposes exact local transport only after track identity is known", () => {
  const mixer = new FakeMixerModule();
  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });

  assert.deepEqual(adapter.captureState(), { a: null, b: null });
  adapter.trackContentIds.set("a", TRACK_A);

  assert.deepEqual(adapter.captureState().a, {
    trackContentId: TRACK_A,
    playing: false,
    positionSeconds: 12,
    durationSeconds: 240,
    playbackRate: 1,
  });
});

test("adapter rejects remote playback for a different track or active local loop", () => {
  const mixer = new FakeMixerModule();
  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });
  adapter.trackContentIds.set("a", TRACK_A);

  assert.equal(adapter.canApplyDeckState("a", sharedState(TRACK_B)), false);
  mixer.states.a.loopActive = true;
  assert.equal(adapter.canApplyDeckState("a", sharedState(TRACK_A)), false);
});

test("remote playback projects host time while preserving mixer-owned local tempo", async () => {
  const mixer = new FakeMixerModule();
  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });
  adapter.trackContentIds.set("a", TRACK_A);

  const remote = sharedState(TRACK_A, { playing: true, playbackRate: 1.08 });
  assert.equal(await adapter.applyDeckState("a", remote, { elapsedMs: 125 }), true);
  assert.deepEqual(mixer.applied, [
    {
      deckId: "a",
      state: {
        ...remote,
        positionSeconds: 12.135,
        playbackRate: 1,
      },
      options: { elapsedMs: 0 },
    },
  ]);
});

test("local mixer transport events become shared deck-state submissions", async () => {
  const mixer = new FakeMixerModule();
  const coordinator = new FakeCoordinator();
  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator });
  adapter.trackContentIds.set("a", TRACK_A);

  await adapter.install();
  mixer.emit("a");

  assert.deepEqual(coordinator.submitted, [
    {
      deckId: "a",
      state: sharedState(TRACK_A),
    },
  ]);
  adapter.destroy();
});

function sharedState(trackContentId, overrides = {}) {
  return {
    trackContentId,
    playing: false,
    positionSeconds: 12,
    durationSeconds: 240,
    playbackRate: 1,
    ...overrides,
  };
}

class FakeMixerModule {
  constructor() {
    this.states = {
      a: { playing: false, positionSeconds: 12, durationSeconds: 240, playbackRate: 1, loopActive: false },
      b: { playing: false, positionSeconds: 0, durationSeconds: 180, playbackRate: 1, loopActive: false },
    };
    this.listeners = { a: new Set(), b: new Set() };
    this.applied = [];
  }

  captureDeckTransport(deckId) {
    return { ...this.states[deckId] };
  }

  subscribeDeckTransport(deckId, listener) {
    this.listeners[deckId].add(listener);
    return () => this.listeners[deckId].delete(listener);
  }

  async applyDeckTransport(deckId, state, options) {
    this.applied.push({ deckId, state, options });
    return true;
  }

  emit(deckId) {
    for (const listener of this.listeners[deckId]) {
      listener(this.captureDeckTransport(deckId));
    }
  }
}

class FakeCoordinator extends EventTarget {
  constructor() {
    super();
    this.submitted = [];
    this.adapter = null;
  }

  registerPlayback(adapter) {
    this.adapter = adapter;
    return () => {
      if (this.adapter === adapter) this.adapter = null;
    };
  }

  submitLocalDeckState(deckId, state) {
    this.submitted.push({ deckId, state });
    return true;
  }

  refreshLocalTracks() {
    return true;
  }

  snapshot() {
    return { active: false, ready: false, role: null, canonicalSequence: 0, clockReady: false, blockedDeckIds: [] };
  }
}
