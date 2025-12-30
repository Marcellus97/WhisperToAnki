#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const crypto = require("crypto");

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

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function buildAnkiTemplateSql(deckName, deckId, modelId) {
  const conf = {
    nextPos: 1,
    estTimes: true,
    activeDecks: [deckId],
    sortType: "noteFld",
    timeLim: 0,
    sortBackwards: false,
    addToCur: true,
    curDeck: deckId,
    newBury: true,
    newSpread: 0,
    dueCounts: true,
    curModel: String(modelId),
    collapseTime: 1200,
  };

  const models = {
    [modelId]: {
      veArs: [],
      name: deckName,
      tags: ["Tag"],
      did: deckId,
      usn: -1,
      req: [[0, "all", [0]]],
      flds: [
        {
          name: "Front",
          media: [],
          sticky: false,
          rtl: false,
          ord: 0,
          font: "Arial",
          size: 20,
        },
        {
          name: "Back",
          media: [],
          sticky: false,
          rtl: false,
          ord: 1,
          font: "Arial",
          size: 20,
        },
      ],
      sortf: 0,
      latexPre:
        "\\\\documentclass[12pt]{article}\\n\\\\special{papersize=3in,5in}\\n\\\\usepackage[utf8]{inputenc}\\n\\\\usepackage{amssymb,amsmath}\\n\\\\pagestyle{empty}\\n\\\\setlength{\\\\parindent}{0in}\\n\\\\begin{document}\\n",
      tmpls: [
        {
          name: "Card 1",
          qfmt: "{{Front}}",
          did: null,
          bafmt: "",
          afmt: "{{FrontSide}}\\n\\n<hr id=\\\"answer\\\">\\n\\n{{Back}}",
          ord: 0,
          bqfmt: "",
        },
      ],
      latexPost: "\\\\end{document}",
      type: 0,
      id: modelId,
      css:
        ".card {\\n font-family: arial;\\n font-size: 20px;\\n text-align: center;\\n color: black;\\nbackground-color: white;\\n}\\n",
      mod: Math.floor(Date.now() / 1000),
    },
  };

  const decks = {
    [deckId]: {
      desc: "",
      name: deckName,
      extendRev: 50,
      usn: 0,
      collapsed: false,
      newToday: [0, 0],
      timeToday: [0, 0],
      dyn: 0,
      extendNew: 10,
      conf: 1,
      revToday: [0, 0],
      lrnToday: [0, 0],
      id: deckId,
      mod: Math.floor(Date.now() / 1000),
    },
  };

  const dconf = {
    1: {
      name: "Default",
      replayq: true,
      lapse: {
        leechFails: 8,
        minInt: 1,
        delays: [10],
        leechAction: 0,
        mult: 0,
      },
      rev: {
        perDay: 100,
        fuzz: 0.05,
        ivlFct: 1,
        maxIvl: 36500,
        ease4: 1.3,
        bury: true,
        minSpace: 1,
      },
      timer: 0,
      maxTaken: 60,
      usn: 0,
      new: {
        perDay: 20,
        delays: [1, 10],
        separate: true,
        ints: [1, 4, 7],
        initialFactor: 2500,
        bury: true,
        order: 1,
      },
      mod: 0,
      id: 1,
      autoplay: true,
    },
  };

  const confJson = escapeSql(JSON.stringify(conf));
  const modelsJson = escapeSql(JSON.stringify(models));
  const decksJson = escapeSql(JSON.stringify(decks));
  const dconfJson = escapeSql(JSON.stringify(dconf));

  return `
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE col (
    id              integer primary key,
    crt             integer not null,
    mod             integer not null,
    scm             integer not null,
    ver             integer not null,
    dty             integer not null,
    usn             integer not null,
    ls              integer not null,
    conf            text not null,
    models          text not null,
    decks           text not null,
    dconf           text not null,
    tags            text not null
);
INSERT INTO "col" VALUES(
  1,
  1388548800,
  1435645724219,
  1435645724215,
  11,
  0,
  0,
  0,
  '${confJson}',
  '${modelsJson}',
  '${decksJson}',
  '${dconfJson}',
  '{}'
);
CREATE TABLE notes (
    id              integer primary key,
    guid            text not null,
    mid             integer not null,
    mod             integer not null,
    usn             integer not null,
    tags            text not null,
    flds            text not null,
    sfld            integer not null,
    csum            integer not null,
    flags           integer not null,
    data            text not null
);
CREATE TABLE cards (
    id              integer primary key,
    nid             integer not null,
    did             integer not null,
    ord             integer not null,
    mod             integer not null,
    usn             integer not null,
    type            integer not null,
    queue           integer not null,
    due             integer not null,
    ivl             integer not null,
    factor          integer not null,
    reps            integer not null,
    lapses          integer not null,
    left            integer not null,
    odue            integer not null,
    odid            integer not null,
    flags           integer not null,
    data            text not null
);
CREATE TABLE revlog (
    id              integer primary key,
    cid             integer not null,
    usn             integer not null,
    ease            integer not null,
    ivl             integer not null,
    lastIvl         integer not null,
    factor          integer not null,
    time            integer not null,
    type            integer not null
);
CREATE TABLE graves (
    usn             integer not null,
    oid             integer not null,
    type            integer not null
);
ANALYZE sqlite_master;
INSERT INTO "sqlite_stat1" VALUES('col',NULL,'1');
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
COMMIT;
`;
}

