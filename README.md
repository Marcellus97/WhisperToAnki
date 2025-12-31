# WhisperToAnki

Minimal Node.js pipeline to turn a single-speaker Italian audio file into a timestamped, phrase-clipped Anki deck using whisper.cpp and ffmpeg.

## Example usage video

<video src="whisperankiexample.mov" autoplay muted loop playsinline controls></video>

## Quick start

1) Install system dependencies:

```bash
brew install cmake ffmpeg
```

2) Clone/build whisper.cpp and download a model (default: base):

```bash
./setup-whisper.sh
```

3) Install the Node dependency:

```bash
npm install
```

4) Run the full pipeline with a single audio file:

```bash
node pipeline.js full-default episode.mp3
```

Or run the steps manually:

```bash
node pipeline.js preprocess episode.mp3 out/episode.wav
node pipeline.js transcribe out/episode.wav out/transcript.words.json --model whisper.cpp/models/ggml-base.bin --language it
node pipeline.js segment out/transcript.words.json out/segments.json
node pipeline.js clip episode.mp3 out/segments.json out/clips --reencode
node pipeline.js anki out/segments.json out/clips out/deck.apkg --deck-name "Italian Podcast" --episode "Episode 01"
```

## pipeline.js commands

### full-default

```bash
node pipeline.js full-default <input_audio> [--out-dir <path>] [--deck-name "Name"] [--episode "Episode"]
```

- Runs preprocess → transcribe → segment → clip → anki with sane defaults.
- Creates `out/<input_basename>/` by default.
- Downloads `ggml-base.bin` if missing.

### preprocess

```bash
node pipeline.js preprocess <input_media> <output_wav>
```

- Uses ffmpeg to convert to mono 16 kHz WAV.

### transcribe

```bash
node pipeline.js transcribe <input_wav> <output_words_json> --model <path> [--whisper-bin <path>] [--language it] [--extra "..."] [--no-defaults]
```

- Runs whisper.cpp and normalizes the output into a word-level `transcript.words.json`.
- Default whisper.cpp binary is `whisper.cpp/bin/whisper-cli` if present, otherwise `whisper.cpp/build/bin/whisper-cli`.
- Default whisper flags: `-t 4 -p 1 -bs 5 -bo 5 -dtw <preset>` plus JSON full output, where the preset is derived from the model filename (e.g. `ggml-base.bin` -> `base`).
- Use `--extra` to add flags, `--no-defaults` to disable defaults.

### segment

```bash
node pipeline.js segment <input_words_json> <output_segments_json> [--max-gap 0.8] [--max-words 20] [--max-duration 6.0] [--min-words 2]
```

- Groups words into phrase segments without altering timestamps.
- Filler words are removed from display text only.

### clip

```bash
node pipeline.js clip <input_media> <segments_json> <clips_dir> [--reencode]
```

- Cuts audio clips for each segment and writes a matching `.txt` file.
- `--reencode` uses WAV decoding for more precise boundaries.

### anki

```bash
node pipeline.js anki <segments_json> <clips_dir> <output_apkg> --deck-name "Name" [--episode "Episode"]
```

- Builds an Anki deck using the system `sqlite3` and `zip` tools (no in-memory SQL.js).

### download-model

```bash
node pipeline.js download-model <model> [models_dir] [--whisper-dir <path>]
```

- Wraps `whisper.cpp/models/download-ggml-model.sh`.

## setup-whisper.sh

```bash
./setup-whisper.sh [model]
```

- Clones whisper.cpp into `./whisper.cpp` if missing.
- Builds whisper.cpp with `make -j`.
- Downloads the requested model to `whisper.cpp/models` (default: `base`).
- Lists valid model names when an invalid model is given.

## Requirements

- `ffmpeg` (install with `brew install ffmpeg`)
- `cmake` (install with `brew install cmake`)
- `sqlite3` and `zip` (preinstalled on macOS)
- Node.js 18+ recommended
