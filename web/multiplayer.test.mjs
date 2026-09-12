import assert from "node:assert/strict";
import test from "node:test";

import {
  DJ_PARTY_SESSION_PROTOCOL,
  MULTIPLAYER_CLIENT_MODULE_URL,
  MULTIPLAYER_CLIENT_SOURCE_COMMIT,
  DjPartyMultiplayerSession,
  isDjPartySessionHello,
  multiplayerApiFromLocation,
  multiplayerInviteUrl,
  normalizeLobbyCode,
  normalizeMultiplayerApiBase,
} from "./multiplayer.js";

if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, { detail } = {}) {
      super(type);
      this.detail = detail;
    }
  };
}

test("multiplayer browser client is pinned to an exact service commit", () => {
  assert.match(MULTIPLAYER_CLIENT_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.ok(MULTIPLAYER_CLIENT_MODULE_URL.includes(`@${MULTIPLAYER_CLIENT_SOURCE_COMMIT}/`));
  assert.ok(MULTIPLAYER_CLIENT_MODULE_URL.endsWith("/web/lobby-session.js"));
});

test("service URL normalization allows HTTPS and loopback HTTP only", () => {
  assert.equal(normalizeMultiplayerApiBase("https://multi.example.com/path"), "https://multi.example.com");
  assert.equal(normalizeMultiplayerApiBase("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeMultiplayerApiBase("http://example.com"), /must use HTTPS/);
  assert.throws(() => normalizeMultiplayerApiBase("https://user:pass@example.com"), /must not contain credentials/);
  assert.throws(() => normalizeMultiplayerApiBase("file:///tmp/service"), /HTTP or HTTPS/);
});

test("local pages default to the local service while hosted pages fail closed without configuration", () => {
  assert.equal(multiplayerApiFromLocation({ href: "http://127.0.0.1:5173/" }), "http://127.0.0.1:8787");
  assert.equal(multiplayerApiFromLocation({ href: "https://example.github.io/dj-party/" }), "");
  assert.equal(
    multiplayerApiFromLocation({ href: "https://example.github.io/dj-party/?api=https%3A%2F%2Fmulti.example.com" }),
    "https://multi.example.com",
  );
});

test("invite URLs carry only service and public lobby code state", () => {
  const invite = multiplayerInviteUrl("https://example.github.io/dj-party/?other=1#private-fragment", {
    apiBase: "https://multi.example.com",
    lobbyCode: "0123-abcd-efgh",
  });
  assert.equal(invite.searchParams.get("api"), "https://multi.example.com");
  assert.equal(invite.searchParams.get("lobby"), "0123-ABCD-EFGH");
  assert.equal(invite.searchParams.has("other"), false);
  assert.equal(invite.searchParams.has("token"), false);
  assert.equal(invite.hash, "");
  assert.deepEqual([...invite.searchParams.keys()].sort(), ["api", "lobby"]);
});

test("lobby code validation rejects path-like or arbitrary input", () => {
  assert.equal(normalizeLobbyCode(" 0123-abcd-efgh "), "0123-ABCD-EFGH");
  assert.throws(() => normalizeLobbyCode("../../room"), /only letters, numbers, and hyphens/);
  assert.throws(() => normalizeLobbyCode(" "), /Enter a lobby code/);
});

test("DJ Party hello is explicitly versioned", () => {
  assert.equal(
    isDjPartySessionHello({
      type: "dj-party/session-hello",
      protocol: DJ_PARTY_SESSION_PROTOCOL,
      application: "dj-party",
    }),
    true,
  );
  assert.equal(isDjPartySessionHello({ type: "dj-party/session-hello", protocol: 99, application: "dj-party" }), false);
  assert.equal(isDjPartySessionHello({ type: "mixer-state", protocol: DJ_PARTY_SESSION_PROTOCOL }), false);
});

test("session adapter delegates setup to the reusable service client without enabling content sharing", async () => {
  let created = null;
  const controller = new DjPartyMultiplayerSession({
    apiBase: "https://multi.example.com",
    loadClient: async () => ({
      LobbySession: class extends FakeLobbySession {
        constructor(options) {
          super(options);
          created = this;
        }
      },
    }),
  });

  const lobby = await controller.host(4);
  assert.equal(lobby.displayCode, "0123-ABCD-EFGH");
  assert.deepEqual(created.options, {
    apiBase: "https://multi.example.com",
    topology: "mesh",
    contentSharing: false,
  });
  assert.equal(controller.snapshot().state, "connected");

  created.ready.add("PEER0001");
  created.emit("peer-ready", { peerId: "PEER0001" });
  assert.deepEqual(created.sent, [
    {
      peerId: "PEER0001",
      data: {
        type: "dj-party/session-hello",
        protocol: DJ_PARTY_SESSION_PROTOCOL,
        application: "dj-party",
      },
    },
  ]);

  created.emit("reliable", {
    peerId: "PEER0001",
    data: { type: "dj-party/session-hello", protocol: DJ_PARTY_SESSION_PROTOCOL, application: "dj-party" },
  });
  assert.deepEqual(controller.snapshot().compatiblePeerIds, ["PEER0001"]);

  created.emit("reliable", { peerId: "PEER0002", data: { type: "mixer-state", value: 123 } });
  assert.deepEqual(controller.snapshot().compatiblePeerIds, ["PEER0001"]);

  controller.close();
  assert.equal(created.closed, true);
  assert.equal(controller.snapshot().state, "closed");
});

class FakeLobbySession extends EventTarget {
  constructor(options) {
    super();
    this.options = options;
    this.lobbyId = null;
    this.displayCode = null;
    this.participantId = null;
    this.hostParticipantId = null;
    this.maxParticipants = null;
    this.participants = new Set();
    this.ready = new Set();
    this.sent = [];
    this.closed = false;
  }

  async host(maxParticipants) {
    this.maxParticipants = maxParticipants;
    return this.#establish("HOST0001");
  }

  async join() {
    this.maxParticipants = 4;
    return this.#establish("GUEST001");
  }

  readyPeerIds() {
    return [...this.ready].sort();
  }

  sendReliable(peerId, data) {
    this.sent.push({ peerId, data });
  }

  close() {
    this.closed = true;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #establish(participantId) {
    this.lobbyId = "0123ABCDEFGH";
    this.displayCode = "0123-ABCD-EFGH";
    this.participantId = participantId;
    this.hostParticipantId = "HOST0001";
    this.participants.add(participantId);
    const lobby = {
      lobbyId: this.lobbyId,
      displayCode: this.displayCode,
      participantId,
      hostParticipantId: this.hostParticipantId,
      maxParticipants: this.maxParticipants,
    };
    this.emit("lobby", lobby);
    return lobby;
  }
}
