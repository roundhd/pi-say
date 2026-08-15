/**
 * Text preparation: markdown stripping and CJK/Latin script segmentation.
 *
 * Pure — strings in, strings out, no fs, no child processes, no pi runtime.
 * Everything here is unit-tested in tests/text.test.ts.
 */

// ── Markdown stripping ─────────────────────────────────────────────

/**
 * Strip markdown so the synthesizer speaks words, not punctuation.
 * Fenced code is dropped entirely (spoken code is noise); inline code keeps
 * its text; links and images keep their label/alt.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/(^|[\s([{])\*{1,3}([^*\n]+?)\*{1,3}(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])_{1,3}([^_\n]+?)_{1,3}(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Drop things that are unpleasant to hear: absolute paths, URLs, long hex
 * blobs. Applied only to auto-spoken text, never to explicit tts calls.
 */
export function stripNoise(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/(?:~|\.{0,2})?\/[\w.-]+(?:\/[\w.-]+){2,}/g, "a path")
    .replace(/\b[0-9a-f]{7,40}\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ── Script segmentation ────────────────────────────────────────────

export type Script = "zh" | "en";

export interface Run {
  script: Script;
  text: string;
}

// CJK ideographs + kana. Hangul deliberately excluded — no `say` voice
// switching story for it, and it is not a language Zoe reads.
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const LATIN = /[A-Za-z]/;

/**
 * Split mixed text into consecutive same-script runs.
 *
 * Neutral characters (spaces, digits, punctuation) attach to the preceding
 * run so we don't shatter "3 个 PR" into six fragments. A run shorter than
 * `minRun` real characters is merged into its neighbour: a single stray
 * English word inside a Chinese sentence sounds far worse when a second
 * voice barges in for one word than when the Chinese voice reads it.
 */
export function splitByScript(text: string, minRun = 4): Run[] {
  const raw: Run[] = [];

  for (const ch of text) {
    const script: Script | null = CJK.test(ch) ? "zh" : LATIN.test(ch) ? "en" : null;
    const last = raw[raw.length - 1];

    if (script === null) {
      if (last) last.text += ch;
      else raw.push({ script: "en", text: ch });
      continue;
    }
    if (last && last.script === script) last.text += ch;
    else raw.push({ script, text: ch });
  }

  // Merge runs too short to be worth a voice switch. Absorbing a short run
  // can leave its neighbours adjacent and same-script ("中文 Bazel 中文"),
  // so coalesce those too or we would switch voice to the same voice.
  const merged: Run[] = [];
  for (const run of raw) {
    const weight = run.script === "zh" ? countCJK(run.text) : countLatinWords(run.text);
    const prev = merged[merged.length - 1];
    if (prev && (prev.script === run.script || weight < minRun)) {
      prev.text += run.text;
      continue;
    }
    merged.push({ ...run });
  }

  return merged.filter((r) => hasSpeakableContent(r.text));
}

function countCJK(s: string): number {
  let n = 0;
  for (const ch of s) if (CJK.test(ch)) n++;
  return n;
}

function countLatinWords(s: string): number {
  return (s.match(/[A-Za-z]+/g) ?? []).length;
}

/** True if the string contains anything worth sending to a synthesizer. */
export function hasSpeakableContent(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/** Dominant script of a string, used to pick a default voice. */
export function dominantScript(text: string): Script {
  return countCJK(text) > countLatinWords(text) ? "zh" : "en";
}
