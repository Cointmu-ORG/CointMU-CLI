import { describe, expect, it } from "vitest";
import {
  coinSymbol,
  DEFAULT_SYMBOL,
  isValidSymbol,
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
