#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function usage() {
  const text = `
Usage:
  node pipeline.js full-default <input_audio> [--out-dir <path>] [--deck-name "Name"] [--episode "Episode"]
  node pipeline.js preprocess <input_media> <output_wav>
  node pipeline.js download-model <model> [models_dir] [--whisper-dir <path>]
  node pipeline.js transcribe <input_wav> <output_words_json> --whisper-bin <path> --model <path> [--language it] [--extra "..."] [--no-defaults]
  node pipeline.js segment <input_words_json> <output_segments_json> [--max-gap 0.45] [--max-words 12] [--max-duration 3.5]
  node pipeline.js clip <input_media> <segments_json> <clips_dir> [--reencode]
  node pipeline.js anki <segments_json> <clips_dir> <output_apkg> --deck-name "Name" [--episode "Episode"]

Notes:
  - whisper.cpp must output JSON with per-word timestamps. Use the flags your build supports to enable word timestamps.
  - ffmpeg is required for preprocess and clip.
  - anki-apkg-export is required for anki.
`;
  console.log(text.trim());
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith("--")) {
      const key = v.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      args.push(v);
    }
  }
  return { args, flags };
}

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${cmdArgs.join(" ")}`);
  }
}

function log(message) {
  console.log(`[pipeline] ${message}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function normalizeToken(token) {
  return token
    .toLowerCase()
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "");
}

function joinWords(words) {
  const text = words.join(" ");
  return text.replace(/\s+([.,!?;:])/g, "$1");
}

function flattenWhisperWords(raw) {
  if (Array.isArray(raw.words)) {
    return raw.words.map((w) => ({
      w: w.w || w.word || w.text || "",
      start: Number(w.start),
      end: Number(w.end),
    }));
  }
  if (Array.isArray(raw.segments)) {
    const out = [];
    for (const seg of raw.segments) {
      if (!Array.isArray(seg.words)) continue;
      for (const w of seg.words) {
        out.push({
          w: w.w || w.word || w.text || "",
          start: Number(w.start),
          end: Number(w.end),
        });
      }
    }
    return out;
  }
  return [];
}

function buildWordsJson(rawWhisperJsonPath, outputWordsJsonPath, language) {
  const raw = readJson(rawWhisperJsonPath);
  const words = flattenWhisperWords(raw).filter((w) => w.w);
  if (words.length === 0) {
    throw new Error(
      "No word timestamps found. Ensure whisper.cpp JSON includes per-word timestamps."
    );
  }
  const durationSec = words.reduce((max, w) => (w.end > max ? w.end : max), 0);
  const out = {
    language: language || "it",
    duration_sec: durationSec,
    words,
  };
  writeJson(outputWordsJsonPath, out);
}

function segmentWords(wordsJson, options) {
  const words = wordsJson.words || [];
  const maxGap = Number(options.maxGap ?? 0.45);
  const maxWords = Number(options.maxWords ?? 12);
  const maxDuration = Number(options.maxDuration ?? 3.5);

  const fillers = new Set([
    "eh",
    "ehm",
    "allora",
    "cioe",
    "diciamo",
    "praticamente",
    "tipo",
    "insomma",
    "boh",
    "capito",
    "ok",
  ]);

  const segments = [];
  let current = [];
  let currentIndices = [];

  function flush() {
    if (current.length === 0) return;
    const start = current[0].start;
    const end = current[current.length - 1].end;
    const rawWords = current.map((w) => w.w);
    const displayWords = [];
    for (const w of rawWords) {
      const norm = normalizeToken(w);
      if (fillers.has(norm)) continue;
      displayWords.push(w);
    }
    const rawText = joinWords(rawWords);
    const displayText = displayWords.length > 0 ? joinWords(displayWords) : rawText;
    const id = `seg_${String(segments.length + 1).padStart(5, "0")}`;
    segments.push({
      id,
      start,
      end,
      text: displayText,
      raw_text: rawText,
      word_indices: currentIndices.slice(),
    });
    current = [];
    currentIndices = [];
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (current.length === 0) {
      current.push(w);
      currentIndices.push(i);
      continue;
    }
    const prev = current[current.length - 1];
    const gap = w.start - prev.end;
    const duration = w.end - current[0].start;
    if (gap >= maxGap || current.length >= maxWords || duration >= maxDuration) {
      flush();
    }
    current.push(w);
    currentIndices.push(i);
  }
  flush();

  return segments;
}

