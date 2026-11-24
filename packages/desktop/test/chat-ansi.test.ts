import test from "node:test";
import assert from "node:assert";
import { parseAnsi } from "../src/shell/chat-ansi.js";

const ESC = "\u001b";

test("plain text is one unstyled span", () => {
  assert.deepStrictEqual(parseAnsi("hello world"), [{ text: "hello world" }]);
});

test("empty input has no spans", () => {
  assert.deepStrictEqual(parseAnsi(""), []);
});

test("basic SGR foreground colors become readable spans", () => {
  assert.deepStrictEqual(parseAnsi(`${ESC}[31mred${ESC}[32mgreen`), [
    { text: "red", color: "#ff7b72" },
    { text: "green", color: "#3fb950" },
  ]);
});

test("bright foreground colors are supported", () => {
  assert.deepStrictEqual(parseAnsi(`${ESC}[94mblue`), [
    { text: "blue", color: "#79c0ff" },
  ]);
});

test("background colors are supported and reset clears both", () => {
  assert.deepStrictEqual(parseAnsi(`${ESC}[41;32mon red${ESC}[0mplain`), [
    { text: "on red", color: "#3fb950", background: "#3d1a1a" },
    { text: "plain" },
  ]);
});

test("bold turns on and off without losing the color", () => {
  assert.deepStrictEqual(parseAnsi(`${ESC}[1;31mbold${ESC}[22mnormal`), [
    { text: "bold", color: "#ff7b72", bold: true },
    { text: "normal", color: "#ff7b72" },
  ]);
});

test("default foreground and background codes remove just that attribute", () => {
  assert.deepStrictEqual(parseAnsi(`${ESC}[1;31;44mstyled${ESC}[39;49mplain`), [
    { text: "styled", color: "#ff7b72", background: "#13294a", bold: true },
    { text: "plain", bold: true },
  ]);
});

test("unknown SGR codes are ignored, not shown", () => {
  assert.deepStrictEqual(parseAnsi(`${ESC}[999mplain${ESC}[2Jafter`), [
    { text: "plainafter" },
  ]);
});

test("non-SGR escapes, OSC links and the literal \\x1b form are stripped or decoded", () => {
  assert.deepStrictEqual(parseAnsi(`a${ESC}[2Jb${ESC}]8;;https://example.com${ESC}\\${ESC}[Kend`), [
    { text: "abend" },
  ]);
  assert.deepStrictEqual(parseAnsi("\\x1b[32mgreen"), [
    { text: "green", color: "#3fb950" },
  ]);
});

test("an incomplete escape sequence is stripped rather than leaking characters", () => {
  assert.deepStrictEqual(parseAnsi(`before${ESC}[31`), [{ text: "before" }]);
});
