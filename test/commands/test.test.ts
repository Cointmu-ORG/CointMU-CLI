import { describe, expect, it } from "vitest";
import { isRpcRequestAllowed } from "../../src/commands/test";

describe("isRpcRequestAllowed", () => {
  it("allows a bare loopback request with no Origin (ethers JsonRpcProvider)", () => {
    expect(isRpcRequestAllowed({ host: "127.0.0.1:8555" })).toBe(true);
  });

  it("allows localhost and IPv6 loopback hosts, case-insensitively", () => {
    expect(isRpcRequestAllowed({ host: "localhost:8555" })).toBe(true);
    expect(isRpcRequestAllowed({ host: "LOCALHOST:8555" })).toBe(true);
    expect(isRpcRequestAllowed({ host: "[::1]:8555" })).toBe(true);
  });

  it("allows a request with no Host header at all", () => {
    expect(isRpcRequestAllowed({})).toBe(true);
  });

  it("rejects any request that carries an Origin header (browser fetch/XHR)", () => {
    expect(
      isRpcRequestAllowed({
        host: "127.0.0.1:8555",
        origin: "http://evil.example",
      }),
    ).toBe(false);
    expect(
      isRpcRequestAllowed({ host: "127.0.0.1:8555", origin: "null" }),
    ).toBe(false);
  });

  it("rejects a foreign Host header (DNS rebinding)", () => {
    expect(isRpcRequestAllowed({ host: "attacker.example" })).toBe(false);
    expect(isRpcRequestAllowed({ host: "attacker.example:8555" })).toBe(false);
    expect(isRpcRequestAllowed({ host: "127.0.0.1:9999" })).toBe(false);
  });

  it("handles header values delivered as arrays", () => {
    expect(isRpcRequestAllowed({ host: ["127.0.0.1:8555"] })).toBe(true);
    expect(
      isRpcRequestAllowed({ host: ["127.0.0.1:8555"], origin: ["http://x"] }),
    ).toBe(false);
  });

  it("bypasses every check when --allow-cors is opted in", () => {
    expect(
      isRpcRequestAllowed(
        { host: "attacker.example", origin: "http://evil.example" },
        true,
      ),
    ).toBe(true);
  });
});
