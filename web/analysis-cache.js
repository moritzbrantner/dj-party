const DATABASE_NAME = "dj-party-analysis-cache";
const DATABASE_VERSION = 1;
const ANALYSIS_STORE = "analyses";
const MAX_CACHE_ENTRIES = 256;

export const ANALYSIS_CACHE_NAMESPACE = "rhythm-v1-waveform720-limit900";

let databasePromise = null;

export async function analysisCacheIdForBytes(bytes) {
  if (!globalThis.crypto?.subtle) {
    return null;
  }

  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes?.buffer;
  if (!(buffer instanceof ArrayBuffer)) {
    return null;
  }

  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buffer));
  const fingerprint = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${ANALYSIS_CACHE_NAMESPACE}:${fingerprint}`;
}

export async function readCachedTrackAnalysis(cacheId) {
  if (!cacheId) {
    return null;
  }

  const database = await openDatabase();
  const transaction = database.transaction(ANALYSIS_STORE, "readonly");
  const record = await requestResult(transaction.objectStore(ANALYSIS_STORE).get(cacheId));
  await transactionDone(transaction);
  return record ?? null;
}

export async function writeCachedTrackAnalysis(record) {
  if (!record?.id || record.namespace !== ANALYSIS_CACHE_NAMESPACE) {
    return false;
  }

  const database = await openDatabase();
  const transaction = database.transaction(ANALYSIS_STORE, "readwrite");
  const store = transaction.objectStore(ANALYSIS_STORE);
  store.put(record);
  const all = await requestResult(store.getAll());
  if (all.length > MAX_CACHE_ENTRIES) {
    all
      .sort((left, right) => Number(left.updatedAt ?? 0) - Number(right.updatedAt ?? 0))
      .slice(0, all.length - MAX_CACHE_ENTRIES)
      .forEach((entry) => store.delete(entry.id));
  }
  await transactionDone(transaction);
  return true;
}

export function cacheRecordFromAnalysis(cacheId, message) {
  if (!cacheId || message?.type !== "analysis-result") {
    return null;
  }

  const extrema = toTypedArray(message.extrema, Float32Array);
  const beats = toTypedArray(message.beats, Float64Array);
  const downbeats = toTypedArray(message.downbeats, Float64Array);
  if (!extrema || !beats || !downbeats) {
    return null;
  }

  const bpm = message.bpm === null || message.bpm === undefined ? null : Number(message.bpm);
  const confidence = Number(message.confidence);
  if ((bpm !== null && (!Number.isFinite(bpm) || bpm <= 0)) || !Number.isFinite(confidence)) {
    return null;
  }

  return {
    id: cacheId,
    namespace: ANALYSIS_CACHE_NAMESPACE,
    extrema: new Float32Array(extrema),
    bpm,
    confidence: Math.max(0, Math.min(1, confidence)),
    beats: new Float64Array(beats),
    downbeats: new Float64Array(downbeats),
    analysisLimited: Boolean(message.analysisLimited),
    updatedAt: Date.now(),
  };
}

export function analysisMessageFromCache(record, deckId, requestId) {
  if (!record || record.namespace !== ANALYSIS_CACHE_NAMESPACE) {
    return null;
  }

  const extrema = toTypedArray(record.extrema, Float32Array);
  const beats = toTypedArray(record.beats, Float64Array);
  const downbeats = toTypedArray(record.downbeats, Float64Array);
  const bpm = record.bpm === null || record.bpm === undefined ? null : Number(record.bpm);
  const confidence = Number(record.confidence);
  if (
    !extrema ||
    !beats ||
    !downbeats ||
    (bpm !== null && (!Number.isFinite(bpm) || bpm <= 0)) ||
    !Number.isFinite(confidence)
  ) {
    return null;
  }

  return {
    type: "analysis-result",
    deckId,
    requestId,
    extrema: new Float32Array(extrema),
    bpm,
    confidence: Math.max(0, Math.min(1, confidence)),
    beats: new Float64Array(beats),
    downbeats: new Float64Array(downbeats),
    analysisLimited: Boolean(record.analysisLimited),
    cached: true,
  };
}

async function openDatabase() {
  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is unavailable in this browser");
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener(
        "upgradeneeded",
        () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(ANALYSIS_STORE)) {
            database.createObjectStore(ANALYSIS_STORE, { keyPath: "id" });
          }
        },
        { once: true },
      );
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("Could not open analysis cache")), {
        once: true,
      });
    });
  }

  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
      once: true,
    });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), {
      once: true,
    });
  });
}

function toTypedArray(value, Constructor) {
  if (value instanceof Constructor) {
    return value;
  }
  if (Array.isArray(value)) {
    return new Constructor(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Constructor(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return null;
}
