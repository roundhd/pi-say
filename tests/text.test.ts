import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dominantScript,
  hasSpeakableContent,
  splitByScript,
  stripMarkdown,
  stripNoise,
} from "../extensions/text.ts";

describe("stripMarkdown", () => {
  it("drops fenced code entirely", () => {
    const out = stripMarkdown("Before\n```js\nconst x = 1;\n```\nAfter");
    assert.ok(!out.includes("const"));
    assert.ok(out.includes("Before"));
    assert.ok(out.includes("After"));
  });

  it("keeps inline code text and link labels", () => {
    assert.equal(stripMarkdown("run `npm test` now"), "run npm test now");
    assert.equal(stripMarkdown("see [the docs](http://x.com)"), "see the docs");
  });

  it("removes heading, quote, and list markers", () => {
    assert.equal(stripMarkdown("## Title"), "Title");
    assert.equal(stripMarkdown("> quoted"), "quoted");
    assert.equal(stripMarkdown("- one\n- two"), "one\ntwo");
  });

  it("unwraps emphasis without eating asterisks in prose", () => {
    assert.equal(stripMarkdown("this is **bold** here"), "this is bold here");
    assert.equal(stripMarkdown("this is _em_ here"), "this is em here");
  });
});

describe("stripNoise", () => {
  it("replaces URLs and deep paths with a word", () => {
    assert.ok(stripNoise("see https://example.com/a/b").includes("link"));
    assert.ok(stripNoise("edit /Users/z/code/pkg/file.ts").includes("a path"));
  });

  it("drops hex blobs", () => {
    assert.ok(!stripNoise("commit 4f3a9b2c1d").includes("4f3a9b2c1d"));
  });
});

describe("splitByScript", () => {
  it("returns a single run for pure English", () => {
    const runs = splitByScript("hello there world");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].script, "en");
  });

  it("returns a single run for pure Chinese", () => {
    const runs = splitByScript("这是一个中文句子");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].script, "zh");
  });

  it("splits a genuinely mixed sentence", () => {
    const runs = splitByScript("这是中文部分 and this is the english part");
    assert.equal(runs.length, 2);
    assert.equal(runs[0].script, "zh");
    assert.equal(runs[1].script, "en");
  });

  it("does not switch voice for a single embedded term", () => {
    // "Bazel" alone is not worth a voice change mid-sentence.
    const runs = splitByScript("我们的 Bazel 构建挂掉了");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].script, "zh");
  });

  it("preserves all speakable characters across runs", () => {
    const input = "先中文 then english 再中文";
    const joined = splitByScript(input)
      .map((r) => r.text)
      .join("");
    assert.equal(joined.replace(/\s/g, ""), input.replace(/\s/g, ""));
  });

  it("drops runs with nothing speakable", () => {
    assert.deepEqual(splitByScript("   ...   "), []);
  });
});

describe("hasSpeakableContent", () => {
  it("is true for letters or digits, false for punctuation alone", () => {
    assert.equal(hasSpeakableContent("hi"), true);
    assert.equal(hasSpeakableContent("好"), true);
    assert.equal(hasSpeakableContent("42"), true);
    assert.equal(hasSpeakableContent(" --- "), false);
  });
});

describe("dominantScript", () => {
  it("picks the script with more weight", () => {
    assert.equal(dominantScript("这句话主要是中文 ok"), "zh");
    assert.equal(dominantScript("mostly english with 中文"), "en");
  });
});
