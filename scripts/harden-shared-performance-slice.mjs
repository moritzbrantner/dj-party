import fs from "node:fs";

function replaceOnce(path, before, after) {
  let source = fs.readFileSync(path, "utf8");
  const index = source.indexOf(before);
  if (index < 0) {
    if (source.includes(after)) return;
    throw new Error(`${path}: expected hardening fragment not found`);
  }
  source = `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
  fs.writeFileSync(path, source);
}

replaceOnce(
  "web/performance-transport.ts",
  `  if (value.kind === "beat-jump") {\n    const delta = Number.isSafeInteger(value.delta) && BEAT_JUMP_DELTAS.has(value.delta) ? value.delta : null;\n    return delta === null ? null : { trackContentId: value.trackContentId, kind: "beat-jump", delta };\n  }`,
  `  if (value.kind === "beat-jump") {\n    const delta = Number.isSafeInteger(value.delta) && BEAT_JUMP_DELTAS.has(value.delta) ? value.delta : null;\n    const originPositionSeconds =\n      typeof value.originPositionSeconds === "number" &&\n      Number.isFinite(value.originPositionSeconds) &&\n      value.originPositionSeconds >= 0 &&\n      value.originPositionSeconds <= MAX_TRACK_SECONDS\n        ? value.originPositionSeconds\n        : null;\n    return delta === null || originPositionSeconds === null\n      ? null\n      : { trackContentId: value.trackContentId, kind: "beat-jump", delta, originPositionSeconds };\n  }`,
);

replaceOnce(
  "web/performance-transport.test.mjs",
  `    validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 4, slot: 2 }),\n    { trackContentId: TRACK, kind: "beat-jump", delta: 4 },\n  );\n  assert.equal(validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 5 }), null);`,
  `    validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 4, originPositionSeconds: 12, slot: 2 }),\n    { trackContentId: TRACK, kind: "beat-jump", delta: 4, originPositionSeconds: 12 },\n  );\n  assert.equal(validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 4 }), null);\n  assert.equal(validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 5, originPositionSeconds: 12 }), null);`,
);
replaceOnce(
  "web/performance-transport.test.mjs",
  `validatePerformanceAction({ trackContentId: "A".repeat(64), kind: "beat-jump", delta: 4 })`,
  `validatePerformanceAction({ trackContentId: "A".repeat(64), kind: "beat-jump", delta: 4, originPositionSeconds: 12 })`,
);

replaceOnce(
  "web/performance.ts",
  `  beatJump(delta, { share = true } = {}) {\n    const duration = this.deck.audio.duration;`,
  `  beatJump(delta, { share = true, originPositionSeconds = this.deck.audio.currentTime } = {}) {\n    const duration = this.deck.audio.duration;`,
);
replaceOnce(
  "web/performance.ts",
  `    const plan = plan_beat_jump(this.deck.beats, this.deck.audio.currentTime, delta, duration);`,
  `    if (!Number.isFinite(originPositionSeconds) || originPositionSeconds < 0 || originPositionSeconds > duration) {\n      return false;\n    }\n\n    const plan = plan_beat_jump(this.deck.beats, originPositionSeconds, delta, duration);`,
);
replaceOnce(
  "web/performance.ts",
  `        this.deck.notifyPerformanceTransport?.({ kind: "beat-jump", delta });`,
  `        this.deck.notifyPerformanceTransport?.({ kind: "beat-jump", delta, originPositionSeconds });`,
);

replaceOnce(
  "web/mixer-app.ts",
  `    return deck.performance.beatJump(action.delta, { share: false }) === true;`,
  `    return deck.performance.beatJump(action.delta, {\n      share: false,\n      originPositionSeconds: action.originPositionSeconds,\n    }) === true;`,
);

replaceOnce(
  "web/collaborative-playback.ts",
  `    return action.kind !== "seek" || action.positionSeconds <= local.durationSeconds;`,
  `    return action.kind === "seek"\n      ? action.positionSeconds <= local.durationSeconds\n      : action.originPositionSeconds <= local.durationSeconds;`,
);

let integration = fs.readFileSync("web/shared-performance-transport.test.mjs", "utf8");
integration = integration.replaceAll(
  `{ trackContentId: TRACK, kind: "beat-jump", delta: 4 }`,
  `{ trackContentId: TRACK, kind: "beat-jump", delta: 4, originPositionSeconds: 12 }`,
);
integration = integration.replace(
  `{ trackContentId: TRACK, kind: "beat-jump", delta: 8 }`,
  `{ trackContentId: TRACK, kind: "beat-jump", delta: 8, originPositionSeconds: 12 }`,
);
integration = integration.replace(
  `if (action.kind === "beat-jump") this.state.positionSeconds += action.delta;`,
  `if (action.kind === "beat-jump") this.state.positionSeconds = action.originPositionSeconds + action.delta;`,
);
fs.writeFileSync("web/shared-performance-transport.test.mjs", integration);

replaceOnce(
  "README.md",
  `Beat jumps cross as bounded ±4/±8-beat intents and are re-planned by the host through the existing Rust-owned beat-jump policy before canonical playback is broadcast.`,
  `Beat jumps cross as bounded ±4/±8-beat intents with the initiating pre-jump playhead; the host re-plans from that bounded origin through the existing Rust-owned beat-jump policy before canonical playback is broadcast.`,
);
replaceOnce(
  "AGENTS.md",
  `Beat jumps must cross as bounded ±4/±8-beat semantic intents and the host must re-run them through the existing Rust-owned beat-jump planner before broadcasting canonical playback.`,
  `Beat jumps must cross as bounded ±4/±8-beat semantic intents with the initiating pre-jump playhead, and the host must re-run them from that bounded origin through the existing Rust-owned beat-jump planner before broadcasting canonical playback.`,
);
