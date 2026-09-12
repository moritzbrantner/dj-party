import assert from "node:assert/strict";
import test from "node:test";

import {
  DJ_PARTY_SESSION_PROTOCOL,
  MULTIPLAYER_CLIENT_MODULE_URL,
  MULTIPLAYER_CLIENT_SOURCE_COMMIT,
  MULTIPLAYER_TURN_MODULE_URL,
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

test("multiplayer browser helpers are pinned to one exact service commit", () => {
  assert.match(MULTIPLAYER_CLIENT_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.ok(MULTIPLAYER_CLIENT_MODULE_URL.includes(`@${MULTIPLAYER_CLIENT_SOURCE_COMMIT}/`));
  assert.ok(MULTIPLAYER_TURN_MODULE_URL.includes(`@${MULTIPLAYER_CLIENT_SOURCE_COMMIT}/`));
  assert.ok(MULTIPLAYER_CLIENT_MODULE_URL.endsWith("/web/lobby-session.js"));
  assert.ok(MULTIPLAYER_TURN_MODULE_URL.endsWith("/web/turn-credentials.js"));
});

test("service URL normalization allows HTTPS and local HTTP only on HTTP pages", () => {
  assert.equal(normalizeMultiplayerApiBase("https://multi.example.com/path"), "https://multi.example.com");
  assert.equal(
    normalizeMultiplayerApiBase("http://127.0.0.1:8787", { pageProtocol: "http:" }),
    "http://127.0.0.1:8787",
  );
  assert.throws(() => normalizeMultiplayerApiBase("http://example.com", { pageProtocol: "http:" }), /must use HTTPS/);
  assert.throws(
    () => normalizeMultiplayerApiBase("http://127.0.0.1:8787", { pageProtocol: "https:" }),
    /cannot use an HTTP multiplayer service/,
  );
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
  assert.equal(
    multiplayerApiFromLocation({ href: "https://example.github.io/dj-party/?api=http%3A%2F%2F127.0.0.1%3A8787" }),
    "",
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

test("session adapter delegates setup and TURN fallback to reusable service helpers", async () => {
  let created = null;
  let turnSession = null;
  const controller = new DjPartyMultiplayerSession({
    apiBase: "https://multi.example.com",
    loadClient: async () => ({
      LobbySession: class extends FakeLobbySession {
        constructor(options) {
          super(options);
          created = this;
        }
      },
      refreshTurnIceServers: async (session) => {
        turnSession = session;
        return { iceServers: [{ urls: ["turns:turn.example.com"] }], expiresAt: Date.now() + 60_000 };
      },
    }),
  });

  const lobby = await controller.host(4);
  await Promise.resolve();
  assert.equal(lobby.displayCode, "0123-ABCD-EFGH");
  assert.deepEqual(created.options, {
    apiBase: "https://multi.example.com",
    topology: "mesh",
    contentSharing: false,
  });
  assert.equal(turnSession, created);
  assert.equal(controller.snapshot().state, "connected");
  assert.equal(controller.snapshot().turnAvailable, true);

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

test("TURN credential failure keeps an established direct session usable", async () => {
  const controller = new DjPartyMultiplayerSession({
    apiBase: "https://multi.example.com",
    loadClient: async () => ({
      LobbySession: FakeLobbySession,
      refreshTurnIceServers: async () => {
        throw new Error("TURN is not configured");
      },
    }),
  });

  await controller.host(2);
  await Promise.resolve();
  assert.equal(controller.snapshot().state, "connected");
  assert.equal(controller.snapshot().turnAvailable, false);
  controller.close();
});

test("closing during client loading cancels setup before a service session is created", async () => {
  let resolveClient;
  let constructed = 0;
  const loading = new Promise((resolve) => {
    resolveClient = resolve;
  });
  const controller = new DjPartyMultiplayerSession({
    apiBase: "https://multi.example.com",
    loadClient: () => loading,
  });

  const hosting = controller.host(2);
  controller.close();
  resolveClient({
    LobbySession: class extends FakeLobbySession {
      constructor(options) {
        super(options);
        constructed += 1;
      }
    },
  });

  await assert.rejects(hosting, /setup was cancelled/);
  assert.equal(constructed, 0);
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
