import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// Issue #214: `network ping` talked to the node with a bare provider, so a
// node that was down printed ethers' retry notice and a raw ECONNREFUSED.

const RPC_URL = "http://127.0.0.1:8585";

const refused = () =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8585"), {
    code: "ECONNREFUSED",
  });

let isDown: boolean;

class FakeProvider {
  async getNetwork() {
    if (isDown) throw refused();
    return { name: "unknown", chainId: 1912n };
  }
  async getBlockNumber() {
    if (isDown) throw refused();
    return 7;
  }
}

describe("network ping", () => {
  let tmpDir: string;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    isDown = false;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-network-ping-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([{ name: "local", rpcUrl: RPC_URL }]),
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

  async function ping() {
    const { networkCommand } = await import("../../src/commands/network");
    await networkCommand.parseAsync(["ping", "local"], { from: "user" });
  }

  it("pings through pingNetwork, then shows the block number", async () => {
    await ping();

    const out = log.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(out).toContain(`Pinging ${RPC_URL}...`);
    expect(out).toContain("Connected to 'local' (chain ID 1912).");
    expect(out).toContain("Block number : 7");
    expect(out.filter((l: string) => l.startsWith("Pinging"))).toHaveLength(1);
  });

  it("reports a node that is down the way other commands do", async () => {
    isDown = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as any);

    await expect(ping()).rejects.toThrow("exited");

    const errors = error.mock.calls.flat().join("\n");
    expect(errors).toContain("network ping failed");
    expect(errors).toContain(`RPC endpoint ${RPC_URL} is unreachable`);
    expect(errors).toContain("cmu network list");
    expect(errors).not.toContain("ECONNREFUSED");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
