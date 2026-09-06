use std::f64::consts::FRAC_PI_2;

use audio_analysis_rhythm::track::{TrackRhythmConfig, analyze_rhythm_track};
use wasm_bindgen::prelude::*;

const MIN_CROSSFADER: f64 = -1.0;
const MAX_CROSSFADER: f64 = 1.0;
const MIN_LEVEL: f64 = 0.0;
const MAX_LEVEL: f64 = 1.0;
const MAX_WAVEFORM_POINTS: usize = 2_048;
const MAX_ANALYSIS_SECONDS: usize = 15 * 60;

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct Mixer {
    crossfader: f64,
    deck_a_level: f64,
    deck_b_level: f64,
}

impl Default for Mixer {
    fn default() -> Self {
        Self {
            crossfader: 0.0,
            deck_a_level: 1.0,
            deck_b_level: 1.0,
        }
    }
}

#[wasm_bindgen]
impl Mixer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn crossfader(&self) -> f64 {
        self.crossfader
    }

    pub fn set_crossfader(&mut self, value: f64) {
        self.crossfader = value.clamp(MIN_CROSSFADER, MAX_CROSSFADER);
    }

    pub fn set_deck_a_level(&mut self, value: f64) {
        self.deck_a_level = value.clamp(MIN_LEVEL, MAX_LEVEL);
    }

    pub fn set_deck_b_level(&mut self, value: f64) {
        self.deck_b_level = value.clamp(MIN_LEVEL, MAX_LEVEL);
    }

    pub fn deck_a_gain(&self) -> f64 {
        let position = normalized_position(self.crossfader);
        (position * FRAC_PI_2).cos() * self.deck_a_level
    }

    pub fn deck_b_gain(&self) -> f64 {
        let position = normalized_position(self.crossfader);
        (position * FRAC_PI_2).sin() * self.deck_b_level
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone, Default)]
pub struct CuePoint {
    seconds: Option<f64>,
}

#[wasm_bindgen]
impl CuePoint {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_seconds(&mut self, seconds: f64) -> bool {
        if !seconds.is_finite() || seconds < 0.0 {
            return false;
        }

        self.seconds = Some(seconds);
        true
    }

    pub fn clear(&mut self) {
        self.seconds = None;
    }

    pub fn has_cue(&self) -> bool {
        self.seconds.is_some()
    }

    pub fn seconds(&self) -> f64 {
        self.seconds.unwrap_or(0.0)
    }
}

#[wasm_bindgen]
pub struct RhythmAnalysis {
    bpm: Option<f32>,
    confidence: f32,
    beats: Vec<f64>,
    downbeats: Vec<f64>,
}

#[wasm_bindgen]
impl RhythmAnalysis {
    pub fn has_bpm(&self) -> bool {
        self.bpm.is_some()
    }

    pub fn bpm(&self) -> f32 {
        self.bpm.unwrap_or(f32::NAN)
    }

    pub fn confidence(&self) -> f32 {
        self.confidence
    }

    pub fn beats(&self) -> Vec<f64> {
        self.beats.clone()
    }

    pub fn downbeats(&self) -> Vec<f64> {
        self.downbeats.clone()
    }
}

#[wasm_bindgen]
pub fn analyze_rhythm(samples: &[f32], sample_rate: u32) -> Result<RhythmAnalysis, JsValue> {
    if sample_rate == 0 {
        return Err(JsValue::from_str("sample rate must be greater than zero"));
    }

    let max_samples = (sample_rate as usize).saturating_mul(MAX_ANALYSIS_SECONDS);
    if samples.len() > max_samples {
        return Err(JsValue::from_str(
            "track analysis is bounded to fifteen minutes per deck",
        ));
    }

    let analysis = analyze_rhythm_track(samples, sample_rate, TrackRhythmConfig::default())
        .map_err(|error| JsValue::from_str(&error.to_string()))?;

    Ok(RhythmAnalysis {
        bpm: analysis.bpm,
        confidence: analysis.confidence,
        beats: analysis
            .beats
            .into_iter()
            .map(|beat| beat.timestamp_seconds)
            .collect(),
        downbeats: analysis.downbeats,
    })
}

