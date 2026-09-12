import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";

import {
  crc32,
  extractZipLibrary,
  matchPlaylistReferences,
  normalizeLibraryPath,
  parseM3u,
} from "./archive-import.js";

test("M3U parsing ignores comments and remote URLs while normalizing local paths", () => {
  const parsed = parseM3u("#EXTM3U\n#EXTINF:1,Track\nMusic\\Track.mp3\nhttps://example.com/live.mp3\n");
  assert.deepEqual(parsed.references, ["Music/Track.mp3"]);
  assert.equal(parsed.ignoredExternal, 1);
  assert.equal(normalizeLibraryPath("sets/../Music/Track.mp3"), "Music/Track.mp3");
});

test("playlist matching prefers exact saved paths and only falls back to unambiguous basenames", () => {
  const records = [
    { id: "one", name: "track.mp3", path: "set-a/track.mp3" },
    { id: "two", name: "other.mp3", path: "set-b/other.mp3" },
  ];
  const result = matchPlaylistReferences(["set-a/track.mp3", "other.mp3", "missing.mp3"], records);
  assert.deepEqual(result.trackIds, ["one", "two"]);
  assert.deepEqual(result.missing, ["missing.mp3"]);
});

test("stored ZIP import verifies entries and resolves embedded playlist paths", async () => {
  const audio = new Uint8Array([1, 2, 3, 4, 5]);
  const playlist = new TextEncoder().encode("#EXTM3U\nsong.mp3\n");
  const archive = buildStoredZip([
    { path: "music/song.mp3", bytes: audio },
    { path: "music/set.m3u8", bytes: playlist },
  ]);
  const file = new File([archive], "crate.zip", { type: "application/zip" });

  const result = await extractZipLibrary(file);
  assert.equal(result.audioEntries.length, 1);
  assert.equal(result.audioEntries[0].path, "music/song.mp3");
  assert.equal(result.audioEntries[0].file.name, "song.mp3");
  assert.deepEqual(new Uint8Array(await result.audioEntries[0].file.arrayBuffer()), audio);
  assert.equal(result.playlists.length, 1);
  assert.deepEqual(result.playlists[0].references, ["music/song.mp3"]);
});

function buildStoredZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length + entry.bytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, entry.bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, eocd]);
}
