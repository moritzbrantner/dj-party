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
    loop: null,
  });
});

test("adapter rejects remote playback for a different track without treating local loops as a separate authority", () => {
  const mixer = new FakeMixerModule();
  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });
  adapter.trackContentIds.set("a", TRACK_A);

  assert.equal(adapter.canApplyDeckState("a", sharedState(TRACK_B)), false);
  mixer.states.a.loopActive = true;
  mixer.states.a.loop = { startSeconds: 10, endSeconds: 12, beatCount: 2 };
  assert.equal(adapter.canApplyDeckState("a", sharedState(TRACK_A)), true);
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

test("remote loop playback wraps projected host time while preserving mixer-owned local tempo", async () => {
  const mixer = new FakeMixerModule();
  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });
  adapter.trackContentIds.set("a", TRACK_A);

  const remote = sharedState(TRACK_A, {
    playing: true,
    positionSeconds: 11.9,
    playbackRate: 1,
    loop: { startSeconds: 10, endSeconds: 12, beatCount: 2 },
  });
  assert.equal(await adapter.applyDeckState("a", remote, { elapsedMs: 250 }), true);
  assert.ok(Math.abs(mixer.applied[0].state.positionSeconds - 10.15) < 1e-9);
  assert.deepEqual(mixer.applied[0].state.loop, remote.loop);
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

test("local loop activation and exit are submitted through the existing shared playback authority", async () => {
  const mixer = new FakeMixerModule();
  const coordinator = new FakeCoordinator();
  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator });
  adapter.trackContentIds.set("a", TRACK_A);

  await adapter.install();
  mixer.states.a.loopActive = true;
  mixer.states.a.loop = { startSeconds: 10, endSeconds: 12, beatCount: 2 };
  mixer.emit("a");
  assert.deepEqual(coordinator.submitted, [
    {
      deckId: "a",
      state: sharedState(TRACK_A, { loop: { startSeconds: 10, endSeconds: 12, beatCount: 2 } }),
    },
  ]);

  mixer.states.a.loopActive = false;
  mixer.states.a.loop = null;
  mixer.emit("a");
  assert.deepEqual(coordinator.submitted.at(-1), { deckId: "a", state: sharedState(TRACK_A) });
  assert.equal(coordinator.refreshes, 0);
  adapter.destroy();
});

function sharedState(trackContentId, overrides = {}) {
  return {
    trackContentId,
    playing: false,
    positionSeconds: 12,
    durationSeconds: 240,
    playbackRate: 1,
    loop: null,
    ...overrides,
  };
}

class FakeMixerModule {
  constructor() {
    this.states = {
      a: { playing: false, positionSeconds: 12, durationSeconds: 240, playbackRate: 1, loopActive: false, loop: null },
      b: { playing: false, positionSeconds: 0, durationSeconds: 180, playbackRate: 1, loopActive: false, loop: null },
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
    this.refreshes = 0;
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
    this.refreshes += 1;
    return true;
  }

  snapshot() {
    return { active: false, ready: false, role: null, canonicalSequence: 0, clockReady: false, blockedDeckIds: [] };
  }
}
