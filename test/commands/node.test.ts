import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLoopbackHost, warnOnNonLoopbackHost } from "../../src/commands/node";

// Issue #86 (b): binding the DevNet to a non-loopback host exposes the RPC
// endpoint and the private keys the command prints, previously with no warning.

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"])(
    "treats %s as loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(["0.0.0.0", "192.168.1.10", "::", "example.local"])(
    "treats %s as non-loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

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
