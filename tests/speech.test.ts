import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWav,
  createQueue,
  listVoices,
  silence,
  synthesize,
  voiceExists,
} from "../extensions/speech.ts";

/** A minimal PCM fmt chunk: mono, 22050 Hz, 16-bit. */
function fakeFmt(): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // channels
  fmt.writeUInt32LE(22050, 4); // sample rate
  fmt.writeUInt32LE(44100, 8); // byte rate
  fmt.writeUInt16LE(2, 12); // block align
  fmt.writeUInt16LE(16, 14); // bits per sample
  return fmt;
}

describe("buildWav", () => {
  it("emits a valid RIFF/WAVE header with correct sizes", () => {
    const data = Buffer.alloc(100, 7);
    const wav = buildWav(fakeFmt(), [data]);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.toString("ascii", 12, 16), "fmt ");
    assert.equal(wav.readUInt32LE(16), 16);
    assert.equal(wav.toString("ascii", 36, 40), "data");
    assert.equal(wav.readUInt32LE(40), 100);
  });

  it("concatenates multiple data chunks", () => {
    const wav = buildWav(fakeFmt(), [Buffer.alloc(10), Buffer.alloc(20)]);
    assert.equal(wav.readUInt32LE(40), 30);
  });
});

describe("silence", () => {
  it("sizes the buffer from the fmt chunk and is frame-aligned", () => {
    const buf = silence(fakeFmt(), 0.5);
    assert.equal(buf.length, 22050 * 0.5 * 2);
    assert.equal(buf.length % 2, 0);
    assert.ok(buf.every((b) => b === 0));
  });
});

describe("createQueue", () => {
  it("runs jobs one at a time, in order", async () => {
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    const q = createQueue();

    const job = (n: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      order.push(n);
      active--;
    };

    q.enqueue(job(1));
    q.enqueue(job(2));
    q.enqueue(job(3));
    await new Promise((r) => setTimeout(r, 80));

    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(maxActive, 1);
    assert.equal(q.pending, 0);
    assert.equal(q.busy, false);
  });

  it("keeps draining after a job throws, and reports it", async () => {
    const seen: unknown[] = [];
    const done: number[] = [];
    const q = createQueue((e) => seen.push(e));

    q.enqueue(async () => {
      throw new Error("boom");
    });
    q.enqueue(async () => {
      done.push(2);
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(seen.length, 1);
    assert.deepEqual(done, [2]);
  });

  it("clear drops queued jobs that have not started", async () => {
    const done: number[] = [];
    const q = createQueue();
    q.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      done.push(1);
    });
    q.enqueue(async () => {
      done.push(2);
    });
    q.clear();
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(done, [1]);
  });
});

// These touch the real `say` binary, so they only run on macOS.
const mac = process.platform === "darwin";

describe("macOS say integration", { skip: mac ? false : "not macOS" }, () => {
  it("lists voices with names and locales", async () => {
    const voices = await listVoices();
    assert.ok(voices.length > 0);
    assert.ok(voices.every((v) => v.name.length > 0 && /^[a-z]{2}_[A-Z]{2}$/.test(v.locale)));
  });

  it("reports whether a voice exists", async () => {
    const voices = await listVoices();
    assert.equal(await voiceExists(voices[0].name), true);
    assert.equal(await voiceExists("Definitely Not A Voice"), false);
  });

  it("synthesizes English to a playable WAV", async () => {
    const wav = await synthesize("Hello there.", { voices: { en: "Alex", zh: "Tingting" } });
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.ok(wav.length > 1000);
  });

  it("stitches a mixed sentence into one WAV longer than either half", async () => {
    const opts = { voices: { en: "Alex", zh: "Tingting" } };
    const mixed = await synthesize("这是中文的部分 and here is the english part", opts);
    const zhOnly = await synthesize("这是中文的部分", opts);
    assert.equal(mixed.toString("ascii", 0, 4), "RIFF");
    assert.ok(mixed.length > zhOnly.length);
  });

  it("rejects text with nothing to say", async () => {
    await assert.rejects(
      () => synthesize("   ---   ", { voices: { en: "Alex", zh: "Tingting" } }),
      /nothing speakable/,
    );
  });
});
