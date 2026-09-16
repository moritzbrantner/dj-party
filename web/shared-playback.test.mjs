import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_PLAYBACK_PROTOCOL,
  SharedPlaybackCoordinator,
  calculateClockSample,
  validateDeckPlaybackState,
} from "./shared-playback.js";

if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, { detail } = {}) {
      super(type);
      this.detail = detail;
    }
  };
}

const TRACK_A = "a".repeat(64);
const TRACK_B = "b".repeat(64);

function deckState(trackContentId = TRACK_A, overrides = {}) {
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

function snapshotState() {
  return { a: deckState(), b: null };
}

test("playback state is bounded and requires exact content identity", () => {
  assert.deepEqual(validateDeckPlaybackState(deckState()), deckState());
  assert.equal(validateDeckPlaybackState(deckState("A".repeat(64))), null);
  assert.equal(validateDeckPlaybackState(deckState(TRACK_A, { playbackRate: 1.5 })), null);
  assert.equal(validateDeckPlaybackState(deckState(TRACK_A, { positionSeconds: 241 })), null);
  assert.deepEqual(
    validateDeckPlaybackState(
      deckState(TRACK_A, { loop: { startSeconds: 12, endSeconds: 14, beatCount: 2 } }),
    ),
    deckState(TRACK_A, { loop: { startSeconds: 12, endSeconds: 14, beatCount: 2 } }),
  );
  assert.equal(
    validateDeckPlaybackState(deckState(TRACK_A, { loop: { startSeconds: 12, endSeconds: 14, beatCount: 3 } })),
    null,
  );
  assert.equal(
    validateDeckPlaybackState(deckState(TRACK_A, { loop: { startSeconds: 12, endSeconds: 241, beatCount: 2 } })),
    null,
  );
});

test("clock sample uses NTP-style midpoint offset and rejects excessive RTT", () => {
  assert.deepEqual(
    calculateClockSample({ guestSentAtMs: 1000, hostReceivedAtMs: 1110, hostSentAtMs: 1112, guestReceivedAtMs: 1022 }),
    { rttMs: 20, offsetMs: 100 },
  );
  assert.equal(
    calculateClockSample({ guestSentAtMs: 1000, hostReceivedAtMs: 9000, hostSentAtMs: 9000, guestReceivedAtMs: 7001 }),
    null,
  );
});

test("host sequences local playback state without sending track bytes", () => {
  let now = 5000;
  const transport = new FakeTransport({ participantId: "HOST", hostParticipantId: "HOST", compatiblePeerIds: ["GUEST"] });
  const coordinator = new SharedPlaybackCoordinator({ now: () => now });
  coordinator.registerPlayback(new FakePlayback({ a: TRACK_A }));
  coordinator.attachTransport(transport);

  assert.equal(
    coordinator.submitLocalDeckState(
      "a",
      deckState(TRACK_A, { playing: true, loop: { startSeconds: 12, endSeconds: 14, beatCount: 2 } }),
    ),
    true,
  );
  assert.deepEqual(transport.broadcasts, [
    {
      type: "dj-party/playback/command",
      protocol: SHARED_PLAYBACK_PROTOCOL,
      sequence: 1,
      hostTimeMs: 5000,
      deckId: "a",
      state: deckState(TRACK_A, { playing: true, loop: { startSeconds: 12, endSeconds: 14, beatCount: 2 } }),
    },
  ]);
  assert.equal(JSON.stringify(transport.broadcasts).includes("content"), false);
});

test("guest requires clock samples before requesting the host snapshot", () => {
  let now = 1000;
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: ["HOST"] });
  const coordinator = new SharedPlaybackCoordinator({ now: () => now, clockSampleTarget: 2 });
  coordinator.registerPlayback(new FakePlayback({ a: TRACK_A }));
  coordinator.attachTransport(transport);

  assert.equal(transport.sent[0].data.type, "dj-party/playback/clock-request");
  const first = transport.sent[0].data;
  now = 1020;
  transport.application("HOST", {
    type: "dj-party/playback/clock-response",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    requestId: first.requestId,
    guestSentAtMs: first.guestSentAtMs,
    hostReceivedAtMs: 1110,
    hostSentAtMs: 1110,
  });

  assert.equal(transport.sent[1].data.type, "dj-party/playback/clock-request");
  const second = transport.sent[1].data;
  now = 1040;
  transport.application("HOST", {
    type: "dj-party/playback/clock-response",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    requestId: second.requestId,
    guestSentAtMs: second.guestSentAtMs,
    hostReceivedAtMs: 1130,
    hostSentAtMs: 1130,
  });

  assert.equal(coordinator.snapshot().clockReady, true);
  assert.equal(transport.sent[2].data.type, "dj-party/playback/snapshot-request");
});

