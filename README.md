# DJ Party

A browser-first DJ mixing experiment with a Rust core.

The first milestone is deliberately small: load local audio into two decks, play/pause each deck, and mix them with an equal-power crossfader. Rust/WASM owns deterministic mixer state and gain calculations; the browser owns file selection and Web Audio playback.

## Roadmap

1. Browser MVP on GitHub Pages
2. Waveform, cueing, tempo and beat analysis
3. Reusable audio-analysis integration where it adds value
4. Multiplayer sessions through `multiplayer-setup-service`
5. Shared-session authority, synchronization and collaborative mixing

No audio files are uploaded by the MVP; selected tracks stay in the browser.