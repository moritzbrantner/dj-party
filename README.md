# DJ Party

DJ Party is a browser-first DJ mixing experiment with a Rust core. The long-term goal is collaborative mixing, while the current milestone remains deliberately small enough to run entirely on GitHub Pages.

## Browser MVP

The app can:

- import many local audio files at once, including folder selection where the browser exposes it;
- import bounded local ZIP archives containing audio and M3U/M3U8 playlists, with checksum verification and no upload/server dependency;
- import standalone M3U/M3U8 playlists and match their local entries to tracks already stored in the browser;
- keep an idempotent browser-local music collection in IndexedDB so previously imported tracks can be picked again on later visits;
- keep imported playlist ordering browser-local and load playlist tracks through the same existing deck-loading path;
- reuse versioned, content-addressed waveform/BPM/beat/downbeat analysis from a bounded browser-local cache when decoded PCM and sample rate match;
- search the collection and load any saved track into Deck A or Deck B without re-selecting the original file;
- load local audio files directly into two independent decks;
- drag and drop MP3 and other browser-supported audio files;
- play, pause, restart, seek, and control deck level;
- mix decks with a Rust-owned equal-power crossfader;
- shape each deck with Rust-owned Low/Mid/High ±12 dB product semantics and a bipolar low-pass ↔ bypass ↔ high-pass sweep;
- render full-track waveforms with Rust-owned extrema;
- analyze BPM, beats, downbeats, and rhythm confidence through the pinned `audio-analysis` Rust engine;
- set an exact cue plus four beat-quantized hot cues per deck;
- adjust tempo by ±16% with optional browser key lock;
- BPM-sync one deck to the other within the supported playback-rate range;
- phase-sync one deck to the other using fractional beat phase and, when verified downbeats are present, the same beat within the 4/4 bar;
- create quantized 1/2/4/8-beat loops;
- jump ±4 or ±8 beats while preserving fractional beat phase;
- show the current analyzed bar, beat, and beat phase;
- route either deck pre-fader to a separate headphone output when the browser exposes secure audio-output selection;
- blend the cued decks with the post-fader master in the headphone monitor using a Rust-owned equal-power Cue ↔ Master control.

Imported library blobs, playlists, cached analysis metadata, selected tracks, decoded PCM, timing state, cue points, loops, tone state, and monitor state stay on the device. Nothing is uploaded by the current app. Browser-local data is subject to the browser's site-storage quota and can disappear if site data is cleared.

## Architecture

DJ Party's Rust/WASM layer is authoritative for deterministic mixer state and product policy: tempo range, effective-BPM/BPM-sync surface, beat/bar and phase-sync behavior, hot-cue and beat-jump semantics, beat-loop policy, per-deck EQ/filter parameter semantics, and headphone-monitor semantics. Reusable policy-neutral audio/DJ calculations such as equal-power crossfade gains, tempo/rate conversion, tempo-only BPM-sync math, generic beat-loop selection, waveform extrema, and generic filter/DSP primitives remain outside DJ Party and are consumed rather than reimplemented here.

The browser layer owns browser-only capabilities: local file/folder/ZIP/M3U selection, browser-local IndexedDB track/playlist/cache storage, object URLs, bounded ZIP extraction, audio decoding, `AudioContext`, media-element playback, Web Audio EQ/filter nodes, pitch-preservation/key-lock behavior, DOM rendering, workers, physical audio-output selection, and applying the transport/gain/tone plans returned by Rust. DJ Party does not implement biquad coefficient design in the browser adapter.

The local library deliberately reuses the existing deck file-input path when a saved or playlist track is loaded. ZIP audio is handed to the same idempotent track importer rather than creating an archive-specific track store. M3U/M3U8 files contain references only: remote URLs are ignored, and unmatched local entries remain visibly unavailable instead of being fetched or guessed.

ZIP extraction is deliberately fail-closed: multi-disk/ZIP64/encrypted entries and unsupported compression methods are rejected, extracted audio/playlist bytes are bounded, and each materialized entry is checked against its ZIP CRC. Deflated entries require browser `DecompressionStream("deflate-raw")` support.

Track-analysis cache entries are keyed by a SHA-256 fingerprint of decoded mono PCM plus sample rate and an explicit analysis namespace. A stale namespace or malformed cached record is ignored. The cache is an optimization only: cache failures never replace or weaken the normal Rust-backed waveform/rhythm analysis path.

Headphone cueing is deliberately pre-fader: each deck's tone chain is applied before the signal splits into the post-fader master branch and pre-fader cue branch. The selected cue therefore hears the same EQ/filter state as the deck while still bypassing deck level and crossfader. The optional Master contribution follows the same Rust-owned post-fader deck gains heard on the main output. If the browser cannot select a separate audio output, the headphone controls stay disabled and the existing master playback route is unchanged.

Reusable ownership remains explicit:

- BPM, beat-grid, downbeat, related rhythm analysis, reusable policy-neutral playback/DJ calculations, and generic DSP/filter math come from shared audio/math layers rather than being reimplemented here;
- collaborative lobby/signaling should integrate through `multiplayer-setup-service` rather than becoming part of the mixer core.

## Build and validate

Requirements: Rust 1.95.0, the `wasm32-unknown-unknown` target, and `wasm-pack` 0.13.1.

```sh
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
node --test web/library.test.mjs web/archive-import.test.mjs web/analysis-cache.test.mjs
cargo install wasm-pack --version 0.13.1 --locked
bash scripts/build-pages.sh
```

The generated static site is written to `_site/` and can be served by any local static HTTP server.

## Roadmap

1. Browser MVP on GitHub Pages — done
2. Waveform display and cue point — done
3. Reusable BPM/beat-grid analysis — done
4. Tempo, beat loops, and BPM sync — done
5. Phase sync, quantized hot cues, and beat-jump transport — done
6. Headphone cue/master routing where browser APIs allow it — done
7. Browser-local multi-file/folder music collection — done
8. Mixer EQ/filter controls with deterministic parameter semantics — done
9. ZIP/playlist library import plus reusable cached track-analysis metadata — done
10. Multiplayer sessions through `multiplayer-setup-service` — current slice
11. Shared-session authority, synchronization, optional asset transfer, and collaborative mixing
