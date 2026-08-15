import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitSentences } from "../extensions/reader.ts";

describe("splitSentences", () => {
  it("splits on Latin terminators and keeps them", () => {
    assert.deepEqual(splitSentences("One. Two! Three?"), ["One.", "Two!", "Three?"]);
  });

  it("splits on CJK terminators", () => {
    assert.deepEqual(splitSentences("第一句。第二句！第三句？"), [
      "第一句。",
      "第二句！",
      "第三句？",
    ]);
  });

  it("treats newlines as hard breaks so list items are separate", () => {
    assert.deepEqual(splitSentences("- alpha\n- beta\n- gamma"), ["- alpha", "- beta", "- gamma"]);
  });

  it("does not split after an abbreviation", () => {
    assert.deepEqual(splitSentences("Ask Dr. Smith about it."), ["Ask Dr. Smith about it."]);
    assert.deepEqual(splitSentences("Bazel, uv, etc. are all pinned."), [
      "Bazel, uv, etc. are all pinned.",
    ]);
  });

  it("does not split on a single initial", () => {
    assert.deepEqual(splitSentences("It was J. Smith who filed it."), [
      "It was J. Smith who filed it.",
    ]);
  });

  it("does not split mid-decimal", () => {
    assert.deepEqual(splitSentences("Version 3.14 shipped."), ["Version 3.14 shipped."]);
  });

  it("requires whitespace after a terminator", () => {
    // Otherwise every "foo.bar" identifier becomes two sentences.
    assert.deepEqual(splitSentences("Call config.load now."), ["Call config.load now."]);
  });

  it("keeps a trailing fragment that has no terminator", () => {
    assert.deepEqual(splitSentences("Done. And one more thing"), ["Done.", "And one more thing"]);
  });

  it("drops fragments with nothing speakable", () => {
    assert.deepEqual(splitSentences("Hi.\n\n---\n\nBye."), ["Hi.", "Bye."]);
  });

  it("returns nothing for empty input", () => {
    assert.deepEqual(splitSentences(""), []);
    assert.deepEqual(splitSentences("   \n  "), []);
  });

  it("loses no words", () => {
    const input = "First one. 第二句。Third and last one!";
    const joined = splitSentences(input).join("");
    assert.equal(joined.replace(/\s/g, ""), input.replace(/\s/g, ""));
  });

  it("handles a realistic mixed paragraph", () => {
    const out = splitSentences(
      "构建挂了。The linker could not find libfoo. Want me to pin it? 我可以直接改。",
    );
    assert.equal(out.length, 4);
  });
});