function checksumSha1(str) {
  const hash = crypto.createHash("sha1").update(str).digest("hex");
  return parseInt(hash.slice(0, 8), 16);
}

function buildDeckDb(segments, clipsDir, dbPath, deckName, episode) {
  const tempDir = path.dirname(dbPath);
  const sqlPath = path.join(tempDir, "deck.sql");
  const deckId = Date.now();
  const modelId = deckId + 1;
  const separator = String.fromCharCode(31);
  const nowSec = Math.floor(Date.now() / 1000);

  let sql = buildAnkiTemplateSql(deckName, deckId, modelId);
  sql += "\nBEGIN TRANSACTION;\n";

  let noteId = Date.now();
  let cardId = noteId + 1;
  let due = 1;

  for (const seg of segments) {
    const audioFile = `${seg.id}.mp3`;
    const audioPath = path.join(clipsDir, audioFile);
    if (!fs.existsSync(audioPath)) continue;

    const front = `${seg.text}<br>[sound:${audioFile}]`;
    const meta = [episode, `${seg.start.toFixed(2)}-${seg.end.toFixed(2)}`]
      .filter(Boolean)
      .join(" | ");
    const back = `${seg.raw_text}<br>${meta}`;

    const flds = `${front}${separator}${back}`;
    const guid = crypto.createHash("sha1").update(`${deckId}${front}${back}`).digest("hex");
    const csum = checksumSha1(flds);

    sql +=
      "INSERT INTO notes VALUES(" +
      `${noteId},` +
      `'${escapeSql(guid)}',` +
      `${modelId},` +
      `${nowSec},` +
      "-1," +
      "''" +
      ",'" +
      escapeSql(flds) +
      "'," +
      `'${escapeSql(front)}',` +
      `${csum},` +
      "0," +
      "''" +
      ");\n";

    sql +=
      "INSERT INTO cards VALUES(" +
      `${cardId},` +
      `${noteId},` +
      `${deckId},` +
      "0," +
      `${nowSec},` +
      "-1," +
      "0,0," +
      `${due},` +
      "0,0,0,0,0,0,0,0," +
      "''" +
      ");\n";

    noteId += 2;
    cardId += 2;
    due += 1;
  }

  sql += "COMMIT;\n";
  fs.writeFileSync(sqlPath, sql, "utf8");
  run("sqlite3", [dbPath, `.read ${sqlPath}`]);
  fs.rmSync(sqlPath, { force: true });

  return { deckId, modelId };
}

