/**
 * The read-along UI: a scrollable sentence list where the cursor is a
 * playhead. Move the cursor, the voice follows.
 *
 * The design goal is that navigating and listening are the same act. There
 * is no separate "select then play" step, because when you are not looking
 * at the screen the selection is invisible — the sentence you hear IS the
 * cursor.
 */

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { PlayerState } from "./reader.ts";
import { Reader } from "./reader.ts";

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];

export interface ReadAlongOptions {
  reader: Reader;
  theme: Theme;
  tui: TUI;
  done: () => void;
  /** Rows of sentence list to show. */
  rows?: number;
  onSpeedChange?: (speed: number) => void;
  initialSpeed?: number;
}

/**
 * A `ctx.ui.custom()` component. Not a subclass of anything — the extension
 * API only needs `render`, `handleInput`, and `invalidate`.
 */
export function createReadAlong(opts: ReadAlongOptions): Component & {
  handleInput(data: string): void;
} {
  const { reader, theme, tui, done } = opts;
  const rows = opts.rows ?? 9;

  let cursor = 0;
  let state: PlayerState = reader.state;
  let speedIndex = Math.max(
    0,
    SPEEDS.indexOf(opts.initialSpeed ?? 1.0) === -1 ? 1 : SPEEDS.indexOf(opts.initialSpeed ?? 1.0),
  );
  let follow = true; // does the cursor chase playback?

  reader.start(0);

  // Playback drives the cursor unless the user has scrolled away to browse.
  const unsubscribe = ((): (() => void) => {
    const handler = (s: PlayerState) => {
      state = s;
      if (follow) cursor = s.index;
      tui.requestRender();
    };
    // The Reader takes its callback at construction, so the extension wires
    // this in; here we just keep a local updater for the state we own.
    readAlongListeners.add(handler);
    return () => readAlongListeners.delete(handler);
  })();

  function moveCursor(delta: number): void {
    const n = reader.sentences.length;
    if (n === 0) return;
    cursor = Math.max(0, Math.min(n - 1, cursor + delta));
    follow = false;
    tui.requestRender();
  }

  function playCursor(): void {
    follow = true;
    reader.seek(cursor);
  }

  function finish(): void {
    unsubscribe();
    reader.dispose();
    done();
  }

  return {
    invalidate() {
      // Nothing cached; render builds strings fresh each frame.
    },

    render(width: number): string[] {
      const lines: string[] = [];
      const border = new DynamicBorder((s: string) => theme.fg("accent", s));

      lines.push(...border.render(width));

      const icon =
        state.status === "playing"
          ? "\u25B6"
          : state.status === "paused"
            ? "\u23F8"
            : state.status === "synthesizing"
              ? "\u22EF"
              : "\u25A0";
      const head = ` ${icon}  ${state.index + 1}/${reader.sentences.length}   ${SPEEDS[speedIndex].toFixed(2)}x${follow ? "" : "   browsing"}`;
      lines.push(theme.fg("accent", truncateToWidth(head, width)));
      lines.push("");

      // Window the list so the cursor stays roughly centred.
      const n = reader.sentences.length;
      const half = Math.floor(rows / 2);
      const start = Math.max(0, Math.min(Math.max(0, n - rows), cursor - half));

      for (let i = start; i < Math.min(n, start + rows); i++) {
        const isCursor = i === cursor;
        const isPlaying = i === state.index && state.status !== "idle";

        // Two marks, because "where I am looking" and "what I am hearing"
        // are different things once you scroll away.
        const mark = isPlaying ? "\u25B8" : " ";
        const num = String(i + 1).padStart(3, " ");
        const body = reader.sentences[i].replace(/\s+/g, " ");
        const raw = ` ${mark}${num}  ${body}`;
        const text = truncateToWidth(raw, width, "\u2026");

        if (isCursor && isPlaying) lines.push(theme.fg("accent", theme.bold(text)));
        else if (isCursor) lines.push(theme.fg("accent", text));
        else if (isPlaying) lines.push(theme.fg("success", text));
        else lines.push(theme.fg("muted", text));
      }

      if (n === 0) lines.push(theme.fg("warning", " nothing speakable here"));

      lines.push("");
      lines.push(
        theme.fg(
          "dim",
          truncateToWidth(
            " \u2191\u2193 move \u2022 enter read here \u2022 space pause \u2022 \u2190\u2192 prev/next \u2022 r again \u2022 [ ] speed \u2022 esc close",
            width,
          ),
        ),
      );
      lines.push(...border.render(width));
      return lines;
    },

    handleInput(data: string): void {
      if (matchesKey(data, "escape") || matchesKey(data, "q")) return finish();

      if (matchesKey(data, "up") || data === "k") return moveCursor(-1);
      if (matchesKey(data, "down") || data === "j") return moveCursor(1);
      if (matchesKey(data, "pageUp")) return moveCursor(-rows);
      if (matchesKey(data, "pageDown")) return moveCursor(rows);
      if (matchesKey(data, "home")) return moveCursor(-1e9);
      if (matchesKey(data, "end")) return moveCursor(1e9);

      if (matchesKey(data, "return")) return playCursor();

      if (matchesKey(data, "space")) {
        reader.toggle();
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "right")) {
        follow = true;
        reader.next();
        return;
      }
      if (matchesKey(data, "left")) {
        follow = true;
        reader.prev();
        return;
      }
      if (data === "r") {
        follow = true;
        reader.again();
        return;
      }

      if (data === "]" || data === "[") {
        speedIndex = Math.max(
          0,
          Math.min(SPEEDS.length - 1, speedIndex + (data === "]" ? 1 : -1)),
        );
        reader.setSpeed(SPEEDS[speedIndex]);
        opts.onSpeedChange?.(SPEEDS[speedIndex]);
        tui.requestRender();
        return;
      }

      // Digits jump proportionally, like a video player: 5 = halfway.
      if (/^[0-9]$/.test(data)) {
        const n = reader.sentences.length;
        cursor = Math.min(n - 1, Math.floor((Number(data) / 10) * n));
        follow = true;
        reader.seek(cursor);
        tui.requestRender();
      }
    },
  };
}

/**
 * Reader state fan-out. The Reader accepts a single onChange callback, but
 * both the component and the extension's status bar want to hear about it,
 * so the extension pushes updates through here.
 */
export const readAlongListeners = new Set<(s: PlayerState) => void>();

export function publishPlayerState(s: PlayerState): void {
  for (const fn of readAlongListeners) fn(s);
}
