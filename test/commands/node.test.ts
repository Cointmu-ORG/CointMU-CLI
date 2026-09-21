import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { warnOnNonLoopbackHost } from "../../src/commands/node";

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
