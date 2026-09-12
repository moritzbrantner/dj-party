const AUDIO_EXTENSION = /\.(aac|aif|aiff|flac|m4a|mp3|mp4|oga|ogg|opus|wav|webm)$/i;
const PLAYLIST_EXTENSION = /\.(m3u|m3u8)$/i;
const ZIP_EXTENSION = /\.zip$/i;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH_BYTES = 65_557;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;

export function isZipFile(file) {
  return String(file?.type ?? "").toLowerCase() === "application/zip" || ZIP_EXTENSION.test(String(file?.name ?? ""));
}

export function isPlaylistFile(file) {
  const type = String(file?.type ?? "").toLowerCase();
  return PLAYLIST_EXTENSION.test(String(file?.name ?? "")) || type === "audio/x-mpegurl" || type === "application/vnd.apple.mpegurl";
}

export function normalizeLibraryPath(value) {
  const raw = String(value ?? "").replaceAll("\\", "/").trim();
  if (!raw || raw.includes("\0")) {
    return null;
  }

  const withoutScheme = raw.replace(/^file:\/\//i, "");
  const parts = withoutScheme.split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (normalized.length === 0) {
        return null;
      }
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
}

export function parseM3u(text) {
  const references = [];
  let ignoredExternal = 0;

  for (const rawLine of String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) && !/^file:\/\//i.test(line)) {
      ignoredExternal += 1;
      continue;
    }

    const reference = decodePlaylistReference(line).replaceAll("\\", "/").trim();
    if (reference && !reference.includes("\0")) {
      references.push(reference);
    }
  }

  return { references, ignoredExternal };
}

export function resolvePlaylistReferences(playlistPath, references) {
  const normalizedPlaylist = normalizeLibraryPath(playlistPath) ?? "playlist.m3u";
  const slash = normalizedPlaylist.lastIndexOf("/");
  const directory = slash >= 0 ? normalizedPlaylist.slice(0, slash) : "";

  return references
    .map((reference) => {
      if (/^[A-Za-z]:\//.test(reference) || reference.startsWith("/")) {
        return normalizeLibraryPath(reference);
      }
      return normalizeLibraryPath(directory ? `${directory}/${reference}` : reference);
    })
    .filter(Boolean);
}

export function matchPlaylistReferences(references, records) {
  const byPath = new Map();
  const byBaseName = new Map();

  for (const record of records ?? []) {
    const path = normalizeLibraryPath(record.path || record.name);
    if (path) {
      byPath.set(path.toLocaleLowerCase(), record.id);
      const baseName = path.slice(path.lastIndexOf("/") + 1).toLocaleLowerCase();
      const existing = byBaseName.get(baseName);
      if (existing === undefined) {
        byBaseName.set(baseName, record.id);
      } else if (existing !== record.id) {
        byBaseName.set(baseName, null);
      }
    }
  }

  const trackIds = [];
  const missing = [];
  for (const reference of references ?? []) {
    const rawReference = String(reference ?? "").replaceAll("\\", "/").trim();
    if (!rawReference || rawReference.includes("\0")) {
      continue;
    }
    const normalized = normalizeLibraryPath(rawReference);
    const exact = normalized ? byPath.get(normalized.toLocaleLowerCase()) : undefined;
    const basenameSource = normalized ?? rawReference;
    const baseName = basenameSource.slice(basenameSource.lastIndexOf("/") + 1).toLocaleLowerCase();
    const fallback = byBaseName.get(baseName);
    const id = exact ?? fallback;
    if (id) {
      if (!trackIds.includes(id)) {
        trackIds.push(id);
      }
    } else {
      missing.push(normalized ?? rawReference);
    }
  }

  return { trackIds, missing };
}

