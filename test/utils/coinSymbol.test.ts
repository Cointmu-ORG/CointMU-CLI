import { describe, expect, it } from "vitest";
import {
  coinSymbol,
  DEFAULT_SYMBOL,
  isValidSymbol,
  savedSymbolNote,
} from "../../src/utils/coinSymbol";

// Issue #228: the label printed next to every amount, per network.

describe("isValidSymbol", () => {
  it.each(["CMU", "cmu", "tCMU", "ETH2", "A", "ABCDEFGHIJK"])(
    "accepts %s",
    (symbol) => {
      expect(isValidSymbol(symbol)).toBe(true);
    },
  );

  it.each([
    ["an empty string", ""],
    ["12 characters", "ABCDEFGHIJKL"],
    ["a dash", "C-M"],
    ["a space", "C M"],
    ["surrounding whitespace", " CMU "],
    ["an emoji", "CMU🚀"],
    ["an ANSI escape", "\x1b[31mCMU"],
    ["a non-ASCII letter", "ÇMU"],
    ["a number", 5],
    ["null", null],
  ])("rejects %s", (_label, symbol) => {
    expect(isValidSymbol(symbol)).toBe(false);
  });
});

describe("coinSymbol", () => {
  const network = { name: "kampus", rpcUrl: "http://127.0.0.1:9000" };

  it("falls back to ETH for a network saved without a symbol", () => {
    expect(coinSymbol(network)).toBe("ETH");
    expect(DEFAULT_SYMBOL).toBe("ETH");
  });

  it("returns the stored symbol as typed", () => {
    expect(coinSymbol({ ...network, symbol: "CMU" })).toBe("CMU");
    expect(coinSymbol({ ...network, symbol: "tCMU" })).toBe("tCMU");
  });

  it.each([
    ["a dash", "c-m"],
    ["an empty string", ""],
    ["a number", 5],
    ["null", null],
  ])("refuses a hand-edited symbol with %s", (_label, symbol) => {
    expect(() => coinSymbol({ ...network, symbol })).toThrow(
      "network 'kampus' has an invalid symbol",
    );
  });

  it("names the command that fixes it, with the saved endpoint filled in", () => {
    expect(() => coinSymbol({ ...network, symbol: "c-m" })).toThrow(
      "cmu network save http://127.0.0.1:9000 --name kampus --symbol <SYMBOL>",
    );
  });
});

describe("savedSymbolNote", () => {
  it("names the symbol that was given", () => {
    expect(savedSymbolNote("CMU", { symbol: "CMU" })).toBe(", symbol CMU");
  });

  it("says which symbol an update without --symbol kept", () => {
    expect(savedSymbolNote(undefined, { symbol: "tCMU" })).toBe(
      ", symbol tCMU kept",
    );
  });

  it("adds nothing for an entry without a symbol", () => {
    expect(savedSymbolNote(undefined, {})).toBe("");
  });

  it("quotes a kept hand-edited symbol instead of printing it raw", () => {
    expect(savedSymbolNote(undefined, { symbol: "\x1b[31mX" })).toBe(
      ', symbol "\\u001b[31mX" kept',
    );
  });
});
