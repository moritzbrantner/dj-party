import fs from "node:fs";

const sharedPlayback = fs.readFileSync("web/shared-playback.ts", "utf8");
const baseApplied =
  sharedPlayback.includes("export const SHARED_PLAYBACK_PROTOCOL = 3;") &&
  sharedPlayback.includes("PERFORMANCE_REQUEST_TYPE");

if (!baseApplied) {
  const path = "README.md";
  const before = "Cue definitions, hot-cue definitions, and content bytes remain local; their resulting one-off playhead movement can still converge through ordinary bounded playback state once the exact-track and clock requirements are satisfied.";
  const after = "Cue and hot-cue definitions remain local. Their one-off jumps cross the peer link only as normalized bounded seek intents carrying the exact track identity; no slot, label, or definition is shared. Beat jumps cross as bounded ±4/±8-beat intents and are re-planned by the host through the existing Rust-owned beat-jump policy before canonical playback is broadcast. Phase Sync may publish its resulting bounded seek while tempo remains part of mixer authority. Content bytes remain local.";

  let source = fs.readFileSync(path, "utf8");
  if (source.includes(before)) {
    source = source.replace(before, after);
    fs.writeFileSync(path, source);
  } else if (!source.includes(after)) {
    throw new Error("README.md: current shared-playback paragraph is not recognized");
  }

  await import("./apply-shared-performance-slice.mjs");
}
