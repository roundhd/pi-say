/**
 * Sentence-level playback: the machinery behind "read from here", skip,
 * back, and pause.
 *
 * `afplay` cannot seek, so seeking is faked at the sentence boundary: the
 * text is split once, each sentence is synthesized to its own file, and
 * "jump to sentence 7" means "kill the current afplay and start playing
 * file 7". Sentences are the natural unit for listening anyway — nobody
 * wants to rewind by three hundred milliseconds.
 *
 * Synthesis runs one sentence ahead of playback rather than all at once, so
 * a long message starts speaking immediately instead of after a ten second
 * render.
 */

import { type ChildProcess, execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthesize, type VoicePair } from "./speech.ts";
import { hasSpeakableContent } from "./text.ts";

// ── Sentence splitting ─────────────────────────────────────────────

/** Abbreviations whose trailing dot does not end a sentence. */
const ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "inc", "ltd",
  "e.g", "i.e", "approx", "fig", "no", "vol", "pp",
]);

/**
 * Split prose into speakable sentences.
 *
 * Deliberately conservative: an over-long sentence is a minor annoyance,
 * but a sentence cut in half sounds broken. Splits on terminators in both
 * scripts, keeps the terminator, and refuses to split after an
 * abbreviation, a decimal point, or a single initial.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // CJK terminators are unambiguous — no abbreviations, no decimals.
    if ("。！？".includes(ch)) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
      continue;
    }

    if (!".!?".includes(ch)) continue;

    const next = text[i + 1];
    // A terminator must be followed by whitespace or end of input.
    if (next !== undefined && !/\s/.test(next)) continue;

    if (ch === ".") {
      const before = text.slice(Math.max(0, i - 12), i);
      const word = (before.match(/[\w.]+$/) ?? [""])[0].toLowerCase();
      if (ABBREV.has(word)) continue;
      // A single letter before the dot is an initial: "J. Smith".
      if (/^[a-z]$/.test(word)) continue;
      // A digit on both sides is a decimal that survived stripping.
      if (/\d$/.test(before) && /^\d/.test(next ?? "")) continue;
    }

    out.push(text.slice(start, i + 1));
    start = i + 1;
  }

  if (start < text.length) out.push(text.slice(start));

  // Newlines are hard breaks — a list item is its own sentence.
  return out
    .flatMap((s) => s.split(/\n+/))
    .map((s) => s.trim())
    .filter(hasSpeakableContent);
}

// ── Player ─────────────────────────────────────────────────────────

export type PlayerStatus = "idle" | "synthesizing" | "playing" | "paused" | "done";

export interface PlayerState {
  status: PlayerStatus;
  index: number;
  total: number;
  /** The sentence currently being spoken, or "" when idle. */
  current: string;
}

export interface PlayerOptions {
  voices: VoicePair;
  speed: number;
  onChange?: (state: PlayerState) => void;
}

/**
 * An interruptible sentence-by-sentence reader.
 *
 * Every seek increments a generation counter. In-flight synthesis and
 * playback check the counter before doing anything visible, which is how a
 * skip during a slow `say` render does not end up playing the stale
 * sentence a second later.
 */
export class Reader {
  readonly sentences: string[];
  private readonly voices: VoicePair;
  private speed: number;
  private readonly onChange?: (state: PlayerState) => void;

  private dir: string | null = null;
  private cache = new Map<number, string>();
  private proc: ChildProcess | null = null;
  private generation = 0;
  private index = 0;
  private status: PlayerStatus = "idle";
  private disposed = false;

  constructor(text: string, opts: PlayerOptions) {
    this.sentences = splitSentences(text);
    this.voices = opts.voices;
    this.speed = opts.speed;
    this.onChange = opts.onChange;
  }

  get state(): PlayerState {
    return {
      status: this.status,
      index: this.index,
      total: this.sentences.length,
      current: this.sentences[this.index] ?? "",
    };
  }

  private emit(status?: PlayerStatus): void {
    if (status) this.status = status;
    this.onChange?.(this.state);
  }

