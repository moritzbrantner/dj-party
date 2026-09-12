export const SHARED_SESSION_PROTOCOL = 1;

const REQUEST_TYPE = "dj-party/shared/request";
const COMMAND_TYPE = "dj-party/shared/command";
const SNAPSHOT_TYPE = "dj-party/shared/snapshot";
const SNAPSHOT_REQUEST_TYPE = "dj-party/shared/snapshot-request";
const DECK_IDS = new Set(["a", "b"]);

export function validateSharedCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  switch (value.kind) {
    case "crossfader": {
      const position = finiteRange(value.position, -1, 1);
      return position === null ? null : { kind: "crossfader", position };
    }
    case "deck-level": {
      const deck = deckId(value.deck);
      const level = finiteRange(value.level, 0, 1);
      return !deck || level === null ? null : { kind: "deck-level", deck, level };
    }
    case "tempo": {
      const deck = deckId(value.deck);
      const percent = finiteRange(value.percent, -16, 16);
      return !deck || percent === null ? null : { kind: "tempo", deck, percent };
    }
    case "key-lock": {
      const deck = deckId(value.deck);
      return !deck || typeof value.enabled !== "boolean"
        ? null
        : { kind: "key-lock", deck, enabled: value.enabled };
    }
    case "tone": {
      const deck = deckId(value.deck);
      const tone = validateTone(value.tone);
      return !deck || !tone ? null : { kind: "tone", deck, tone };
    }
    default:
      return null;
  }
}

export function validateSharedState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const crossfader = finiteRange(value.crossfader, -1, 1);
  const deckA = validateDeckState(value.decks?.a);
  const deckB = validateDeckState(value.decks?.b);
  if (crossfader === null || !deckA || !deckB) {
    return null;
  }
  return { crossfader, decks: { a: deckA, b: deckB } };
}

export class SharedSessionCoordinator extends EventTarget {
  constructor() {
    super();
    this.transport = null;
    this.transportAbort = null;
    this.mixer = null;
    this.canonicalSequence = 0;
    this.lastCanonicalSequence = 0;
    this.localRequestSequence = 0;
    this.lastRequestSequenceByPeer = new Map();
    this.snapshotRequestPending = false;
    this.ready = false;
  }

  registerMixer(adapter) {
    if (
      !adapter ||
      typeof adapter.captureState !== "function" ||
      typeof adapter.applyCommand !== "function" ||
      typeof adapter.applySnapshot !== "function"
    ) {
      throw new Error("Shared session mixer adapter is incomplete");
    }
    this.mixer = adapter;
    this.#mixerReady();
    return () => {
      if (this.mixer === adapter) {
        this.mixer = null;
        this.snapshotRequestPending = false;
        this.ready = false;
        this.#emitChange();
      }
    };
  }

