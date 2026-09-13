import assert from "node:assert/strict";
import test from "node:test";

import { isTrackContentId, trackContentIdForBytes, trackContentIdForFile } from "./track-identity.js";

test("track identity is the lowercase SHA-256 of exact file bytes", async () => {
  const bytes = new TextEncoder().encode("dj-party exact track bytes");
  const id = await trackContentIdForBytes(bytes);

  assert.equal(id, "b838579af8e8004bfbc9a1783c90d21e85f72a4470e6b29fd0180b4b875f8e5d");
  assert.equal(isTrackContentId(id), true);
});

test("different encoded bytes never alias merely because metadata matches", async () => {
  const left = await trackContentIdForBytes(new Uint8Array([1, 2, 3, 4]));
  const right = await trackContentIdForBytes(new Uint8Array([1, 2, 3, 5]));

  assert.notEqual(left, right);
});

test("file identity fails closed when hashing is unavailable", async () => {
  const file = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };

  assert.equal(await trackContentIdForFile(file, {}), null);
  assert.equal(isTrackContentId("A".repeat(64)), false);
  assert.equal(isTrackContentId("0".repeat(63)), false);
});