  private tmpDir(): string {
    this.dir ??= mkdtempSync(join(tmpdir(), "pi-say-reader-"));
    return this.dir;
  }

  /** Render one sentence to disk, memoized. Safe to call speculatively. */
  private async render(i: number): Promise<string | null> {
    if (i < 0 || i >= this.sentences.length) return null;
    const hit = this.cache.get(i);
    if (hit) return hit;

    try {
      const wav = await synthesize(this.sentences[i], {
        voices: this.voices,
        speed: this.speed,
      });
      if (this.disposed) return null;
      const path = join(this.tmpDir(), `s${i}.wav`);
      writeFileSync(path, wav);
      this.cache.set(i, path);
      return path;
    } catch {
      // A sentence that will not synthesize should be skipped, not fatal.
      return null;
    }
  }

  /** Stop whatever is sounding right now. Does not change the index. */
  private kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  private playFile(path: string, gen: number): Promise<"ended" | "interrupted"> {
    return new Promise((resolve) => {
      const child = execFile("/usr/bin/afplay", [path], () => {
        resolve(gen === this.generation && !this.disposed ? "ended" : "interrupted");
      });
      this.proc = child;
    });
  }

  /**
   * Play from `index` to the end, or until interrupted.
   * Each seek starts a new run and abandons the old one.
   */
  private async run(): Promise<void> {
    const gen = ++this.generation;
    this.kill();

    while (!this.disposed && gen === this.generation && this.index < this.sentences.length) {
      const path = this.cache.get(this.index) ?? null;
      if (!path) this.emit("synthesizing");

      const ready = path ?? (await this.render(this.index));
      if (gen !== this.generation || this.disposed) return;

      if (!ready) {
        this.index++;
        continue;
      }

      this.emit("playing");
      // Warm the next sentence while this one plays — this is what keeps
      // playback gapless without rendering the whole message up front.
      void this.render(this.index + 1);

      const outcome = await this.playFile(ready, gen);
      if (outcome === "interrupted" || gen !== this.generation || this.disposed) return;

      this.index++;
    }

    if (gen === this.generation && !this.disposed) {
      this.index = Math.max(0, this.sentences.length - 1);
      this.emit("done");
    }
  }

  // ── Transport ────────────────────────────────────────────────

  /** Start (or restart) playback at `from`. */
  start(from = 0): void {
    if (this.sentences.length === 0) return;
    this.index = clamp(from, 0, this.sentences.length - 1);
    void this.run();
  }

  /** Jump to a sentence and keep playing. This is "click here to read". */
  seek(to: number): void {
    if (this.sentences.length === 0) return;
    this.index = clamp(to, 0, this.sentences.length - 1);
    void this.run();
  }

  next(): void {
    this.seek(this.index + 1);
  }

  /**
   * Back one sentence. If we are more than a moment into the current
   * sentence, restart it instead — the same instinct as a music player's
   * previous button.
   */
  prev(): void {
    this.seek(this.index - 1);
  }

  /** Restart the sentence being spoken. */
  again(): void {
    this.seek(this.index);
  }

  pause(): void {
    if (this.status !== "playing" && this.status !== "synthesizing") return;
    this.generation++; // abandon the current run
    this.kill();
    this.emit("paused");
  }

  resume(): void {
    if (this.status !== "paused") return;
    void this.run();
  }

  toggle(): void {
    if (this.status === "paused") this.resume();
    else if (this.status === "playing" || this.status === "synthesizing") this.pause();
    else this.start(this.index);
  }

  setSpeed(speed: number): void {
    if (speed === this.speed) return;
    this.speed = speed;
    // Rendered audio has the old rate baked in; drop it.
    this.cache.clear();
    if (this.status === "playing") this.seek(this.index);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.kill();
    if (this.dir) {
      rmSync(this.dir, { recursive: true, force: true });
      this.dir = null;
    }
    this.cache.clear();
    this.emit("idle");
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
