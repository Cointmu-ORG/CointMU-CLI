import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nodeCommand,
  parsePort,
  warnOnNonLoopbackHost,
} from "../../src/commands/node";
import { LOCAL_PORT } from "../../src/utils/defaults";

// Issue #86 (b): binding the DevNet to a non-loopback host exposes the RPC
// endpoint and the private keys the command prints, previously with no warning.
// isLoopbackHost() moved to src/utils/rpcProxy.ts, where the RPC gate also
// uses it; it is covered in test/utils/rpcProxy.test.ts.

describe("warnOnNonLoopbackHost", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns that the RPC endpoint and printed keys become reachable", () => {
    warnOnNonLoopbackHost("0.0.0.0");

    const output = (console.log as any).mock.calls.flat().join("\n");
    expect(output).toContain("warning:");
    expect(output).toContain("0.0.0.0");
    expect(output).toContain("non-loopback");
    expect(output).toContain("private keys");
    expect(output).toContain("hint:");
  });

  it("stays quiet for the default loopback host", () => {
    warnOnNonLoopbackHost("127.0.0.1");
    expect(console.log).not.toHaveBeenCalled();
  });
});

// Issue #160: parseInt() turned "abc" into the default port and "80abc" into
// 80, so a typo started the node somewhere the user never asked for.
describe("parsePort", () => {
  it("accepts whole numbers from 1 to 65535", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("8585")).toBe(8585);
    expect(parsePort(" 3000 ")).toBe(3000);
    expect(parsePort("65535")).toBe(65535);
  });

  it("rejects non-numeric and partly numeric values instead of guessing", () => {
    for (const bad of ["abc", "", " ", "80abc", "1.5", "0x50", "1e3"]) {
      expect(() => parsePort(bad)).toThrow(/is not a valid port number/);
    }
  });

  it("rejects ports outside 1-65535", () => {
    for (const bad of ["0", "-1", "65536", "99999999", "9".repeat(400)]) {
      expect(() => parsePort(bad)).toThrow(/is not a valid port number/);
    }
  });

  it("names the bad value and hints at the valid range", () => {
    expect(() => parsePort("abc")).toThrow(
      /'abc' is not a valid port number\.\n.*hint:.*between 1 and 65535/,
    );
  });

  it("falls back to the default port only when -p is not given", () => {
    const start = nodeCommand.commands.find((c) => c.name() === "start")!;
    const port = start.options.find((o) => o.long === "--port")!;
    expect(parsePort(port.defaultValue)).toBe(LOCAL_PORT);
  });
});
