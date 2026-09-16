import { isTrackContentId } from "./track-identity.js";

export const SHARED_PLAYBACK_PROTOCOL = 2;

const CLOCK_REQUEST_TYPE = "dj-party/playback/clock-request";
const CLOCK_RESPONSE_TYPE = "dj-party/playback/clock-response";
const REQUEST_TYPE = "dj-party/playback/request";
const COMMAND_TYPE = "dj-party/playback/command";
const SNAPSHOT_TYPE = "dj-party/playback/snapshot";
const SNAPSHOT_REQUEST_TYPE = "dj-party/playback/snapshot-request";
const DECK_IDS = ["a", "b"];
const DEFAULT_CLOCK_SAMPLE_TARGET = 3;
const MAX_TRACK_SECONDS = 12 * 60 * 60;
const MAX_MESSAGE_AGE_MS = 10_000;
const MAX_CLOCK_RTT_MS = 5_000;
const MIN_PLAYBACK_RATE = 0.84;
const MAX_PLAYBACK_RATE = 1.16;
const LOOP_BEAT_COUNTS = new Set([1, 2, 4, 8]);

export function validateDeckPlaybackState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!isTrackContentId(value.trackContentId) || typeof value.playing !== "boolean") {
    return null;
  }
  const positionSeconds = finiteRange(value.positionSeconds, 0, MAX_TRACK_SECONDS);
  const durationSeconds = finiteRange(value.durationSeconds, Number.EPSILON, MAX_TRACK_SECONDS);
  const playbackRate = finiteRange(value.playbackRate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
  if (
    positionSeconds === null ||
    durationSeconds === null ||
    playbackRate === null ||
    positionSeconds > durationSeconds
  ) {
    return null;
  }
  const loop = validateLoopState(value.loop, durationSeconds);
  if (loop === undefined) {
    return null;
  }
  return {
    trackContentId: value.trackContentId,
    playing: value.playing,
    positionSeconds,
    durationSeconds,
    playbackRate,
    loop,
  };
}

export function validatePlaybackSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result = {};
  for (const deckId of DECK_IDS) {
    if (value[deckId] === null) {
      result[deckId] = null;
      continue;
    }
    const deck = validateDeckPlaybackState(value[deckId]);
    if (!deck) {
      return null;
    }
    result[deckId] = deck;
  }
  return result;
}

export function calculateClockSample({ guestSentAtMs, hostReceivedAtMs, hostSentAtMs, guestReceivedAtMs }) {
  if (![guestSentAtMs, hostReceivedAtMs, hostSentAtMs, guestReceivedAtMs].every(finiteTimestamp)) {
    return null;
  }
  if (guestReceivedAtMs < guestSentAtMs || hostSentAtMs < hostReceivedAtMs) {
    return null;
  }
  const rttMs = guestReceivedAtMs - guestSentAtMs - (hostSentAtMs - hostReceivedAtMs);
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > MAX_CLOCK_RTT_MS) {
    return null;
  }
  const offsetMs = ((hostReceivedAtMs - guestSentAtMs) + (hostSentAtMs - guestReceivedAtMs)) / 2;
  if (!Number.isFinite(offsetMs)) {
    return null;
  }
  return { rttMs, offsetMs };
}

export class SharedPlaybackCoordinator extends EventTarget {
  declare blockedDeckIds: any;
  declare canonicalSequence: any;
  declare clockOffsetMs: any;
  declare clockReady: any;
  declare clockRttMs: any;
  declare ready: any;
  declare clockRequestPending: any;
  declare clockRequestSequence: any;
  declare clockSampleTarget: any;
  declare clockSamples: any;
  declare lastCanonicalSequence: any;
  declare lastRequestSequenceByPeer: any;
  declare localRequestSequence: any;
  declare now: any;
  declare playback: any;
  declare snapshotRequestPending: any;
  declare transport: any;
  declare transportAbort: any;
  constructor({ now = epochNow, clockSampleTarget = DEFAULT_CLOCK_SAMPLE_TARGET } = {}) {
    super();
    if (!Number.isSafeInteger(clockSampleTarget) || clockSampleTarget < 1 || clockSampleTarget > 8) {
      throw new Error("clockSampleTarget must be between 1 and 8");
    }
    this.now = now;
    this.clockSampleTarget = clockSampleTarget;
    this.transport = null;
    this.transportAbort = null;
    this.playback = null;
    this.canonicalSequence = 0;
    this.lastCanonicalSequence = 0;
    this.localRequestSequence = 0;
    this.lastRequestSequenceByPeer = new Map();
    this.snapshotRequestPending = false;
    this.clockRequestSequence = 0;
    this.clockRequestPending = null;
    this.clockSamples = [];
    this.clockReady = false;
    this.clockOffsetMs = null;
    this.clockRttMs = null;
    this.ready = false;
    this.blockedDeckIds = new Set();
  }