  attachTransport(transport) {
    this.detachTransport();
    if (!transport || typeof transport.snapshot !== "function") {
      throw new Error("Shared session transport is required");
    }
    this.transport = transport;
    this.transportAbort = new AbortController();
    this.canonicalSequence = 0;
    this.lastCanonicalSequence = 0;
    this.localRequestSequence = 0;
    this.lastRequestSequenceByPeer.clear();
    this.snapshotRequestPending = false;
    this.ready = false;

    const signal = this.transportAbort.signal;
    transport.addEventListener("change", () => this.#transportChanged(), { signal });
    transport.addEventListener("peer-compatible", (event) => this.#peerCompatible(event.detail?.peerId), { signal });
    transport.addEventListener(
      "application-message",
      (event) => this.#receive(event.detail?.peerId, event.detail?.data),
      { signal },
    );
    this.#transportChanged();
    this.#mixerReady();
  }

  detachTransport() {
    this.transportAbort?.abort();
    this.transportAbort = null;
    this.transport = null;
    this.canonicalSequence = 0;
    this.lastCanonicalSequence = 0;
    this.localRequestSequence = 0;
    this.lastRequestSequenceByPeer.clear();
    this.snapshotRequestPending = false;
    this.ready = false;
    this.#emitChange();
  }

  snapshot() {
    const network = this.transport?.snapshot?.() ?? null;
    const participantId = typeof network?.participantId === "string" ? network.participantId : null;
    const hostParticipantId = typeof network?.hostParticipantId === "string" ? network.hostParticipantId : null;
    return {
      active: Boolean(network?.state === "connected" && participantId && hostParticipantId),
      ready: this.ready,
      role: participantId && hostParticipantId ? (participantId === hostParticipantId ? "host" : "guest") : null,
      participantId,
      hostParticipantId,
      canonicalSequence: this.#isHost() ? this.canonicalSequence : this.lastCanonicalSequence,
    };
  }

  submitLocalCommand(value) {
    const command = validateSharedCommand(value);
    if (!command || !this.transport || !this.mixer) {
      return false;
    }
    const network = this.transport.snapshot();
    if (network?.state !== "connected") {
      return false;
    }

    if (this.#isHost()) {
      this.transport.broadcastApplicationReliable(this.#canonicalize(command));
      this.ready = true;
      this.#emitChange();
      return true;
    }

    const host = network.hostParticipantId;
    if (typeof host !== "string" || !network.compatiblePeerIds?.includes(host)) {
      return false;
    }
    this.localRequestSequence += 1;
    try {
      this.transport.sendApplicationReliable(host, {
        type: REQUEST_TYPE,
        protocol: SHARED_SESSION_PROTOCOL,
        requestSequence: this.localRequestSequence,
        command,
      });
      return true;
    } catch {
      this.snapshotRequestPending = false;
      this.ready = false;
      this.#emitChange();
      return false;
    }
  }

  publishSnapshot() {
    if (!this.#isHost() || !this.transport || !this.mixer) {
      return false;
    }
    const message = this.#snapshotMessage();
    if (!message) {
      return false;
    }
    this.transport.broadcastApplicationReliable(message);
    return true;
  }

  #mixerReady() {
    if (!this.transport || !this.mixer) {
      return;
    }
    const state = this.transport.snapshot();
    if (state.state !== "connected") {
      return;
    }
    if (this.#isHost()) {
      this.ready = true;
      for (const peerId of [...(state.compatiblePeerIds ?? [])].sort()) {
        this.#sendSnapshot(peerId);
      }
    } else {
      this.#requestSnapshot();
    }
    this.#emitChange();
  }

  #transportChanged() {
    if (!this.transport) {
      return;
    }
    const state = this.transport.snapshot();
    if (state.state !== "connected") {
      this.snapshotRequestPending = false;
      this.ready = false;
    } else if (this.#isHost()) {
      this.snapshotRequestPending = false;
      this.ready = Boolean(this.mixer);
    } else if (!state.compatiblePeerIds?.includes(state.hostParticipantId)) {
      this.snapshotRequestPending = false;
      this.ready = false;
    } else if (!this.ready && this.mixer) {
      this.#requestSnapshot();
    }
    this.#emitChange();
  }

  #peerCompatible(peerId) {
    if (typeof peerId !== "string" || !this.transport) {
      return;
    }
    if (this.#isHost()) {
      this.#sendSnapshot(peerId);
    } else if (peerId === this.transport.snapshot()?.hostParticipantId) {
      this.snapshotRequestPending = false;
      this.#requestSnapshot();
    }
    this.#emitChange();
  }