function commandPreprocess(args) {
  if (args.length < 2) usage(), process.exit(1);
  const [input, output] = args;
  ensureDir(path.dirname(output));
  run("ffmpeg", ["-i", input, "-ac", "1", "-ar", "16000", "-vn", output]);
}

function commandTranscribe(args, flags) {
  if (args.length < 2) usage(), process.exit(1);
  const [inputWav, outputWordsJson] = args;
  const defaultWhisperBin = path.join(process.cwd(), "whisper.cpp", "bin", "whisper-cli");
  const whisperBin = flags["whisper-bin"] || defaultWhisperBin;
  const model = flags.model;
  const language = flags.language || "it";
  const defaultFlags = ["-t", "4", "-p", "1", "-bs", "5", "-bo", "5"];
  const extra = flags.extra ? flags.extra.split(" ") : [];
  const whisperExtra = flags["no-defaults"] ? extra : defaultFlags.concat(extra);

  if (!model) {
    throw new Error("--model is required for whisper.cpp");
  }

  const outBase = outputWordsJson.replace(/\.json$/i, "");
  ensureDir(path.dirname(outputWordsJson));

  const whisperArgs = [
    "-m",
    model,
    "-f",
    inputWav,
    "-l",
    language,
    "-oj",
    "-of",
    outBase,
    ...whisperExtra,
  ];

  run(whisperBin, whisperArgs);

  const rawJsonPath = outBase + ".json";
  if (!fs.existsSync(rawJsonPath)) {
    throw new Error(`Expected whisper.cpp output at ${rawJsonPath}`);
  }
  buildWordsJson(rawJsonPath, outputWordsJson, language);
}