function buildApkg(segments, clipsDir, outputApkg, deckName, episode) {
  const tempDir = `${outputApkg}.tmp`;
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  ensureDir(tempDir);

  const dbPath = path.join(tempDir, "collection.anki2");
  buildDeckDb(segments, clipsDir, dbPath, deckName, episode);

  const mediaMap = {};
  let index = 0;
  for (const seg of segments) {
    const audioFile = `${seg.id}.mp3`;
    const audioPath = path.join(clipsDir, audioFile);
    if (!fs.existsSync(audioPath)) continue;
    const targetName = String(index);
    fs.copyFileSync(audioPath, path.join(tempDir, targetName));
    mediaMap[targetName] = audioFile;
    index += 1;
  }

  fs.writeFileSync(path.join(tempDir, "media"), JSON.stringify(mediaMap), "utf8");

  const files = ["collection.anki2", "media"];
  for (let i = 0; i < index; i++) files.push(String(i));

  if (fs.existsSync(outputApkg)) {
    fs.rmSync(outputApkg, { force: true });
  }

  run("zip", ["-q", "-X", outputApkg].concat(files), { cwd: tempDir });
  fs.rmSync(tempDir, { recursive: true, force: true });
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

function getOffsetSeconds(obj) {
  if (!obj || !obj.offsets) return null;
  const from = Number(obj.offsets.from);
  const to = Number(obj.offsets.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { start: from / 1000, end: to / 1000 };
}

function tokensToWords(tokens) {
  const words = [];
  let current = null;

  for (const token of tokens) {
    const tokenText = token.text || "";
    const trimmed = tokenText.replace(/^\s+/, "");
    if (!trimmed) {
      continue;
    }

    const time = getOffsetSeconds(token);
    const startsNew = /^\s/.test(tokenText) || !current;

    if (startsNew) {
      if (current) words.push(current);
      current = { w: trimmed, start: time ? time.start : null, end: time ? time.end : null };
      continue;
    }

    current.w += trimmed;
    if (time) {
      if (current.start == null) current.start = time.start;
      current.end = time.end;
    }
  }

  if (current) words.push(current);

  return words.filter((w) => w.w && w.start != null && w.end != null);
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
  if (Array.isArray(raw.transcription)) {
    const out = [];
    for (const seg of raw.transcription) {
      if (!Array.isArray(seg.tokens)) continue;
      const words = tokensToWords(seg.tokens);
      for (const w of words) {
        out.push(w);
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
      "No word timestamps found. Run whisper.cpp with --output-json-full and --dtw <model>."
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
  run("ffmpeg", ["-y", "-i", input, "-ac", "1", "-ar", "16000", "-vn", output]);
}

function resolveWhisperBin(explicitPath) {
  if (explicitPath) return explicitPath;
  const primary = path.join(process.cwd(), "whisper.cpp", "bin", "whisper-cli");
  if (fs.existsSync(primary)) return primary;
  const fallback = path.join(process.cwd(), "whisper.cpp", "build", "bin", "whisper-cli");
  return fallback;
}

function commandTranscribe(args, flags) {
  if (args.length < 2) usage(), process.exit(1);
  const [inputWav, outputWordsJson] = args;
  const whisperBin = resolveWhisperBin(flags["whisper-bin"]);
  const model = flags.model;
  const language = flags.language || "it";
  const defaultFlags = ["-t", "4", "-p", "1", "-bs", "5", "-bo", "5"];
  const extra = flags.extra ? flags.extra.split(" ") : [];
  const hasDtw = extra.includes("-dtw") || extra.includes("--dtw");
  const dtwPresetMatch = model ? path.basename(model).match(/^ggml-(.+)\.bin$/) : null;
  const dtwPreset = dtwPresetMatch ? dtwPresetMatch[1] : null;
  const dtwFlags = hasDtw || !dtwPreset ? [] : ["-dtw", dtwPreset];
  const whisperExtra = flags["no-defaults"]
    ? extra
    : defaultFlags.concat(dtwFlags, extra);

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
    "-ojf",
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
  const whisperBin = resolveWhisperBin();
  const modelPath = path.join(whisperDir, "models", "ggml-base.bin");

  ensureDir(outDir);
  const wavPath = path.join(outDir, `${baseName}.wav`);
  const wordsJsonPath = path.join(outDir, "transcript.words.json");
  const segmentsJsonPath = path.join(outDir, "segments.json");
  const clipsDir = path.join(outDir, "clips");
  const deckPath = path.join(outDir, "deck.apkg");
  const outputPaths = [wavPath, wordsJsonPath, segmentsJsonPath, deckPath];

  if (!fs.existsSync(whisperBin)) {
    throw new Error(
      `whisper.cpp binary not found at ${whisperBin}. Run ./setup-whisper.sh first.`
    );
  }

  if (!fs.existsSync(modelPath)) {
    log("Model not found, downloading ggml-base...");
    commandDownloadModel(["base", path.join(whisperDir, "models")], { "whisper-dir": whisperDir });
  }

  for (const outPath of outputPaths) {
    if (fs.existsSync(outPath)) {
      fs.rmSync(outPath, { force: true });
    }
  }
  if (fs.existsSync(clipsDir)) {
    fs.rmSync(clipsDir, { recursive: true, force: true });
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
    const overwrite = ["-y"];
    const argsList = flags.reencode
      ? baseArgs
          .concat(overwrite)
          .concat(["-ar", "44100", "-ac", "2", "-codec:a", "libmp3lame", "-q:a", "4", outFile])
      : baseArgs.concat(overwrite).concat(["-c", "copy", outFile]);

    run("ffmpeg", argsList);
  }
}

async function commandAnki(args, flags) {
  if (args.length < 3) usage(), process.exit(1);
  const [segmentsJson, clipsDir, outputApkg] = args;
  const deckName = flags["deck-name"] || "Italian Podcast";
  const episode = flags.episode || "";
  const segments = readJson(segmentsJson);
  ensureDir(path.dirname(outputApkg));
  buildApkg(segments, clipsDir, outputApkg, deckName, episode);
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