  registerPlayback(adapter) {
    if (
      !adapter ||
      typeof adapter.captureState !== "function" ||
      typeof adapter.canApplyDeckState !== "function" ||
      typeof adapter.applyDeckState !== "function"
    ) {
      throw new Error("Shared playback adapter is incomplete");
    }
    this.playback = adapter;
    this.#synchronize();
    return () => {
      if (this.playback === adapter) {
        this.playback = null;
        this.ready = false;
        this.snapshotRequestPending = false;
        this.blockedDeckIds.clear();
        this.#emitChange();
      }
    };
  }

  attachTransport(transport) {
    this.detachTransport();
    if (!transport || typeof transport.snapshot !== "function") {
      throw new Error("Shared playback transport is required");
    }
    this.transport = transport;
    this.transportAbort = new AbortController();
    this.#resetSessionState();

    const signal = this.transportAbort.signal;
    transport.addEventListener("change", () => this.#transportChanged(), { signal });
    transport.addEventListener("peer-compatible", (event) => this.#peerCompatible(event.detail?.peerId), { signal });
    transport.addEventListener(
      "application-message",
      (event) => {
        void this.#receive(event.detail?.peerId, event.detail?.data);
      },
      { signal },
    );
    this.#transportChanged();
    this.#synchronize();
  }

  detachTransport() {
    this.transportAbort?.abort();
    this.transportAbort = null;
    this.transport = null;
    this.#resetSessionState();
    this.#emitChange();
  }

  snapshot() {
    const network = this.transport?.snapshot?.() ?? null;
    const participantId = typeof network?.participantId === "string" ? network.participantId : null;
    const hostParticipantId = typeof network?.hostParticipantId === "string" ? network.hostParticipantId : null;
    const role = participantId && hostParticipantId ? (participantId === hostParticipantId ? "host" : "guest") : null;
    return {
      active: Boolean(network?.state === "connected" && participantId && hostParticipantId),
      ready: this.ready,
      role,
      participantId,
      hostParticipantId,
      canonicalSequence: role === "host" ? this.canonicalSequence : this.lastCanonicalSequence,
      clockReady: role === "host" ? true : this.clockReady,
      clockRttMs: role === "host" ? 0 : this.clockRttMs,
      blockedDeckIds: [...this.blockedDeckIds].sort(),
    };
  }

  submitLocalDeckState(deckId, value) {
    const state = validateDeckPlaybackState(value);
    if (!DECK_IDS.includes(deckId) || !state || !this.transport || !this.playback) {
      return false;
    }
    const network = this.transport.snapshot();
    if (network?.state !== "connected") {
      return false;
    }

    if (this.#isHost()) {
      this.transport.broadcastApplicationReliable(this.#canonicalize(deckId, state));
      this.ready = true;
      this.#emitChange();
      return true;
    }

    if (!this.ready || !this.clockReady) {
      return false;
    }
    const host = network.hostParticipantId;
    if (typeof host !== "string" || !network.compatiblePeerIds?.includes(host)) {
      return false;
    }
    this.localRequestSequence += 1;
    try {
      this.transport.sendApplicationReliable(host, {
        type: REQUEST_TYPE,
        protocol: SHARED_PLAYBACK_PROTOCOL,
        requestSequence: this.localRequestSequence,
        deckId,
        state,
      });
      return true;
    } catch {
      this.ready = false;
      this.snapshotRequestPending = false;
      this.#emitChange();
      return false;
    }
  }

  publishSnapshot() {
    if (!this.#isHost() || !this.transport || !this.playback) {
      return false;
    }
    const message = this.#snapshotMessage();
    if (!message) {
      return false;
    }
    this.transport.broadcastApplicationReliable(message);
    return true;
  }

  refreshLocalTracks() {
    if (!this.transport || !this.playback) {
      return false;
    }
    this.blockedDeckIds.clear();
    this.snapshotRequestPending = false;
    if (this.#isHost()) {
      this.ready = true;
      const published = this.publishSnapshot();
      this.#emitChange();
      return published;
    }
    this.ready = false;
    const requested = this.#synchronize();
    this.#emitChange();
    return requested;
  }

  #resetSessionState() {
    this.canonicalSequence = 0;
    this.lastCanonicalSequence = 0;
    this.localRequestSequence = 0;
    this.lastRequestSequenceByPeer.clear();
    this.snapshotRequestPending = false;
    this.clockRequestSequence = 0;
    this.clockRequestPending = null;
    this.clockSamples = [];
    this.clockReady = false;
    this.clockOffsetMs = null;
    this.clockRttMs = null;
    this.ready = false;
    this.blockedDeckIds.clear();
  }

  #transportChanged() {
    if (!this.transport) {
      return;
    }
    const state = this.transport.snapshot();
    if (state.state !== "connected") {
      this.ready = false;
      this.snapshotRequestPending = false;
      this.clockRequestPending = null;
    } else if (this.#isHost()) {
      this.ready = Boolean(this.playback);
      this.snapshotRequestPending = false;
      this.clockReady = true;
      this.clockOffsetMs = 0;
      this.clockRttMs = 0;
    } else if (!state.compatiblePeerIds?.includes(state.hostParticipantId)) {
      this.ready = false;
      this.snapshotRequestPending = false;
      this.clockRequestPending = null;
      this.clockReady = false;
      this.clockSamples = [];
    } else {
      this.#synchronize();
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
      this.ready = false;
      this.snapshotRequestPending = false;
      this.clockRequestPending = null;
      this.clockSamples = [];
      this.clockReady = false;
      this.#synchronize();
    }
    this.#emitChange();
  }

  #synchronize() {
    if (!this.transport || !this.playback) {
      return false;
    }
    const state = this.transport.snapshot();
    if (state.state !== "connected") {
      return false;
    }
    if (this.#isHost()) {
      this.ready = true;
      return true;
    }
    const host = state.hostParticipantId;
    if (typeof host !== "string" || !state.compatiblePeerIds?.includes(host)) {
      return false;
    }
    if (!this.clockReady) {
      return this.#requestClockSample();
    }
    if (!this.ready && this.blockedDeckIds.size === 0) {
      return this.#requestSnapshot();
    }
    return false;
  }

