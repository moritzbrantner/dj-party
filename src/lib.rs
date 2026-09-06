use std::f64::consts::FRAC_PI_2;

use wasm_bindgen::prelude::*;

const MIN_CROSSFADER: f64 = -1.0;
const MAX_CROSSFADER: f64 = 1.0;
const MIN_LEVEL: f64 = 0.0;
const MAX_LEVEL: f64 = 1.0;

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
}
