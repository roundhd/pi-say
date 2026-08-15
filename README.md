# pi-say

Text to speech for [pi](https://pi.dev) using the macOS `say` command.

No server. No model downloads. No network. Speech is synthesized in-process by
shelling out to `say`, so there is nothing to keep running and nothing that can
be offline when you need it.

Built for a bilingual user: mixed Chinese and English text is segmented by
script and each run is rendered with its own voice, then stitched into a single
WAV. `我们的 Bazel 构建挂了, want me to look?` comes out in two voices, one
sentence, no seam.

## Why not the Kokoro-based extensions

Neural TTS sounds better. It also wants a model download, a resident server, a
port, and in my case a Tailscale hop to a GPU box that is not always up. The
macOS voices are already on the machine, already load instantly, and the
Premium ones are good enough to listen to all day. When the point of the tool
is *accessibility*, "always works" beats "sounds best".

## Install

```bash
pi install git:github.com/roundhd/pi-say
```

Or, for local development:

```bash
pi install /path/to/pi-say
```

macOS only. Requires node 22.18 or newer.

Install the good voices first — the stock ones are rough. **System Settings →
Accessibility → Spoken Content → System Voice → Manage Voices**, then download
the *Premium* variants. `Ava (Premium)` for English and `Yue (Premium)` for
Chinese are the defaults here.

## What it does

| Surface | |
|---|---|
| `tts` tool | The model can speak text on demand. |
| `/say` | Menu: toggle, announce mode, voices, speed, preview. |
| `/say <text>` | Speak that text right now. |
| `/say on` / `/say off` | Toggle without the menu. |
| `alt+s` | Same toggle, from anywhere. |
| End of turn | Announces the outcome. See below. |

### Deciding what to say

This is the part most TTS extensions get wrong. The default behaviour is to
summarize the assistant's final message, which means you hear a paraphrase of
the thing you just asked for. That is noise, and noise trains you to stop
listening.

`pi-say` assumes speech is only worth an interruption when it carries something
you could not have predicted. It classifies the turn locally and speaks at most
one line:

| Verdict | What you hear |
|---|---|
| `failed` | The sentence describing what broke. |
| `decision` | The choice you have to make. |
| `question` | The question, verbatim. |
| `finding` | The surprising bit. |
| `routine` | "Done." — four characters, so you know the turn ended. |
| `silent` | Nothing. |

Detection runs on local heuristics in both English and Chinese. Zero tokens,
zero latency, no extra model call. If you would rather have an LLM write the
line, set `announce` to `"model"` and edit `announcePrompt`.

Markdown, code blocks, file paths, URLs, and commit hashes are stripped before
anything is spoken. Nobody wants to hear a path read out character by character.

## Configuration

`~/.pi/say/config.json`. Everything is optional; missing keys fall back to
defaults.

```json
{
  "enabled": true,
  "enVoice": "Ava (Premium)",
  "zhVoice": "Yue (Premium)",
  "speed": 1.0,
  "announce": "rules",
  "maxAnnounceChars": 240
}
```

| Key | |
|---|---|
| `enVoice` / `zhVoice` | Any name from `say -v '?'`. |
| `speed` | Multiplier on 190 wpm. |
| `announce` | `rules` (local, default), `model` (LLM writes it), `off`. |
| `announcePrompt` | System prompt, only used when `announce` is `model`. |
| `announceModel` | `{ "provider": "...", "id": "..." }`, defaults to the session model. |
| `maxAnnounceChars` | Hard cap on an auto-spoken line. |

Changes made through `/say` apply to the current session only and are stored in
the session log, so a branch keeps its own setting. Edit the file to change the
default everywhere.

## Development

```bash
npm install
npm test        # 38 tests; the `say` integration ones skip off macOS
npm run typecheck
pi -e ./extensions/index.ts
```

| File | |
|---|---|
| `extensions/text.ts` | Markdown stripping, script segmentation. Pure. |
| `extensions/announce.ts` | The rule engine that decides what to say. Pure. |
| `extensions/speech.ts` | `say` invocation, WAV stitching, playback queue. |
| `extensions/config.ts` | Types, defaults, load/save. |
| `extensions/index.ts` | Tool, command, shortcut, event wiring. |

The first three have no pi dependency, which is why they are the ones with real
test coverage.

## Notes

- One `say` process per script run, so a paragraph alternating languages every
  few words is slower than a monolingual one. Runs shorter than four characters
  or words are absorbed into their neighbour to avoid exactly that.
- Playback is serialized through a queue, so a tool call and an end-of-turn
  announcement never talk over each other.
- Korean, Thai, and other non-CJK scripts fall through to the English voice.

## License

MIT