export async function extractZipLibrary(file) {
  if (!isZipFile(file)) {
    throw new Error("Not a ZIP archive");
  }

  const entries = await readZipDirectory(file);
  let extractedBytes = 0;
  const audioEntries = [];
  const playlists = [];
  let skippedEntries = 0;

  for (const entry of entries) {
    if (!AUDIO_EXTENSION.test(entry.path) && !PLAYLIST_EXTENSION.test(entry.path)) {
      skippedEntries += 1;
      continue;
    }

    if (entry.uncompressedSize > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`ZIP entry is too large: ${entry.path}`);
    }
    extractedBytes += entry.uncompressedSize;
    if (extractedBytes > MAX_EXTRACTED_BYTES) {
      throw new Error("ZIP expands beyond the 512 MB browser import limit");
    }

    const bytes = await extractZipEntry(file, entry);
    if (AUDIO_EXTENSION.test(entry.path)) {
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      audioEntries.push({
        file: new File([bytes], name, {
          type: mimeTypeForPath(entry.path),
          lastModified: entry.lastModified,
        }),
        path: entry.path,
      });
    } else {
      const text = new TextDecoder("utf-8").decode(bytes);
      const parsed = parseM3u(text);
      playlists.push({
        name: stripExtension(entry.path.slice(entry.path.lastIndexOf("/") + 1)),
        path: entry.path,
        references: resolvePlaylistReferences(entry.path, parsed.references),
        ignoredExternal: parsed.ignoredExternal,
      });
    }
  }

  return { audioEntries, playlists, skippedEntries };
}

async function readZipDirectory(file) {
  const tailStart = Math.max(0, file.size - MAX_EOCD_SEARCH_BYTES);
  const tailBytes = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const eocdOffset = findEndOfCentralDirectory(tailBytes);
  if (eocdOffset < 0) {
    throw new Error("ZIP central directory was not found");
  }

  const eocd = new DataView(tailBytes.buffer, tailBytes.byteOffset + eocdOffset);
  const diskNumber = eocd.getUint16(4, true);
  const centralDirectoryDisk = eocd.getUint16(6, true);
  const entriesOnDisk = eocd.getUint16(8, true);
  const totalEntries = eocd.getUint16(10, true);
  const centralDirectorySize = eocd.getUint32(12, true);
  const centralDirectoryOffset = eocd.getUint32(16, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }
  if (totalEntries === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported by the browser importer");
  }
  if (totalEntries > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`ZIP contains more than ${MAX_ARCHIVE_ENTRIES} entries`);
  }
  if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error("ZIP central directory exceeds the 16 MB browser metadata limit");
  }
  if (centralDirectoryOffset + centralDirectorySize > file.size) {
    throw new Error("ZIP central directory is outside the selected file");
  }

  const bytes = new Uint8Array(
    await file.slice(centralDirectoryOffset, centralDirectoryOffset + centralDirectorySize).arrayBuffer(),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8");
  const entries = [];
  let offset = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("ZIP central directory entry is malformed");
    }

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const dosTime = view.getUint16(offset + 12, true);
    const dosDate = view.getUint16(offset + 14, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength) {
      throw new Error("ZIP central directory entry is truncated");
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("ZIP64 entries are not supported by the browser importer");
    }

    const rawName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const path = normalizeLibraryPath(rawName);
    offset = end;
    if (!path || rawName.endsWith("/")) {
      continue;
    }

    entries.push({
      path,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      lastModified: dosTimestamp(dosDate, dosTime),
    });
  }

  return entries;
}

