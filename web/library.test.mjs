import assert from "node:assert/strict";
import test from "node:test";

import { formatFileSize, isSupportedAudioFile, trackIdForFile } from "./library.js";

test("audio file detection accepts MIME types and known extensions", () => {
  assert.equal(isSupportedAudioFile({ name: "set.mp3", type: "" }), true);
  assert.equal(isSupportedAudioFile({ name: "recording.bin", type: "audio/flac" }), true);
  assert.equal(isSupportedAudioFile({ name: "cover.jpg", type: "image/jpeg" }), false);
});

test("track ids are stable for the same file identity and change for distinct files", () => {
  const base = { name: "track.wav", size: 1234, lastModified: 99 };
  assert.equal(trackIdForFile(base), trackIdForFile({ ...base }));
  assert.notEqual(trackIdForFile(base), trackIdForFile({ ...base, size: 1235 }));
  assert.notEqual(trackIdForFile(base), trackIdForFile({ ...base, lastModified: 100 }));
});

test("explicit archive paths distinguish otherwise identical files without changing normal identities", () => {
  const base = { name: "track.wav", size: 1234, lastModified: 99 };
  const ordinary = trackIdForFile(base);
  assert.equal(ordinary, trackIdForFile({ ...base }));
  assert.notEqual(trackIdForFile(base, "set-a/track.wav"), trackIdForFile(base, "set-b/track.wav"));
  assert.equal(trackIdForFile(base, "set-a\\track.wav"), trackIdForFile(base, "set-a/track.wav"));
});

test("file sizes are formatted for collection metadata", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(1024), "1.00 KB");
  assert.equal(formatFileSize(12 * 1024 * 1024), "12.0 MB");
});
