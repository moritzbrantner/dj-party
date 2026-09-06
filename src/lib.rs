use std::f64::consts::FRAC_PI_2;

use audio_analysis_rhythm::track::{TrackRhythmConfig, analyze_rhythm_track};
use wasm_bindgen::prelude::*;

const MIN_CROSSFADER: f64 = -1.0;
const MAX_CROSSFADER: f64 = 1.0;
const MIN_LEVEL: f64 = 0.0;
const MAX_LEVEL: f64 = 1.0;
const MIN_TEMPO_PERCENT: f64 = -16.0;
const MAX_TEMPO_PERCENT: f64 = 16.0;
const MIN_PLAYBACK_RATE: f64 = 0.84;
const MAX_PLAYBACK_RATE: f64 = 1.16;
const MAX_WAVEFORM_POINTS: usize = 2_048;
const MAX_ANALYSIS_SECONDS: usize = 15 * 60;
const LOOP_BEAT_COUNTS: [usize; 4] = [1, 2, 4, 8];

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
#[derive(Debug, Clone)]
pub struct SyncPlan {
    valid: bool,
    playback_rate: f64,
    target_bpm: f64,
    effective_bpm: f64,
    limited: bool,
}

#[wasm_bindgen]
impl SyncPlan {
    pub fn valid(&self) -> bool {
        self.valid
    }

    pub fn playback_rate(&self) -> f64 {
        self.playback_rate
    }

    pub fn target_bpm(&self) -> f64 {
        self.target_bpm
    }

    pub fn effective_bpm(&self) -> f64 {
        self.effective_bpm
    }

