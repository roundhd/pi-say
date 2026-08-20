/**
 * The read-along transport bar.
 *
 * Deliberately NOT a text viewer. An earlier version rendered the sentences
 * in a scrolling list, which was a mistake: the terminal above has already
 * rendered that same text with syntax highlighting, tables, and colour, and
 * this component was both duplicating it and doing it worse. Worse still,
 * the list stole the screen, so you could not look at the good rendering
 * while listening to it.
 *
 * So this is a single status line. The text stays where it already is; this
 * just tells you where the voice is in it and takes your transport keys.
 */

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PlayerState } from "./reader.ts";
import type { Reader } from "./reader.ts";

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];

export interface ReadAlongOptions {
  reader: Reader;
  theme: Theme;
  tui: TUI;
  done: () => void;
  onSpeedChange?: (speed: number) => void;
  initialSpeed?: number;
  /** Start playing as soon as the bar appears. */
  autoStart?: boolean;
}

/** A progress bar drawn in the space left over after the labels. */
function bar(index: number, total: number, width: number): string {
  if (width < 4 || total === 0) return "";
  const filled = Math.round(((index + 1) / total) * width);
  return "\u2501".repeat(filled) + "\u2500".repeat(Math.max(0, width - filled));
}

export function createReadAlong(opts: ReadAlongOptions): Component & {
  handleInput(data: string): void;
} {
  const { reader, theme, tui, done } = opts;

  let state: PlayerState = reader.state;
  let speedIndex = (() => {
    const i = SPEEDS.indexOf(opts.initialSpeed ?? 1.0);
    return i === -1 ? 1 : i;
  })();
  let showHelp = false;

  readAlongListeners.add((s) => {
    state = s;
    tui.requestRender();
  });

  if (opts.autoStart !== false) reader.start(0);

  function finish(): void {
    readAlongListeners.clear();
    reader.dispose();
    done();
  }

  return {
    invalidate() {},

    render(width: number): string[] {
      const lines: string[] = [];
      lines.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));

      const icon =
        state.status === "playing"
          ? "\u25B6"
          : state.status === "paused"
            ? "\u23F8"
            : state.status === "synthesizing"
              ? "\u22EF"
              : state.status === "done"
                ? "\u2713"
                : "\u25A0";

      const pos = `${state.index + 1}/${state.total}`;
      const speed = `${SPEEDS[speedIndex].toFixed(2)}x`;
      const left = ` ${icon}  ${pos}  ${speed}  `;
      const barWidth = Math.max(0, width - visibleWidth(left) - 1);
      lines.push(theme.fg("accent", left) + theme.fg("dim", bar(state.index, state.total, barWidth)));

      // One line of the sentence being spoken, so you can confirm the voice
      // is where you think it is without hunting for it in the scrollback.
      const current = state.current.replace(/\s+/g, " ");
      if (current) {
        lines.push(theme.fg("muted", truncateToWidth(` ${current}`, width, "\u2026")));
      }

      lines.push(
        theme.fg(
          "dim",
          truncateToWidth(
            showHelp
              ? " space pause \u2022 \u2190\u2192 sentence \u2022 r repeat \u2022 [ ] speed \u2022 0-9 jump \u2022 esc close"
              : " space \u2022 \u2190\u2192 \u2022 r \u2022 [ ] \u2022 esc     (? for keys)",
            width,
          ),
        ),
      );

      lines.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));
      return lines;
    },

    handleInput(data: string): void {
      if (matchesKey(data, "escape") || data === "q") return finish();

      if (data === "?") {
        showHelp = !showHelp;
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "space")) {
        reader.toggle();
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "right") || matchesKey(data, "down")) return reader.next();
      if (matchesKey(data, "left") || matchesKey(data, "up")) return reader.prev();
      if (data === "r") return reader.again();

      if (data === "]" || data === "[") {
        speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, speedIndex + (data === "]" ? 1 : -1)));
        reader.setSpeed(SPEEDS[speedIndex]);
        opts.onSpeedChange?.(SPEEDS[speedIndex]);
        tui.requestRender();
        return;
      }

      // Proportional jump, like a video player: 5 is halfway.
      if (/^[0-9]$/.test(data)) {
        reader.seek(Math.floor((Number(data) / 10) * state.total));
      }
    },
  };
}

/**
 * Reader state fan-out. Reader takes a single onChange callback, but the bar
 * and the status line both want it.
 */
export const readAlongListeners = new Set<(s: PlayerState) => void>();

export function publishPlayerState(s: PlayerState): void {
  for (const fn of readAlongListeners) fn(s);
}
