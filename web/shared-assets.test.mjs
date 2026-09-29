import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TRACK_ASSET_BYTES,
  SHARED_ASSET_PROTOCOL,
  TRACK_ASSET_CLEAR_TYPE,
  TRACK_ASSET_OFFER_TYPE,
  SharedAssetTransferCoordinator,
  buildTrackAssetOffer,
  validateTrackAssetOfferMessage,
} from "./shared-assets.js";

if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, { detail } = {}) {
      super(type);
      this.detail = detail;
    }
  };
}

if (typeof globalThis.File !== "function") {
  globalThis.File = class File extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = name;
      this.lastModified = options.lastModified ?? 0;
    }
  };
}

const HELLO_WORLD_SHA = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

test("track offers derive a content-addressed one-file manifest with chunk verification", async () => {
  const bytes = new TextEncoder().encode("hello world");
  const file = fakeFile(bytes, { name: "hello.mp3", type: "audio/mpeg", lastModified: 123 });

  const offer = await buildTrackAssetOffer(file, "a");

  assert.equal(offer.sha256, HELLO_WORLD_SHA);
  assert.equal(offer.path, `tracks/${HELLO_WORLD_SHA}.mp3`);
  assert.equal(offer.bytes, bytes.byteLength);
  assert.equal(offer.manifest.protocol, "multiplayer-content-manifest-v1");
  assert.deepEqual(offer.manifest.game, { id: "dj-party", version: "shared-track-v1" });
  assert.deepEqual(offer.manifest.files, [
    {
      path: offer.path,
      bytes: bytes.byteLength,
      sha256: HELLO_WORLD_SHA,
      role: "asset",
      chunks: {
        bytes: 60 * 1024,
        sha256: [HELLO_WORLD_SHA],
      },
    },
  ]);
});

test("track offer validation rejects metadata that is not bound to the verified manifest", async () => {
  const bytes = new TextEncoder().encode("hello world");
  const prepared = await buildTrackAssetOffer(fakeFile(bytes), "b");
  const message = offerMessage(prepared, 4);

  assert.deepEqual(validateTrackAssetOfferMessage(message)?.sha256, HELLO_WORLD_SHA);
  assert.equal(validateTrackAssetOfferMessage({ ...message, bytes: bytes.byteLength + 1 }), null);
  assert.equal(
    validateTrackAssetOfferMessage({
      ...message,
      manifest: {
        ...message.manifest,
        files: [{ ...message.manifest.files[0], sha256: "a".repeat(64) }],
      },
    }),
    null,
  );
  assert.equal(validateTrackAssetOfferMessage({ ...message, name: "../hello.mp3" }), null);
});

test("oversized tracks fail before their bytes are materialized", async () => {
  let read = false;
  const file = {
    name: "too-large.wav",
    type: "audio/wav",
    size: MAX_TRACK_ASSET_BYTES + 1,
    lastModified: 0,
    async arrayBuffer() {
      read = true;
      return new ArrayBuffer(0);
    },
  };

  await assert.rejects(buildTrackAssetOffer(file, "a"), /limited to 64 MB/);
  assert.equal(read, false);
});

test("host sharing is explicit and providers refuse unverified peers", async () => {
  const bytes = new TextEncoder().encode("hello world");
  const file = fakeFile(bytes);
  const transport = new FakeTransport({
    participantId: "HOST",
    hostParticipantId: "HOST",
    compatiblePeerIds: ["GUEST"],
    contentPeerIds: ["GUEST"],
  });
  const coordinator = new SharedAssetTransferCoordinator();
  coordinator.attachTransport(transport);

  assert.equal(transport.broadcasted.length, 0);
  await coordinator.offerTrack(file, "a");

  assert.equal(transport.broadcasted.length, 1);
  assert.equal(transport.broadcasted[0].type, TRACK_ASSET_OFFER_TYPE);
  assert.equal(transport.created.length, 1);
  const provider = transport.created[0].provider;
  assert.equal(await provider({ peerId: "UNVERIFIED" }), null);
  assert.equal(await provider({ peerId: "GUEST" }), file);

  coordinator.stopOffering();
  assert.equal(transport.broadcasted.at(-1).type, TRACK_ASSET_CLEAR_TYPE);
  coordinator.detachTransport();
});

test("guests accept offers only from the verified host and request bytes only after explicit action", async () => {
  const bytes = new TextEncoder().encode("hello world");
  const prepared = await buildTrackAssetOffer(fakeFile(bytes), "b");
  const transport = new FakeTransport({
    participantId: "GUEST",
    hostParticipantId: "HOST",
    compatiblePeerIds: ["HOST", "OTHER"],
    contentPeerIds: ["HOST"],
  });
  transport.requestBytes = bytes;
  const coordinator = new SharedAssetTransferCoordinator();
  coordinator.attachTransport(transport);

  transport.emitApplication("OTHER", offerMessage(prepared, 1));
  assert.equal(coordinator.snapshot().offer, null);
  assert.equal(transport.created.length, 0);

  transport.emitApplication("HOST", offerMessage(prepared, 1));
  assert.equal(coordinator.snapshot().offer?.deckId, "b");
  assert.equal(transport.created.length, 0);

  const file = await coordinator.requestOfferedTrack();
  assert.equal(transport.created.length, 1);
  assert.deepEqual(transport.created[0].requests, [{ peerId: "HOST", path: prepared.path }]);
  assert.equal(file.name, prepared.name);
  assert.equal(file.size, bytes.byteLength);
  assert.equal(new Uint8Array(await file.arrayBuffer()).join(","), bytes.join(","));
  coordinator.detachTransport();
});

