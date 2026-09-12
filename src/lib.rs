use audio_analysis_processing::operations::playback::{
    TempoRange, effective_bpm as shared_effective_bpm, equal_power_crossfade_gains,
    plan_beat_loop as shared_plan_beat_loop, plan_bpm_sync,
    playback_rate_for_tempo as shared_playback_rate_for_tempo,
    tempo_percent_for_rate as shared_tempo_percent_for_rate, valid_beat_grid,
    waveform_extrema as shared_waveform_extrema,
};
use audio_analysis_rhythm::track::{TrackRhythmConfig, analyze_rhythm_track};
use wasm_bindgen::prelude::*;

mod effects;
mod monitoring;
mod transport;
pub use effects::*;
pub use monitoring::*;
pub use transport::*;

const MIN_CROSSFADER: f64 = -1.0;
const MAX_CROSSFADER: f64 = 1.0;
const MIN_LEVEL: f64 = 0.0;
const MAX_LEVEL: f64 = 1.0;
const MIN_TEMPO_PERCENT: f64 = -16.0;
const MAX_TEMPO_PERCENT: f64 = 16.0;
const DJ_TEMPO_RANGE: TempoRange = TempoRange::new(MIN_TEMPO_PERCENT, MAX_TEMPO_PERCENT);
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
        equal_power_crossfade_gains(self.crossfader).left * self.deck_a_level
    }

    pub fn deck_b_gain(&self) -> f64 {
        equal_power_crossfade_gains(self.crossfader).right * self.deck_b_level
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
    shared_playback_rate_for_tempo(tempo_percent, DJ_TEMPO_RANGE).unwrap_or(1.0)
}

#[wasm_bindgen]
pub fn tempo_percent_for_rate(playback_rate: f64) -> f64 {
    shared_tempo_percent_for_rate(playback_rate, DJ_TEMPO_RANGE).unwrap_or(0.0)
}

#[wasm_bindgen]
pub fn effective_bpm(base_bpm: f64, playback_rate: f64) -> f64 {
    shared_effective_bpm(base_bpm, playback_rate).unwrap_or(f64::NAN)
}

#[wasm_bindgen]
pub fn plan_sync(source_bpm: f64, target_bpm: f64, target_playback_rate: f64) -> SyncPlan {
    let Some(plan) = plan_bpm_sync(source_bpm, target_bpm, target_playback_rate, DJ_TEMPO_RANGE)
    else {
        return invalid_sync_plan();
    };

    SyncPlan {
        valid: true,
        playback_rate: plan.playback_rate,
        target_bpm: plan.target_effective_bpm,
        effective_bpm: plan.source_effective_bpm,
        limited: plan.limited,
    }
}

#[wasm_bindgen]
pub fn plan_beat_loop(
    beats: &[f64],
    current_seconds: f64,
    beat_count: usize,
    duration_seconds: f64,
) -> BeatLoop {
    if !LOOP_BEAT_COUNTS.contains(&beat_count) {
        return invalid_beat_loop(beat_count);
    }

    let Some(plan) = shared_plan_beat_loop(beats, current_seconds, beat_count, duration_seconds)
    else {
        return invalid_beat_loop(beat_count);
    };

    BeatLoop {
        valid: true,
        start_seconds: plan.start_seconds,
        end_seconds: plan.end_seconds,
        beat_count: plan.beat_count,
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
    let point_count = point_count.min(MAX_WAVEFORM_POINTS);
    shared_waveform_extrema(samples, point_count)
        .into_iter()
        .flat_map(|point| [point.min, point.max])
        .collect()
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
