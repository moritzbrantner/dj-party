import { plan_deck_tone } from "./pkg/dj_party.js";

const FILTER_BYPASS = 0;
const FILTER_LOW_PASS = 1;
const FILTER_HIGH_PASS = 2;
const PARAMETER_SMOOTHING_SECONDS = 0.012;

export function installDeckEffectsUi() {
  if (!document.querySelector('link[data-effects-styles]')) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./effects.css", import.meta.url).href;
    stylesheet.dataset.effectsStyles = "true";
    document.head.append(stylesheet);
  }

  for (const id of ["a", "b"]) {
    const deck = document.querySelector(`[data-deck="${id}"]`);
    const timingPanel = deck?.querySelector(".timing-panel");
    if (!deck || !timingPanel || deck.querySelector(`#deck-${id}-effects`)) {
      continue;
    }

    timingPanel.insertAdjacentHTML(
      "afterend",
      `<section id="deck-${id}-effects" class="effects-panel" aria-label="Deck ${id.toUpperCase()} EQ and filter">
        <div class="effects-heading">
          <div>
            <span class="effects-kicker">Channel tone</span>
            <strong>EQ / Filter</strong>
          </div>
          <button id="deck-${id}-effects-reset" class="mini-button" type="button">Reset</button>
        </div>
        <div class="effects-controls">
          ${effectControl(id, "low", "Low", "0.0 dB")}
          ${effectControl(id, "mid", "Mid", "0.0 dB")}
          ${effectControl(id, "high", "High", "0.0 dB")}
          ${effectControl(id, "filter", "Filter", "Bypass")}
        </div>
        <p class="effects-note">EQ and filter are pre-fader, so the headphone cue hears the same channel tone as the deck.</p>
      </section>`,
    );
  }
}

function effectControl(deckId, name, label, initialValue) {
  return `<label class="effect-control" for="deck-${deckId}-${name}">
    <span class="effect-control-heading"><span>${label}</span><output id="deck-${deckId}-${name}-value">${initialValue}</output></span>
    <input id="deck-${deckId}-${name}" type="range" min="-100" max="100" step="1" value="0" />
  </label>`;
}

export class DeckEffects {
  constructor(id) {
    this.id = id;
    this.context = null;
    this.lowNode = null;
    this.midNode = null;
    this.highNode = null;
    this.filterNode = null;
    this.dryGainNode = null;
    this.wetGainNode = null;
    this.outputNode = null;

    this.controls = {
      low: document.querySelector(`#deck-${id}-low`),
      mid: document.querySelector(`#deck-${id}-mid`),
      high: document.querySelector(`#deck-${id}-high`),
      filter: document.querySelector(`#deck-${id}-filter`),
    };
    this.outputs = {
      low: document.querySelector(`#deck-${id}-low-value`),
      mid: document.querySelector(`#deck-${id}-mid-value`),
      high: document.querySelector(`#deck-${id}-high-value`),
      filter: document.querySelector(`#deck-${id}-filter-value`),
    };
    this.resetButton = document.querySelector(`#deck-${id}-effects-reset`);

    for (const control of Object.values(this.controls)) {
      control?.addEventListener("input", () => this.apply());
    }
    this.resetButton?.addEventListener("click", () => this.reset());
    this.apply();
  }

  connect(context, sourceNode, masterGainNode, cueGainNode) {
    if (this.outputNode) {
      return;
    }

    this.context = context;
    this.lowNode = context.createBiquadFilter();
    this.lowNode.type = "lowshelf";
    this.midNode = context.createBiquadFilter();
    this.midNode.type = "peaking";
    this.highNode = context.createBiquadFilter();
    this.highNode.type = "highshelf";
    this.filterNode = context.createBiquadFilter();
    this.filterNode.type = "lowpass";
    this.dryGainNode = context.createGain();
    this.wetGainNode = context.createGain();
    this.outputNode = context.createGain();
    this.dryGainNode.gain.value = 1;
    this.wetGainNode.gain.value = 0;

    sourceNode.connect(this.lowNode);
    this.lowNode.connect(this.midNode);
    this.midNode.connect(this.highNode);
    this.highNode.connect(this.dryGainNode);
    this.highNode.connect(this.filterNode);
    this.filterNode.connect(this.wetGainNode);
    this.dryGainNode.connect(this.outputNode);
    this.wetGainNode.connect(this.outputNode);
    this.outputNode.connect(masterGainNode);
    this.outputNode.connect(cueGainNode);

    this.apply();
  }