    pub fn limited(&self) -> bool {
        self.limited
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct BeatLoop {
    valid: bool,
    start_seconds: f64,
    end_seconds: f64,
    beat_count: usize,
}

#[wasm_bindgen]
impl BeatLoop {
    pub fn valid(&self) -> bool {
        self.valid
    }

    pub fn start_seconds(&self) -> f64 {
        self.start_seconds
    }

    pub fn end_seconds(&self) -> f64 {
        self.end_seconds
    }

    pub fn beat_count(&self) -> usize {
        self.beat_count
    }
}

#[wasm_bindgen]
pub fn playback_rate_for_tempo(tempo_percent: f64) -> f64 {
    if !tempo_percent.is_finite() {
        return 1.0;
    }

    1.0 + tempo_percent.clamp(MIN_TEMPO_PERCENT, MAX_TEMPO_PERCENT) / 100.0
}

#[wasm_bindgen]
pub fn tempo_percent_for_rate(playback_rate: f64) -> f64 {
    if !playback_rate.is_finite() || playback_rate <= 0.0 {
        return 0.0;
    }

    ((playback_rate.clamp(MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE) - 1.0) * 100.0)
        .clamp(MIN_TEMPO_PERCENT, MAX_TEMPO_PERCENT)
}

#[wasm_bindgen]
pub fn effective_bpm(base_bpm: f64, playback_rate: f64) -> f64 {
    if !base_bpm.is_finite()
        || base_bpm <= 0.0
        || !playback_rate.is_finite()
        || playback_rate <= 0.0
    {
        return f64::NAN;
    }

    base_bpm * playback_rate
}

#[wasm_bindgen]
pub fn plan_sync(source_bpm: f64, target_bpm: f64, target_playback_rate: f64) -> SyncPlan {
    if !source_bpm.is_finite()
        || source_bpm <= 0.0
        || !target_bpm.is_finite()
        || target_bpm <= 0.0
        || !target_playback_rate.is_finite()
        || target_playback_rate <= 0.0
    {
        return invalid_sync_plan();
    }

    let target_bpm = target_bpm * target_playback_rate;
    let requested_rate = target_bpm / source_bpm;
    let playback_rate = requested_rate.clamp(MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
    let effective_bpm = source_bpm * playback_rate;

    SyncPlan {
        valid: true,
        playback_rate,
        target_bpm,
        effective_bpm,
        limited: (playback_rate - requested_rate).abs() > f64::EPSILON,
    }
}

#[wasm_bindgen]
pub fn plan_beat_loop(
    beats: &[f64],
    current_seconds: f64,
    beat_count: usize,
    duration_seconds: f64,
) -> BeatLoop {
    if !current_seconds.is_finite()
        || current_seconds < 0.0
        || !duration_seconds.is_finite()
        || duration_seconds <= 0.0
        || !LOOP_BEAT_COUNTS.contains(&beat_count)
        || beats.len() <= beat_count
        || !valid_beat_grid(beats)
    {
        return invalid_beat_loop(beat_count);
    }

    if current_seconds > beats[beats.len() - 1] {
        return invalid_beat_loop(beat_count);
    }

    let last_start_index = beats.len() - beat_count - 1;
    let mut selected_index = None;
    let mut selected_distance = f64::INFINITY;

    for index in 0..=last_start_index {
        let start = beats[index];
        let end = beats[index + beat_count];
        if start < 0.0 || end <= start || end > duration_seconds {
            continue;
        }

        let distance = (start - current_seconds).abs();
        if distance < selected_distance {
            selected_index = Some(index);
            selected_distance = distance;
        }
    }

    let Some(index) = selected_index else {
        return invalid_beat_loop(beat_count);
    };

    BeatLoop {
        valid: true,
        start_seconds: beats[index],
        end_seconds: beats[index + beat_count],
        beat_count,
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

fn invalid_sync_plan() -> SyncPlan {
    SyncPlan {
        valid: false,
        playback_rate: 1.0,
        target_bpm: f64::NAN,
        effective_bpm: f64::NAN,
        limited: false,
    }
}

fn invalid_beat_loop(beat_count: usize) -> BeatLoop {
    BeatLoop {
        valid: false,
        start_seconds: 0.0,
        end_seconds: 0.0,
        beat_count,
    }
}

fn valid_beat_grid(beats: &[f64]) -> bool {
    if beats.iter().any(|beat| !beat.is_finite()) {
        return false;
    }

    beats.windows(2).all(|pair| pair[1] > pair[0])
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
    fn tempo_mapping_is_clamped_and_reversible_inside_range() {
        assert_close(playback_rate_for_tempo(-50.0), 0.84);
        assert_close(playback_rate_for_tempo(50.0), 1.16);
        assert_close(playback_rate_for_tempo(7.5), 1.075);
        assert_close(tempo_percent_for_rate(1.075), 7.5);
    }

    #[test]
    fn sync_plan_matches_target_effective_bpm_when_reachable() {
        let plan = plan_sync(120.0, 128.0, 1.0);
        assert!(plan.valid());
        assert!(!plan.limited());
        assert_close(plan.playback_rate(), 128.0 / 120.0);
        assert_close(plan.target_bpm(), 128.0);
        assert_close(plan.effective_bpm(), 128.0);
    }

    #[test]
    fn sync_plan_reports_when_rate_range_limits_match() {
        let plan = plan_sync(100.0, 140.0, 1.0);
        assert!(plan.valid());
        assert!(plan.limited());
        assert_close(plan.playback_rate(), 1.16);
        assert_close(plan.effective_bpm(), 116.0);
    }

    #[test]
    fn beat_loop_quantizes_to_nearest_beat_and_spans_requested_beats() {
        let beats = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
        let beat_loop = plan_beat_loop(&beats, 1.82, 2, 4.0);
        assert!(beat_loop.valid());
        assert_close(beat_loop.start_seconds(), 2.0);
        assert_close(beat_loop.end_seconds(), 3.0);
        assert_eq!(beat_loop.beat_count(), 2);
    }

    #[test]
    fn beat_loop_rejects_invalid_unsupported_or_unanalyzed_positions() {
        assert!(!plan_beat_loop(&[0.0, 1.0, 0.5], 0.5, 1, 2.0).valid());
        assert!(!plan_beat_loop(&[0.0, 1.0, 2.0], 0.5, 3, 3.0).valid());
        assert!(!plan_beat_loop(&[0.0, 1.0, 2.0], 8.0, 1, 10.0).valid());
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
