const TRACK_ID_PATTERN = /^[0-9a-f]{64}$/;

export function isTrackContentId(value) {
  return typeof value === "string" && TRACK_ID_PATTERN.test(value);
}

export async function trackContentIdForFile(file, cryptoImpl = globalThis.crypto) {
  if (!file || typeof file.arrayBuffer !== "function") {
    return null;
  }
  try {
    return await trackContentIdForBytes(await file.arrayBuffer(), cryptoImpl);
  } catch {
    return null;
  }
}

export async function trackContentIdForBytes(bytes, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) {
    return null;
  }
  const buffer = exactArrayBuffer(bytes);
  if (!buffer) {
    return null;
  }
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  }
  return null;
}
