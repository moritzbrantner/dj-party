use std::f64::consts::FRAC_PI_2;

use wasm_bindgen::prelude::*;

const MIN_MONITOR_VALUE: f64 = 0.0;
const MAX_MONITOR_VALUE: f64 = 1.0;
const DEFAULT_MONITOR_LEVEL: f64 = 0.75;

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct MonitorMixer {
    deck_a_cue: bool,
    deck_b_cue: bool,
    mix: f64,
    level: f64,
}

impl Default for MonitorMixer {
    fn default() -> Self {
        Self {
            deck_a_cue: false,
            deck_b_cue: false,
            mix: 0.0,
            level: DEFAULT_MONITOR_LEVEL,
        }
    }
}

#[wasm_bindgen]
impl MonitorMixer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_deck_a_cue(&mut self, enabled: bool) {
        self.deck_a_cue = enabled;
    }

    pub fn set_deck_b_cue(&mut self, enabled: bool) {
        self.deck_b_cue = enabled;
    }

    pub fn deck_a_cue_enabled(&self) -> bool {
        self.deck_a_cue
    }

    pub fn deck_b_cue_enabled(&self) -> bool {
        self.deck_b_cue
    }

    pub fn set_mix(&mut self, value: f64) {
        self.mix = sanitize_unit(value);
    }

    pub fn mix(&self) -> f64 {
        self.mix
    }

    pub fn set_level(&mut self, value: f64) {
        self.level = sanitize_unit(value);
    }

    pub fn level(&self) -> f64 {
        self.level
    }

    pub fn master_gain(&self) -> f64 {
        (self.mix * FRAC_PI_2).sin() * self.level
    }

    pub fn deck_a_cue_gain(&self) -> f64 {
        self.deck_cue_gain(self.deck_a_cue)
    }

    pub fn deck_b_cue_gain(&self) -> f64 {
        self.deck_cue_gain(self.deck_b_cue)
    }
}

impl MonitorMixer {
    fn deck_cue_gain(&self, enabled: bool) -> f64 {
        if !enabled {
            return 0.0;
        }

        let selected = self.deck_a_cue as usize + self.deck_b_cue as usize;
        if selected == 0 {
            return 0.0;
        }

        let cue_bus_gain = (self.mix * FRAC_PI_2).cos() * self.level;
        cue_bus_gain / (selected as f64).sqrt()
    }
}

fn sanitize_unit(value: f64) -> f64 {
    if !value.is_finite() {
        return MIN_MONITOR_VALUE;
    }

    value.clamp(MIN_MONITOR_VALUE, MAX_MONITOR_VALUE)
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
    fn monitor_defaults_to_cue_side_without_sending_unselected_decks() {
        let monitor = MonitorMixer::new();

        assert!(!monitor.deck_a_cue_enabled());
        assert!(!monitor.deck_b_cue_enabled());
        assert_close(monitor.mix(), 0.0);
        assert_close(monitor.level(), DEFAULT_MONITOR_LEVEL);
        assert_close(monitor.deck_a_cue_gain(), 0.0);
        assert_close(monitor.deck_b_cue_gain(), 0.0);
        assert_close(monitor.master_gain(), 0.0);
    }

    #[test]
    fn cue_master_mix_uses_equal_power_weights() {
        let mut monitor = MonitorMixer::new();
        monitor.set_deck_a_cue(true);
        monitor.set_level(1.0);
        monitor.set_mix(0.5);

        let equal_power = 1.0 / 2.0_f64.sqrt();
        assert_close(monitor.deck_a_cue_gain(), equal_power);
        assert_close(monitor.master_gain(), equal_power);
    }

    #[test]
    fn two_cued_decks_normalize_the_cue_bus_power() {
        let mut monitor = MonitorMixer::new();
        monitor.set_deck_a_cue(true);
        monitor.set_deck_b_cue(true);
        monitor.set_level(1.0);

        let deck_gain = 1.0 / 2.0_f64.sqrt();
        assert_close(monitor.deck_a_cue_gain(), deck_gain);
        assert_close(monitor.deck_b_cue_gain(), deck_gain);
        assert_close(
            monitor.deck_a_cue_gain().powi(2) + monitor.deck_b_cue_gain().powi(2),
            1.0,
        );
    }

    #[test]
    fn monitor_mix_and_level_are_clamped_and_reject_non_finite_values() {
        let mut monitor = MonitorMixer::new();

        monitor.set_mix(2.0);
        monitor.set_level(-1.0);
        assert_close(monitor.mix(), 1.0);
        assert_close(monitor.level(), 0.0);

        monitor.set_mix(f64::NAN);
        monitor.set_level(f64::INFINITY);
        assert_close(monitor.mix(), 0.0);
        assert_close(monitor.level(), 0.0);
    }
}
