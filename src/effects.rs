use wasm_bindgen::prelude::*;

const MIN_CONTROL: f64 = -1.0;
const MAX_CONTROL: f64 = 1.0;
const EQ_GAIN_DB: f64 = 12.0;
const LOW_FREQUENCY_HZ: f64 = 250.0;
const MID_FREQUENCY_HZ: f64 = 1_000.0;
const MID_Q: f64 = 0.9;
const HIGH_FREQUENCY_HZ: f64 = 4_000.0;
const FILTER_Q: f64 = 0.8;
const LOW_PASS_OPEN_HZ: f64 = 18_000.0;
const LOW_PASS_CLOSED_HZ: f64 = 80.0;
const HIGH_PASS_OPEN_HZ: f64 = 20.0;
const HIGH_PASS_CLOSED_HZ: f64 = 8_000.0;

const FILTER_BYPASS: u8 = 0;
const FILTER_LOW_PASS: u8 = 1;
const FILTER_HIGH_PASS: u8 = 2;

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct DeckTonePlan {
    low_gain_db: f64,
    mid_gain_db: f64,
    high_gain_db: f64,
    low_frequency_hz: f64,
    mid_frequency_hz: f64,
    mid_q: f64,
    high_frequency_hz: f64,
    filter_enabled: bool,
    filter_mode: u8,
    filter_frequency_hz: f64,
    filter_q: f64,
}

#[wasm_bindgen]
impl DeckTonePlan {
    pub fn low_gain_db(&self) -> f64 {
        self.low_gain_db
    }

    pub fn mid_gain_db(&self) -> f64 {
        self.mid_gain_db
    }

    pub fn high_gain_db(&self) -> f64 {
        self.high_gain_db
    }

    pub fn low_frequency_hz(&self) -> f64 {
        self.low_frequency_hz
    }

    pub fn mid_frequency_hz(&self) -> f64 {
        self.mid_frequency_hz
    }

    pub fn mid_q(&self) -> f64 {
        self.mid_q
    }

    pub fn high_frequency_hz(&self) -> f64 {
        self.high_frequency_hz
    }

    pub fn filter_enabled(&self) -> bool {
        self.filter_enabled
    }

    pub fn filter_mode(&self) -> u8 {
        self.filter_mode
    }

    pub fn filter_frequency_hz(&self) -> f64 {
        self.filter_frequency_hz
    }

    pub fn filter_q(&self) -> f64 {
        self.filter_q
    }
}

#[wasm_bindgen]
pub fn plan_deck_tone(low: f64, mid: f64, high: f64, filter: f64) -> DeckTonePlan {
    let low = normalize_control(low);
    let mid = normalize_control(mid);
    let high = normalize_control(high);
    let filter = normalize_control(filter);

    let (filter_enabled, filter_mode, filter_frequency_hz) = if filter < 0.0 {
        (
            true,
            FILTER_LOW_PASS,
            log_lerp(LOW_PASS_OPEN_HZ, LOW_PASS_CLOSED_HZ, -filter),
        )
    } else if filter > 0.0 {
        (
            true,
            FILTER_HIGH_PASS,
            log_lerp(HIGH_PASS_OPEN_HZ, HIGH_PASS_CLOSED_HZ, filter),
        )
    } else {
        (false, FILTER_BYPASS, LOW_PASS_OPEN_HZ)
    };

    DeckTonePlan {
        low_gain_db: low * EQ_GAIN_DB,
        mid_gain_db: mid * EQ_GAIN_DB,
        high_gain_db: high * EQ_GAIN_DB,
        low_frequency_hz: LOW_FREQUENCY_HZ,
        mid_frequency_hz: MID_FREQUENCY_HZ,
        mid_q: MID_Q,
        high_frequency_hz: HIGH_FREQUENCY_HZ,
        filter_enabled,
        filter_mode,
        filter_frequency_hz,
        filter_q: FILTER_Q,
    }
}

fn normalize_control(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(MIN_CONTROL, MAX_CONTROL)
    } else {
        0.0
    }
}

fn log_lerp(start_hz: f64, end_hz: f64, amount: f64) -> f64 {
    let amount = amount.clamp(0.0, 1.0);
    (start_hz.ln() + (end_hz.ln() - start_hz.ln()) * amount).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f64 = 1e-9;

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= EPSILON,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn neutral_controls_are_flat_and_bypass_the_filter() {
        let plan = plan_deck_tone(0.0, 0.0, 0.0, 0.0);

        assert_close(plan.low_gain_db, 0.0);
        assert_close(plan.mid_gain_db, 0.0);
        assert_close(plan.high_gain_db, 0.0);
        assert!(!plan.filter_enabled);
        assert_eq!(plan.filter_mode, FILTER_BYPASS);
    }

    #[test]
    fn eq_controls_clamp_to_product_gain_range() {
        let plan = plan_deck_tone(-4.0, 0.5, 7.0, 0.0);

        assert_close(plan.low_gain_db, -12.0);
        assert_close(plan.mid_gain_db, 6.0);
        assert_close(plan.high_gain_db, 12.0);
    }

    #[test]
    fn invalid_controls_fail_to_neutral_values() {
        let plan = plan_deck_tone(f64::NAN, f64::INFINITY, f64::NEG_INFINITY, f64::NAN);

        assert_close(plan.low_gain_db, 0.0);
        assert_close(plan.mid_gain_db, 0.0);
        assert_close(plan.high_gain_db, 0.0);
        assert!(!plan.filter_enabled);
    }

    #[test]
    fn negative_filter_sweeps_low_pass_logarithmically() {
        let open = plan_deck_tone(0.0, 0.0, 0.0, -0.01);
        let middle = plan_deck_tone(0.0, 0.0, 0.0, -0.5);
        let closed = plan_deck_tone(0.0, 0.0, 0.0, -1.0);

        assert_eq!(closed.filter_mode, FILTER_LOW_PASS);
        assert!(open.filter_frequency_hz > middle.filter_frequency_hz);
        assert!(middle.filter_frequency_hz > closed.filter_frequency_hz);
        assert_close(closed.filter_frequency_hz, LOW_PASS_CLOSED_HZ);
    }

    #[test]
    fn positive_filter_sweeps_high_pass_logarithmically() {
        let open = plan_deck_tone(0.0, 0.0, 0.0, 0.01);
        let middle = plan_deck_tone(0.0, 0.0, 0.0, 0.5);
        let closed = plan_deck_tone(0.0, 0.0, 0.0, 1.0);

        assert_eq!(closed.filter_mode, FILTER_HIGH_PASS);
        assert!(open.filter_frequency_hz < middle.filter_frequency_hz);
        assert!(middle.filter_frequency_hz < closed.filter_frequency_hz);
        assert_close(closed.filter_frequency_hz, HIGH_PASS_CLOSED_HZ);
    }
}