#[wasm_bindgen]
pub fn waveform_extrema(samples: &[f32], point_count: usize) -> Vec<f32> {
    if samples.is_empty() || point_count == 0 {
        return Vec::new();
    }

    let point_count = point_count.min(MAX_WAVEFORM_POINTS).min(samples.len());
    let mut extrema = Vec::with_capacity(point_count * 2);

    for index in 0..point_count {
        let start = index * samples.len() / point_count;
        let mut end = (index + 1) * samples.len() / point_count;
        if end <= start {
            end = start + 1;
        }

        let mut minimum = 0.0_f32;
        let mut maximum = 0.0_f32;
        for sample in &samples[start..end.min(samples.len())] {
            if !sample.is_finite() {
                continue;
            }
            minimum = minimum.min(*sample);
            maximum = maximum.max(*sample);
        }
        extrema.push(minimum.clamp(-1.0, 1.0));
        extrema.push(maximum.clamp(-1.0, 1.0));
    }

    extrema
}

fn normalized_position(crossfader: f64) -> f64 {
    (crossfader.clamp(MIN_CROSSFADER, MAX_CROSSFADER) + 1.0) * 0.5
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f64 = 1e-12;

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= EPSILON,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn crossfader_edges_fully_select_one_deck() {
        let mut mixer = Mixer::new();

        mixer.set_crossfader(-1.0);
        assert_close(mixer.deck_a_gain(), 1.0);
        assert_close(mixer.deck_b_gain(), 0.0);

        mixer.set_crossfader(1.0);
        assert_close(mixer.deck_a_gain(), 0.0);
        assert_close(mixer.deck_b_gain(), 1.0);
    }

    #[test]
    fn centered_crossfader_uses_equal_power() {
        let mixer = Mixer::new();
        let expected = 1.0 / 2.0_f64.sqrt();

        assert_close(mixer.deck_a_gain(), expected);
        assert_close(mixer.deck_b_gain(), expected);
    }

    #[test]
    fn crossfader_values_are_clamped() {
        let mut mixer = Mixer::new();

        mixer.set_crossfader(-10.0);
        assert_close(mixer.crossfader(), -1.0);

        mixer.set_crossfader(10.0);
        assert_close(mixer.crossfader(), 1.0);
    }

    #[test]
    fn deck_levels_scale_the_mix_and_are_clamped() {
        let mut mixer = Mixer::new();
        let equal_power = 1.0 / 2.0_f64.sqrt();

        mixer.set_deck_a_level(0.5);
        mixer.set_deck_b_level(2.0);

        assert_close(mixer.deck_a_gain(), equal_power * 0.5);
        assert_close(mixer.deck_b_gain(), equal_power);

        mixer.set_deck_a_level(-1.0);
        assert_close(mixer.deck_a_gain(), 0.0);
    }

    #[test]
    fn cue_point_only_accepts_finite_nonnegative_times() {
        let mut cue = CuePoint::new();
        assert!(!cue.has_cue());
        assert!(!cue.set_seconds(-1.0));
        assert!(!cue.set_seconds(f64::NAN));
        assert!(cue.set_seconds(12.5));
        assert!(cue.has_cue());
        assert_close(cue.seconds(), 12.5);
        cue.clear();
        assert!(!cue.has_cue());
    }

    #[test]
    fn waveform_extrema_preserve_bucket_minimum_and_maximum() {
        let extrema = waveform_extrema(&[-0.5, 0.25, -1.2, 1.4], 2);
        assert_eq!(extrema, vec![-0.5, 0.25, -1.0, 1.0]);
    }

    #[test]
    fn silent_rhythm_analysis_has_no_tempo() {
        let samples = vec![0.0; 8_192];
        let analysis = analyze_rhythm(&samples, 8_000).expect("analyze silence");
        assert!(!analysis.has_bpm());
        assert!(analysis.beats().is_empty());
    }
}
