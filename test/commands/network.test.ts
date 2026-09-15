import { describe, expect, it } from "vitest";
import { isValidRpcUrl } from "../../src/commands/network";

// Issue #86 (a): `cmu network --save` persisted whatever string it was given.

describe("isValidRpcUrl", () => {
  it.each([
    "http://127.0.0.1:8585",
    "https://rpc.example.com",
    "https://rpc.example.com:8585/path",
  ])("accepts %s", (url) => {
    expect(isValidRpcUrl(url)).toBe(true);
  });

  it.each([
    ["a bare word", "notaurl"],
    ["a host with no scheme", "127.0.0.1:8585"],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("rejects %s", (_label, url) => {
    expect(isValidRpcUrl(url)).toBe(false);
  });

  it.each([
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["ws", "ws://127.0.0.1:8585"],
    ["wss", "wss://rpc.example.com"],
  ])("rejects the %s scheme, which JsonRpcProvider cannot speak", (_l, url) => {
    expect(isValidRpcUrl(url)).toBe(false);
  });
});
