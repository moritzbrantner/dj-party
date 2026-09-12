import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_SESSION_PROTOCOL,
  SharedSessionCoordinator,
  validateSharedCommand,
  validateSharedState,
} from "./shared-session.js";

if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, { detail } = {}) {
      super(type);
      this.detail = detail;
    }
  };
}

test("shared commands fail closed outside deterministic mixer bounds", () => {
  assert.deepEqual(validateSharedCommand({ kind: "crossfader", position: 0.5 }), {
    kind: "crossfader",
    position: 0.5,
  });
  assert.deepEqual(validateSharedCommand({ kind: "tone", deck: "b", tone: tone() }), {
    kind: "tone",
    deck: "b",
    tone: tone(),
  });
  assert.equal(validateSharedCommand({ kind: "tempo", deck: "a", percent: 20 }), null);
  assert.equal(validateSharedCommand({ kind: "crossfader", position: "0.5" }), null);
  assert.equal(validateSharedCommand({ kind: "transport", deck: "a", action: "play" }), null);
  assert.equal(validateSharedCommand({ kind: "tone", deck: "x", tone: tone() }), null);
});

test("shared snapshots require complete bounded mixer state", () => {
  assert.deepEqual(validateSharedState(sharedState()), sharedState());
  const invalid = sharedState();
  invalid.decks.a.tone.filter = 101;
  assert.equal(validateSharedState(invalid), null);
  const coerced = sharedState();
  coerced.crossfader = "0";
  assert.equal(validateSharedState(coerced), null);
});

test("host sequences local commands and sends a canonical stream", () => {
  const transport = new FakeTransport({ participantId: "HOST", hostParticipantId: "HOST", compatiblePeerIds: ["GUEST"] });
  const mixer = new FakeMixer();
  const coordinator = new SharedSessionCoordinator();
  coordinator.registerMixer(mixer);
  coordinator.attachTransport(transport);

  assert.equal(coordinator.submitLocalCommand({ kind: "crossfader", position: 0.25 }), true);
  assert.equal(mixer.commands.length, 0, "local host UI has already applied the command");
  assert.deepEqual(transport.broadcasts, [
    {
      type: "dj-party/shared/command",
      protocol: SHARED_SESSION_PROTOCOL,
      sequence: 1,
      command: { kind: "crossfader", position: 0.25 },
    },
  ]);
  assert.equal(coordinator.snapshot().canonicalSequence, 1);
});

test("guest requests are host-sequenced and duplicate request numbers are ignored", () => {
  const transport = new FakeTransport({ participantId: "HOST", hostParticipantId: "HOST", compatiblePeerIds: ["GUEST"] });
  const mixer = new FakeMixer();
  const coordinator = new SharedSessionCoordinator();
  coordinator.registerMixer(mixer);
  coordinator.attachTransport(transport);

  const request = {
    type: "dj-party/shared/request",
    protocol: SHARED_SESSION_PROTOCOL,
    requestSequence: 1,
    command: { kind: "deck-level", deck: "b", level: 0.4 },
  };
  transport.application("GUEST", request);
  transport.application("GUEST", request);

  assert.deepEqual(mixer.commands, [{ kind: "deck-level", deck: "b", level: 0.4 }]);
  assert.equal(transport.broadcasts.length, 1);
  assert.equal(transport.broadcasts[0].sequence, 1);
});

test("guest accepts canonical commands only from the host and in increasing order", () => {
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: ["HOST"] });
  const mixer = new FakeMixer();
  const coordinator = new SharedSessionCoordinator();
  coordinator.registerMixer(mixer);
  coordinator.attachTransport(transport);
  transport.sent.length = 0;

  const canonical = {
    type: "dj-party/shared/command",
    protocol: SHARED_SESSION_PROTOCOL,
    sequence: 2,
    command: { kind: "tempo", deck: "a", percent: -4.5 },
  };
  transport.application("OTHER", canonical);
  transport.application("HOST", canonical);
  transport.application("HOST", canonical);

  assert.deepEqual(mixer.commands, [{ kind: "tempo", deck: "a", percent: -4.5 }]);
  assert.equal(coordinator.snapshot().canonicalSequence, 2);
  assert.equal(coordinator.snapshot().ready, false, "a canonical delta alone is not a full state convergence proof");
});

test("guest local changes become requests after requesting the host snapshot", () => {
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: ["HOST"] });
  const coordinator = new SharedSessionCoordinator();
  coordinator.registerMixer(new FakeMixer());
  coordinator.attachTransport(transport);

  assert.deepEqual(transport.sent[0], {
    peerId: "HOST",
    data: { type: "dj-party/shared/snapshot-request", protocol: SHARED_SESSION_PROTOCOL },
  });
  assert.equal(coordinator.submitLocalCommand({ kind: "key-lock", deck: "a", enabled: false }), true);
  assert.deepEqual(transport.sent[1], {
    peerId: "HOST",
    data: {
      type: "dj-party/shared/request",
      protocol: SHARED_SESSION_PROTOCOL,
      requestSequence: 1,
      command: { kind: "key-lock", deck: "a", enabled: false },
    },
  });
});

