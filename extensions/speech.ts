/**
 * Speech synthesis via macOS `say`, plus WAV stitching and a serial
 * playback queue.
 *
 * Why WAV stitching: `say` renders one voice per invocation. A mixed
 * Chinese/English sentence therefore needs N invocations, and playing N
 * files back-to-back leaves audible gaps and races the queue. Instead we
 * render each run to a temp WAV, concatenate the raw PCM, and hand back a
 * single buffer.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Run, splitByScript } from "./text.ts";

const execFileP = promisify(execFile);

/** All runs are forced to one PCM format so concatenation stays valid. */
const DATA_FORMAT = "LEI16@22050";

/** Long messages can exceed a minute of audio. */
const PLAYBACK_TIMEOUT_MS = 5 * 60 * 1000;
const SYNTH_TIMEOUT_MS = 60 * 1000;

/** `say -r` is words per minute; macOS defaults to ~175. */
export const BASE_WPM = 190;

// ── Voice discovery ────────────────────────────────────────────────

export interface MacVoice {
  name: string;
  locale: string;
}

let voiceCache: MacVoice[] | null = null;

export async function listVoices(): Promise<MacVoice[]> {
  if (voiceCache) return voiceCache;
  const { stdout } = await execFileP("say", ["-v", "?"]);
  voiceCache = stdout
    .split("\n")
    .map((line) => line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ name: m[1].trim(), locale: m[2] }));
  return voiceCache;
}

export async function voicesForLocale(prefix: string): Promise<string[]> {
  const all = await listVoices();
  return all.filter((v) => v.locale.startsWith(prefix)).map((v) => v.name);
}

/**
 * Check a configured voice actually exists, so a typo surfaces as a clear
 * message instead of a cryptic `say` exit code.
 */
export async function voiceExists(name: string): Promise<boolean> {
  const all = await listVoices();
  return all.some((v) => v.name === name);
}

// ── WAV plumbing ───────────────────────────────────────────────────

interface Wav {
  fmt: Buffer;
  data: Buffer;
}

/**
 * Walk RIFF chunks to find fmt/data. Necessary because `say` emits a JUNK
 * chunk first, so the naive "fmt starts at byte 12" assumption is wrong.
 */
function parseWav(buf: Buffer): Wav {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("say produced something that is not a RIFF/WAVE file");
  }
  let off = 12;
  let fmt: Buffer | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === "fmt ") fmt = body;
    else if (id === "data") data = body;
    off += 8 + size + (size % 2); // RIFF chunks are word-aligned
  }
  if (!fmt || !data) throw new Error("WAV is missing a fmt or data chunk");
  return { fmt, data };
}

export function buildWav(fmt: Buffer, dataChunks: Buffer[]): Buffer {
  const data = Buffer.concat(dataChunks);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + (8 + fmt.length) + (8 + data.length), 4);
  riff.write("WAVE", 8, "ascii");

  const fmtHdr = Buffer.alloc(8);
  fmtHdr.write("fmt ", 0, "ascii");
  fmtHdr.writeUInt32LE(fmt.length, 4);

  const dataHdr = Buffer.alloc(8);
  dataHdr.write("data", 0, "ascii");
  dataHdr.writeUInt32LE(data.length, 4);

  return Buffer.concat([riff, fmtHdr, fmt, dataHdr, data]);
}

/** Digital silence matching a fmt chunk, used as a gap between voices. */
export function silence(fmt: Buffer, seconds: number): Buffer {
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bytesPerSample = fmt.readUInt16LE(14) / 8;
  const frame = channels * bytesPerSample;
  return Buffer.alloc(Math.round(sampleRate * seconds) * frame);
}

// ── Synthesis ──────────────────────────────────────────────────────

export interface VoicePair {
  en: string;
  zh: string;
}

async function sayToWav(text: string, voice: string, wpm: number, out: string): Promise<Wav> {
  // execFile, not a shell — no quoting bugs, no injection surface. The `--`
  // stops `say` from reading a leading dash as a flag.
  await execFileP(
    "say",
    ["-v", voice, "-r", String(wpm), "-o", out, "--data-format", DATA_FORMAT, "--", text],
    { timeout: SYNTH_TIMEOUT_MS },
  );
  return parseWav(readFileSync(out));
}

export interface SynthOptions {
  voices: VoicePair;
  speed?: number;
  /** Silence inserted where the voice switches, in seconds. */
  gap?: number;
}

/**
 * Render text to a single WAV buffer, switching voice per script run.
 * Throws if there is nothing speakable.
 */
export async function synthesize(text: string, opts: SynthOptions): Promise<Buffer> {
  const runs: Run[] = splitByScript(text);
  if (runs.length === 0) throw new Error("nothing speakable in that text");

  const wpm = Math.round(BASE_WPM * (opts.speed ?? 1));
  const gap = opts.gap ?? 0.08;
  const dir = mkdtempSync(join(tmpdir(), "pi-say-"));

  try {
    let fmt: Buffer | null = null;
    const chunks: Buffer[] = [];

    for (const [i, run] of runs.entries()) {
      const voice = run.script === "zh" ? opts.voices.zh : opts.voices.en;
      const wav = await sayToWav(run.text, voice, wpm, join(dir, `run-${i}.wav`));
      if (!fmt) fmt = wav.fmt;
      else chunks.push(silence(fmt, gap));
      chunks.push(wav.data);
    }

    return buildWav(fmt as Buffer, chunks);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Playback ───────────────────────────────────────────────────────

function play(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/afplay", [path], { timeout: PLAYBACK_TIMEOUT_MS }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/** Synthesize, play, and clean up the temp file. */
export async function synthesizeAndPlay(text: string, opts: SynthOptions): Promise<void> {
  const wav = await synthesize(text, opts);
  const dir = mkdtempSync(join(tmpdir(), "pi-say-play-"));
  const path = join(dir, "out.wav");
  try {
    writeFileSync(path, wav);
    await play(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Serial queue ───────────────────────────────────────────────────

export interface SpeechQueue {
  enqueue(job: () => Promise<void>): void;
  /** Drop everything not yet started. Does not stop what is playing. */
  clear(): void;
  readonly pending: number;
  readonly busy: boolean;
}

/**
 * Serializes speech so a tool call and an auto-spoken summary never talk
 * over each other. A failing job is swallowed so it cannot wedge the queue.
 */
export function createQueue(onError?: (err: unknown) => void): SpeechQueue {
  const jobs: Array<() => Promise<void>> = [];
  let busy = false;

  function drain(): void {
    if (busy) return;
    const job = jobs.shift();
    if (!job) return;
    busy = true;
    job()
      .catch((err) => onError?.(err))
      .finally(() => {
        busy = false;
        drain();
      });
  }

  return {
    enqueue(job) {
      jobs.push(job);
      drain();
    },
    clear() {
      jobs.length = 0;
    },
    get pending() {
      return jobs.length;
    },
    get busy() {
      return busy;
    },
  };
}
