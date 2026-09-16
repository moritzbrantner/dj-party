import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, source) {
  fs.writeFileSync(path, source);
}

function replaceOnce(path, before, after) {
  let source = read(path);
  const index = source.indexOf(before);
  if (index < 0) {
    if (!after || source.includes(after)) return;
    throw new Error(`${path}: expected source fragment not found`);
  }
  source = `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
  write(path, source);
}

function insertBefore(path, marker, insertion, sentinel) {
  let source = read(path);
  if (source.includes(sentinel)) return;
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`${path}: insertion marker not found`);
  source = `${source.slice(0, index)}${insertion}${source.slice(index)}`;
  write(path, source);
}

function replaceRange(path, startMarker, endMarker, replacement, sentinel) {
  let source = read(path);
  if (source.includes(sentinel)) return;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`${path}: range start not found`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`${path}: range end not found`);
  source = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  write(path, source);
}

write(
  "web/performance-transport.ts",
  `import { isTrackContentId } from "./track-identity.js";\n\nconst MAX_TRACK_SECONDS = 12 * 60 * 60;\nconst BEAT_JUMP_DELTAS = new Set([-8, -4, 4, 8]);\nconst SEEK_SOURCES = new Set(["cue", "hot-cue", "phase-sync"]);\n\nexport function validatePerformanceAction(value) {\n  if (!value || typeof value !== "object" || Array.isArray(value) || !isTrackContentId(value.trackContentId)) {\n    return null;\n  }\n\n  if (value.kind === "beat-jump") {\n    const delta = Number.isSafeInteger(value.delta) && BEAT_JUMP_DELTAS.has(value.delta) ? value.delta : null;\n    return delta === null ? null : { trackContentId: value.trackContentId, kind: "beat-jump", delta };\n  }\n\n  if (value.kind === "seek") {\n    const positionSeconds =\n      typeof value.positionSeconds === "number" &&\n      Number.isFinite(value.positionSeconds) &&\n      value.positionSeconds >= 0 &&\n      value.positionSeconds <= MAX_TRACK_SECONDS\n        ? value.positionSeconds\n        : null;\n    const source = typeof value.source === "string" && SEEK_SOURCES.has(value.source) ? value.source : null;\n    return positionSeconds === null || source === null\n      ? null\n      : { trackContentId: value.trackContentId, kind: "seek", source, positionSeconds };\n  }\n\n  return null;\n}\n`,
);

write(
  "web/performance-transport.test.mjs",
  `import assert from "node:assert/strict";\nimport test from "node:test";\n\nimport { validatePerformanceAction } from "./performance-transport.js";\n\nconst TRACK = "a".repeat(64);\n\ntest("performance actions are exact-track, bounded, and normalized", () => {\n  assert.deepEqual(\n    validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 4, slot: 2 }),\n    { trackContentId: TRACK, kind: "beat-jump", delta: 4 },\n  );\n  assert.equal(validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 5 }), null);\n  assert.equal(validatePerformanceAction({ trackContentId: "A".repeat(64), kind: "beat-jump", delta: 4 }), null);\n\n  assert.deepEqual(\n    validatePerformanceAction({\n      trackContentId: TRACK,\n      kind: "seek",\n      source: "hot-cue",\n      positionSeconds: 42.5,\n      slot: 3,\n      label: "secret local cue",\n    }),\n    { trackContentId: TRACK, kind: "seek", source: "hot-cue", positionSeconds: 42.5 },\n  );\n  assert.equal(\n    validatePerformanceAction({ trackContentId: TRACK, kind: "seek", source: "unknown", positionSeconds: 1 }),\n    null,\n  );\n  assert.equal(\n    validatePerformanceAction({ trackContentId: TRACK, kind: "seek", source: "cue", positionSeconds: "1" }),\n    null,\n  );\n});\n`,
);

replaceOnce(
  "web/shared-playback.ts",
  `import { isTrackContentId } from "./track-identity.js";`,
  `import { validatePerformanceAction } from "./performance-transport.js";\nimport { isTrackContentId } from "./track-identity.js";`,
);
replaceOnce(
  "web/shared-playback.ts",
  `export const SHARED_PLAYBACK_PROTOCOL = 2;`,
  `export const SHARED_PLAYBACK_PROTOCOL = 3;`,
);
replaceOnce(
  "web/shared-playback.ts",
  `const REQUEST_TYPE = "dj-party/playback/request";`,
  `const REQUEST_TYPE = "dj-party/playback/request";\nconst PERFORMANCE_REQUEST_TYPE = "dj-party/playback/performance-request";`,
);

insertBefore(
  "web/shared-playback.ts",
  `\n  publishSnapshot() {`,
  `\n  submitLocalPerformanceAction(deckId, value) {\n    const action = validatePerformanceAction(value);\n    if (!DECK_IDS.includes(deckId) || !action || !this.transport || !this.playback) {\n      return false;\n    }\n    if (\n      typeof this.playback.canApplyPerformanceAction !== "function" ||\n      typeof this.playback.applyPerformanceAction !== "function" ||\n      !this.playback.canApplyPerformanceAction(deckId, action)\n    ) {\n      return false;\n    }\n    const network = this.transport.snapshot();\n    if (network?.state !== "connected") {\n      return false;\n    }\n\n    if (this.#isHost()) {\n      const state = validateDeckPlaybackState(this.playback.captureState?.()?.[deckId]);\n      if (!state || state.trackContentId !== action.trackContentId) {\n        return false;\n      }\n      this.transport.broadcastApplicationReliable(this.#canonicalize(deckId, state));\n      this.ready = true;\n      this.#emitChange();\n      return true;\n    }\n\n    if (!this.ready || !this.clockReady) {\n      return false;\n    }\n    const host = network.hostParticipantId;\n    if (typeof host !== "string" || !network.compatiblePeerIds?.includes(host)) {\n      return false;\n    }\n    this.localRequestSequence += 1;\n    try {\n      this.transport.sendApplicationReliable(host, {\n        type: PERFORMANCE_REQUEST_TYPE,\n        protocol: SHARED_PLAYBACK_PROTOCOL,\n        requestSequence: this.localRequestSequence,\n        deckId,\n        action,\n      });\n      return true;\n    } catch {\n      this.ready = false;\n      this.snapshotRequestPending = false;\n      this.#emitChange();\n      return false;\n    }\n  }\n`,
  `submitLocalPerformanceAction(deckId, value)`,
);

replaceRange(
  "web/shared-playback.ts",
  `      if (data.type !== REQUEST_TYPE || !this.playback) {`,
  `\n    const host = this.transport.snapshot()?.hostParticipantId;`,
  `      if ((data.type !== REQUEST_TYPE && data.type !== PERFORMANCE_REQUEST_TYPE) || !this.playback) {\n        return;\n      }\n      const requestSequence = positiveSafeInteger(data.requestSequence);\n      const deckId = DECK_IDS.includes(data.deckId) ? data.deckId : null;\n      if (!requestSequence || !deckId) {\n        return;\n      }\n      const state = data.type === REQUEST_TYPE ? validateDeckPlaybackState(data.state) : null;\n      const action = data.type === PERFORMANCE_REQUEST_TYPE ? validatePerformanceAction(data.action) : null;\n      if ((data.type === REQUEST_TYPE && !state) || (data.type === PERFORMANCE_REQUEST_TYPE && !action)) {\n        return;\n      }\n      const previous = this.lastRequestSequenceByPeer.get(peerId) ?? 0;\n      if (requestSequence <= previous) {\n        return;\n      }\n      this.lastRequestSequenceByPeer.set(peerId, requestSequence);\n\n      if (action) {\n        if (\n          typeof this.playback.canApplyPerformanceAction !== "function" ||\n          typeof this.playback.applyPerformanceAction !== "function" ||\n          !this.playback.canApplyPerformanceAction(deckId, action)\n        ) {\n          return;\n        }\n        const applied = await this.playback.applyPerformanceAction(deckId, action, {\n          source: "remote-request",\n          peerId,\n        });\n        if (applied === false) {\n          return;\n        }\n        const canonicalState = validateDeckPlaybackState(this.playback.captureState?.()?.[deckId]);\n        if (!canonicalState || canonicalState.trackContentId !== action.trackContentId) {\n          return;\n        }\n        this.transport.broadcastApplicationReliable(this.#canonicalize(deckId, canonicalState));\n        this.#emitChange();\n        return;\n      }\n\n      if (!this.playback.canApplyDeckState(deckId, state)) {\n        return;\n      }\n      const applied = await this.playback.applyDeckState(deckId, state, {\n        elapsedMs: 0,\n        source: "remote-request",\n        peerId,\n      });\n      if (applied === false) {\n        return;\n      }\n      const canonicalState = validateDeckPlaybackState(this.playback.captureState()?.[deckId]);\n      if (!canonicalState) {\n        return;\n      }\n      this.transport.broadcastApplicationReliable(this.#canonicalize(deckId, canonicalState));\n      this.#emitChange();\n      return;\n    }\n`,
  `PERFORMANCE_REQUEST_TYPE && !this.playback`,
);

replaceOnce(
  "web/collaborative-playback.ts",
  `import { sharedPlaybackSession } from "./shared-playback.js";`,
  `import { validatePerformanceAction } from "./performance-transport.js";\nimport { sharedPlaybackSession } from "./shared-playback.js";`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  `  declare mixerModule: any;\n  declare status: any;`,
  `  declare mixerModule: any;\n  declare performanceSuppression: any;\n  declare status: any;`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  `    this.applyingRemote = new Set();\n    this.unsubscribers = [];`,
  `    this.applyingRemote = new Set();\n    this.performanceSuppression = new Map();\n    this.unsubscribers = [];`,
);

insertBefore(
  "web/collaborative-playback.ts",
  `\n  destroy() {`,
  `\n  canApplyPerformanceAction(deckId, value) {\n    const action = validatePerformanceAction(value);\n    if (!action || !DECK_IDS.includes(deckId) || this.trackContentIds.get(deckId) !== action.trackContentId) {\n      return false;\n    }\n    const local = this.mixerModule.captureDeckTransport(deckId);\n    if (!local || !Number.isFinite(local.durationSeconds) || local.durationSeconds <= 0) {\n      return false;\n    }\n    return action.kind !== "seek" || action.positionSeconds <= local.durationSeconds;\n  }\n\n  async applyPerformanceAction(deckId, value) {\n    const action = validatePerformanceAction(value);\n    if (\n      !action ||\n      !this.canApplyPerformanceAction(deckId, action) ||\n      typeof this.mixerModule.applyDeckPerformanceAction !== "function"\n    ) {\n      return false;\n    }\n\n    this.applyingRemote.add(deckId);\n    try {\n      return (await this.mixerModule.applyDeckPerformanceAction(deckId, action)) === true;\n    } finally {\n      await nextTask();\n      this.applyingRemote.delete(deckId);\n    }\n  }\n`,
  `canApplyPerformanceAction(deckId, value)`,
);

replaceOnce(
  "web/collaborative-playback.ts",
  `      const unsubscribe = this.mixerModule.subscribeDeckTransport(deckId, () => this.#localTransportChanged(deckId));\n      this.unsubscribers.push(unsubscribe);`,
  `      const unsubscribe = this.mixerModule.subscribeDeckTransport(deckId, () => this.#localTransportChanged(deckId));\n      this.unsubscribers.push(unsubscribe);\n      if (typeof this.mixerModule.subscribeDeckPerformanceTransport === "function") {\n        const unsubscribePerformance = this.mixerModule.subscribeDeckPerformanceTransport(deckId, (action) =>\n          this.#localPerformanceChanged(deckId, action),\n        );\n        this.unsubscribers.push(unsubscribePerformance);\n      }`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  `    const state = this.#sharedStateForDeck(deckId);\n    if (state) {\n      this.coordinator.submitLocalDeckState(deckId, state);\n    }\n    this.#renderStatus(this.coordinator.snapshot());`,
  `    const state = this.#sharedStateForDeck(deckId);\n    if (state) {\n      const suppressed = this.performanceSuppression.get(deckId);\n      this.performanceSuppression.delete(deckId);\n      if (!suppressed || !sameSharedState(suppressed, state)) {\n        this.coordinator.submitLocalDeckState(deckId, state);\n      }\n    }\n    this.#renderStatus(this.coordinator.snapshot());`,
);
insertBefore(
  "web/collaborative-playback.ts",
  `\n  #bindTrackIdentity() {`,
  `\n  #localPerformanceChanged(deckId, value) {\n    if (this.applyingRemote.has(deckId)) {\n      return;\n    }\n    const trackContentId = this.trackContentIds.get(deckId);\n    const state = this.#sharedStateForDeck(deckId);\n    const action = validatePerformanceAction({ ...value, trackContentId });\n    if (!state || !action || typeof this.coordinator.submitLocalPerformanceAction !== "function") {\n      return;\n    }\n    const submitted = this.coordinator.submitLocalPerformanceAction(deckId, action) === true;\n    if (submitted) {\n      this.performanceSuppression.set(deckId, state);\n    }\n    this.#renderStatus(this.coordinator.snapshot());\n  }\n`,
  `#localPerformanceChanged(deckId, value)`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  `    this.trackContentIds.set(deckId, null);\n    this.coordinator.refreshLocalTracks();`,
  `    this.trackContentIds.set(deckId, null);\n    this.performanceSuppression.delete(deckId);\n    this.coordinator.refreshLocalTracks();`,
);
insertBefore(
  "web/collaborative-playback.ts",
  `\nfunction projectSharedPosition(state, elapsedMs) {`,
  `\nfunction sameSharedState(left, right) {\n  if (!left || !right) {\n    return false;\n  }\n  const sameLoop =\n    left.loop === right.loop ||\n    (left.loop &&\n      right.loop &&\n      left.loop.beatCount === right.loop.beatCount &&\n      Math.abs(left.loop.startSeconds - right.loop.startSeconds) < 1e-6 &&\n      Math.abs(left.loop.endSeconds - right.loop.endSeconds) < 1e-6);\n  return (\n    left.trackContentId === right.trackContentId &&\n    left.playing === right.playing &&\n    Math.abs(left.positionSeconds - right.positionSeconds) < 0.1 &&\n    Math.abs(left.durationSeconds - right.durationSeconds) < 1e-6 &&\n    Math.abs(left.playbackRate - right.playbackRate) < 1e-6 &&\n    Boolean(sameLoop)\n  );\n}\n`,
  `function sameSharedState(left, right)`,
);

replaceOnce(
  "web/performance.ts",
  `    this.seekTransportTarget(seconds);\n    this.hotCueStatus.textContent = \`Jumped to hot cue \${slot}\`;`,
  `    this.seekTransportTarget(seconds, { source: "hot-cue", share: true });\n    this.hotCueStatus.textContent = \`Jumped to hot cue \${slot}\`;`,
);
replaceOnce(
  "web/performance.ts",
  `  beatJump(delta) {`,
  `  beatJump(delta, { share = true } = {}) {`,
);
replaceOnce(
  "web/performance.ts",
  `    if (!Number.isFinite(duration) || duration <= 0) {\n      return;\n    }\n\n    const plan = plan_beat_jump`,
  `    if (!Number.isFinite(duration) || duration <= 0) {\n      return false;\n    }\n\n    const plan = plan_beat_jump`,
);
replaceOnce(
  "web/performance.ts",
  `        this.beatJumpStatus.textContent = "Jump would leave the verified beat grid";\n        return;\n      }\n\n      this.seekTransportTarget(plan.target_seconds());\n      this.beatJumpStatus.textContent = \`${"${delta > 0 ? \"+\" : \"\"}${delta} beats"}\`;`,
  `        this.beatJumpStatus.textContent = "Jump would leave the verified beat grid";\n        return false;\n      }\n\n      const moved = this.seekTransportTarget(plan.target_seconds(), { share: false });\n      if (!moved) {\n        return false;\n      }\n      this.beatJumpStatus.textContent = \`${"${delta > 0 ? \"+\" : \"\"}${delta} beats"}\`;\n      if (share) {\n        this.deck.notifyPerformanceTransport?.({ kind: "beat-jump", delta });\n      }\n      return true;`,
);
replaceOnce(
  "web/performance.ts",
  `      this.seekTransportTarget(plan.target_seconds());\n      const alignment = plan.bar_aligned() ? "bar + beat phase" : "beat phase";`,
  `      this.seekTransportTarget(plan.target_seconds(), { source: "phase-sync", share: true });\n      const alignment = plan.bar_aligned() ? "bar + beat phase" : "beat phase";`,
);
replaceOnce(
  "web/performance.ts",
  `  seekTransportTarget(seconds) {\n    if (!Number.isFinite(seconds)) {\n      return;\n    }`,
  `  seekTransportTarget(seconds, { source = null, share = false } = {}) {\n    if (!Number.isFinite(seconds)) {\n      return false;\n    }`,
);
replaceOnce(
  "web/performance.ts",
  `    this.deck.audio.currentTime = Math.min(Math.max(0, seconds), this.deck.audio.duration || seconds);\n    this.deck.updateProgress();\n  }`,
  `    const target = Math.min(Math.max(0, seconds), this.deck.audio.duration || seconds);\n    this.deck.audio.currentTime = target;\n    this.deck.updateProgress();\n    if (share && source) {\n      this.deck.notifyPerformanceTransport?.({ kind: "seek", source, positionSeconds: target });\n    }\n    return true;\n  }`,
);

replaceOnce(
  "web/mixer-app.ts",
  `  declare performance: any;\n  declare platter: any;`,
  `  declare performance: any;\n  declare performanceTransportListeners: any;\n  declare platter: any;`,
);
replaceOnce(
  "web/mixer-app.ts",
  `    this.activeLoop = null;\n    this.animationFrame = null;`,
  `    this.activeLoop = null;\n    this.animationFrame = null;\n    this.performanceTransportListeners = new Set();`,
);
replaceOnce(
  "web/mixer-app.ts",
  `      this.audio.currentTime = Math.min(this.cue.seconds(), this.audio.duration || this.cue.seconds());\n      this.enforceLoop();\n      this.updateProgress();`,
  `      this.performance.seekTransportTarget(\n        Math.min(this.cue.seconds(), this.audio.duration || this.cue.seconds()),\n        { source: "cue", share: true },\n      );`,
);
insertBefore(
  "web/mixer-app.ts",
  `\n  loadFile(file) {`,
  `\n  notifyPerformanceTransport(action) {\n    for (const listener of this.performanceTransportListeners) {\n      listener(action);\n    }\n  }\n\n  subscribePerformanceTransport(listener) {\n    if (typeof listener !== "function") {\n      return () => {};\n    }\n    this.performanceTransportListeners.add(listener);\n    return () => this.performanceTransportListeners.delete(listener);\n  }\n`,
  `notifyPerformanceTransport(action)`,
);
insertBefore(
  "web/mixer-app.ts",
  `\nexport function captureDeckTransport(deckId) {`,
  `\nexport function subscribeDeckPerformanceTransport(deckId, listener) {\n  const deck = state.decks.get(deckId);\n  return deck?.subscribePerformanceTransport(listener) ?? (() => {});\n}\n\nexport async function applyDeckPerformanceAction(deckId, action) {\n  const deck = state.decks.get(deckId);\n  if (!deck || !action || typeof action !== "object") {\n    return false;\n  }\n  if (action.kind === "beat-jump") {\n    return deck.performance.beatJump(action.delta, { share: false }) === true;\n  }\n  if (action.kind === "seek") {\n    return deck.performance.seekTransportTarget(action.positionSeconds, { share: false }) === true;\n  }\n  return false;\n}\n`,
  `export function subscribeDeckPerformanceTransport`,
);

write(
  "web/shared-performance-transport.test.mjs",
  `import assert from "node:assert/strict";\nimport test from "node:test";\n\nimport { CollaborativePlaybackAdapter } from "./collaborative-playback.js";\nimport { SHARED_PLAYBACK_PROTOCOL, SharedPlaybackCoordinator } from "./shared-playback.js";\n\nif (typeof globalThis.CustomEvent !== "function") {\n  globalThis.CustomEvent = class CustomEvent extends Event {\n    constructor(type, { detail } = {}) {\n      super(type);\n      this.detail = detail;\n    }\n  };\n}\n\nconst TRACK = "a".repeat(64);\n\nfunction deckState(positionSeconds = 12) {\n  return {\n    trackContentId: TRACK,\n    playing: false,\n    positionSeconds,\n    durationSeconds: 240,\n    playbackRate: 1,\n    loop: null,\n  };\n}\n\ntest("host replays guest beat-jump intent before broadcasting canonical playback", async () => {\n  const transport = new FakeTransport();\n  const playback = new FakePlayback();\n  const coordinator = new SharedPlaybackCoordinator();\n  coordinator.registerPlayback(playback);\n  coordinator.attachTransport(transport);\n\n  transport.application("GUEST", {\n    type: "dj-party/playback/performance-request",\n    protocol: SHARED_PLAYBACK_PROTOCOL,\n    requestSequence: 1,\n    deckId: "a",\n    action: { trackContentId: TRACK, kind: "beat-jump", delta: 4 },\n  });\n  await tick();\n\n  assert.deepEqual(playback.actions, [{ deckId: "a", action: { trackContentId: TRACK, kind: "beat-jump", delta: 4 } }]);\n  assert.equal(transport.broadcasts.length, 1);\n  assert.equal(transport.broadcasts[0].type, "dj-party/playback/command");\n  assert.equal(transport.broadcasts[0].state.positionSeconds, 16);\n\n  transport.application("GUEST", {\n    type: "dj-party/playback/performance-request",\n    protocol: SHARED_PLAYBACK_PROTOCOL,\n    requestSequence: 1,\n    deckId: "a",\n    action: { trackContentId: TRACK, kind: "beat-jump", delta: 8 },\n  });\n  await tick();\n  assert.equal(playback.actions.length, 1);\n});\n\ntest("collaborative adapter submits one semantic action and suppresses its duplicate seek state", async () => {\n  const mixer = new FakeMixer();\n  const coordinator = new FakeCoordinator();\n  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator });\n  adapter.trackContentIds.set("a", TRACK);\n  await adapter.install();\n\n  mixer.states.a.positionSeconds = 20;\n  mixer.emitPerformance("a", { kind: "beat-jump", delta: 4 });\n  mixer.emitTransport("a");\n\n  assert.deepEqual(coordinator.performance, [\n    { deckId: "a", action: { trackContentId: TRACK, kind: "beat-jump", delta: 4 } },\n  ]);\n  assert.deepEqual(coordinator.states, []);\n  adapter.destroy();\n});\n\ntest("remote semantic actions require the exact local track and use the mixer bridge", async () => {\n  const mixer = new FakeMixer();\n  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });\n  adapter.trackContentIds.set("a", TRACK);\n\n  assert.equal(\n    await adapter.applyPerformanceAction("a", { trackContentId: TRACK, kind: "seek", source: "cue", positionSeconds: 33 }),\n    true,\n  );\n  assert.deepEqual(mixer.appliedPerformance, [\n    { deckId: "a", action: { trackContentId: TRACK, kind: "seek", source: "cue", positionSeconds: 33 } },\n  ]);\n  assert.equal(\n    await adapter.applyPerformanceAction("a", { trackContentId: "b".repeat(64), kind: "beat-jump", delta: 4 }),\n    false,\n  );\n});\n\nclass FakeTransport extends EventTarget {\n  constructor() {\n    super();\n    this.sent = [];\n    this.broadcasts = [];\n  }\n\n  snapshot() {\n    return { state: "connected", participantId: "HOST", hostParticipantId: "HOST", compatiblePeerIds: ["GUEST"] };\n  }\n\n  sendApplicationReliable(peerId, data) {\n    this.sent.push({ peerId, data });\n  }\n\n  broadcastApplicationReliable(data) {\n    this.broadcasts.push(data);\n    return 1;\n  }\n\n  application(peerId, data) {\n    this.dispatchEvent(new CustomEvent("application-message", { detail: { peerId, data } }));\n  }\n}\n\nclass FakePlayback {\n  constructor() {\n    this.state = deckState();\n    this.actions = [];\n  }\n\n  captureState() {\n    return { a: { ...this.state }, b: null };\n  }\n\n  canApplyDeckState(deckId, state) {\n    return deckId === "a" && state.trackContentId === TRACK;\n  }\n\n  async applyDeckState() {\n    return true;\n  }\n\n  canApplyPerformanceAction(deckId, action) {\n    return deckId === "a" && action.trackContentId === TRACK;\n  }\n\n  async applyPerformanceAction(deckId, action) {\n    this.actions.push({ deckId, action });\n    if (action.kind === "beat-jump") this.state.positionSeconds += action.delta;\n    if (action.kind === "seek") this.state.positionSeconds = action.positionSeconds;\n    return true;\n  }\n}\n\nclass FakeMixer {\n  constructor() {\n    this.states = {\n      a: { playing: false, positionSeconds: 12, durationSeconds: 240, playbackRate: 1, loopActive: false, loop: null },\n      b: { playing: false, positionSeconds: 0, durationSeconds: 180, playbackRate: 1, loopActive: false, loop: null },\n    };\n    this.transportListeners = { a: new Set(), b: new Set() };\n    this.performanceListeners = { a: new Set(), b: new Set() };\n    this.appliedPerformance = [];\n  }\n\n  captureDeckTransport(deckId) {\n    return { ...this.states[deckId] };\n  }\n\n  subscribeDeckTransport(deckId, listener) {\n    this.transportListeners[deckId].add(listener);\n    return () => this.transportListeners[deckId].delete(listener);\n  }\n\n  subscribeDeckPerformanceTransport(deckId, listener) {\n    this.performanceListeners[deckId].add(listener);\n    return () => this.performanceListeners[deckId].delete(listener);\n  }\n\n  async applyDeckTransport() {\n    return true;\n  }\n\n  async applyDeckPerformanceAction(deckId, action) {\n    this.appliedPerformance.push({ deckId, action });\n    return true;\n  }\n\n  emitTransport(deckId) {\n    for (const listener of this.transportListeners[deckId]) listener(this.captureDeckTransport(deckId));\n  }\n\n  emitPerformance(deckId, action) {\n    for (const listener of this.performanceListeners[deckId]) listener(action);\n  }\n}\n\nclass FakeCoordinator extends EventTarget {\n  constructor() {\n    super();\n    this.states = [];\n    this.performance = [];\n  }\n\n  registerPlayback() {\n    return () => {};\n  }\n\n  submitLocalDeckState(deckId, state) {\n    this.states.push({ deckId, state });\n    return true;\n  }\n\n  submitLocalPerformanceAction(deckId, action) {\n    this.performance.push({ deckId, action });\n    return true;\n  }\n\n  refreshLocalTracks() {\n    return true;\n  }\n\n  snapshot() {\n    return { active: false, ready: false, role: null, canonicalSequence: 0, clockReady: false, blockedDeckIds: [] };\n  }\n}\n\nfunction tick() {\n  return new Promise((resolve) => setTimeout(resolve, 0));\n}\n`,
);

replaceOnce(
  "README.md",
  `   - richer performance-transport semantics — next\n   - optional verified asset transfer and broader collaborative mixing — later`,
  `   - richer performance-transport semantics — implemented\n   - optional verified asset transfer and broader collaborative mixing — next`,
);
replaceOnce(
  "README.md",
  `Cue definitions, hot-cue definitions, and content bytes likewise remain local. Their resulting one-off playhead movement can converge through ordinary bounded playback state once the exact-track and clock requirements are satisfied.`,
  `Cue and hot-cue definitions remain local. Their one-off jumps cross the peer link only as normalized bounded seek intents carrying the exact track identity; no slot, label, or definition is shared. Beat jumps cross as bounded ±4/±8-beat intents and are re-planned by the host through the existing Rust-owned beat-jump policy before canonical playback is broadcast. Phase Sync may publish its resulting bounded seek while tempo remains part of mixer authority. Content bytes remain local.`,
);
replaceOnce(
  "AGENTS.md",
  `- Cue/hot-cue/beat-jump definitions remain local. Their resulting playhead seek may be represented by bounded shared transport state only when exact track identity and clock requirements hold.`,
  `- Cue and hot-cue definitions remain local. Shared performance transport may carry only their normalized bounded target seek plus exact track identity; never share slot mappings, labels, or cue banks. Beat jumps must cross as bounded ±4/±8-beat semantic intents and the host must re-run them through the existing Rust-owned beat-jump planner before broadcasting canonical playback. Phase Sync may share its resulting bounded seek while tempo remains mixer authority.`,
);
replaceOnce(
  "AGENTS.md",
  `14. playback authority covers exact SHA-256 track identity, host sequencing, per-peer replay protection, bounded three-sample clock alignment, contiguous canonical commands, late-join/gap snapshots, mismatched-track failure, and shared loop activation/exit validated against the local Rust beat-loop plan`,
  `14. playback authority covers exact SHA-256 track identity, host sequencing, per-peer replay protection across state and performance requests, bounded three-sample clock alignment, contiguous canonical commands, late-join/gap snapshots, mismatched-track failure, shared loop activation/exit validated against the local Rust beat-loop plan, host-replayed beat jumps, and bounded cue/hot-cue/phase-sync seek intents`,
);
replaceOnce(
  "AGENTS.md",
  `15. track bytes, decoded PCM, library storage, capability tokens, physical output routing, monitor controls, cue definitions, and hot-cue definitions never enter shared playback messages`,
  `15. track bytes, decoded PCM, library storage, capability tokens, physical output routing, monitor controls, cue definitions, hot-cue definitions, cue slots, and cue labels never enter shared playback messages`,
);