test("guest cannot submit until the host is a verified peer", () => {
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: [] });
  const coordinator = new SharedSessionCoordinator();
  coordinator.registerMixer(new FakeMixer());
  coordinator.attachTransport(transport);

  assert.equal(coordinator.submitLocalCommand({ kind: "crossfader", position: 0.2 }), false);
  assert.deepEqual(transport.sent, []);
});

test("guest requests canonical state when its mixer registers after transport setup", () => {
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: ["HOST"] });
  const coordinator = new SharedSessionCoordinator();
  coordinator.attachTransport(transport);
  assert.deepEqual(transport.sent, []);

  coordinator.registerMixer(new FakeMixer());
  assert.deepEqual(transport.sent, [
    {
      peerId: "HOST",
      data: { type: "dj-party/shared/snapshot-request", protocol: SHARED_SESSION_PROTOCOL },
    },
  ]);

  transport.changed();
  assert.equal(transport.sent.length, 1, "only one snapshot request may be outstanding");
});

test("host answers snapshot requests and sends snapshots to newly compatible peers", () => {
  const transport = new FakeTransport({ participantId: "HOST", hostParticipantId: "HOST", compatiblePeerIds: [] });
  const mixer = new FakeMixer();
  const coordinator = new SharedSessionCoordinator();
  coordinator.registerMixer(mixer);
  coordinator.attachTransport(transport);
  coordinator.submitLocalCommand({ kind: "crossfader", position: -0.5 });

  transport.compatible("GUEST");
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].data.type, "dj-party/shared/snapshot");
  assert.equal(transport.sent[0].data.sequence, 1);

  transport.application("GUEST", {
    type: "dj-party/shared/snapshot-request",
    protocol: SHARED_SESSION_PROTOCOL,
  });
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.sent[1].peerId, "GUEST");
  assert.deepEqual(transport.sent[1].data.state, sharedState());
});

test("guest applies host snapshots, becomes ready, and rejects stale snapshots", () => {
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: ["HOST"] });
  const mixer = new FakeMixer();
  const coordinator = new SharedSessionCoordinator();
  coordinator.registerMixer(mixer);
  coordinator.attachTransport(transport);

  transport.application("HOST", {
    type: "dj-party/shared/snapshot",
    protocol: SHARED_SESSION_PROTOCOL,
    sequence: 3,
    state: sharedState(),
  });
  transport.application("HOST", {
    type: "dj-party/shared/snapshot",
    protocol: SHARED_SESSION_PROTOCOL,
    sequence: 2,
    state: sharedState(),
  });

  assert.equal(mixer.snapshots.length, 1);
  assert.equal(coordinator.snapshot().canonicalSequence, 3);
  assert.equal(coordinator.snapshot().ready, true);
});

test("guest requires a fresh snapshot after host compatibility is lost and restored", () => {
  const transport = new FakeTransport({ participantId: "GUEST", hostParticipantId: "HOST", compatiblePeerIds: ["HOST"] });
  const coordinator = new SharedSessionCoordinator();
  coordinator.registerMixer(new FakeMixer());
  coordinator.attachTransport(transport);
  transport.application("HOST", {
    type: "dj-party/shared/snapshot",
    protocol: SHARED_SESSION_PROTOCOL,
    sequence: 0,
    state: sharedState(),
  });
  assert.equal(coordinator.snapshot().ready, true);

  transport.current.compatiblePeerIds = [];
  transport.changed();
  assert.equal(coordinator.snapshot().ready, false);
  transport.compatible("HOST");
  assert.equal(transport.sent.at(-1).data.type, "dj-party/shared/snapshot-request");
});

class FakeTransport extends EventTarget {
  constructor({ participantId, hostParticipantId, compatiblePeerIds }) {
    super();
    this.current = {
      state: "connected",
      participantId,
      hostParticipantId,
      compatiblePeerIds: [...compatiblePeerIds],
    };
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
  }

  compatible(peerId) {
    if (!this.current.compatiblePeerIds.includes(peerId)) {
      this.current.compatiblePeerIds.push(peerId);
    }
    this.dispatchEvent(new CustomEvent("peer-compatible", { detail: { peerId } }));
  }

  changed() {
    this.dispatchEvent(new CustomEvent("change", { detail: this.snapshot() }));
  }

  application(peerId, data) {
    this.dispatchEvent(new CustomEvent("application-message", { detail: { peerId, data } }));
  }
}

class FakeMixer {
  constructor() {
    this.commands = [];
    this.snapshots = [];
  }

  captureState() {
    return sharedState();
  }

  applyCommand(command) {
    this.commands.push(command);
  }

  applySnapshot(snapshot) {
    this.snapshots.push(snapshot);
  }
}

function tone() {
  return { low: 0, mid: 0, high: 0, filter: 0 };
}

function deckState() {
  return {
    level: 1,
    tempoPercent: 0,
    keyLock: true,
    tone: tone(),
  };
}

function sharedState() {
  return {
    crossfader: 0,
    decks: { a: deckState(), b: deckState() },
  };
}
