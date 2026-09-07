use wasm_bindgen::prelude::*;

use crate::{plan_sync, valid_beat_grid};

const BEATS_PER_BAR: usize = 4;
const HOT_CUE_SLOTS: usize = 4;
const ALLOWED_BEAT_JUMPS: [i32; 4] = [-8, -4, 4, 8];
const DOWNBEAT_MATCH_EPSILON: f64 = 1e-4;

#[derive(Debug, Clone, Copy)]
struct Position {
    beat_index: usize,
    phase: f64,
    beat_start_seconds: f64,
    beat_end_seconds: f64,
    bar_index: usize,
    beat_in_bar: usize,
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct BeatPosition {
    valid: bool,
    beat_index: usize,
    phase: f64,
    beat_start_seconds: f64,
    beat_end_seconds: f64,
    bar_index: usize,
    beat_in_bar: usize,
}

#[wasm_bindgen]
impl BeatPosition {
    pub fn valid(&self) -> bool {
        self.valid
    }

    pub fn beat_index(&self) -> usize {
        self.beat_index
    }

    pub fn phase(&self) -> f64 {
        self.phase
    }

    pub fn beat_start_seconds(&self) -> f64 {
        self.beat_start_seconds
    }

    pub fn beat_end_seconds(&self) -> f64 {
        self.beat_end_seconds
    }

    pub fn bar_index(&self) -> usize {
        self.bar_index
    }

