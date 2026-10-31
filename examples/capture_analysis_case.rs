//! Capture a DJ Party analysis failure as an `audio-analysis` consumer-failure case.
//!
//! Runs the deck worker's exact rhythm path (`analyze_track_rhythm`) on a local
//! file decoded by `ffmpeg` to mono 48 kHz (the browser's mean mixdown), and
//! prints one JSON case for
//! `audio-analysis/crates/audio/audio-analysis-rhythm/tests/fixtures/consumer-failures.v1.json`.
//!
//! ```text
//! cargo run --example capture_analysis_case -- track.mp3 --id my-case \
//!   --scenario bpm-sync --expected-bpm 124 [--expected-downbeat 0.42] \
//!   [--start 30 --duration 20] [--license CC0-1.0 --source-url https://… \
//!   --excerpt-out excerpt.wav] [--note "what went wrong in the product"]
//! ```
//!
//! Without a free license the case records only features, expected vs observed
//! values and provenance (`audio.kind = "private"`); no audio leaves the machine.
//! `--excerpt-out` refuses NC/ND or unlicensed audio.

use std::{collections::HashMap, env, process::Command};

use serde_json::json;
use sha2::{Digest, Sha256};

const SAMPLE_RATE: u32 = 48_000;
const SCENARIOS: [&str; 6] = [
    "bpm-sync",
    "phase-sync",
    "beat-loop",
    "beat-jump",
    "bar-beat-display",
    "analysis-cache",
];

fn main() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let input = args
        .next()
        .ok_or("usage: capture_analysis_case <audio-file> [--flag value]…")?;
    let mut flags = HashMap::new();
    while let Some(flag) = args.next() {
        let name = flag
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected argument {flag}"))?;
        let value = args
            .next()
            .ok_or_else(|| format!("--{name} needs a value"))?;
        flags.insert(name.to_owned(), value);
    }
    let number = |name: &str| -> Result<Option<f64>, String> {
        flags
            .get(name)
            .map(|value| {
                value
                    .parse()
                    .map_err(|_| format!("--{name} must be a number"))
            })
            .transpose()
    };

    let id = flags.get("id").ok_or("--id is required")?;
    let scenario = flags.get("scenario").ok_or("--scenario is required")?;
    if !SCENARIOS.contains(&scenario.as_str()) {
        return Err(format!("--scenario must be one of {SCENARIOS:?}"));
    }
    let start = number("start")?.unwrap_or(0.0);
    let duration = number("duration")?;
    let license = flags.get("license");

    let samples = decode(&input, start, duration)?;
    let analysis = dj_party::analyze_track_rhythm(&samples, SAMPLE_RATE)?;
    let pcm_sha256 = hex(&Sha256::digest(
        samples
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect::<Vec<_>>(),
    ));

    let audio = match (license, flags.get("excerpt-out")) {
        (Some(license), Some(path)) => {
            if !free_license(license) {
                return Err(format!("refusing to write an excerpt under {license}"));
            }
            let sha256 = write_wav(path, &samples)?;
            json!({
                "kind": "excerpt",
                "path": format!("consumer-audio/{}", file_name(path)),
                "sha256": sha256,
                "license": license,
                "sourceUrl": flags.get("source-url"),
                "startSeconds": start,
                "durationSeconds": samples.len() as f64 / SAMPLE_RATE as f64,
            })
        }
        (_, Some(_)) => return Err("--excerpt-out needs --license".to_owned()),
        _ => json!({
            "kind": if license.is_some() { "excerpt-reference" } else { "private" },
            "license": license,
            "sourceUrl": flags.get("source-url"),
            "decodedPcmSha256": pcm_sha256,
            "sampleRate": SAMPLE_RATE,
            "startSeconds": start,
            "durationSeconds": samples.len() as f64 / SAMPLE_RATE as f64,
        }),
    };

    let beats = analysis.beats();
    let downbeats = analysis.downbeats();
    let median_period = {
        let mut periods = beats.windows(2).map(|w| w[1] - w[0]).collect::<Vec<_>>();
        periods.sort_by(f64::total_cmp);
        periods.get(periods.len() / 2).copied()
    };
    let case = json!({
        "id": id,
        "status": "open",
        "consumer": "moritzbrantner/dj-party",
        "scenario": scenario,
        "note": flags.get("note"),
        "provenance": {
            "consumerRevision": git_head(),
            "audioAnalysisRevision": audio_analysis_rev(),
            "entryPoint": "dj_party::analyze_track_rhythm (TrackRhythmConfig::default)",
        },
        "audio": audio,
        "expected": {
            "bpm": number("expected-bpm")?,
            "firstDownbeatSeconds": number("expected-downbeat")?,
        },
        "observed": {
            "bpm": analysis.has_bpm().then(|| analysis.bpm()),
            "confidence": analysis.confidence(),
            "beatCount": beats.len(),
            "medianBeatPeriodSeconds": median_period,
            "firstBeatsSeconds": beats.iter().take(8).collect::<Vec<_>>(),
            "firstDownbeatSeconds": downbeats.first(),
        },
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&case).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn decode(input: &str, start: f64, duration: Option<f64>) -> Result<Vec<f32>, String> {
    let mut command = Command::new("ffmpeg");
    command.args(["-v", "error", "-ss", &start.to_string(), "-i", input]);
    if let Some(duration) = duration {
        command.args(["-t", &duration.to_string()]);
    }
    let output = command
        .args([
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "f32le",
            "-",
        ])
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let (chunks, _) = output.stdout.as_chunks::<4>();
    Ok(chunks
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect())
}

fn free_license(license: &str) -> bool {
    let upper = license.to_ascii_uppercase();
    (upper.starts_with("CC0") || upper.starts_with("CC-PDM") || upper.starts_with("CC-BY"))
        && !upper.contains("NC")
        && !upper.contains("ND")
}

fn write_wav(path: &str, samples: &[f32]) -> Result<String, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        writer.write_sample(value).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(hex(&Sha256::digest(bytes)))
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn git_head() -> Option<String> {
    let output = Command::new("git")
        .args(["-C", env!("CARGO_MANIFEST_DIR"), "rev-parse", "HEAD"])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn audio_analysis_rev() -> Option<&'static str> {
    let manifest = include_str!("../Cargo.toml");
    let line = manifest
        .lines()
        .find(|line| line.contains("audio-analysis.git"))?;
    line.split("rev = \"").nth(1)?.split('"').next()
}
