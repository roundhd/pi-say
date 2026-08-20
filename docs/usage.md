# Using pi-say

You have it installed. Here is how to actually use it.

For what it is and why it works the way it does, see [README.md](../README.md).
This file is only about driving it.

## Contents

- [The thirty second version](#the-thirty-second-version)
- [Every key and command](#every-key-and-command)
- [The four announce modes](#the-four-announce-modes)
- [Picking voices](#picking-voices)
- [Recipes](#recipes)
- [When it misbehaves](#when-it-misbehaves)

## The thirty second version

Out of the box, **every time the assistant finishes replying, a bar appears at
the bottom and starts reading the reply aloud.**

```
 ▶  3/17  1.00x  ━━━━━━━━━────────────────────
   The linker could not find libfoo.
 space • ←→ • r • [ ] • esc     (? for keys)
```

Three keys cover almost everything:

| | |
|---|---|
| `esc` | Not interested. Closes and stops. |
| `space` | Pause. Press again to continue. |
| `→` | Next sentence. Hold it to skim. |

The bar does not redraw your text. Whatever the terminal rendered above —
tables, highlighted code, colour — stays exactly where it was, so you can read
along with your eyes while it reads with the voice.

If you do not want to be read to at all: `/say` → Announce → `off`.

## Every key and command

### Inside the read-along bar

| Key | |
|---|---|
| `space` | Pause / resume. |
| `→` or `↓` | Next sentence. |
| `←` or `↑` | Previous sentence. |
| `r` | Repeat this sentence. |
| `]` | Faster. Takes effect on the next sentence. |
| `[` | Slower. |
| `0`–`9` | Jump proportionally through the message. `5` is halfway, `8` is near the end. |
| `?` | Show the full key list in the bar. |
| `esc` or `q` | Close and stop. |

Speed changes made with `[` and `]` stick for the rest of the session.

### Commands

| | |
|---|---|
| `/read` | Read the last reply. |
| `/read 3` | Read the third most recent reply. |
| `/read pick` | Choose from the last dozen replies. |
| `/read some text` | Read exactly that text. |
| `/say` | Open the settings menu. |
| `/say on` / `/say off` | Turn speech on or off. |
| `/say some text` | Speak that text once, no bar, no controls. |

### Shortcuts

| | |
|---|---|
| `alt+r` | Read the last reply. Same as bare `/read`. |
| `alt+s` | Toggle speech on and off. |

### The status indicator

Bottom right, a `♪`:

| | |
|---|---|
| `♪` in green | On and idle. |
| `♪ 4/17` in accent | Reading, and where it is. |
| `♪` dimmed | Off, or announce is `off`. |

## The four announce modes

This is the setting worth understanding, because it decides what happens
after every single turn. Change it with `/say` → Announce.

### `read` — the default

Opens the bar and reads the whole reply.

Best when you are away from the screen, or reading is tiring, or the reply is
long and you would rather skim it by ear. You keep full control: skip, jump,
bail.

The cost is that it starts talking after every turn, including the ones where
the answer was one line.

### `ack` — one line, then quiet

Speaks at most one sentence, chosen by local rules:

| It says | When |
|---|---|
| The sentence describing the failure | Something broke |
| The choice | You have to decide something |
| The question, word for word | The reply ends by asking you something |
| The surprising bit | It found something unexpected |
| "Done." / "好了。" | Routine work finished |
| nothing | The reply was filler |

Best when you are watching the screen anyway and just want to know *whether*
you need to look. No tokens, no delay, no model call.

The cost is that the rules are pattern matching, not comprehension. They will
occasionally pick a boring sentence. That is the tradeoff for being instant.

### `model` — let an LLM write the line

Sends the reply to a model with instructions to produce one short spoken line.

Best if `ack` keeps picking the wrong sentence and you would rather spend
tokens on judgement. Uses your session model unless you set `announceModel`.

The cost: an extra model call per turn, a delay before it speaks, and a
summary that can quietly drop the thing that mattered. This is why it is not
the default.

### `off` — silence

Nothing is spoken automatically. `/read`, `/say <text>`, `alt+r`, and the
`tts` tool all still work.

Best when you are in a meeting, or pairing, or the room is quiet.

## Picking voices

`/say` → English voice / Chinese voice. It previews immediately after you
choose, so you can cycle until one is tolerable.

Defaults are `Zoe (Premium)` and `Yue (Premium)`.

**Install the Premium voices first.** The stock ones are genuinely unpleasant
over a full workday. System Settings → Accessibility → Spoken Content →
System Voice → Manage Voices, then look for entries marked *Premium*. They are
a few hundred megabytes each and worth it.

Mixed sentences switch voice automatically, so `我们的 Bazel 构建挂了, want me
to look?` uses the Chinese voice for the Chinese and the English voice for the
English, in one continuous sentence. A single foreign word inside a sentence
does *not* trigger a switch — one word in another voice sounds worse than the
wrong voice reading it.

## Recipes

**Listen to a long answer while doing something else.**
Leave it on `read`. When the bar appears, walk away. Come back and press `←`
a few times to hear the part you missed.

**Only interrupt me when something is wrong.**
`/say` → Announce → `ack`. Now a routine turn is four characters of speech and
a failure is the actual error sentence.

**I am in a meeting.**
`alt+s`. Toggles everything off without opening a menu. `alt+s` again after.

**Re-read something from earlier.**
`/read pick`, then choose from the list. Or `/read 4` if you know how far back
it was.

**Read me this specific thing, not a reply.**
`/say <paste the text>` for a one-shot, or `/read <text>` if you want to be
able to skip and repeat inside it.

**It is reading too slowly.**
`]` inside the bar, or `/say` → Speed. Around `1.5x` is comfortable once you
are used to the voice.

**Practising English listening.**
`read` mode plus `[` to slow down. It reads the exact words on screen, so you
can compare what you hear against what is written.

## When it misbehaves

**No sound at all.**

```bash
say -v "Zoe (Premium)" hello    # is the voice installed?
pi list                          # is pi-say installed?
```

If `say` is silent, the problem is macOS, not pi-say. Check your output device
and volume. If `pi list` does not show pi-say, it is not loaded — restart pi.

**It reads paths and code out loud.**

It should not. Markdown, fenced code, URLs, file paths, and commit hashes are
stripped before anything reaches the synthesizer. If you hear one, that is a
bug worth reporting with the exact text.

**A sentence gets cut in half.**

Sentence splitting is conservative, but abbreviations it does not know will
fool it. `Dr.`, `etc.`, `3.14`, and `config.load` are all handled. Something
unusual may not be.

**It talks over itself.**

Speech is serialized, so this should be impossible. If two voices overlap,
something crashed mid-queue — restart pi and note what triggered it.

**Changes from `/say` disappear.**

That is intentional. Menu changes apply to the current session only, and are
recorded in the session log so a branch keeps its own setting. To change the
default permanently, edit `~/.pi/say/config.json`:

```json
{
  "enVoice": "Zoe (Premium)",
  "zhVoice": "Yue (Premium)",
  "speed": 1.25,
  "announce": "ack"
}
```

The file does not exist until you create it. Missing keys fall back to
defaults, so you only need to write the ones you are changing.

**The bar covers something I was reading.**

It sits below your content and takes about five lines. `esc` closes it
immediately; the text underneath is untouched.