    pub fn beat_in_bar(&self) -> usize {
        self.beat_in_bar
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct HotCueBank {
    slots: [Option<f64>; HOT_CUE_SLOTS],
}

impl Default for HotCueBank {
    fn default() -> Self {
        Self {
            slots: [None; HOT_CUE_SLOTS],
        }
    }
}

#[wasm_bindgen]
impl HotCueBank {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_quantized(
        &mut self,
        slot: usize,
        beats: &[f64],
        current_seconds: f64,
        duration_seconds: f64,
    ) -> bool {
        let Some(index) = cue_slot_index(slot) else {
            return false;
        };
        let Some(seconds) = nearest_beat_seconds(beats, current_seconds, duration_seconds) else {
            return false;
        };

        self.slots[index] = Some(seconds);
        true
    }

    pub fn clear(&mut self, slot: usize) -> bool {
        let Some(index) = cue_slot_index(slot) else {
            return false;
        };

        self.slots[index] = None;
        true
    }

    pub fn clear_all(&mut self) {
        self.slots.fill(None);
    }

    pub fn has_cue(&self, slot: usize) -> bool {
        cue_slot_index(slot).is_some_and(|index| self.slots[index].is_some())
    }

    pub fn seconds(&self, slot: usize) -> f64 {
        cue_slot_index(slot)
            .and_then(|index| self.slots[index])
            .unwrap_or(f64::NAN)
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct BeatJump {
    valid: bool,
    target_seconds: f64,
    beat_delta: i32,
}

#[wasm_bindgen]
impl BeatJump {
    pub fn valid(&self) -> bool {
        self.valid
    }

    pub fn target_seconds(&self) -> f64 {
        self.target_seconds
    }

    pub fn beat_delta(&self) -> i32 {
        self.beat_delta
    }
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct PhaseSyncPlan {
    valid: bool,
    playback_rate: f64,
    target_seconds: f64,
    target_bpm: f64,
    effective_bpm: f64,
    limited: bool,
    bar_aligned: bool,
    reference_phase: f64,
    reference_beat_in_bar: usize,
}

#[wasm_bindgen]
impl PhaseSyncPlan {
    pub fn valid(&self) -> bool {
        self.valid
    }

    pub fn playback_rate(&self) -> f64 {
        self.playback_rate
    }

    pub fn target_seconds(&self) -> f64 {
        self.target_seconds
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

    pub fn bar_aligned(&self) -> bool {
        self.bar_aligned
    }

    pub fn reference_phase(&self) -> f64 {
        self.reference_phase
    }

    pub fn reference_beat_in_bar(&self) -> usize {
        self.reference_beat_in_bar
    }
}

#[wasm_bindgen]
pub fn locate_beat_position(
    beats: &[f64],
    downbeats: &[f64],
    current_seconds: f64,
) -> BeatPosition {
    locate_position(beats, downbeats, current_seconds)
        .map(beat_position_from)
        .unwrap_or_else(invalid_beat_position)
}

#[wasm_bindgen]
pub fn plan_beat_jump(
    beats: &[f64],
    current_seconds: f64,
    beat_delta: i32,
    duration_seconds: f64,
) -> BeatJump {
    if !ALLOWED_BEAT_JUMPS.contains(&beat_delta)
        || !duration_seconds.is_finite()
        || duration_seconds <= 0.0
    {
        return invalid_beat_jump(beat_delta);
    }

    let Some(position) = locate_position(beats, &[], current_seconds) else {
        return invalid_beat_jump(beat_delta);
    };
    let target_index = position.beat_index as i64 + i64::from(beat_delta);
    if target_index < 0 || target_index as usize + 1 >= beats.len() {
        return invalid_beat_jump(beat_delta);
    }

    let target_index = target_index as usize;
    let target_start = beats[target_index];
    let target_end = beats[target_index + 1];
    let target_seconds = target_start + position.phase * (target_end - target_start);
    if !target_seconds.is_finite() || target_seconds < 0.0 || target_seconds > duration_seconds {
        return invalid_beat_jump(beat_delta);
    }

    BeatJump {
        valid: true,
        target_seconds,
        beat_delta,
    }
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn plan_phase_sync(
    source_bpm: f64,
    source_beats: &[f64],
    source_downbeats: &[f64],
    source_current_seconds: f64,
    source_duration_seconds: f64,
    reference_bpm: f64,
    reference_playback_rate: f64,
    reference_beats: &[f64],
    reference_downbeats: &[f64],
    reference_current_seconds: f64,
) -> PhaseSyncPlan {
    let tempo = plan_sync(source_bpm, reference_bpm, reference_playback_rate);
    if !tempo.valid() || !source_duration_seconds.is_finite() || source_duration_seconds <= 0.0 {
        return invalid_phase_sync_plan();
    }

    let Some(_source_position) =
        locate_position(source_beats, source_downbeats, source_current_seconds)
    else {
        return invalid_phase_sync_plan();
    };
    let Some(reference_position) = locate_position(
        reference_beats,
        reference_downbeats,
        reference_current_seconds,
    ) else {
        return invalid_phase_sync_plan();
    };

    let desired_beat_in_bar = reference_position.beat_in_bar;
    let bar_candidate = (desired_beat_in_bar > 0).then(|| {
        nearest_phase_candidate(
            source_beats,
            source_downbeats,
            source_current_seconds,
            source_duration_seconds,
            reference_position.phase,
            Some(desired_beat_in_bar),
        )
    });
    let (target_seconds, bar_aligned) = match bar_candidate.flatten() {
        Some(seconds) => (seconds, true),
        None => {
            let Some(seconds) = nearest_phase_candidate(
                source_beats,
                source_downbeats,
                source_current_seconds,
                source_duration_seconds,
                reference_position.phase,
                None,
            ) else {
                return invalid_phase_sync_plan();
            };
            (seconds, false)
        }
    };

    PhaseSyncPlan {
        valid: true,
        playback_rate: tempo.playback_rate(),
        target_seconds,
        target_bpm: tempo.target_bpm(),
        effective_bpm: tempo.effective_bpm(),
        limited: tempo.limited(),
        bar_aligned,
        reference_phase: reference_position.phase,
        reference_beat_in_bar: desired_beat_in_bar,
    }
}

fn beat_position_from(position: Position) -> BeatPosition {
    BeatPosition {
        valid: true,
        beat_index: position.beat_index + 1,
        phase: position.phase,
        beat_start_seconds: position.beat_start_seconds,
        beat_end_seconds: position.beat_end_seconds,
        bar_index: position.bar_index,
        beat_in_bar: position.beat_in_bar,
    }
}

fn locate_position(beats: &[f64], downbeats: &[f64], current_seconds: f64) -> Option<Position> {
    if beats.len() < 2
        || !current_seconds.is_finite()
        || current_seconds < 0.0
        || !valid_nonnegative_grid(beats)
        || current_seconds < beats[0]
        || current_seconds >= beats[beats.len() - 1]
    {
        return None;
    }

    let beat_index = beats
        .partition_point(|beat| *beat <= current_seconds)
        .saturating_sub(1);
    if beat_index + 1 >= beats.len() {
        return None;
    }

    let beat_start_seconds = beats[beat_index];
    let beat_end_seconds = beats[beat_index + 1];
    let phase = ((current_seconds - beat_start_seconds) / (beat_end_seconds - beat_start_seconds))
        .clamp(0.0, 1.0);
    let (bar_index, beat_in_bar) = bar_context(beats, downbeats, beat_index);

    Some(Position {
        beat_index,
        phase,
        beat_start_seconds,
        beat_end_seconds,
        bar_index,
        beat_in_bar,
    })
}

fn nearest_phase_candidate(
    beats: &[f64],
    downbeats: &[f64],
    current_seconds: f64,
    duration_seconds: f64,
    phase: f64,
    beat_in_bar_filter: Option<usize>,
) -> Option<f64> {
    if beats.len() < 2 || !valid_nonnegative_grid(beats) || !phase.is_finite() {
        return None;
    }

    let mut selected = None;
    let mut selected_distance = f64::INFINITY;
    for index in 0..beats.len() - 1 {
        let start = beats[index];
        let end = beats[index + 1];
        if end > duration_seconds {
            continue;
        }
        if let Some(required) = beat_in_bar_filter {
            let (_, candidate_beat_in_bar) = bar_context(beats, downbeats, index);
            if candidate_beat_in_bar != required {
                continue;
            }
        }

        let seconds = start + phase.clamp(0.0, 1.0) * (end - start);
        let distance = (seconds - current_seconds).abs();
        if distance < selected_distance {
            selected = Some(seconds);
            selected_distance = distance;
        }
    }
    selected
}

fn bar_context(beats: &[f64], downbeats: &[f64], beat_index: usize) -> (usize, usize) {
    if downbeats.is_empty() || !valid_nonnegative_grid(downbeats) || beat_index >= beats.len() {
        return (0, 0);
    }

    let beat_start = beats[beat_index];
    let Some(downbeat_index) = downbeats
        .iter()
        .rposition(|downbeat| *downbeat <= beat_start)
    else {
        return (0, 0);
    };
    let downbeat = downbeats[downbeat_index];
    let anchor = beats
        .iter()
        .enumerate()
        .min_by(|(_, left), (_, right)| {
            (**left - downbeat)
                .abs()
                .total_cmp(&(**right - downbeat).abs())
        })
        .map(|(index, _)| index);
    let Some(anchor) = anchor else {
        return (0, 0);
    };
    if (beats[anchor] - downbeat).abs() > DOWNBEAT_MATCH_EPSILON || anchor > beat_index {
        return (0, 0);
    }

    (
        downbeat_index + 1,
        ((beat_index - anchor) % BEATS_PER_BAR) + 1,
    )
}

fn nearest_beat_seconds(beats: &[f64], current_seconds: f64, duration_seconds: f64) -> Option<f64> {
    if beats.is_empty()
        || !current_seconds.is_finite()
        || current_seconds < 0.0
        || !duration_seconds.is_finite()
        || duration_seconds <= 0.0
        || !valid_nonnegative_grid(beats)
        || current_seconds > beats[beats.len() - 1]
    {
        return None;
    }

    let mut selected = None;
    let mut selected_distance = f64::INFINITY;
    for beat in beats
        .iter()
        .copied()
        .filter(|beat| *beat <= duration_seconds)
    {
        let distance = (beat - current_seconds).abs();
        if distance < selected_distance {
            selected = Some(beat);
            selected_distance = distance;
        }
    }
    selected
}

fn cue_slot_index(slot: usize) -> Option<usize> {
    (1..=HOT_CUE_SLOTS).contains(&slot).then_some(slot - 1)
}

fn valid_nonnegative_grid(values: &[f64]) -> bool {
    !values.is_empty()
        && values
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0)
        && valid_beat_grid(values)
}

fn invalid_beat_position() -> BeatPosition {
    BeatPosition {
        valid: false,
        beat_index: 0,
        phase: f64::NAN,
        beat_start_seconds: f64::NAN,
        beat_end_seconds: f64::NAN,
        bar_index: 0,
        beat_in_bar: 0,
    }
}

fn invalid_beat_jump(beat_delta: i32) -> BeatJump {
    BeatJump {
        valid: false,
        target_seconds: f64::NAN,
        beat_delta,
    }
}

fn invalid_phase_sync_plan() -> PhaseSyncPlan {
    PhaseSyncPlan {
        valid: false,
        playback_rate: 1.0,
        target_seconds: f64::NAN,
        target_bpm: f64::NAN,
        effective_bpm: f64::NAN,
        limited: false,
        bar_aligned: false,
        reference_phase: f64::NAN,
        reference_beat_in_bar: 0,
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
    fn beat_position_reports_bar_beat_and_fractional_phase() {
        let beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
        let downbeats = [0.0, 2.0, 4.0];
        let position = locate_beat_position(&beats, &downbeats, 2.75);

        assert!(position.valid());
        assert_eq!(position.beat_index(), 6);
        assert_eq!(position.bar_index(), 2);
        assert_eq!(position.beat_in_bar(), 2);
        assert_close(position.phase(), 0.5);
    }

    #[test]
    fn hot_cues_quantize_to_nearest_verified_beat() {
        let mut cues = HotCueBank::new();
        let beats = [0.0, 0.5, 1.0, 1.5, 2.0];

        assert!(cues.set_quantized(1, &beats, 1.26, 3.0));
        assert!(cues.has_cue(1));
        assert_close(cues.seconds(1), 1.5);
        assert!(!cues.set_quantized(5, &beats, 1.0, 3.0));
        assert!(!cues.set_quantized(2, &beats, 8.0, 10.0));
    }

    #[test]
    fn beat_jump_preserves_phase_inside_target_beat() {
        let beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
        let jump = plan_beat_jump(&beats, 1.25, 4, 5.0);

        assert!(jump.valid());
        assert_eq!(jump.beat_delta(), 4);
        assert_close(jump.target_seconds(), 3.25);
        assert!(!plan_beat_jump(&beats, 1.25, 3, 5.0).valid());
    }

    #[test]
    fn phase_sync_matches_reference_phase_and_bar_beat_when_available() {
        let beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
        let downbeats = [0.0, 2.0, 4.0];
        let plan = plan_phase_sync(
            120.0, &beats, &downbeats, 1.8, 4.0, 128.0, 1.0, &beats, &downbeats, 2.25,
        );

        assert!(plan.valid());
        assert!(plan.bar_aligned());
        assert_close(plan.playback_rate(), 128.0 / 120.0);
        assert_close(plan.reference_phase(), 0.5);
        assert_eq!(plan.reference_beat_in_bar(), 1);
        assert_close(plan.target_seconds(), 2.25);
    }

    #[test]
    fn phase_sync_fails_closed_outside_analyzed_beat_horizon() {
        let beats = [0.0, 0.5, 1.0, 1.5, 2.0];
        let downbeats = [0.0, 2.0];
        let plan = plan_phase_sync(
            120.0, &beats, &downbeats, 8.0, 10.0, 120.0, 1.0, &beats, &downbeats, 1.25,
        );

        assert!(!plan.valid());
    }
}
