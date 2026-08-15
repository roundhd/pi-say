import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { announce, sentences } from "../extensions/announce.ts";

describe("sentences", () => {
  it("splits on both Latin and CJK terminators", () => {
    assert.deepEqual(sentences("One. Two! Three?"), ["One.", "Two!", "Three?"]);
    assert.deepEqual(sentences("第一句。第二句！"), ["第一句。", "第二句！"]);
  });

  it("splits on newlines and drops empty fragments", () => {
    assert.deepEqual(sentences("a\n\n b \n"), ["a", "b"]);
  });
});

describe("announce", () => {
  it("leads with a failure even when other content follows", () => {
    const r = announce("I updated the config. The build failed on the linker step. Next I will look at flags.");
    assert.equal(r.verdict, "failed");
    assert.match(r.text, /build failed/);
  });

  it("detects Chinese failure wording", () => {
    const r = announce("改好了配置。构建失败了，缺一个依赖。");
    assert.equal(r.verdict, "failed");
  });

  it("speaks a trailing question verbatim", () => {
    const r = announce("Wrote three files. Want me to run the tests?");
    assert.ok(r.verdict === "question" || r.verdict === "decision");
    assert.match(r.text, /run the tests\?/);
  });

  it("classifies an either-or question as a decision", () => {
    const r = announce("Two ways to do it. Should I patch it or rewrite the module?");
    assert.equal(r.verdict, "decision");
  });

  it("surfaces a finding when nothing failed and nothing was asked", () => {
    const r = announce("Checked the pipeline. Turns out the cache key was never being set.");
    assert.equal(r.verdict, "finding");
    assert.match(r.text, /cache key/);
  });

  it("gives a terse ack for routine work", () => {
    const r = announce("Renamed the variable in three files and updated the imports.");
    assert.equal(r.verdict, "routine");
    assert.equal(r.text, "Done.");
  });

  it("acks in Chinese when the message is Chinese", () => {
    const r = announce("我把三个文件里的变量都重命名了，导入也更新了。");
    assert.equal(r.verdict, "routine");
    assert.equal(r.text, "好了。");
  });

  it("stays silent on an empty or symbol-only message", () => {
    assert.equal(announce("").verdict, "silent");
    assert.equal(announce("--- \n ***").verdict, "silent");
  });

  it("can be told not to ack routine turns", () => {
    const r = announce("Renamed a variable.", { ackRoutine: false });
    assert.equal(r.verdict, "silent");
    assert.equal(r.text, "");
  });

  it("never speaks code, paths, or URLs", () => {
    const r = announce("Failed to read /Users/z/a/b/c.ts, see https://example.com/x for details.");
    assert.ok(!r.text.includes("/Users/"));
    assert.ok(!r.text.includes("http"));
  });

  it("truncates a very long line", () => {
    const long = `The build failed because ${"x".repeat(500)}`;
    const r = announce(long, { maxChars: 60 });
    assert.ok(r.text.length <= 61, `got ${r.text.length}`);
  });
});
