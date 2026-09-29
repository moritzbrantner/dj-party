import { trackContentIdForBytes } from "./track-identity.js";

export const SHARED_ASSET_PROTOCOL = 1;
export const TRACK_ASSET_OFFER_TYPE = "dj-party/track-asset-offer";
export const TRACK_ASSET_CLEAR_TYPE = "dj-party/track-asset-clear";
export const TRACK_ASSET_MANIFEST_PROTOCOL = "multiplayer-content-manifest-v1";
export const TRACK_ASSET_MANIFEST_VERSION = "shared-track-v1";
export const TRACK_ASSET_CHUNK_BYTES = 60 * 1024;
export const MAX_TRACK_ASSET_BYTES = 64 * 1024 * 1024;

const DECK_IDS = new Set(["a", "b"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PATH_PATTERN = /^tracks\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/;
const AUDIO_TYPE_PATTERN = /^audio\/[a-z0-9!#$&^_.+~-]+$/i;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 100;

export async function buildTrackAssetOffer(file, deckId, cryptoImpl = globalThis.crypto) {
  if (!DECK_IDS.has(deckId)) {
    throw new Error("Shared track must come from Deck A or Deck B");
  }
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("A local audio file is required");
  }

  const bytes = Number(file.size);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("Shared track must contain audio bytes");
  }
  if (bytes > MAX_TRACK_ASSET_BYTES) {
    throw new Error("Shared tracks are limited to 64 MB");
  }

  const name = requireSafeFileName(file.name);
  const encoded = new Uint8Array(await file.arrayBuffer());
  if (encoded.byteLength !== bytes) {
    throw new Error("Track bytes changed while preparing the shared asset");
  }

  const sha256 = await trackContentIdForBytes(encoded, cryptoImpl);
  if (!sha256) {
    throw new Error("SHA-256 is unavailable for track verification");
  }

  const chunkHashes = [];
  for (let offset = 0; offset < encoded.byteLength; offset += TRACK_ASSET_CHUNK_BYTES) {
    const hash = await trackContentIdForBytes(
      encoded.subarray(offset, Math.min(offset + TRACK_ASSET_CHUNK_BYTES, encoded.byteLength)),
      cryptoImpl,
    );
    if (!hash) {
      throw new Error("SHA-256 is unavailable for track chunk verification");
    }
    chunkHashes.push(hash);
  }

  const extension = safeExtension(name);
  const path = `tracks/${sha256}.${extension}`;
  const type = normalizedAudioType(file.type);
  const lastModified =
    Number.isSafeInteger(Number(file.lastModified)) && Number(file.lastModified) >= 0 ? Number(file.lastModified) : 0;
  const manifest = {
    protocol: TRACK_ASSET_MANIFEST_PROTOCOL,
    game: {
      id: "dj-party",
      version: TRACK_ASSET_MANIFEST_VERSION,
    },
    files: [
      {
        path,
        bytes,
        sha256,
        role: "asset",
        chunks: {
          bytes: TRACK_ASSET_CHUNK_BYTES,
          sha256: chunkHashes,
        },
      },
    ],
  };

  return {
    deckId,
    name,
    type,
    bytes,
    lastModified,
    sha256,
    path,
    manifest,
  };
}

export function validateTrackAssetOfferMessage(value) {
  if (!isObject(value) || value.type !== TRACK_ASSET_OFFER_TYPE || value.protocol !== SHARED_ASSET_PROTOCOL) {
    return null;
  }

  const revision = positiveSafeInteger(value.revision);
  if (
    revision === null ||
    !DECK_IDS.has(value.deckId) ||
    typeof value.name !== "string" ||
    value.name !== safeFileNameOrNull(value.name) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > MAX_TRACK_ASSET_BYTES ||
    !Number.isSafeInteger(value.lastModified) ||
    value.lastModified < 0 ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    typeof value.path !== "string" ||
    !PATH_PATTERN.test(value.path) ||
    !value.path.startsWith(`tracks/${value.sha256}.`) ||
    typeof value.mediaType !== "string" ||
    value.mediaType !== normalizedAudioType(value.mediaType)
  ) {
    return null;
  }

  const manifest = normalizeManifest(value.manifest, {
    path: value.path,
    bytes: value.bytes,
    sha256: value.sha256,
  });
  if (!manifest) {
    return null;
  }

  return {
    revision,
    deckId: value.deckId,
    name: value.name,
    type: value.mediaType,
    bytes: value.bytes,
    lastModified: value.lastModified,
    sha256: value.sha256,
    path: value.path,
    manifest,
  };
}

export function validateTrackAssetClearMessage(value) {
  if (!isObject(value) || value.type !== TRACK_ASSET_CLEAR_TYPE || value.protocol !== SHARED_ASSET_PROTOCOL) {
    return null;
  }
  const revision = positiveSafeInteger(value.revision);
  return revision === null ? null : { revision };
}

export class SharedAssetTransferCoordinator extends EventTarget {
  declare busy: any;
  declare gameFiles: any;
  declare gameFilesAbort: any;
  declare lastError: any;
  declare localOffer: any;
  declare localRevision: any;
  declare progress: any;
  declare remoteOffer: any;
  declare remoteRevision: any;
  declare transport: any;
  declare transportAbort: any;

  constructor() {
    super();
    this.transport = null;
    this.transportAbort = null;
    this.gameFiles = null;
    this.gameFilesAbort = null;
    this.localOffer = null;
    this.remoteOffer = null;
    this.localRevision = 0;
    this.remoteRevision = 0;
    this.busy = false;
    this.progress = null;
    this.lastError = null;
  }

  attachTransport(transport) {
    this.detachTransport();
    if (
      !transport ||
      typeof transport.snapshot !== "function" ||
      typeof transport.sendApplicationReliable !== "function" ||
      typeof transport.broadcastApplicationReliable !== "function" ||
      typeof transport.createGameFiles !== "function"
    ) {
      throw new Error("Shared asset transport is incomplete");
    }

    this.transport = transport;
    this.transportAbort = new AbortController();
    const signal = this.transportAbort.signal;
    transport.addEventListener("application-message", (event) => this.#applicationMessage(event.detail), { signal });
    transport.addEventListener("peer-compatible", (event) => this.#peerCompatible(event.detail?.peerId), { signal });
    transport.addEventListener("change", () => this.#transportChanged(), { signal });
    this.#transportChanged();
  }

  detachTransport() {
    this.transportAbort?.abort();
    this.transportAbort = null;
    this.#closeGameFiles();
    this.transport = null;
    this.localOffer = null;
    this.remoteOffer = null;
    this.remoteRevision = 0;
    this.busy = false;
    this.progress = null;
    this.lastError = null;
    this.#emitChange();
  }

  snapshot() {
    const network = this.transport?.snapshot?.() ?? null;
    const participantId = typeof network?.participantId === "string" ? network.participantId : null;
    const hostParticipantId = typeof network?.hostParticipantId === "string" ? network.hostParticipantId : null;
    const role = participantId && hostParticipantId ? (participantId === hostParticipantId ? "host" : "guest") : null;
    const active = Boolean(network?.state === "connected" && participantId && hostParticipantId);
    const hostCompatible =
      role === "guest" &&
      typeof hostParticipantId === "string" &&
      Array.isArray(network?.compatiblePeerIds) &&
      network.compatiblePeerIds.includes(hostParticipantId);
    const hostContentReady =
      hostCompatible &&
      Array.isArray(network?.contentPeerIds) &&
      network.contentPeerIds.includes(hostParticipantId);

    return {
      active,
      role,
      participantId,
      hostParticipantId,
      transferAvailable: Boolean(active && network?.contentTransferAvailable === true),
      contentReady: role === "host" ? Boolean(active && network?.contentTransferAvailable) : Boolean(hostContentReady),
      offer: publicOffer(role === "host" ? this.localOffer : this.remoteOffer),
      busy: this.busy,
      progress: this.progress ? { ...this.progress } : null,
      error: this.lastError,
    };
  }

  async offerTrack(file, deckId) {
    const networkBefore = this.#requireHost();
    const initiatingTransport = this.transport;
    const initiatingParticipantId = networkBefore.participantId;
    const initiatingHostParticipantId = networkBefore.hostParticipantId;
    if (networkBefore.contentTransferAvailable !== true) {
      throw new Error("Verified track transfer is unavailable in this multiplayer client");
    }

    this.busy = true;
    this.progress = null;
    this.lastError = null;
    this.#emitChange();

    try {
      const prepared = await buildTrackAssetOffer(file, deckId);
      if (this.transport !== initiatingTransport) {
        throw new Error("Multiplayer session changed while preparing the shared track");
      }
      const networkAfter = initiatingTransport.snapshot();
      if (
        networkAfter?.state !== "connected" ||
        networkAfter?.participantId !== initiatingParticipantId ||
        networkAfter?.hostParticipantId !== initiatingHostParticipantId ||
        initiatingParticipantId !== initiatingHostParticipantId
      ) {
        throw new Error("Multiplayer session changed while preparing the shared track");
      }

      this.#closeGameFiles();
      const gameFiles = initiatingTransport.createGameFiles(prepared.manifest);
      const revision = this.localRevision + 1;
      this.localRevision = revision;
      this.localOffer = { ...prepared, revision };
      this.gameFiles = gameFiles;
      this.#observeGameFiles(gameFiles);

      gameFiles.provide(prepared.path, ({ peerId }) => {
        const current = this.transport?.snapshot?.();
        const stillOffered =
          this.localOffer?.revision === revision &&
          this.transport === initiatingTransport &&
          this.localOffer?.sha256 === prepared.sha256 &&
          current?.state === "connected" &&
          current?.participantId === current?.hostParticipantId;
        return stillOffered && current?.compatiblePeerIds?.includes(peerId) ? file : null;
      });

      initiatingTransport.broadcastApplicationReliable(networkOffer(this.localOffer));
      return publicOffer(this.localOffer);
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    } finally {
      this.busy = false;
      this.#emitChange();
    }
  }

  stopOffering() {
    this.#requireHost();
    this.localRevision += 1;
    this.#closeGameFiles();
    this.localOffer = null;
    this.lastError = null;
    this.transport.broadcastApplicationReliable({
      type: TRACK_ASSET_CLEAR_TYPE,
      protocol: SHARED_ASSET_PROTOCOL,
      revision: this.localRevision,
    });
    this.#emitChange();
  }

  async requestOfferedTrack() {
    const network = this.#requireGuest();
    const offer = this.remoteOffer;
    if (!offer) {
      throw new Error("The host is not offering a track");
    }
    if (!network.compatiblePeerIds?.includes(network.hostParticipantId)) {
      throw new Error("The host is not a verified DJ Party peer");
    }
    if (!network.contentPeerIds?.includes(network.hostParticipantId)) {
      throw new Error("The host content channel is not ready");
    }
    if (this.busy) {
      throw new Error("A track transfer is already in progress");
    }

    this.busy = true;
    this.progress = { receivedChunks: 0, totalChunks: offer.manifest.files[0].chunks.sha256.length };
    this.lastError = null;
    this.#emitChange();

    this.#closeGameFiles();
    const gameFiles = this.transport.createGameFiles(offer.manifest);
    this.gameFiles = gameFiles;
    this.#observeGameFiles(gameFiles);

    try {
      const bytes = await gameFiles.requestFile(network.hostParticipantId, offer.path);
      const sha256 = await trackContentIdForBytes(bytes);
      if (sha256 !== offer.sha256) {
        throw new Error("Received track identity does not match the host offer");
      }
      if (typeof File !== "function") {
        throw new Error("This browser cannot create a local file from the verified transfer");
      }
      return new File([bytes], offer.name, {
        type: offer.type,
        lastModified: offer.lastModified,
      });
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    } finally {
      this.#closeGameFiles();
      this.busy = false;
      this.progress = null;
      this.#emitChange();
    }
  }

  #observeGameFiles(gameFiles) {
    this.gameFilesAbort?.abort();
    this.gameFilesAbort = new AbortController();
    const signal = this.gameFilesAbort.signal;
    gameFiles.addEventListener(
      "progress",
      (event) => {
        const detail = event.detail ?? {};
        if (
          Number.isSafeInteger(detail.receivedChunks) &&
          Number.isSafeInteger(detail.totalChunks) &&
          detail.receivedChunks >= 0 &&
          detail.totalChunks > 0
        ) {
          this.progress = {
            receivedChunks: detail.receivedChunks,
            totalChunks: detail.totalChunks,
          };
          this.#emitChange();
        }
      },
      { signal },
    );
    gameFiles.addEventListener(
      "error",
      (event) => {
        this.lastError = errorMessage(event.detail?.error ?? "Verified track transfer failed");
        this.#emitChange();
      },
      { signal },
    );
  }

  #applicationMessage(detail) {
    if (!this.transport || this.#isHost()) {
      return;
    }
    const network = this.transport.snapshot();
    if (detail?.peerId !== network?.hostParticipantId) {
      return;
    }

    const offer = validateTrackAssetOfferMessage(detail?.data);
    if (offer) {
      if (offer.revision <= this.remoteRevision) {
        return;
      }
      this.remoteRevision = offer.revision;
      this.#closeGameFiles();
      this.remoteOffer = offer;
      this.lastError = null;
      this.progress = null;
      this.#emitChange();
      return;
    }

    const clear = validateTrackAssetClearMessage(detail?.data);
    if (!clear || clear.revision <= this.remoteRevision) {
      return;
    }
    this.remoteRevision = clear.revision;
    this.#closeGameFiles();
    this.remoteOffer = null;
    this.progress = null;
    this.lastError = null;
    this.#emitChange();
  }

  #peerCompatible(peerId) {
    if (!this.#isHost() || !this.localOffer || typeof peerId !== "string") {
      return;
    }
    try {
      this.transport.sendApplicationReliable(peerId, networkOffer(this.localOffer));
    } catch (error) {
      this.lastError = errorMessage(error);
      this.#emitChange();
    }
  }

  #transportChanged() {
    const network = this.transport?.snapshot?.();
    if (!network || network.state !== "connected") {
      this.#closeGameFiles();
      this.remoteOffer = null;
      this.progress = null;
      this.busy = false;
    } else if (!this.#isHost() && !network.compatiblePeerIds?.includes(network.hostParticipantId)) {
      this.#closeGameFiles();
    }
    this.#emitChange();
  }

  #requireHost() {
    const network = this.transport?.snapshot?.();
    if (
      !network ||
      network.state !== "connected" ||
      typeof network.participantId !== "string" ||
      network.participantId !== network.hostParticipantId
    ) {
      throw new Error("Only the lobby host can offer a track");
    }
    return network;
  }

  #requireGuest() {
    const network = this.transport?.snapshot?.();
    if (
      !network ||
      network.state !== "connected" ||
      typeof network.participantId !== "string" ||
      typeof network.hostParticipantId !== "string" ||
      network.participantId === network.hostParticipantId
    ) {
      throw new Error("Only a lobby guest can request the host track");
    }
    return network;
  }

  #isHost() {
    const network = this.transport?.snapshot?.();
    return Boolean(network?.participantId && network.participantId === network.hostParticipantId);
  }

  #closeGameFiles() {
    this.gameFilesAbort?.abort();
    this.gameFilesAbort = null;
    this.gameFiles?.close?.();
    this.gameFiles = null;
  }

  #emitChange() {
    this.dispatchEvent(new CustomEvent("change", { detail: this.snapshot() }));
  }
}

