/**
 * Config: types, defaults, and load/save for ~/.pi/say/config.json.
 *
 * Only the two functions at the bottom touch the filesystem, and both take
 * the path as a parameter so tests can point at a temp dir.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type AnnounceMode = "read" | "ack" | "model" | "off";

export interface ModelRef {
  provider: string;
  id: string;
}

export interface SayConfig {
  enabled: boolean;
  /** Voice used for Latin-script runs. Must be a name from `say -v ?`. */
  enVoice: string;
  /** Voice used for CJK runs. */
  zhVoice: string;
  /** Multiplier on the base 190 wpm rate. */
  speed: number;
  /**
   * What happens when a turn ends.
   *   read  — read the whole reply aloud, with transport controls (default)
   *   ack   — one line: what broke, what you must decide, or "Done."
   *   model — a side LLM writes a line using `announcePrompt`
   *   off   — never speak automatically; the tts tool still works
   *
   * `read` is the default because summarizing a technical answer into one
   * sentence reliably produces something either useless or wrong. Reading
   * the actual words, with the ability to skip, beats a bad summary.
   */
  announce: AnnounceMode;
  /** Only used when announce is "model". */
  announcePrompt: string;
  announceModel?: ModelRef;
  /** Hard cap on auto-spoken length, in characters. */
  maxAnnounceChars: number;
}

/** Session-scoped overrides, persisted in the session log, not on disk. */
export interface SessionState {
  enabled?: boolean;
  enVoice?: string;
  zhVoice?: string;
  speed?: number;
  announce?: AnnounceMode;
}

export const DEFAULT_ANNOUNCE_PROMPT = [
  "You write one short spoken line for a text-to-speech system.",
  "The listener is a developer who is NOT looking at the screen.",
  "You receive an assistant's final message inside quadruple backticks.",
  "",
  "Say only what she cannot already infer from having asked. Priority:",
  "1. It FAILED or is BLOCKED — say what broke.",
  "2. It needs a DECISION — say the choice.",
  "3. It found something SURPRISING — say the finding.",
  "4. Routine completion — four words, then stop.",
  "",
  "Rules: under twenty spoken words. No preamble. No markdown, file paths,",
  "code, or URLs. Numbers as words. Dry and flat. If the message is only a",
  "question back to her, speak the question. If it is filler, output nothing.",
  "Match the language of the message: Chinese in, Chinese out.",
  "",
  "Output the line and nothing else.",
].join("\n");

export const DEFAULT_CONFIG: SayConfig = {
  enabled: true,
  enVoice: "Zoe (Premium)",
  zhVoice: "Yue (Premium)",
  speed: 1.0,
  announce: "read",
  announcePrompt: DEFAULT_ANNOUNCE_PROMPT,
  maxAnnounceChars: 240,
};

export const CONFIG_DIR = resolve(homedir(), ".pi", "say");
export const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");

export function loadConfig(path: string = CONFIG_PATH): SayConfig {
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<SayConfig>;
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch {
    // A broken config should degrade to defaults, not break the session.
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: SayConfig, path: string = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function effective(defaults: SayConfig, session: SessionState): SayConfig {
  return {
    ...defaults,
    enabled: session.enabled ?? defaults.enabled,
    enVoice: session.enVoice ?? defaults.enVoice,
    zhVoice: session.zhVoice ?? defaults.zhVoice,
    speed: session.speed ?? defaults.speed,
    announce: session.announce ?? defaults.announce,
  };
}
