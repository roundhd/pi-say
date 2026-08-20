/**
 * pi-say — text to speech for pi using macOS `say`.
 *
 * No server, no model download, no network. Speech is synthesized in-process
 * by shelling out to `say`, so there is nothing to keep running and nothing
 * to fail at three in the morning.
 *
 * Mixed Chinese/English text is segmented by script and each run is rendered
 * with its own voice, then stitched into one WAV.
 *
 * Surface:
 *   tool     tts        — speak text on demand
 *   command  /say       — configure voice, speed, announce mode
 *   shortcut alt+s      — toggle speech on/off
 *   event    agent_end  — announce the outcome of a turn
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "typebox";
import { announce } from "./announce.ts";
import {
  type AnnounceMode,
  effective,
  loadConfig,
  type ModelRef,
  type SayConfig,
  type SessionState,
} from "./config.ts";
import { createReadAlong, publishPlayerState } from "./read-along.ts";
import { Reader, splitSentences } from "./reader.ts";
import {
  createQueue,
  listVoices,
  synthesizeAndPlay,
  voiceExists,
  voicesForLocale,
} from "./speech.ts";
import { hasSpeakableContent, stripMarkdown } from "./text.ts";

const SESSION_ENTRY = "say-session";
const ANNOUNCE_MODES: AnnounceMode[] = ["read", "ack", "model", "off"];

// One shared runtime for every side session we spin up.
let runtimePromise: Promise<ModelRuntime> | undefined;
function sharedRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= ModelRuntime.create();
  return runtimePromise;
}

/** Text content of the final assistant message in an event payload. */
// biome-ignore lint/suspicious/noExplicitAny: event shape varies by event type
function lastAssistantText(event: any): string {
  const msg =
    Array.isArray(event?.messages) && event.messages.length > 0
      ? event.messages[event.messages.length - 1]
      : event?.message;
  const content = msg?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: { type?: string }) => c?.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("\n");
}

/**
 * Walk the session backwards and collect assistant messages, newest first.
 * Used by /read to answer "read the last thing you said" and to offer a
 * pick list when the interesting message is further back.
 */
function recentAssistantTexts(ctx: ExtensionContext, limit: number): string[] {
  const out: string[] = [];
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "message") continue;
    if (entry.message?.role !== "assistant") continue;
    const text = lastAssistantText({ message: entry.message });
    if (text.trim()) out.push(text);
  }
  return out;
}

/**
 * Ask a model to write the spoken line. Used only when announce is "model".
 * Runs in a throwaway side session with every user resource disabled — in
 * particular extensions, or this one would recurse into itself.
 */
async function modelAnnounce(
  prompt: string,
  context: string,
  ctx: ExtensionContext,
  modelRef?: ModelRef,
): Promise<string | null> {
  const model = modelRef ? ctx.modelRegistry.find(modelRef.provider, modelRef.id) : ctx.model;
  if (!model) return null;

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: resolve(homedir(), ".pi", "agent"),
    systemPromptOverride: () => prompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    model,
    tools: [],
    sessionManager: SessionManager.inMemory(),
    modelRuntime: await sharedRuntime(),
    resourceLoader: loader,
  });

  try {
    let out = "";
    const unsub = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        for (const part of event.message.content) {
          if (part.type === "text" && part.text) out += part.text;
        }
      }
    });
    await session.prompt(`\`\`\`\`\n${context}\n\`\`\`\``);
    unsub();
    return out.trim() || null;
  } finally {
    session.dispose();
  }
}