async function extractZipEntry(file, entry) {
  if ((entry.flags & 0x0001) !== 0) {
    throw new Error(`Encrypted ZIP entries are not supported: ${entry.path}`);
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`Unsupported ZIP compression method ${entry.method}: ${entry.path}`);
  }
  if (entry.localHeaderOffset + 30 > file.size) {
    throw new Error(`ZIP local header is truncated: ${entry.path}`);
  }

  const localBytes = new Uint8Array(await file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer());
  if (localBytes.byteLength !== 30) {
    throw new Error(`ZIP local header is truncated: ${entry.path}`);
  }
  const local = new DataView(localBytes.buffer, localBytes.byteOffset, localBytes.byteLength);
  if (local.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`ZIP local header is malformed: ${entry.path}`);
  }

  const nameLength = local.getUint16(26, true);
  const extraLength = local.getUint16(28, true);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > file.size) {
    throw new Error(`ZIP entry data is truncated: ${entry.path}`);
  }

  const compressed = new Uint8Array(await file.slice(dataOffset, dataOffset + entry.compressedSize).arrayBuffer());
  const bytes = entry.method === 0 ? compressed : await inflateRaw(compressed, entry.uncompressedSize, entry.path);
  if (bytes.byteLength !== entry.uncompressedSize) {
    throw new Error(`ZIP entry size mismatch: ${entry.path}`);
  }
  if (crc32(bytes) !== entry.crc) {
    throw new Error(`ZIP entry checksum mismatch: ${entry.path}`);
  }
  return bytes;
}

async function inflateRaw(bytes, expectedSize, path) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot decompress deflated ZIP entries");
  }
  let stream;
  try {
    stream = new DecompressionStream("deflate-raw");
  } catch {
    throw new Error("This browser cannot decompress deflated ZIP entries");
  }
  return readBoundedStream(new Blob([bytes]).stream().pipeThrough(stream), expectedSize, path);
}

export async function readBoundedStream(stream, expectedSize, label = "ZIP entry") {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_ENTRY_BYTES) {
    throw new Error(`Invalid bounded output size: ${label}`);
  }

  const output = new Uint8Array(expectedSize);
  const reader = stream.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (offset + chunk.byteLength > expectedSize) {
        await reader.cancel("decompressed output exceeds declared size");
        throw new Error(`ZIP entry expands beyond its declared size: ${label}`);
      }
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (offset !== expectedSize) {
    throw new Error(`ZIP entry size mismatch: ${label}`);
  }
  return output;
}

function findEndOfCentralDirectory(bytes) {
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (
      bytes[offset] !== (EOCD_SIGNATURE & 0xff) ||
      bytes[offset + 1] !== ((EOCD_SIGNATURE >>> 8) & 0xff) ||
      bytes[offset + 2] !== ((EOCD_SIGNATURE >>> 16) & 0xff) ||
      bytes[offset + 3] !== ((EOCD_SIGNATURE >>> 24) & 0xff)
    ) {
      continue;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const commentLength = view.getUint16(20, true);
    if (offset + 22 + commentLength === bytes.byteLength) {
      return offset;
    }
  }
  return -1;
}

function decodePlaylistReference(line) {
  if (!/^file:\/\//i.test(line)) {
    return line;
  }
  try {
    return decodeURIComponent(line.replace(/^file:\/\//i, ""));
  } catch {
    return line.replace(/^file:\/\//i, "");
  }
}

function stripExtension(name) {
  return String(name ?? "").replace(/\.[^.]+$/, "") || String(name ?? "");
}

function dosTimestamp(date, time) {
  const year = 1980 + ((date >>> 9) & 0x7f);
  const month = ((date >>> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hour = (time >>> 11) & 0x1f;
  const minute = (time >>> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  const value = Date.UTC(year, Math.max(0, month), Math.max(1, day), hour, minute, second);
  return Number.isFinite(value) ? value : 0;
}

function mimeTypeForPath(path) {
  const extension = path.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  return (
    {
      aac: "audio/aac",
      aif: "audio/aiff",
      aiff: "audio/aiff",
      flac: "audio/flac",
      m4a: "audio/mp4",
      mp3: "audio/mpeg",
      mp4: "audio/mp4",
      oga: "audio/ogg",
      ogg: "audio/ogg",
      opus: "audio/ogg",
      wav: "audio/wav",
      webm: "audio/webm",
    }[extension] ?? "application/octet-stream"
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