test("guest readiness drops immediately when DJ Party peer verification is lost", async () => {
  const bytes = new TextEncoder().encode("hello world");
  const prepared = await buildTrackAssetOffer(fakeFile(bytes), "a");
  const transport = new FakeTransport({
    participantId: "GUEST",
    hostParticipantId: "HOST",
    compatiblePeerIds: ["HOST"],
    contentPeerIds: ["HOST"],
  });
  transport.requestBytes = bytes;
  const coordinator = new SharedAssetTransferCoordinator();
  coordinator.attachTransport(transport);

  transport.emitApplication("HOST", offerMessage(prepared, 1));
  assert.equal(coordinator.snapshot().contentReady, true);

  transport.current.compatiblePeerIds = [];
  transport.dispatchEvent(new CustomEvent("change", { detail: transport.snapshot() }));

  assert.equal(coordinator.snapshot().contentReady, false);
  await assert.rejects(coordinator.requestOfferedTrack(), /not a verified DJ Party peer/);
  coordinator.detachTransport();
});

test("stale clears cannot remove a newer host offer", async () => {
  const bytes = new TextEncoder().encode("hello world");
  const prepared = await buildTrackAssetOffer(fakeFile(bytes), "a");
  const transport = new FakeTransport({
    participantId: "GUEST",
    hostParticipantId: "HOST",
    compatiblePeerIds: ["HOST"],
    contentPeerIds: ["HOST"],
  });
  const coordinator = new SharedAssetTransferCoordinator();
  coordinator.attachTransport(transport);

  transport.emitApplication("HOST", offerMessage(prepared, 3));
  transport.emitApplication("HOST", {
    type: TRACK_ASSET_CLEAR_TYPE,
    protocol: SHARED_ASSET_PROTOCOL,
    revision: 2,
  });

  assert.equal(coordinator.snapshot().offer?.revision, 3);
  coordinator.detachTransport();
});

function fakeFile(bytes, { name = "hello.mp3", type = "audio/mpeg", lastModified = 10 } = {}) {
  const copy = bytes.slice();
  return {
    name,
    type,
    size: copy.byteLength,
    lastModified,
    async arrayBuffer() {
      return copy.slice().buffer;
    },
  };
}

function offerMessage(prepared, revision) {
  return {
    type: TRACK_ASSET_OFFER_TYPE,
    protocol: SHARED_ASSET_PROTOCOL,
    revision,
    deckId: prepared.deckId,
    name: prepared.name,
    mediaType: prepared.type,
    bytes: prepared.bytes,
    lastModified: prepared.lastModified,
    sha256: prepared.sha256,
    path: prepared.path,
    manifest: prepared.manifest,
  };
}

class FakeTransport extends EventTarget {
  constructor({
    participantId,
    hostParticipantId,
    compatiblePeerIds = [],
    contentPeerIds = [],
  }) {
    super();
    this.current = {
      state: "connected",
      participantId,
      hostParticipantId,
      compatiblePeerIds: [...compatiblePeerIds],
      contentPeerIds: [...contentPeerIds],
      contentTransferAvailable: true,
    };
    this.broadcasted = [];
    this.sent = [];
    this.created = [];
    this.requestBytes = null;
  }

  snapshot() {
    return {
      ...this.current,
      compatiblePeerIds: [...this.current.compatiblePeerIds],
      contentPeerIds: [...this.current.contentPeerIds],
    };
  }

  sendApplicationReliable(peerId, data) {
    if (!this.current.compatiblePeerIds.includes(peerId)) {
      throw new Error("peer is not verified");
    }
    this.sent.push({ peerId, data });
  }

  broadcastApplicationReliable(data) {
    this.broadcasted.push(data);
    return this.current.compatiblePeerIds.length;
  }

  createGameFiles(manifest) {
    const files = new FakeGameFiles(manifest, () => this.requestBytes);
    this.created.push(files);
    return files;
  }

  emitApplication(peerId, data) {
    this.dispatchEvent(new CustomEvent("application-message", { detail: { peerId, data } }));
  }
}

class FakeGameFiles extends EventTarget {
  constructor(manifest, bytes) {
    super();
    this.manifest = manifest;
    this.bytes = bytes;
    this.provider = null;
    this.requests = [];
    this.closed = false;
  }

  provide(_path, provider) {
    this.provider = provider;
    return () => {
      if (this.provider === provider) this.provider = null;
    };
  }

  async requestFile(peerId, path) {
    this.requests.push({ peerId, path });
    return this.bytes();
  }

  close() {
    this.closed = true;
  }
}
