import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_CACHE_NAMESPACE,
  analysisCacheIdForBytes,
  analysisMessageFromCache,
  cacheRecordFromAnalysis,
} from "./analysis-cache.js";

test("analysis cache ids are content-addressed and versioned", async () => {
  const first = await analysisCacheIdForBytes(new Uint8Array([1, 2, 3]).buffer);
  const same = await analysisCacheIdForBytes(new Uint8Array([1, 2, 3]).buffer);
  const other = await analysisCacheIdForBytes(new Uint8Array([1, 2, 4]).buffer);

  assert.equal(first, same);
  assert.notEqual(first, other);
  assert.ok(first.startsWith(`${ANALYSIS_CACHE_NAMESPACE}:`));
});

test("analysis cache records round-trip without sharing transferred array storage", () => {
  const message = {
    type: "analysis-result",
    extrema: new Float32Array([-1, 1, -0.5, 0.5]),
    bpm: 128,
    confidence: 0.92,
    beats: new Float64Array([0.5, 1.0, 1.5]),
    downbeats: new Float64Array([0.5]),
    analysisLimited: false,
  };

  const record = cacheRecordFromAnalysis("cache:one", message);
  assert.ok(record);
  assert.notEqual(record.extrema.buffer, message.extrema.buffer);
  assert.notEqual(record.beats.buffer, message.beats.buffer);

  const restored = analysisMessageFromCache(record, "a", 7);
  assert.equal(restored.cached, true);
  assert.equal(restored.deckId, "a");
  assert.equal(restored.requestId, 7);
  assert.equal(restored.bpm, 128);
  assert.deepEqual([...restored.beats], [0.5, 1.0, 1.5]);
});

test("stale analysis namespaces fail closed", () => {
  const stale = {
    id: "old",
    namespace: "old-analysis",
    extrema: new Float32Array([0, 0]),
    bpm: 120,
    confidence: 1,
    beats: new Float64Array([0]),
    downbeats: new Float64Array([0]),
  };

  assert.equal(analysisMessageFromCache(stale, "b", 1), null);
});
