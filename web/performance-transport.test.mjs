import assert from "node:assert/strict";
import test from "node:test";

import { validatePerformanceAction } from "./performance-transport.js";

const TRACK = "a".repeat(64);

test("performance actions are exact-track, bounded, and normalized", () => {
  assert.deepEqual(
    validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 4, originPositionSeconds: 12, slot: 2 }),
    { trackContentId: TRACK, kind: "beat-jump", delta: 4, originPositionSeconds: 12 },
  );
  assert.equal(validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 4 }), null);
  assert.equal(validatePerformanceAction({ trackContentId: TRACK, kind: "beat-jump", delta: 5, originPositionSeconds: 12 }), null);
  assert.equal(validatePerformanceAction({ trackContentId: "A".repeat(64), kind: "beat-jump", delta: 4, originPositionSeconds: 12 }), null);

  assert.deepEqual(
    validatePerformanceAction({
      trackContentId: TRACK,
      kind: "seek",
      source: "hot-cue",
      positionSeconds: 42.5,
      slot: 3,
      label: "secret local cue",
    }),
    { trackContentId: TRACK, kind: "seek", source: "hot-cue", positionSeconds: 42.5 },
  );
  assert.equal(
    validatePerformanceAction({ trackContentId: TRACK, kind: "seek", source: "unknown", positionSeconds: 1 }),
    null,
  );
  assert.equal(
    validatePerformanceAction({ trackContentId: TRACK, kind: "seek", source: "cue", positionSeconds: "1" }),
    null,
  );
});
