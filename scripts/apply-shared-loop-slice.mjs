import fs from "node:fs";

function replaceOnce(path, before, after) {
  let source = fs.readFileSync(path, "utf8");
  if (source.includes(after)) {
    return;
  }
  const index = source.indexOf(before);
  if (index < 0) {
    throw new Error(`${path}: expected source fragment not found`);
  }
  source = `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
  fs.writeFileSync(path, source);
}

replaceOnce(
  "web/shared-playback.ts",
  "export const SHARED_PLAYBACK_PROTOCOL = 1;",
  "export const SHARED_PLAYBACK_PROTOCOL = 2;",
);
replaceOnce(
  "web/shared-playback.ts",
  "const MAX_PLAYBACK_RATE = 1.16;",
  "const MAX_PLAYBACK_RATE = 1.16;\nconst LOOP_BEAT_COUNTS = new Set([1, 2, 4, 8]);",
);
replaceOnce(
  "web/shared-playback.ts",
  `  if (\n    positionSeconds === null ||\n    durationSeconds === null ||\n    playbackRate === null ||\n    positionSeconds > durationSeconds\n  ) {\n    return null;\n  }\n  return {\n    trackContentId: value.trackContentId,\n    playing: value.playing,\n    positionSeconds,\n    durationSeconds,\n    playbackRate,\n  };`,
  `  if (\n    positionSeconds === null ||\n    durationSeconds === null ||\n    playbackRate === null ||\n    positionSeconds > durationSeconds\n  ) {\n    return null;\n  }\n  const loop = validateLoopState(value.loop, durationSeconds);\n  if (loop === undefined) {\n    return null;\n  }\n  return {\n    trackContentId: value.trackContentId,\n    playing: value.playing,\n    positionSeconds,\n    durationSeconds,\n    playbackRate,\n    loop,\n  };`,
);
replaceOnce(
  "web/shared-playback.ts",
  `      this.transport.broadcastApplicationReliable(this.#canonicalize(deckId, state));\n      this.#emitChange();\n      return;`,
  `      const canonicalState = validateDeckPlaybackState(this.playback.captureState()?.[deckId]);\n      if (!canonicalState) {\n        return;\n      }\n      this.transport.broadcastApplicationReliable(this.#canonicalize(deckId, canonicalState));\n      this.#emitChange();\n      return;`,
);
replaceOnce(
  "web/shared-playback.ts",
  `function finiteTimestamp(value) {`,
  `function validateLoopState(value, durationSeconds) {\n  if (value == null) {\n    return null;\n  }\n  if (!value || typeof value !== "object" || Array.isArray(value)) {\n    return undefined;\n  }\n  const startSeconds = finiteRange(value.startSeconds, 0, durationSeconds);\n  const endSeconds = finiteRange(value.endSeconds, 0, durationSeconds);\n  const beatCount = Number.isSafeInteger(value.beatCount) && LOOP_BEAT_COUNTS.has(value.beatCount) ? value.beatCount : null;\n  if (startSeconds === null || endSeconds === null || beatCount === null || endSeconds <= startSeconds) {\n    return undefined;\n  }\n  return { startSeconds, endSeconds, beatCount };\n}\n\nfunction finiteTimestamp(value) {`,
);

replaceOnce(
  "web/collaborative-playback.ts",
  "  declare loopSuspended: any;\n",
  "",
);
replaceOnce(
  "web/collaborative-playback.ts",
  "    this.loopSuspended = new Set();\n",
  "",
);
replaceOnce(
  "web/collaborative-playback.ts",
  `    if (!local || local.loopActive || !Number.isFinite(local.durationSeconds) || local.durationSeconds <= 0) {`,
  `    if (!local || !Number.isFinite(local.durationSeconds) || local.durationSeconds <= 0) {`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  `    const projectedPosition = state.positionSeconds + (state.playing ? (elapsedMs / 1000) * state.playbackRate : 0);\n    const localAuthorityState = {`,
  `    const projectedPosition = projectSharedPosition(state, elapsedMs);\n    if (projectedPosition === null) {\n      return false;\n    }\n    const localAuthorityState = {`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  `    const local = this.mixerModule.captureDeckTransport(deckId);\n    if (local?.loopActive) {\n      if (!this.loopSuspended.has(deckId)) {\n        this.loopSuspended.add(deckId);\n        this.coordinator.refreshLocalTracks();\n      }\n      this.#renderStatus(this.coordinator.snapshot());\n      return;\n    }\n    if (this.loopSuspended.delete(deckId)) {\n      this.coordinator.refreshLocalTracks();\n    }\n    const state = this.#sharedStateForDeck(deckId);`,
  `    const state = this.#sharedStateForDeck(deckId);`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  "    this.loopSuspended.delete(deckId);\n",
  "",
);
replaceOnce(
  "web/collaborative-playback.ts",
  `      !local ||\n      local.loopActive ||\n      !Number.isFinite(local.positionSeconds) ||`,
  `      !local ||\n      !Number.isFinite(local.positionSeconds) ||`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  `      durationSeconds: local.durationSeconds,\n      playbackRate: local.playbackRate,\n    };`,
  `      durationSeconds: local.durationSeconds,\n      playbackRate: local.playbackRate,\n      loop: local.loop ?? null,\n    };`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  `    const localLoop = DECK_IDS.some((deckId) => this.mixerModule.captureDeckTransport(deckId)?.loopActive);\n    if (localLoop) {\n      this.status.textContent = "Shared playback paused while a local beat loop is active";\n      return;\n    }\n`,
  "",
);
replaceOnce(
  "web/collaborative-playback.ts",
  `function looksLikeAudio(file) {`,
  `function projectSharedPosition(state, elapsedMs) {\n  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 10_000) {\n    return null;\n  }\n  if (!state.playing) {\n    return state.positionSeconds;\n  }\n  const advanced = state.positionSeconds + (elapsedMs / 1000) * state.playbackRate;\n  if (!state.loop) {\n    return Math.min(advanced, state.durationSeconds);\n  }\n  const span = state.loop.endSeconds - state.loop.startSeconds;\n  if (!Number.isFinite(span) || span <= 0) {\n    return null;\n  }\n  const offset = ((advanced - state.loop.startSeconds) % span + span) % span;\n  return state.loop.startSeconds + offset;\n}\n\nfunction looksLikeAudio(file) {`,
);
replaceOnce(
  "web/collaborative-playback.ts",
  "Shared playback needs matching track on Deck ${snapshot.blockedDeckIds.join(\"/\").toUpperCase()}",
  "Shared playback needs matching track and beat grid on Deck ${snapshot.blockedDeckIds.join(\"/\").toUpperCase()}",
);

replaceOnce(
  "web/mixer-app.ts",
  "const state = {",
  "const SHARED_LOOP_TOLERANCE_SECONDS = 0.02;\n\nconst state = {",
);
replaceOnce(
  "web/mixer-app.ts",
  `      this.activeLoop = {\n        start: plan.start_seconds(),\n        end: plan.end_seconds(),\n        beatCount: plan.beat_count(),\n      };\n      this.audio.currentTime = this.activeLoop.start;\n      this.loopOffButton.disabled = false;\n      this.loopStatus.textContent = \`${"${beatCount}"}-beat loop · ${"${formatTimePrecise(this.activeLoop.start)}"}–${"${formatTimePrecise(this.activeLoop.end)}"}\`;\n      for (const button of this.loopButtons) {\n        button.classList.toggle("is-active", Number(button.dataset.loopBeats) === beatCount);\n      }\n      this.updateProgress();`,
  `      this.applyLoopState({\n        start: plan.start_seconds(),\n        end: plan.end_seconds(),\n        beatCount: plan.beat_count(),\n      });\n      this.audio.currentTime = this.activeLoop.start;\n      this.updateProgress();`,
);
replaceOnce(
  "web/mixer-app.ts",
  `  disableLoop() {`,
  `  applyLoopState(loop) {\n    this.activeLoop = loop;\n    this.loopOffButton.disabled = false;\n    this.loopStatus.textContent = \`${"${loop.beatCount}"}-beat loop · ${"${formatTimePrecise(loop.start)}"}–${"${formatTimePrecise(loop.end)}"}\`;\n    for (const button of this.loopButtons) {\n      button.classList.toggle("is-active", Number(button.dataset.loopBeats) === loop.beatCount);\n    }\n    this.drawWaveform();\n  }\n\n  disableLoop() {`,
);
replaceOnce(
  "web/mixer-app.ts",
  `    loopActive: Boolean(deck.activeLoop),\n  };`,
  `    loopActive: Boolean(deck.activeLoop),\n    loop: deck.activeLoop\n      ? {\n          startSeconds: deck.activeLoop.start,\n          endSeconds: deck.activeLoop.end,\n          beatCount: deck.activeLoop.beatCount,\n        }\n      : null,\n  };`,
);
replaceOnce(
  "web/mixer-app.ts",
  `  if (!deck || deck.activeLoop || !value || typeof value !== "object") {`,
  `  if (!deck || !value || typeof value !== "object") {`,
);
replaceOnce(
  "web/mixer-app.ts",
  `  const projected = position + (value.playing === true ? (elapsedMs / 1000) * playbackRate : 0);\n  const target = Math.min(Math.max(0, projected), Math.max(0, duration - (value.playing === true ? 0.001 : 0)));\n  deck.setPlaybackRate(playbackRate);`,
  `  const loop = resolveSharedLoop(deck, value.loop, duration);\n  if (loop === undefined) {\n    return false;\n  }\n\n  const projected = position + (value.playing === true ? (elapsedMs / 1000) * playbackRate : 0);\n  const target = loop\n    ? projectLoopPosition(projected, loop, value.playing === true)\n    : Math.min(Math.max(0, projected), Math.max(0, duration - (value.playing === true ? 0.001 : 0)));\n  if (loop) {\n    deck.applyLoopState(loop);\n  } else if (deck.activeLoop) {\n    deck.disableLoop();\n  }\n  deck.setPlaybackRate(playbackRate);`,
);
replaceOnce(
  "web/mixer-app.ts",
  `  deck.audio.pause();\n  return true;\n}`,
  `  deck.audio.pause();\n  return true;\n}\n\nfunction resolveSharedLoop(deck, value, durationSeconds) {\n  if (value == null) {\n    return null;\n  }\n  if (!value || typeof value !== "object" || Array.isArray(value)) {\n    return undefined;\n  }\n  const startSeconds = Number(value.startSeconds);\n  const endSeconds = Number(value.endSeconds);\n  const beatCount = Number(value.beatCount);\n  if (\n    !Number.isFinite(startSeconds) ||\n    startSeconds < 0 ||\n    !Number.isFinite(endSeconds) ||\n    endSeconds <= startSeconds ||\n    endSeconds > durationSeconds ||\n    !Number.isSafeInteger(beatCount)\n  ) {\n    return undefined;\n  }\n\n  const plan = plan_beat_loop(deck.beats, startSeconds, beatCount, durationSeconds);\n  try {\n    if (!plan.valid() || plan.beat_count() !== beatCount) {\n      return undefined;\n    }\n    const start = plan.start_seconds();\n    const end = plan.end_seconds();\n    if (\n      Math.abs(start - startSeconds) > SHARED_LOOP_TOLERANCE_SECONDS ||\n      Math.abs(end - endSeconds) > SHARED_LOOP_TOLERANCE_SECONDS\n    ) {\n      return undefined;\n    }\n    return { start, end, beatCount };\n  } finally {\n    plan.free();\n  }\n}\n\nfunction projectLoopPosition(positionSeconds, loop, playing) {\n  if (!playing) {\n    return Math.min(Math.max(positionSeconds, loop.start), loop.end);\n  }\n  const span = loop.end - loop.start;\n  const offset = ((positionSeconds - loop.start) % span + span) % span;\n  return loop.start + offset;\n}`,
);

replaceOnce(
  "web/shared-playback.test.mjs",
  `    playbackRate: 1,\n    ...overrides,`,
  `    playbackRate: 1,\n    loop: null,\n    ...overrides,`,
);
replaceOnce(
  "web/shared-playback.test.mjs",
  `  assert.equal(validateDeckPlaybackState(deckState(TRACK_A, { positionSeconds: 241 })), null);`,
  `  assert.equal(validateDeckPlaybackState(deckState(TRACK_A, { positionSeconds: 241 })), null);\n  assert.deepEqual(\n    validateDeckPlaybackState(\n      deckState(TRACK_A, { loop: { startSeconds: 12, endSeconds: 14, beatCount: 2 } }),\n    ),\n    deckState(TRACK_A, { loop: { startSeconds: 12, endSeconds: 14, beatCount: 2 } }),\n  );\n  assert.equal(\n    validateDeckPlaybackState(deckState(TRACK_A, { loop: { startSeconds: 12, endSeconds: 14, beatCount: 3 } })),\n    null,\n  );\n  assert.equal(\n    validateDeckPlaybackState(deckState(TRACK_A, { loop: { startSeconds: 12, endSeconds: 241, beatCount: 2 } })),\n    null,\n  );`,
);
replaceOnce(
  "web/shared-playback.test.mjs",
  `  assert.equal(coordinator.submitLocalDeckState("a", deckState(TRACK_A, { playing: true })), true);`,
  `  assert.equal(\n    coordinator.submitLocalDeckState(\n      "a",\n      deckState(TRACK_A, { playing: true, loop: { startSeconds: 12, endSeconds: 14, beatCount: 2 } }),\n    ),\n    true,\n  );`,
);
replaceOnce(
  "web/shared-playback.test.mjs",
  `      state: deckState(TRACK_A, { playing: true }),`,
  `      state: deckState(TRACK_A, { playing: true, loop: { startSeconds: 12, endSeconds: 14, beatCount: 2 } }),`,
);

replaceOnce(
  "web/collaborative-playback.test.mjs",
  `    playbackRate: 1,\n    ...overrides,`,
  `    playbackRate: 1,\n    loop: null,\n    ...overrides,`,
);
replaceOnce(
  "web/collaborative-playback.test.mjs",
  `    playbackRate: 1,\n  });`,
  `    playbackRate: 1,\n    loop: null,\n  });`,
);
replaceOnce(
  "web/collaborative-playback.test.mjs",
  `test("adapter rejects remote playback for a different track or active local loop", () => {\n  const mixer = new FakeMixerModule();\n  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });\n  adapter.trackContentIds.set("a", TRACK_A);\n\n  assert.equal(adapter.canApplyDeckState("a", sharedState(TRACK_B)), false);\n  mixer.states.a.loopActive = true;\n  assert.equal(adapter.canApplyDeckState("a", sharedState(TRACK_A)), false);\n});`,
  `test("adapter rejects remote playback for a different track without treating local loops as a separate authority", () => {\n  const mixer = new FakeMixerModule();\n  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });\n  adapter.trackContentIds.set("a", TRACK_A);\n\n  assert.equal(adapter.canApplyDeckState("a", sharedState(TRACK_B)), false);\n  mixer.states.a.loopActive = true;\n  mixer.states.a.loop = { startSeconds: 10, endSeconds: 12, beatCount: 2 };\n  assert.equal(adapter.canApplyDeckState("a", sharedState(TRACK_A)), true);\n});`,
);
replaceOnce(
  "web/collaborative-playback.test.mjs",
  `test("local mixer transport events become shared deck-state submissions", async () => {`,
  `test("remote loop playback wraps projected host time while preserving mixer-owned local tempo", async () => {\n  const mixer = new FakeMixerModule();\n  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator: new FakeCoordinator() });\n  adapter.trackContentIds.set("a", TRACK_A);\n\n  const remote = sharedState(TRACK_A, {\n    playing: true,\n    positionSeconds: 11.9,\n    playbackRate: 1,\n    loop: { startSeconds: 10, endSeconds: 12, beatCount: 2 },\n  });\n  assert.equal(await adapter.applyDeckState("a", remote, { elapsedMs: 250 }), true);\n  assert.equal(mixer.applied[0].state.positionSeconds, 10.15);\n  assert.deepEqual(mixer.applied[0].state.loop, remote.loop);\n});\n\ntest("local mixer transport events become shared deck-state submissions", async () => {`,
);
replaceOnce(
  "web/collaborative-playback.test.mjs",
  `test("local loop activation suspends sharing and loop exit reconciles before resuming", async () => {\n  const mixer = new FakeMixerModule();\n  const coordinator = new FakeCoordinator();\n  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator });\n  adapter.trackContentIds.set("a", TRACK_A);\n\n  await adapter.install();\n  mixer.states.a.loopActive = true;\n  mixer.emit("a");\n  assert.equal(coordinator.refreshes, 1);\n  assert.deepEqual(coordinator.submitted, []);\n\n  mixer.states.a.loopActive = false;\n  mixer.emit("a");\n  assert.equal(coordinator.refreshes, 2);\n  assert.deepEqual(coordinator.submitted, [{ deckId: "a", state: sharedState(TRACK_A) }]);\n  adapter.destroy();\n});`,
  `test("local loop activation and exit are submitted through the existing shared playback authority", async () => {\n  const mixer = new FakeMixerModule();\n  const coordinator = new FakeCoordinator();\n  const adapter = new CollaborativePlaybackAdapter({ mixerModule: mixer, coordinator });\n  adapter.trackContentIds.set("a", TRACK_A);\n\n  await adapter.install();\n  mixer.states.a.loopActive = true;\n  mixer.states.a.loop = { startSeconds: 10, endSeconds: 12, beatCount: 2 };\n  mixer.emit("a");\n  assert.deepEqual(coordinator.submitted, [\n    {\n      deckId: "a",\n      state: sharedState(TRACK_A, { loop: { startSeconds: 10, endSeconds: 12, beatCount: 2 } }),\n    },\n  ]);\n\n  mixer.states.a.loopActive = false;\n  mixer.states.a.loop = null;\n  mixer.emit("a");\n  assert.deepEqual(coordinator.submitted.at(-1), { deckId: "a", state: sharedState(TRACK_A) });\n  assert.equal(coordinator.refreshes, 0);\n  adapter.destroy();\n});`,
);
replaceOnce(
  "web/collaborative-playback.test.mjs",
  `      a: { playing: false, positionSeconds: 12, durationSeconds: 240, playbackRate: 1, loopActive: false },\n      b: { playing: false, positionSeconds: 0, durationSeconds: 180, playbackRate: 1, loopActive: false },`,
  `      a: { playing: false, positionSeconds: 12, durationSeconds: 240, playbackRate: 1, loopActive: false, loop: null },\n      b: { playing: false, positionSeconds: 0, durationSeconds: 180, playbackRate: 1, loopActive: false, loop: null },`,
);

replaceOnce(
  "README.md",
  `- synchronize play/pause and playhead position when both peers already have the exact same locally loaded track, verified by the SHA-256 digest of the encoded file bytes;`,
  `- synchronize play/pause, playhead position, and 1/2/4/8-beat loop lifecycle when both peers already have the exact same locally loaded track and a compatible locally analyzed beat window, verified by the SHA-256 digest of the encoded file bytes;`,
);
replaceOnce(
  "README.md",
  `Library blobs, playlists, cached analysis metadata, selected track files, decoded PCM, cue/hot-cue definitions, beat-loop definitions, and physical monitor/output routing remain on the device.`,
  `Library blobs, playlists, cached analysis metadata, selected track files, decoded PCM, cue/hot-cue definitions, and physical monitor/output routing remain on the device.`,
);
replaceOnce(
  "README.md",
  `Active beat loops remain intentionally local in this phase. A deck with a local active loop does not participate in shared playback until the loop is disabled, rather than pretending a loop definition has been synchronized. Cue definitions, hot-cue definitions, and content bytes likewise remain local. Their resulting one-off playhead movement can converge through ordinary bounded playback state once the exact-track and clock requirements are satisfied.`,
  `Beat-loop lifecycle is part of shared playback protocol v2. Loop activation carries only the bounded beat count and start/end transport window; every receiving deck must independently reproduce that window through the local Rust-owned beat-loop planner before applying it. Loop exit is represented by a null loop. A mismatched local beat grid fails closed and requires reconciliation rather than accepting remote loop arithmetic. Cue definitions, hot-cue definitions, and content bytes remain local; their resulting one-off playhead movement can still converge through ordinary bounded playback state once the exact-track and clock requirements are satisfied.`,
);
replaceOnce(
  "README.md",
  `   - shared loop lifecycle and richer performance-transport semantics — next\n   - optional verified asset transfer and broader collaborative mixing — later`,
  `   - shared loop lifecycle — implemented\n   - richer performance-transport semantics — next\n   - optional verified asset transfer and broader collaborative mixing — later`,
);

replaceOnce(
  "AGENTS.md",
  `- Active beat loops remain local in this phase and must block shared playback application/submission rather than silently diverging. Loop definitions and loop lifecycle become shareable only in a later explicit protocol slice.`,
  `- Shared playback protocol v2 may carry a bounded 1/2/4/8-beat loop lifecycle together with exact-track transport state. The receiver must re-derive the requested loop through the local Rust-owned beat-loop planner and fail closed if the local analyzed beat window does not match the transmitted start/end bounds. Networking code must not invent or duplicate beat-loop arithmetic.`,
);
replaceOnce(
  "AGENTS.md",
  `14. playback authority covers exact SHA-256 track identity, host sequencing, per-peer replay protection, bounded three-sample clock alignment, contiguous canonical commands, late-join/gap snapshots, and mismatched-track failure\n15. track bytes, decoded PCM, library storage, capability tokens, physical output routing, monitor controls, and active loop definitions never enter shared playback messages`,
  `14. playback authority covers exact SHA-256 track identity, host sequencing, per-peer replay protection, bounded three-sample clock alignment, contiguous canonical commands, late-join/gap snapshots, mismatched-track failure, and shared loop activation/exit validated against the local Rust beat-loop plan\n15. track bytes, decoded PCM, library storage, capability tokens, physical output routing, monitor controls, cue definitions, and hot-cue definitions never enter shared playback messages`,
);

replaceOnce(
  ".github/workflows/pages.yml",
  `          assert 'loopActive' in collaborative_playback, "local beat-loop conflict is not fail-closed"`,
  `          assert 'SHARED_PLAYBACK_PROTOCOL = 2' in shared_playback, "shared playback protocol was not versioned for loop lifecycle"\n          assert 'loop' in shared_playback and 'beatCount' in shared_playback, "shared playback loop lifecycle is missing"\n          assert 'plan_beat_loop' in mixer and 'resolveSharedLoop' in mixer, "remote loops are not revalidated through the Rust-owned beat-loop plan"`,
);

for (const path of [
  "web/shared-playback.ts",
  "web/collaborative-playback.ts",
  "web/mixer-app.ts",
  "web/shared-playback.test.mjs",
  "web/collaborative-playback.test.mjs",
  "README.md",
  "AGENTS.md",
  ".github/workflows/pages.yml",
]) {
  const source = fs.readFileSync(path, "utf8");
  if (source.includes("loopSuspended")) {
    throw new Error(`${path}: obsolete loop suspension remains`);
  }
}