export default function (pi: ExtensionAPI) {
  let defaults: SayConfig = loadConfig();
  let session: SessionState = {};
  let currentCtx: ExtensionContext | undefined;

  const queue = createQueue((err) => {
    console.warn("[pi-say]", err instanceof Error ? err.message : err);
  });

  const config = (): SayConfig => effective(defaults, session);

  function persist(): void {
    pi.appendEntry<SessionState>(SESSION_ENTRY, { ...session });
  }

  function restore(ctx: ExtensionContext): void {
    session = {};
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SESSION_ENTRY) {
        const data = entry.data as SessionState | undefined;
        if (data) session = { ...data };
      }
    }
    defaults = loadConfig();
  }

  /** Queue a line for speech. Never throws; failures are logged and dropped. */
  function speak(text: string, override: Partial<SayConfig> = {}): void {
    const cfg = { ...config(), ...override };
    if (!hasSpeakableContent(text)) return;
    queue.enqueue(() =>
      synthesizeAndPlay(text, {
        voices: { en: cfg.enVoice, zh: cfg.zhVoice },
        speed: cfg.speed,
      }),
    );
  }

  function updateStatus(): void {
    if (!currentCtx) return;
    const cfg = config();
    const theme = currentCtx.ui.theme;
    const on = cfg.enabled && cfg.announce !== "off";
    currentCtx.ui.setStatus("pi-say", theme.fg(on ? "success" : "dim", "\u266A"));
  }

  // ── tts tool ───────────────────────────────────────────────────

  pi.registerTool({
    name: "tts",
    label: "Speak",
    description:
      "Speak text aloud through the macOS speech synthesizer. Handles mixed " +
      "Chinese and English by switching voice per language.",
    promptSnippet: "Speak text aloud",
    promptGuidelines: [
      "Use tts when the user asks to hear something read aloud.",
      "Pass plain prose. Markdown, code blocks, and URLs are stripped before speaking.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Text to speak" }),
      speed: Type.Optional(
        Type.Number({ description: "Rate multiplier, 0.5 to 3.0", minimum: 0.5, maximum: 3.0 }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const cfg = config();
      if (!cfg.enabled) {
        return {
          content: [{ type: "text" as const, text: "Speech is off. Enable it with /say on." }],
          details: {},
        };
      }

      const text = stripMarkdown(params.text);
      if (!hasSpeakableContent(text)) {
        return {
          content: [{ type: "text" as const, text: "Nothing speakable in that text." }],
          details: {},
        };
      }

      speak(text, params.speed ? { speed: params.speed } : {});
      const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      return {
        content: [{ type: "text" as const, text: `Speaking: "${preview}"` }],
        details: {},
      };
    },
  });

  // ── /say command ───────────────────────────────────────────────

  pi.registerCommand("say", {
    description: "Configure speech: voices, speed, announce mode",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on" || arg === "off") {
        session.enabled = arg === "on";
        persist();
        updateStatus();
        ctx.ui.notify(`Speech ${arg}`, "info");
        return;
      }

      if (arg) {
        // Anything else is treated as text to speak — /say hello world.
        speak(stripMarkdown(args));
        return;
      }

      const cfg = config();
      // ui.select works on plain strings, so labels double as the value and
      // we match on a stable prefix rather than an id.
      const MENU = {
        toggle: `Speech: ${cfg.enabled ? "on" : "off"}`,
        announce: `Announce: ${cfg.announce}`,
        en: `English voice: ${cfg.enVoice}`,
        zh: `Chinese voice: ${cfg.zhVoice}`,
        speed: `Speed: ${cfg.speed.toFixed(2)}x`,
        preview: "Preview",
      };
      const picked = await ctx.ui.select("pi-say", Object.values(MENU));
      if (!picked) return;
      const choice = (Object.keys(MENU) as Array<keyof typeof MENU>).find(
        (k) => MENU[k] === picked,
      );
      if (!choice) return;

      if (choice === "toggle") {
        session.enabled = !cfg.enabled;
        persist();
        updateStatus();
        ctx.ui.notify(`Speech ${session.enabled ? "on" : "off"}`, "info");
        return;
      }

      if (choice === "announce") {
        const labels: Record<AnnounceMode, string> = {
          read: "read \u2014 read the whole reply, with controls",
          ack: "ack \u2014 one line: what broke or what to decide",
          model: "model \u2014 an LLM writes a summary line",
          off: "off \u2014 stay quiet",
        };
        const chosen = await ctx.ui.select(
          "How should the end of a turn be announced?",
          ANNOUNCE_MODES.map((m) => labels[m]),
        );
        if (!chosen) return;
        const mode = ANNOUNCE_MODES.find((m) => labels[m] === chosen);
        if (!mode) return;
        session.announce = mode;
        persist();
        updateStatus();
        ctx.ui.notify(`Announce: ${mode}`, "info");
        return;
      }

      if (choice === "en" || choice === "zh") {
        const names = await voicesForLocale(choice);
        if (names.length === 0) {
          ctx.ui.notify(`No ${choice} voices installed. Add them in System Settings.`, "warning");
          return;
        }
        const voice = await ctx.ui.select(`${choice} voice`, names);
        if (!voice) return;
        if (choice === "en") session.enVoice = voice;
        else session.zhVoice = voice;
        persist();
        speak(choice === "en" ? "This is how I sound." : "\u8fd9\u662f\u6211\u7684\u58f0\u97f3\u3002");
        return;
      }

      if (choice === "speed") {
        const options = ["0.75", "1.0", "1.25", "1.5", "1.75", "2.0", "2.5"];
        const chosen = await ctx.ui.select("Speed", options.map((s) => `${s}x`));
        if (!chosen) return;
        session.speed = Number.parseFloat(chosen);
        persist();
        speak("Speed set.");
        return;
      }

      speak("Build finished. \u4e09\u4e2a\u6d4b\u8bd5\u6ca1\u8fc7, want me to fix them?");
    },
  });

  // ── /read — the read-along player ───────────────────────────────

  /** The reader currently on screen, if any. One at a time. */
  let activeReader: Reader | null = null;

  async function openReadAlong(text: string, ctx: ExtensionContext): Promise<void> {
    const clean = stripMarkdown(text);
    if (!hasSpeakableContent(clean)) {
      ctx.ui.notify("Nothing speakable in that message.", "warning");
      return;
    }
    if (ctx.mode !== "tui") {
      // Outside the TUI there is no cursor to follow, so just read it.
      speak(clean);
      return;
    }

    const cfg = config();
    activeReader?.dispose();

    // Queued speech and the reader would fight over the speakers.
    queue.clear();

    const reader = new Reader(clean, {
      voices: { en: cfg.enVoice, zh: cfg.zhVoice },
      speed: cfg.speed,
      onChange: (s) => {
        publishPlayerState(s);
        if (currentCtx) {
          currentCtx.ui.setStatus(
            "pi-say",
            s.status === "idle" || s.status === "done"
              ? currentCtx.ui.theme.fg("success", "\u266A")
              : currentCtx.ui.theme.fg("accent", `\u266A ${s.index + 1}/${s.total}`),
          );
        }
      },
    });
    activeReader = reader;

    try {
      await ctx.ui.custom<void>((tui, theme, _kb, done) =>
        createReadAlong({
          reader,
          theme,
          tui,
          done: () => done(undefined),
          initialSpeed: cfg.speed,
          onSpeedChange: (speed) => {
            session.speed = speed;
            persist();
          },
        }),
      );
    } finally {
      reader.dispose();
      if (activeReader === reader) activeReader = null;
      updateStatus();
    }
  }

  pi.registerCommand("read", {
    description: "Read a message aloud with sentence navigation",
    handler: async (args, ctx) => {
      const arg = args.trim();

      // Explicit text wins: /read <anything> reads exactly that.
      if (arg && !/^\d+$/.test(arg) && arg !== "pick") {
        await openReadAlong(arg, ctx);
        return;
      }

      const history = recentAssistantTexts(ctx, 12);
      if (history.length === 0) {
        ctx.ui.notify("Nothing has been said yet.", "warning");
        return;
      }

      // /read 3 — the third most recent reply.
      if (/^\d+$/.test(arg)) {
        const n = Number(arg);
        const text = history[Math.max(0, Math.min(history.length - 1, n - 1))];
        await openReadAlong(text, ctx);
        return;
      }

      if (arg === "pick") {
        const labels = history.map((t, i) => {
          const first = splitSentences(stripMarkdown(t))[0] ?? "";
          return `${String(i + 1).padStart(2)}  ${first.slice(0, 70)}`;
        });
        const chosen = await ctx.ui.select("Read which reply?", labels);
        if (!chosen) return;
        const idx = labels.indexOf(chosen);
        if (idx >= 0) await openReadAlong(history[idx], ctx);
        return;
      }

      // Bare /read — the most recent reply, which is what you want 90% of
      // the time.
      await openReadAlong(history[0], ctx);
    },
  });

  pi.registerShortcut("alt+r", {
    description: "Read the last reply aloud, with navigation",
    handler: async (ctx) => {
      const history = recentAssistantTexts(ctx, 1);
      if (history.length === 0) {
        ctx.ui.notify("Nothing has been said yet.", "warning");
        return;
      }
      await openReadAlong(history[0], ctx);
    },
  });

  // ── alt+s toggle ───────────────────────────────────────────────

  pi.registerShortcut("alt+s", {
    description: "Toggle speech on/off",
    handler: async (ctx) => {
      session.enabled = !config().enabled;
      persist();
      updateStatus();
      ctx.ui.notify(`Speech ${session.enabled ? "on" : "off"}`, "info");
    },
  });

  // ── Session lifecycle ──────────────────────────────────────────

  async function onSession(ctx: ExtensionContext): Promise<void> {
    currentCtx = ctx;
    restore(ctx);
    updateStatus();

    // A typo in the config should be visible, not a silent no-op later.
    const cfg = config();
    for (const [label, name] of [
      ["English", cfg.enVoice],
      ["Chinese", cfg.zhVoice],
    ] as const) {
      if (!(await voiceExists(name))) {
        ctx.ui.notify(`[pi-say] ${label} voice "${name}" is not installed.`, "warning");
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => onSession(ctx));
  pi.on("session_tree", async (_event, ctx) => onSession(ctx));

  // ── End-of-turn announcement ───────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    const cfg = config();
    if (!cfg.enabled || cfg.announce === "off") return;

    const raw = lastAssistantText(event);
    if (!raw.trim()) return;

    try {
      // Read the actual words. No summary can be trusted to keep the part
      // that mattered, and you can always skip ahead.
      if (cfg.announce === "read") {
        await openReadAlong(raw, ctx);
        return;
      }

      if (cfg.announce === "ack") {
        const { text } = announce(raw, { maxChars: cfg.maxAnnounceChars });
        if (text) speak(text);
        return;
      }

      const line = await modelAnnounce(cfg.announcePrompt, raw, ctx, cfg.announceModel);
      if (line) speak(line);
    } catch (err) {
      console.warn("[pi-say] announce failed:", err);
    }
  });

  // Warm the voice list so the first /say is instant.
  void listVoices().catch(() => {});
}
