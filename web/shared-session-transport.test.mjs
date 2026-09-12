import assert from "node:assert/strict";
import test from "node:test";

import { sharedSession } from "./shared-session.js";
import { installSharedSessionTransport, MultiplayerSharedTransport } from "./shared-session-transport.js";

if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, { detail } = {}) {
      super(type);
      this.detail = detail;
    }
  };
}

test("shared transport attaches and detaches through explicit controller lifecycle events", () => {
  const ui = new EventTarget();
  const installed = installSharedSessionTransport(ui);
  const controller = new FakeController();

  ui.dispatchEvent(new CustomEvent("controller-ready", { detail: { controller } }));
  assert.equal(sharedSession.snapshot().active, true);
  assert.equal(sharedSession.snapshot().role, "host");

  ui.dispatchEvent(new CustomEvent("controller-closed", { detail: { controller } }));
  assert.equal(sharedSession.snapshot().active, false);
  installed.close();
});

test("bridge forwards only messages from verified DJ Party peers", () => {
  const controller = new FakeController();
  const bridge = new MultiplayerSharedTransport(controller);
  const received = [];
  bridge.addEventListener("application-message", (event) => received.push(event.detail));

  controller.session.emitReliable("UNVERIFIED", { type: "anything" });
  controller.compatiblePeers.add("VERIFIED");
  controller.dispatchEvent(new CustomEvent("change", { detail: controller.snapshot() }));
  controller.session.emitReliable("VERIFIED", { type: "shared" });

  assert.deepEqual(received, [{ peerId: "VERIFIED", data: { type: "shared" } }]);
});

test("bridge exposes compatible peers and delegates reliable sends", () => {
  const controller = new FakeController();
  controller.compatiblePeers.add("B");
  controller.compatiblePeers.add("A");
  const bridge = new MultiplayerSharedTransport(controller);
  const compatible = [];
  bridge.addEventListener("peer-compatible", (event) => compatible.push(event.detail.peerId));
  bridge.emitInitialCompatiblePeers();

  bridge.broadcastApplicationReliable({ value: 1 });
  assert.deepEqual(controller.session.sent, [
    { peerId: "A", data: { value: 1 } },
    { peerId: "B", data: { value: 1 } },
  ]);
  assert.throws(() => bridge.sendApplicationReliable("X", {}), /not a verified DJ Party peer/);
  assert.deepEqual(compatible, ["A", "B"]);
});

class FakeController extends EventTarget {
  constructor() {
    super();
    this.compatiblePeers = new Set();
    this.session = new FakeSession();
    this.state = {
      state: "connected",
      participantId: "HOST",
      hostParticipantId: "HOST",
      compatiblePeerIds: [],
    };
  }

  snapshot() {
    return {
      ...this.state,
      compatiblePeerIds: [...this.compatiblePeers].sort(),
    };
  }
}

class FakeSession extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }

  sendReliable(peerId, data) {
    this.sent.push({ peerId, data });
  }

  emitReliable(peerId, data) {
    this.dispatchEvent(new CustomEvent("reliable", { detail: { peerId, data } }));
  }
}