test("guest applies host playback using clock-compensated elapsed time", async () => {
  let now = 1000;
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: ["HOST"] });
  const playback = new FakePlayback({ a: TRACK_A });
  const coordinator = new SharedPlaybackCoordinator({ now: () => now, clockSampleTarget: 1 });
  coordinator.registerPlayback(playback);
  coordinator.attachTransport(transport);

  const clock = transport.sent[0].data;
  now = 1020;
  transport.application("HOST", {
    type: "dj-party/playback/clock-response",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    requestId: clock.requestId,
    guestSentAtMs: clock.guestSentAtMs,
    hostReceivedAtMs: 1110,
    hostSentAtMs: 1110,
  });
  now = 1040;
  transport.application("HOST", {
    type: "dj-party/playback/snapshot",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    sequence: 0,
    hostTimeMs: 1120,
    state: snapshotState(),
  });
  await tick();
  assert.equal(coordinator.snapshot().ready, true);

  now = 1100;
  transport.application("HOST", {
    type: "dj-party/playback/command",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    sequence: 1,
    hostTimeMs: 1160,
    deckId: "a",
    state: deckState(TRACK_A, { playing: true, positionSeconds: 20 }),
  });
  await tick();

  assert.equal(playback.applied.at(-1).deckId, "a");
  assert.equal(playback.applied.at(-1).context.source, "canonical");
  assert.equal(playback.applied.at(-1).context.elapsedMs, 40);
});

test("track mismatch blocks canonical playback until a fresh matching snapshot", async () => {
  let now = 1000;
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: ["HOST"] });
  const playback = new FakePlayback({ a: TRACK_B });
  const coordinator = new SharedPlaybackCoordinator({ now: () => now, clockSampleTarget: 1 });
  coordinator.registerPlayback(playback);
  coordinator.attachTransport(transport);

  const clock = transport.sent[0].data;
  now = 1020;
  transport.application("HOST", {
    type: "dj-party/playback/clock-response",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    requestId: clock.requestId,
    guestSentAtMs: clock.guestSentAtMs,
    hostReceivedAtMs: 1110,
    hostSentAtMs: 1110,
  });
  now = 1030;
  transport.application("HOST", {
    type: "dj-party/playback/snapshot",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    sequence: 0,
    hostTimeMs: 1120,
    state: snapshotState(),
  });
  await tick();

  assert.equal(coordinator.snapshot().ready, false);
  assert.deepEqual(coordinator.snapshot().blockedDeckIds, ["a"]);
  assert.deepEqual(playback.applied, []);

  playback.trackIds.a = TRACK_A;
  coordinator.refreshLocalTracks();
  assert.equal(transport.sent.at(-1).data.type, "dj-party/playback/snapshot-request");
});

test("canonical sequence gaps fail closed and request reconciliation", async () => {
  let now = 1000;
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: ["HOST"] });
  const playback = new FakePlayback({ a: TRACK_A });
  const coordinator = new SharedPlaybackCoordinator({ now: () => now, clockSampleTarget: 1 });
  coordinator.registerPlayback(playback);
  coordinator.attachTransport(transport);

  const clock = transport.sent[0].data;
  now = 1020;
  transport.application("HOST", {
    type: "dj-party/playback/clock-response",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    requestId: clock.requestId,
    guestSentAtMs: clock.guestSentAtMs,
    hostReceivedAtMs: 1110,
    hostSentAtMs: 1110,
  });
  now = 1030;
  transport.application("HOST", {
    type: "dj-party/playback/snapshot",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    sequence: 1,
    hostTimeMs: 1120,
    state: snapshotState(),
  });
  await tick();
  transport.sent.length = 0;

  now = 1040;
  transport.application("HOST", {
    type: "dj-party/playback/command",
    protocol: SHARED_PLAYBACK_PROTOCOL,
    sequence: 3,
    hostTimeMs: 1130,
    deckId: "a",
    state: deckState(TRACK_A, { positionSeconds: 30 }),
  });
  await tick();

  assert.equal(coordinator.snapshot().ready, false);
  assert.equal(transport.sent[0].data.type, "dj-party/playback/snapshot-request");
});

class FakeTransport extends EventTarget {
  constructor({ participantId, hostParticipantId, compatiblePeerIds }) {
    super();
    this.current = { state: "connected", participantId, hostParticipantId, compatiblePeerIds: [...compatiblePeerIds] };
    this.sent = [];
    this.broadcasts = [];
  }

  snapshot() {
    return { ...this.current, compatiblePeerIds: [...this.current.compatiblePeerIds] };
  }

  sendApplicationReliable(peerId, data) {
    this.sent.push({ peerId, data });
  }

  broadcastApplicationReliable(data) {
    this.broadcasts.push(data);
    return this.current.compatiblePeerIds.length;
  }

  application(peerId, data) {
    this.dispatchEvent(new CustomEvent("application-message", { detail: { peerId, data } }));
  }
}

class FakePlayback {
  constructor(trackIds) {
    this.trackIds = { a: trackIds.a ?? null, b: trackIds.b ?? null };
    this.applied = [];
  }

  captureState() {
    return {
      a: this.trackIds.a ? deckState(this.trackIds.a) : null,
      b: this.trackIds.b ? deckState(this.trackIds.b) : null,
    };
  }

  canApplyDeckState(deckId, state) {
    return this.trackIds[deckId] === state.trackContentId;
  }

  async applyDeckState(deckId, state, context) {
    if (!this.canApplyDeckState(deckId, state)) {
      return false;
    }
    this.applied.push({ deckId, state, context });
    return true;
  }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