  reset() {
    for (const control of Object.values(this.controls)) {
      if (control) {
        control.value = "0";
      }
    }
    this.apply();
  }

  apply() {
    const plan = plan_deck_tone(
      normalizedControl(this.controls.low),
      normalizedControl(this.controls.mid),
      normalizedControl(this.controls.high),
      normalizedControl(this.controls.filter),
    );

    try {
      this.render(plan);
      if (!this.context || !this.outputNode) {
        return;
      }

      setAudioParam(this.lowNode.frequency, plan.low_frequency_hz(), this.context);
      setAudioParam(this.lowNode.gain, plan.low_gain_db(), this.context);
      setAudioParam(this.midNode.frequency, plan.mid_frequency_hz(), this.context);
      setAudioParam(this.midNode.Q, plan.mid_q(), this.context);
      setAudioParam(this.midNode.gain, plan.mid_gain_db(), this.context);
      setAudioParam(this.highNode.frequency, plan.high_frequency_hz(), this.context);
      setAudioParam(this.highNode.gain, plan.high_gain_db(), this.context);

      if (plan.filter_enabled()) {
        this.filterNode.type = filterType(plan.filter_mode());
        setAudioParam(this.filterNode.frequency, plan.filter_frequency_hz(), this.context);
        setAudioParam(this.filterNode.Q, plan.filter_q(), this.context);
        setAudioParam(this.dryGainNode.gain, 0, this.context);
        setAudioParam(this.wetGainNode.gain, 1, this.context);
      } else {
        setAudioParam(this.dryGainNode.gain, 1, this.context);
        setAudioParam(this.wetGainNode.gain, 0, this.context);
      }
    } finally {
      plan.free();
    }
  }

  render(plan) {
    this.outputs.low.textContent = formatDb(plan.low_gain_db());
    this.outputs.mid.textContent = formatDb(plan.mid_gain_db());
    this.outputs.high.textContent = formatDb(plan.high_gain_db());

    if (!plan.filter_enabled() || plan.filter_mode() === FILTER_BYPASS) {
      this.outputs.filter.textContent = "Bypass";
      return;
    }

    const label = plan.filter_mode() === FILTER_LOW_PASS ? "LPF" : "HPF";
    this.outputs.filter.textContent = `${label} ${formatFrequency(plan.filter_frequency_hz())}`;
  }

  destroy() {
    for (const node of [
      this.lowNode,
      this.midNode,
      this.highNode,
      this.filterNode,
      this.dryGainNode,
      this.wetGainNode,
      this.outputNode,
    ]) {
      node?.disconnect();
    }
  }
}

function normalizedControl(input) {
  return Number(input?.value ?? 0) / 100;
}

function filterType(mode) {
  if (mode === FILTER_HIGH_PASS) {
    return "highpass";
  }
  return "lowpass";
}

function setAudioParam(parameter, value, context) {
  const now = context.currentTime;
  parameter.cancelScheduledValues(now);
  parameter.setTargetAtTime(value, now, PARAMETER_SMOOTHING_SECONDS);
}

function formatDb(value) {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  return `${normalized > 0 ? "+" : ""}${normalized.toFixed(1)} dB`;
}

function formatFrequency(value) {
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} kHz`;
  }
  return `${Math.round(value)} Hz`;
}