  #requestClockSample() {
    if (!this.transport || this.#isHost() || this.clockReady || this.clockRequestPending) {
      return false;
    }
    const network = this.transport.snapshot();
    const host = network.hostParticipantId;
    if (typeof host !== "string" || !network.compatiblePeerIds?.includes(host)) {
      return false;
    }
    this.clockRequestSequence += 1;
    const requestId = this.clockRequestSequence;
    const guestSentAtMs = this.now();
    if (!finiteTimestamp(guestSentAtMs)) {
      return false;
    }
    try {
      this.transport.sendApplicationReliable(host, {
        type: CLOCK_REQUEST_TYPE,
        protocol: SHARED_PLAYBACK_PROTOCOL,
        requestId,
        guestSentAtMs,
      });
      this.clockRequestPending = { requestId, guestSentAtMs };
      return true;
    } catch {
      this.clockRequestPending = null;
      return false;
    }
  }

  #requestSnapshot() {
    if (!this.transport || !this.playback || this.#isHost() || !this.clockReady || this.snapshotRequestPending) {
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
        protocol: SHARED_PLAYBACK_PROTOCOL,
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
    if (!this.transport || !this.playback || !this.#isHost()) {
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

  async #receive(peerId, data) {
    if (typeof peerId !== "string" || !this.transport || !data || typeof data !== "object") {
      return;
    }
    if (data.protocol !== SHARED_PLAYBACK_PROTOCOL) {
      return;
    }

    if (this.#isHost()) {
      if (data.type === CLOCK_REQUEST_TYPE) {
        this.#answerClockRequest(peerId, data);
        return;
      }
      if (data.type === SNAPSHOT_REQUEST_TYPE) {
        this.#sendSnapshot(peerId);
        return;
      }
      if (data.type !== REQUEST_TYPE || !this.playback) {
        return;
      }
      const requestSequence = positiveSafeInteger(data.requestSequence);
      const deckId = DECK_IDS.includes(data.deckId) ? data.deckId : null;
      const state = validateDeckPlaybackState(data.state);
      if (!requestSequence || !deckId || !state) {
        return;
      }
      const previous = this.lastRequestSequenceByPeer.get(peerId) ?? 0;
      if (requestSequence <= previous) {
        return;
      }
      this.lastRequestSequenceByPeer.set(peerId, requestSequence);
      if (!this.playback.canApplyDeckState(deckId, state)) {
        return;
      }
      const applied = await this.playback.applyDeckState(deckId, state, {
        elapsedMs: 0,
        source: "remote-request",
        peerId,
      });
      if (applied === false) {
        return;
      }
      const canonicalState = validateDeckPlaybackState(this.playback.captureState()?.[deckId]);
      if (!canonicalState) {
        return;
      }
      this.transport.broadcastApplicationReliable(this.#canonicalize(deckId, canonicalState));
      this.#emitChange();
      return;
    }

    const host = this.transport.snapshot()?.hostParticipantId;
    if (peerId !== host) {
      return;
    }

    if (data.type === CLOCK_RESPONSE_TYPE) {
      this.#acceptClockResponse(data);
      return;
    }
    if (!this.playback || !this.clockReady) {
      return;
    }

    if (data.type === COMMAND_TYPE) {
      await this.#acceptCanonicalCommand(data);
    } else if (data.type === SNAPSHOT_TYPE) {
      await this.#acceptSnapshot(data);
    }
  }

  #answerClockRequest(peerId, data) {
    const requestId = positiveSafeInteger(data.requestId);
    const guestSentAtMs = finiteTimestamp(data.guestSentAtMs) ? data.guestSentAtMs : null;
    if (!requestId || guestSentAtMs === null) {
      return false;
    }
    const hostReceivedAtMs = this.now();
    if (!finiteTimestamp(hostReceivedAtMs)) {
      return false;
    }
    try {
      const hostSentAtMs = this.now();
      this.transport.sendApplicationReliable(peerId, {
        type: CLOCK_RESPONSE_TYPE,
        protocol: SHARED_PLAYBACK_PROTOCOL,
        requestId,
        guestSentAtMs,
        hostReceivedAtMs,
        hostSentAtMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  #acceptClockResponse(data) {
    const pending = this.clockRequestPending;
    const requestId = positiveSafeInteger(data.requestId);
    if (!pending || requestId !== pending.requestId || data.guestSentAtMs !== pending.guestSentAtMs) {
      return false;
    }
    this.clockRequestPending = null;
    const sample = calculateClockSample({
      guestSentAtMs: pending.guestSentAtMs,
      hostReceivedAtMs: data.hostReceivedAtMs,
      hostSentAtMs: data.hostSentAtMs,
      guestReceivedAtMs: this.now(),
    });
    if (!sample) {
      this.#requestClockSample();
      return false;
    }
    this.clockSamples.push(sample);
    const best = [...this.clockSamples].sort((left, right) => left.rttMs - right.rttMs)[0];
    this.clockOffsetMs = best.offsetMs;
    this.clockRttMs = best.rttMs;
    if (this.clockSamples.length >= this.clockSampleTarget) {
      this.clockReady = true;
      this.#requestSnapshot();
    } else {
      this.#requestClockSample();
    }
    this.#emitChange();
    return true;
  }

  async #acceptCanonicalCommand(data) {
    const sequence = positiveSafeInteger(data.sequence);
    const hostTimeMs = finiteTimestamp(data.hostTimeMs) ? data.hostTimeMs : null;
    const deckId = DECK_IDS.includes(data.deckId) ? data.deckId : null;
    const state = validateDeckPlaybackState(data.state);
    if (!sequence || hostTimeMs === null || !deckId || !state || sequence <= this.lastCanonicalSequence) {
      return false;
    }
    if (!this.ready || sequence !== this.lastCanonicalSequence + 1) {
      this.ready = false;
      this.snapshotRequestPending = false;
      this.#requestSnapshot();
      this.#emitChange();
      return false;
    }
    const elapsedMs = this.#elapsedSinceHost(hostTimeMs);
    if (elapsedMs === null) {
      this.ready = false;
      this.snapshotRequestPending = false;
      this.#requestSnapshot();
      this.#emitChange();
      return false;
    }
    if (!this.playback.canApplyDeckState(deckId, state)) {
      this.lastCanonicalSequence = sequence;
      this.ready = false;
      this.blockedDeckIds.add(deckId);
      this.snapshotRequestPending = false;
      this.#emitChange();
      return false;
    }
    const applied = await this.playback.applyDeckState(deckId, state, {
      elapsedMs,
      source: "canonical",
      sequence,
    });
    this.lastCanonicalSequence = sequence;
    if (applied === false) {
      this.ready = false;
      this.blockedDeckIds.add(deckId);
    }
    this.#emitChange();
    return applied !== false;
  }

  async #acceptSnapshot(data) {
    const sequence = nonNegativeSafeInteger(data.sequence);
    const hostTimeMs = finiteTimestamp(data.hostTimeMs) ? data.hostTimeMs : null;
    const snapshot = validatePlaybackSnapshot(data.state);
    if (sequence === null || hostTimeMs === null || !snapshot || sequence < this.lastCanonicalSequence) {
      return false;
    }
    const elapsedMs = this.#elapsedSinceHost(hostTimeMs);
    if (elapsedMs === null) {
      return false;
    }
    const blocked = DECK_IDS.filter((deckId) => snapshot[deckId] && !this.playback.canApplyDeckState(deckId, snapshot[deckId]));
    this.lastCanonicalSequence = sequence;
    this.snapshotRequestPending = false;
    if (blocked.length > 0) {
      this.ready = false;
      this.blockedDeckIds = new Set(blocked);
      this.#emitChange();
      return false;
    }

    for (const deckId of DECK_IDS) {
      const state = snapshot[deckId];
      if (!state) {
        continue;
      }
      const applied = await this.playback.applyDeckState(deckId, state, {
        elapsedMs,
        source: "snapshot",
        sequence,
      });
      if (applied === false) {
        this.ready = false;
        this.blockedDeckIds.add(deckId);
        this.#emitChange();
        return false;
      }
    }
    this.blockedDeckIds.clear();
    this.ready = true;
    this.#emitChange();
    return true;
  }

  #elapsedSinceHost(hostTimeMs) {
    if (!this.clockReady || !Number.isFinite(this.clockOffsetMs)) {
      return null;
    }
    const estimatedHostNow = this.now() + this.clockOffsetMs;
    if (!finiteTimestamp(estimatedHostNow)) {
      return null;
    }
    const elapsedMs = estimatedHostNow - hostTimeMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs > MAX_MESSAGE_AGE_MS || elapsedMs < -250) {
      return null;
    }
    return Math.max(0, elapsedMs);
  }

  #canonicalize(deckId, state) {
    this.canonicalSequence += 1;
    return {
      type: COMMAND_TYPE,
      protocol: SHARED_PLAYBACK_PROTOCOL,
      sequence: this.canonicalSequence,
      hostTimeMs: this.now(),
      deckId,
      state,
    };
  }

  #snapshotMessage() {
    const state = validatePlaybackSnapshot(this.playback?.captureState?.());
    const hostTimeMs = this.now();
    if (!state || !finiteTimestamp(hostTimeMs)) {
      return null;
    }
    return {
      type: SNAPSHOT_TYPE,
      protocol: SHARED_PLAYBACK_PROTOCOL,
      sequence: this.canonicalSequence,
      hostTimeMs,
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

export const sharedPlaybackSession = new SharedPlaybackCoordinator();

function epochNow() {
  if (globalThis.performance && Number.isFinite(globalThis.performance.timeOrigin)) {
    return globalThis.performance.timeOrigin + globalThis.performance.now();
  }
  return Date.now();
}

function validateLoopState(value, durationSeconds) {
  if (value == null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const startSeconds = finiteRange(value.startSeconds, 0, durationSeconds);
  const endSeconds = finiteRange(value.endSeconds, 0, durationSeconds);
  const beatCount = Number.isSafeInteger(value.beatCount) && LOOP_BEAT_COUNTS.has(value.beatCount) ? value.beatCount : null;
  if (startSeconds === null || endSeconds === null || beatCount === null || endSeconds <= startSeconds) {
    return undefined;
  }
  return { startSeconds, endSeconds, beatCount };
}

function finiteTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteRange(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
