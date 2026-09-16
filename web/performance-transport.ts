import { isTrackContentId } from "./track-identity.js";

const MAX_TRACK_SECONDS = 12 * 60 * 60;
const BEAT_JUMP_DELTAS = new Set([-8, -4, 4, 8]);
const SEEK_SOURCES = new Set(["cue", "hot-cue", "phase-sync"]);

export function validatePerformanceAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isTrackContentId(value.trackContentId)) {
    return null;
  }

  if (value.kind === "beat-jump") {
    const delta = Number.isSafeInteger(value.delta) && BEAT_JUMP_DELTAS.has(value.delta) ? value.delta : null;
    const originPositionSeconds =
      typeof value.originPositionSeconds === "number" &&
      Number.isFinite(value.originPositionSeconds) &&
      value.originPositionSeconds >= 0 &&
      value.originPositionSeconds <= MAX_TRACK_SECONDS
        ? value.originPositionSeconds
        : null;
    return delta === null || originPositionSeconds === null
      ? null
      : { trackContentId: value.trackContentId, kind: "beat-jump", delta, originPositionSeconds };
  }

  if (value.kind === "seek") {
    const positionSeconds =
      typeof value.positionSeconds === "number" &&
      Number.isFinite(value.positionSeconds) &&
      value.positionSeconds >= 0 &&
      value.positionSeconds <= MAX_TRACK_SECONDS
        ? value.positionSeconds
        : null;
    const source = typeof value.source === "string" && SEEK_SOURCES.has(value.source) ? value.source : null;
    return positionSeconds === null || source === null
      ? null
      : { trackContentId: value.trackContentId, kind: "seek", source, positionSeconds };
  }

  return null;
}
