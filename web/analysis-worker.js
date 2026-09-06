import init, { analyze_rhythm, waveform_extrema } from "./pkg/dj_party.js";

const ready = init();
const WAVEFORM_POINTS = 720;

self.addEventListener("message", async (event) => {
  const { type, deckId, requestId, samples, sampleRate } = event.data ?? {};
  if (type !== "analyze" || !(samples instanceof Float32Array)) {
    return;
  }

  try {
    await ready;
    const extrema = waveform_extrema(samples, WAVEFORM_POINTS);
    const analysis = analyze_rhythm(samples, sampleRate);
    const beats = analysis.beats();
    const downbeats = analysis.downbeats();
    const result = {
      type: "analysis-result",
      deckId,
      requestId,
      extrema,
      bpm: analysis.has_bpm() ? analysis.bpm() : null,
      confidence: analysis.confidence(),
      beats,
      downbeats,
    };
    analysis.free();

    self.postMessage(result, [extrema.buffer, beats.buffer, downbeats.buffer]);
  } catch (error) {
    self.postMessage({
      type: "analysis-error",
      deckId,
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
