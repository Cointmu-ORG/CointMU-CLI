import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

// Issue #187: `node connect` printed ethers' name for the chain, which is
// 'unknown' for every CointMU node, instead of the saved network it resolved.
describe("node connect", () => {
  const RPC_URL = "http://127.0.0.1:8585";
  let tmpDir: string;
  let dialed: string[];

  /** Answers like ethers does for a chain it has no name registered for. */
  class FakeProvider {
    constructor(url: string) {
      dialed.push(url);
    }
    async getNetwork() {
      return { name: "unknown", chainId: 1912n };
    }
    async getBlockNumber() {
      return 0;
    }
  }

  beforeEach(() => {
    vi.resetModules();
    dialed = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-node-connect-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    // local and kampus share an endpoint, and so a chain ID: only the saved
    // name tells them apart.
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([
        { name: "local", rpcUrl: RPC_URL },
        { name: "kampus", rpcUrl: RPC_URL },
      ]),
    );
    vi.doMock("ethers", async (importOriginal) => {
      const real = await importOriginal<typeof import("ethers")>();
      return {
        ...real,
        ethers: { ...real.ethers, JsonRpcProvider: FakeProvider },
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("ethers");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Runs `node connect` with the given arguments, returning what it printed. */
  async function connect(...args: string[]): Promise<string[]> {
    (console.log as any).mockClear();
    const { nodeCommand: command } = await import("../../src/commands/node");
    await command.parseAsync(["connect", ...args], { from: "user" });
    return (console.log as any).mock.calls.map((call: unknown[]) =>
      call.join(" "),
    );
  }

  it("names the network given with -n, not ethers' 'unknown'", async () => {
    const out = await connect("-n", "kampus");

    expect(out).toContain("Network      : kampus");
    expect(out.join("\n")).not.toContain("unknown");
    expect(dialed).toEqual([RPC_URL]);
  });

  it("names the session's active network when -n is not given", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({ activeNetwork: "kampus" }),
    );

    expect(await connect()).toContain("Network      : kampus");
  });

  it("names the local network when there is no session", async () => {
    expect(await connect()).toContain("Network      : local");
  });

  it("tells apart two saved networks that share a chain ID", async () => {
    const local = await connect("-n", "local");
    const kampus = await connect("-n", "kampus");

    expect(local).toContain("Network      : local");
    expect(kampus).toContain("Network      : kampus");
    expect(local).toContain("Chain ID     : 1912");
    expect(kampus).toContain("Chain ID     : 1912");
  });

  it("keeps the rest of the output as it was", async () => {
    expect(await connect("-n", "local")).toEqual([
      `Pinging ${RPC_URL}...`,
      "Connected to the CointMU node.",
      "Network      : local",
      "Chain ID     : 1912",
      "Block number : 0",
    ]);
  });
});
