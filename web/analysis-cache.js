const DATABASE_NAME = "dj-party-analysis-cache";
const DATABASE_VERSION = 1;
const ANALYSIS_STORE = "analyses";
const MAX_CACHE_ENTRIES = 256;
const MAX_WAVEFORM_VALUES = 720 * 2;
const MAX_BEAT_MARKERS = 32_768;
const MAX_DOWNBEAT_MARKERS = 8_192;
const MAX_ANALYSIS_SECONDS = 15 * 60;

export const ANALYSIS_CACHE_NAMESPACE = "rhythm-v1-waveform720-limit900";

let databasePromise = null;

export async function analysisCacheIdForBytes(bytes) {
  if (!globalThis.crypto?.subtle) {
    return null;
  }

  const buffer = exactArrayBuffer(bytes);
  if (!buffer) {
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
  const write = database.transaction(ANALYSIS_STORE, "readwrite");
  write.objectStore(ANALYSIS_STORE).put(record);
  await transactionDone(write);

  const read = database.transaction(ANALYSIS_STORE, "readonly");
  const all = await requestResult(read.objectStore(ANALYSIS_STORE).getAll());
  await transactionDone(read);

  if (all.length > MAX_CACHE_ENTRIES) {
    const expiredIds = all
      .sort((left, right) => Number(left.updatedAt ?? 0) - Number(right.updatedAt ?? 0))
      .slice(0, all.length - MAX_CACHE_ENTRIES)
      .map((entry) => entry.id);
    const prune = database.transaction(ANALYSIS_STORE, "readwrite");
    const store = prune.objectStore(ANALYSIS_STORE);
    for (const id of expiredIds) {
      store.delete(id);
    }
    await transactionDone(prune);
  }
  return true;
}

export function cacheRecordFromAnalysis(cacheId, message) {
  if (!cacheId || message?.type !== "analysis-result") {
    return null;
  }

  const validated = validatedAnalysisPayload(message);
  if (!validated) {
    return null;
  }

  return {
    id: cacheId,
    namespace: ANALYSIS_CACHE_NAMESPACE,
    extrema: new Float32Array(validated.extrema),
    bpm: validated.bpm,
    confidence: validated.confidence,
    beats: new Float64Array(validated.beats),
    downbeats: new Float64Array(validated.downbeats),
    analysisLimited: Boolean(message.analysisLimited),
    updatedAt: Date.now(),
  };
}

export function analysisMessageFromCache(record, deckId, requestId) {
  if (!record || record.namespace !== ANALYSIS_CACHE_NAMESPACE) {
    return null;
  }

  const validated = validatedAnalysisPayload(record);
  if (!validated) {
    return null;
  }

  return {
    type: "analysis-result",
    deckId,
    requestId,
    extrema: new Float32Array(validated.extrema),
    bpm: validated.bpm,
    confidence: validated.confidence,
    beats: new Float64Array(validated.beats),
    downbeats: new Float64Array(validated.downbeats),
    analysisLimited: Boolean(record.analysisLimited),
    cached: true,
  };
}

function validatedAnalysisPayload(value) {
  const extrema = typedArray(value.extrema, Float32Array, MAX_WAVEFORM_VALUES);
  const beats = typedArray(value.beats, Float64Array, MAX_BEAT_MARKERS);
  const downbeats = typedArray(value.downbeats, Float64Array, MAX_DOWNBEAT_MARKERS);
  if (!extrema || !beats || !downbeats || !validWaveform(extrema)) {
    return null;
  }
  if (!validMarkers(beats) || !validMarkers(downbeats)) {
    return null;
  }

  const bpm = value.bpm === null || value.bpm === undefined ? null : Number(value.bpm);
  const confidence = Number(value.confidence);
  if ((bpm !== null && (!Number.isFinite(bpm) || bpm <= 0)) || !Number.isFinite(confidence)) {
    return null;
  }
  if (confidence < 0 || confidence > 1) {
    return null;
  }

  return { extrema, bpm, confidence, beats, downbeats };
}

function validWaveform(extrema) {
  if (extrema.length % 2 !== 0) {
    return false;
  }
  for (let index = 0; index < extrema.length; index += 2) {
    const minimum = extrema[index];
    const maximum = extrema[index + 1];
    if (
      !Number.isFinite(minimum) ||
      !Number.isFinite(maximum) ||
      minimum < -1 ||
      maximum > 1 ||
      minimum > maximum
    ) {
      return false;
    }
  }
  return true;
}

function validMarkers(markers) {
  let previous = -Infinity;
  for (const marker of markers) {
    if (!Number.isFinite(marker) || marker < 0 || marker > MAX_ANALYSIS_SECONDS || marker <= previous) {
      return false;
    }
    previous = marker;
  }
  return true;
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

function typedArray(value, Constructor, maxLength) {
  if (value instanceof Constructor) {
    return value.length <= maxLength ? value : null;
  }
  if (Array.isArray(value)) {
    return value.length <= maxLength ? new Constructor(value) : null;
  }
  return null;
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return null;
}