export const sharedAssetTransferSession = new SharedAssetTransferCoordinator();

function networkOffer(offer) {
  return {
    type: TRACK_ASSET_OFFER_TYPE,
    protocol: SHARED_ASSET_PROTOCOL,
    revision: offer.revision,
    deckId: offer.deckId,
    name: offer.name,
    mediaType: offer.type,
    bytes: offer.bytes,
    lastModified: offer.lastModified,
    sha256: offer.sha256,
    path: offer.path,
    manifest: offer.manifest,
  };
}

function publicOffer(offer) {
  if (!offer) {
    return null;
  }
  return {
    revision: offer.revision,
    deckId: offer.deckId,
    name: offer.name,
    type: offer.type,
    bytes: offer.bytes,
    lastModified: offer.lastModified,
    sha256: offer.sha256,
    path: offer.path,
  };
}

function normalizeManifest(manifest, expected) {
  if (
    !isObject(manifest) ||
    manifest.protocol !== TRACK_ASSET_MANIFEST_PROTOCOL ||
    !isObject(manifest.game) ||
    manifest.game.id !== "dj-party" ||
    manifest.game.version !== TRACK_ASSET_MANIFEST_VERSION ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 1
  ) {
    return null;
  }

  const file = manifest.files[0];
  const chunks = file?.chunks;
  const expectedChunkCount = Math.ceil(expected.bytes / TRACK_ASSET_CHUNK_BYTES);
  if (
    !isObject(file) ||
    file.path !== expected.path ||
    file.bytes !== expected.bytes ||
    file.sha256 !== expected.sha256 ||
    file.role !== "asset" ||
    !isObject(chunks) ||
    chunks.bytes !== TRACK_ASSET_CHUNK_BYTES ||
    !Array.isArray(chunks.sha256) ||
    chunks.sha256.length !== expectedChunkCount ||
    chunks.sha256.some((hash) => typeof hash !== "string" || !SHA256_PATTERN.test(hash))
  ) {
    return null;
  }

  return {
    protocol: TRACK_ASSET_MANIFEST_PROTOCOL,
    game: {
      id: "dj-party",
      version: TRACK_ASSET_MANIFEST_VERSION,
    },
    files: [
      {
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        role: "asset",
        chunks: {
          bytes: TRACK_ASSET_CHUNK_BYTES,
          sha256: [...chunks.sha256],
        },
      },
    ],
  };
}

function requireSafeFileName(value) {
  const name = safeFileNameOrNull(value);
  if (!name) {
    throw new Error("Track filename is invalid");
  }
  return name;
}

function safeFileNameOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim();
  if (
    name.length < 1 ||
    name.length > MAX_FILE_NAME_LENGTH ||
    name !== value ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    return null;
  }
  return name;
}

function normalizedAudioType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  if (!type) {
    return "";
  }
  if (type.length > MAX_MEDIA_TYPE_LENGTH || !AUDIO_TYPE_PATTERN.test(type)) {
    return "";
  }
  return type;
}

function safeExtension(name) {
  const extension = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  return extension ?? "audio";
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "Verified track transfer failed");
}
