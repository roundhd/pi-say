/**
 * Deciding WHAT to say at the end of a turn.
 *
 * The premise: the user asked for the thing, so repeating the thing back is
 * noise. Speech is only worth interrupting her for when it carries
 * information she cannot predict — a failure, a decision she has to make, a
 * question, or a surprise. Everything else gets a four-word acknowledgement
 * so she knows the turn ended, and nothing more.
 *
 * This runs locally: no tokens, no network, no added latency. Set
 * `announce: "model"` in config if you want an LLM to write the line instead.
 */

import { dominantScript, hasSpeakableContent, stripMarkdown, stripNoise } from "./text.ts";

export type Verdict = "failed" | "question" | "decision" | "finding" | "routine" | "silent";

export interface Announcement {
  text: string;
  verdict: Verdict;
}

// ── Signal detection ───────────────────────────────────────────────

const FAILURE = [
  /\b(failed|failing|error|errors|broken|broke|cannot|can't|unable to|blocked|crashed|timed out|timeout)\b/i,
  /\b(does not exist|not found|missing|denied|rejected|conflict)\b/i,
  /(失败|报错|错误|不能|无法|挂了|坏了|超时|冲突|被拒)/,
];

const DECISION = [
  /\b(which|should i|do you want|prefer|option|either|or should)\b.*\?/i,
  /\b(let me know|your call|up to you|confirm before)\b/i,
  /(要不要|你想|哪一个|哪个|你决定|需要我|确认一下)/,
];

const FINDING = [
  /\b(turns out|actually|the real (cause|reason)|root cause|surprising|note that|caveat|heads up|careful)\b/i,
  /\b(already|instead of what)\b.*\b(exists|existed|was)\b/i,
  /(其实|原来|结果是|根本原因|注意|坑|居然)/,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ── Sentence utilities ─────────────────────────────────────────────

/** Split on sentence terminators in both scripts, keeping the terminator. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => hasSpeakableContent(s));
}

/** The last question asked, if the message ends by asking something. */
function trailingQuestion(text: string): string | null {
  const list = sentences(text);
  for (let i = list.length - 1; i >= Math.max(0, list.length - 3); i--) {
    if (/[?？]\s*$/.test(list[i])) return list[i];
  }
  return null;
}

/** First sentence matching any pattern, else null. */
function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const s of sentences(text)) {
    if (matchesAny(s, patterns)) return s;
  }
  return null;
}

const ACK_EN = "Done.";
const ACK_ZH = "好了。";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Prefer cutting at a word boundary so we don't clip mid-word.
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

// ── The rule engine ────────────────────────────────────────────────

export interface AnnounceOptions {
  maxChars?: number;
  /** Speak an acknowledgement for routine turns. Off means stay silent. */
  ackRoutine?: boolean;
}

/**
 * Turn an assistant message into at most one spoken line.
 *
 * Order matters and mirrors urgency: a failed run is worth hearing even if
 * the message also ends with a question, because the failure is the thing
 * she has to react to.
 */
export function announce(raw: string, opts: AnnounceOptions = {}): Announcement {
  const maxChars = opts.maxChars ?? 240;
  const ackRoutine = opts.ackRoutine ?? true;

  const clean = stripNoise(stripMarkdown(raw));
  if (!hasSpeakableContent(clean)) return { text: "", verdict: "silent" };

  const zh = dominantScript(clean) === "zh";
  const ack = zh ? ACK_ZH : ACK_EN;

  const failure = firstMatch(clean, FAILURE);
  if (failure) return { text: truncate(failure, maxChars), verdict: "failed" };

  const question = trailingQuestion(clean);
  if (question) {
    const decision = matchesAny(question, DECISION);
    return {
      text: truncate(question, maxChars),
      verdict: decision ? "decision" : "question",
    };
  }

  const decision = firstMatch(clean, DECISION);
  if (decision) return { text: truncate(decision, maxChars), verdict: "decision" };

  const finding = firstMatch(clean, FINDING);
  if (finding) return { text: truncate(finding, maxChars), verdict: "finding" };

  return ackRoutine ? { text: ack, verdict: "routine" } : { text: "", verdict: "silent" };
}
