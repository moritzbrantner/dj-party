import assert from "node:assert/strict";
import test from "node:test";

import { CollaborativePlaybackAdapter } from "./collaborative-playback.js";
import { SHARED_PLAYBACK_PROTOCOL, SharedPlaybackCoordinator } from "./shared-playback.js";

if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, { detail } = {}) {
      super(type);
      this.detail = detail;
    }
  };
}

const TRACK = "a".repeat(64);

function deckState(positionSeconds = 12) {
  return {
    trackContentId: TRACK,
    playing: false,
    positionSeconds,
    durationSeconds: 240,
    playbackRate: 1,
    loop: null,
  };
}

test("host replays guest beat-jump intent before broadcasting canonical playback", async () => {
  const transport = new FakeTransport();
  const playback = new FakePlayback();
  const coordinator = new SharedPlaybackCoordinator();
  coordinator.registerPlayback(playback);
  coordinator.attachTransport(transport);

  transport.application("GUEST", {
    type: "dj-party/playback/performance-request",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    requestSequence: 1,
    deckId: "a",
    action: { trackContentId: TRACK, kind: "beat-jump", delta: 4, originPositionSeconds: 12 },
  });
  await tick();

  assert.deepEqual(playback.actions, [{ deckId: "a", action: { trackContentId: TRACK, kind: "beat-jump", delta: 4, originPositionSeconds: 12 } }]);
  assert.equal(transport.broadcasts.length, 1);
  assert.equal(transport.broadcasts[0].type, "dj-party/playback/command");
  assert.equal(transport.broadcasts[0].state.positionSeconds, 16);

  transport.application("GUEST", {
    type: "dj-party/playback/performance-request",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    requestSequence: 1,
    deckId: "a",
    action: { trackContentId: TRACK, kind: "beat-jump", delta: 8, originPositionSeconds: 12 },
  });
  await tick();
  assert.equal(playback.actions.length, 1);
});

test("collaborative adapter submits one semantic action and suppresses its duplicate seek state", async () => {
  const mixer = new FakeMixer();
  const coordinator = new FakeCoordinator();
  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator });
  adapter.trackContentIds.set("a", TRACK);
  await adapter.install();

  mixer.states.a.positionSeconds = 20;
  mixer.emitPerformance("a", { kind: "beat-jump", delta: 4, originPositionSeconds: 20 });
  mixer.emitTransport("a");

  assert.deepEqual(coordinator.performance, [
    { deckId: "a", action: { trackContentId: TRACK, kind: "beat-jump", delta: 4, originPositionSeconds: 20 } },
  ]);
  assert.deepEqual(coordinator.states, []);
  adapter.destroy();
});

test("remote semantic actions require the exact local track and use the mixer bridge", async () => {
  const mixer = new FakeMixer();
  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });
  adapter.trackContentIds.set("a", TRACK);

  assert.equal(
    await adapter.applyPerformanceAction("a", { trackContentId: TRACK, kind: "seek", source: "cue", positionSeconds: 33 }),
    true,
  );
  assert.deepEqual(mixer.appliedPerformance, [
    { deckId: "a", action: { trackContentId: TRACK, kind: "seek", source: "cue", positionSeconds: 33 } },
  ]);
  assert.equal(
    await adapter.applyPerformanceAction("a", { trackContentId: "b".repeat(64), kind: "beat-jump", delta: 4 }),
    false,
  );
});

class FakeTransport extends EventTarget {
  constructor() {
    super();
    this.sent = [];
    this.broadcasts = [];
  }

  snapshot() {
    return { state: "connected", participantId: "HOST", hostParticipantId: "HOST", compatiblePeerIds: ["GUEST"] };
  }

  sendApplicationReliable(peerId, data) {
    this.sent.push({ peerId, data });
  }

  broadcastApplicationReliable(data) {
    this.broadcasts.push(data);
    return 1;
  }

  application(peerId, data) {
    this.dispatchEvent(new CustomEvent("application-message", { detail: { peerId, data } }));
  }
}

class FakePlayback {
  constructor() {
    this.state = deckState();
    this.actions = [];
  }

  captureState() {
    return { a: { ...this.state }, b: null };
  }

  canApplyDeckState(deckId, state) {
    return deckId === "a" && state.trackContentId === TRACK;
  }

  async applyDeckState() {
    return true;
  }

  canApplyPerformanceAction(deckId, action) {
    return deckId === "a" && action.trackContentId === TRACK;
  }

  async applyPerformanceAction(deckId, action) {
    this.actions.push({ deckId, action });
    if (action.kind === "beat-jump") this.state.positionSeconds = action.originPositionSeconds + action.delta;
    if (action.kind === "seek") this.state.positionSeconds = action.positionSeconds;
    return true;
  }
}

class FakeMixer {
  constructor() {
    this.states = {
      a: { playing: false, positionSeconds: 12, durationSeconds: 240, playbackRate: 1, loopActive: false, loop: null },
      b: { playing: false, positionSeconds: 0, durationSeconds: 180, playbackRate: 1, loopActive: false, loop: null },
    };
    this.transportListeners = { a: new Set(), b: new Set() };
    this.performanceListeners = { a: new Set(), b: new Set() };
    this.appliedPerformance = [];
  }

  captureDeckTransport(deckId) {
    return { ...this.states[deckId] };
  }

  subscribeDeckTransport(deckId, listener) {
    this.transportListeners[deckId].add(listener);
    return () => this.transportListeners[deckId].delete(listener);
  }

  subscribeDeckPerformanceTransport(deckId, listener) {
    this.performanceListeners[deckId].add(listener);
    return () => this.performanceListeners[deckId].delete(listener);
  }

  async applyDeckTransport() {
    return true;
  }

  async applyDeckPerformanceAction(deckId, action) {
    this.appliedPerformance.push({ deckId, action });
    return true;
  }

  emitTransport(deckId) {
    for (const listener of this.transportListeners[deckId]) listener(this.captureDeckTransport(deckId));
  }

  emitPerformance(deckId, action) {
    for (const listener of this.performanceListeners[deckId]) listener(action);
  }
}

class FakeCoordinator extends EventTarget {
  constructor() {
    super();
    this.states = [];
    this.performance = [];
  }

  registerPlayback() {
    return () => {};
  }

  submitLocalDeckState(deckId, state) {
    this.states.push({ deckId, state });
    return true;
  }

  submitLocalPerformanceAction(deckId, action) {
    this.performance.push({ deckId, action });
    return true;
  }

  refreshLocalTracks() {
    return true;
  }

  snapshot() {
    return { active: false, ready: false, role: null, canonicalSequence: 0, clockReady: false, blockedDeckIds: [] };
  }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