function commandDownloadModel(args, flags) {
  if (args.length < 1) usage(), process.exit(1);
  const [model, modelsDirArg] = args;
  const whisperDir = flags["whisper-dir"] || path.join(process.cwd(), "whisper.cpp");
  const scriptPath = path.join(whisperDir, "models", "download-ggml-model.sh");
  const modelsDir = modelsDirArg || path.join(whisperDir, "models");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Missing download script: ${scriptPath}`);
  }
  ensureDir(modelsDir);
  run("sh", [scriptPath, model, modelsDir]);
}

function commandFullDefault(args, flags) {
  if (args.length < 1) usage(), process.exit(1);
  const [inputMp3] = args;
  const baseName = path.basename(inputMp3).replace(path.extname(inputMp3), "");
  const outDir = flags["out-dir"] || path.join(process.cwd(), "out", baseName);
  const deckName = flags["deck-name"] || "Italian Podcast";
  const episode = flags.episode || baseName;

  const whisperDir = path.join(process.cwd(), "whisper.cpp");
  const whisperBin = path.join(whisperDir, "bin", "whisper-cli");
  const modelPath = path.join(whisperDir, "models", "ggml-base.bin");

  ensureDir(outDir);
  const wavPath = path.join(outDir, `${baseName}.wav`);
  const wordsJsonPath = path.join(outDir, "transcript.words.json");
  const segmentsJsonPath = path.join(outDir, "segments.json");
  const clipsDir = path.join(outDir, "clips");
  const deckPath = path.join(outDir, "deck.apkg");

  if (!fs.existsSync(whisperBin)) {
    throw new Error(`whisper.cpp binary not found at ${whisperBin}. Run ./setup-whisper.sh first.`);
  }

  if (!fs.existsSync(modelPath)) {
    log("Model not found, downloading ggml-base...");
    commandDownloadModel(["base", path.join(whisperDir, "models")], { "whisper-dir": whisperDir });
  }

  log("Preprocessing audio...");
  commandPreprocess([inputMp3, wavPath], {});

  log("Transcribing with whisper.cpp...");
  commandTranscribe([wavPath, wordsJsonPath], {
    "whisper-bin": whisperBin,
    model: modelPath,
    language: "it",
  });

  log("Segmenting transcript...");
  commandSegment([wordsJsonPath, segmentsJsonPath], {});

  log("Clipping audio segments...");
  commandClip([inputMp3, segmentsJsonPath, clipsDir], { reencode: true });

  log("Building Anki deck...");
  return commandAnki([segmentsJsonPath, clipsDir, deckPath], {
    "deck-name": deckName,
    episode,
  });
}

function commandSegment(args, flags) {
  if (args.length < 2) usage(), process.exit(1);
  const [inputWordsJson, outputSegmentsJson] = args;
  const wordsJson = readJson(inputWordsJson);
  const segments = segmentWords(wordsJson, {
    maxGap: flags["max-gap"],
    maxWords: flags["max-words"],
    maxDuration: flags["max-duration"],
  });
  ensureDir(path.dirname(outputSegmentsJson));
  writeJson(outputSegmentsJson, segments);
}

function commandClip(args, flags) {
  if (args.length < 3) usage(), process.exit(1);
  const [inputMedia, segmentsJson, clipsDir] = args;
  const segments = readJson(segmentsJson);
  ensureDir(clipsDir);

  for (const seg of segments) {
    const outFile = path.join(clipsDir, `${seg.id}.mp3`);
    const txtFile = path.join(clipsDir, `${seg.id}.txt`);
    fs.writeFileSync(txtFile, seg.text + "\n", "utf8");

    const baseArgs = ["-ss", String(seg.start), "-to", String(seg.end), "-i", inputMedia];
    const argsList = flags.reencode
      ? baseArgs.concat(["-ar", "44100", "-ac", "2", "-codec:a", "libmp3lame", "-q:a", "4", outFile])
      : baseArgs.concat(["-c", "copy", outFile]);

    run("ffmpeg", argsList);
  }
}

async function commandAnki(args, flags) {
  if (args.length < 3) usage(), process.exit(1);
  const [segmentsJson, clipsDir, outputApkg] = args;
  const deckName = flags["deck-name"] || "Italian Podcast";
  const episode = flags.episode || "";

  let AnkiExport = require("anki-apkg-export");
  AnkiExport = AnkiExport.default || AnkiExport;

  const segments = readJson(segmentsJson);
  const deck = new AnkiExport(deckName);

  for (const seg of segments) {
    const audioFile = `${seg.id}.mp3`;
    const audioPath = path.join(clipsDir, audioFile);
    if (!fs.existsSync(audioPath)) continue;

    const front = `${seg.text}<br>[sound:${audioFile}]`;
    const meta = [episode, `${seg.start.toFixed(2)}-${seg.end.toFixed(2)}`]
      .filter(Boolean)
      .join(" | ");
    const back = `${seg.raw_text}<br>${meta}`;

    deck.addCard(front, back);
    deck.addMedia(audioFile, fs.readFileSync(audioPath));
  }

  const zip = await deck.save();
  ensureDir(path.dirname(outputApkg));
  fs.writeFileSync(outputApkg, zip, "binary");
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { args, flags } = parseArgs(rest);

  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }

  try {
    if (cmd === "full-default") return commandFullDefault(args, flags);
    if (cmd === "download-model") return commandDownloadModel(args, flags);
    if (cmd === "preprocess") return commandPreprocess(args, flags);
    if (cmd === "transcribe") return commandTranscribe(args, flags);
    if (cmd === "segment") return commandSegment(args, flags);
    if (cmd === "clip") return commandClip(args, flags);
    if (cmd === "anki") return commandAnki(args, flags);
    usage();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