  #requestSnapshot() {
    if (!this.transport || !this.mixer || this.#isHost() || this.snapshotRequestPending) {
      return false;
    }
    const state = this.transport.snapshot();
    const host = state.hostParticipantId;
    if (typeof host !== "string" || !state.compatiblePeerIds?.includes(host)) {
      return false;
    }
    try {
      this.transport.sendApplicationReliable(host, {
        type: SNAPSHOT_REQUEST_TYPE,
        protocol: SHARED_SESSION_PROTOCOL,
      });
      this.snapshotRequestPending = true;
      return true;
    } catch {
      this.snapshotRequestPending = false;
      this.ready = false;
      return false;
    }
  }

  #sendSnapshot(peerId) {
    if (!this.transport || !this.mixer || !this.#isHost()) {
      return false;
    }
    const message = this.#snapshotMessage();
    if (!message) {
      return false;
    }
    try {
      this.transport.sendApplicationReliable(peerId, message);
      return true;
    } catch {
      return false;
    }
  }

  #receive(peerId, data) {
    if (typeof peerId !== "string" || !this.transport || !data || typeof data !== "object") {
      return;
    }
    if (data.protocol !== SHARED_SESSION_PROTOCOL) {
      return;
    }

    if (this.#isHost()) {
      if (data.type === SNAPSHOT_REQUEST_TYPE) {
        this.#sendSnapshot(peerId);
        return;
      }
      if (data.type !== REQUEST_TYPE || !this.mixer) {
        return;
      }
      const requestSequence = positiveSafeInteger(data.requestSequence);
      const command = validateSharedCommand(data.command);
      if (!requestSequence || !command) {
        return;
      }
      const previous = this.lastRequestSequenceByPeer.get(peerId) ?? 0;
      if (requestSequence <= previous) {
        return;
      }
      this.lastRequestSequenceByPeer.set(peerId, requestSequence);
      this.mixer.applyCommand(command, { source: "remote-request", peerId });
      this.transport.broadcastApplicationReliable(this.#canonicalize(command));
      this.#emitChange();
      return;
    }

    if (!this.mixer) {
      return;
    }
    const host = this.transport.snapshot()?.hostParticipantId;
    if (peerId !== host) {
      return;
    }

    if (data.type === COMMAND_TYPE) {
      const sequence = positiveSafeInteger(data.sequence);
      const command = validateSharedCommand(data.command);
      if (!sequence || !command || sequence <= this.lastCanonicalSequence) {
        return;
      }
      this.lastCanonicalSequence = sequence;
      this.mixer.applyCommand(command, { source: "canonical", peerId, sequence });
      this.#emitChange();
      return;
    }

    if (data.type === SNAPSHOT_TYPE) {
      const sequence = nonNegativeSafeInteger(data.sequence);
      const sharedState = validateSharedState(data.state);
      if (sequence === null || !sharedState || sequence < this.lastCanonicalSequence) {
        return;
      }
      this.lastCanonicalSequence = sequence;
      this.mixer.applySnapshot(sharedState, { source: "snapshot", peerId, sequence });
      this.snapshotRequestPending = false;
      this.ready = true;
      this.#emitChange();
    }
  }

  #canonicalize(command) {
    this.canonicalSequence += 1;
    return {
      type: COMMAND_TYPE,
      protocol: SHARED_SESSION_PROTOCOL,
      sequence: this.canonicalSequence,
      command,
    };
  }

  #snapshotMessage() {
    const state = validateSharedState(this.mixer?.captureState?.());
    if (!state) {
      return null;
    }
    return {
      type: SNAPSHOT_TYPE,
      protocol: SHARED_SESSION_PROTOCOL,
      sequence: this.canonicalSequence,
      state,
    };
  }

  #isHost() {
    const state = this.transport?.snapshot?.();
    return Boolean(state?.participantId && state.participantId === state.hostParticipantId);
  }

  #emitChange() {
    this.dispatchEvent(new CustomEvent("change", { detail: this.snapshot() }));
  }
}

export const sharedSession = new SharedSessionCoordinator();

function validateDeckState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const level = finiteRange(value.level, 0, 1);
  const tempoPercent = finiteRange(value.tempoPercent, -16, 16);
  const tone = validateTone(value.tone);
  if (level === null || tempoPercent === null || typeof value.keyLock !== "boolean" || !tone) {
    return null;
  }
  return { level, tempoPercent, keyLock: value.keyLock, tone };
}

function validateTone(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result = {};
  for (const key of ["low", "mid", "high", "filter"]) {
    const current = integerRange(value[key], -100, 100);
    if (current === null) {
      return null;
    }
    result[key] = current;
  }
  return result;
}

function deckId(value) {
  return DECK_IDS.has(value) ? value : null;
}

function finiteRange(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function integerRange(value, minimum, maximum) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
