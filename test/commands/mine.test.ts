import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// `mine start` and `mine stop` share one code path. Only start may touch the
// etherbase, since that decides which wallet the rewards go to.

describe("mineCommand", () => {
  const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  let tmpDir: string;
  let sent: [string, unknown[]][];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-mine-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    // Keeps .cmu-networks.json out of the developer's real home directory.
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({ address: ADDRESS, activeNetwork: "local" }),
    );

    sent = [];
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          send = async (method: string, params: unknown[]) => {
            sent.push([method, params]);
          };
        },
      },
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("ethers");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function run(subcommand: string) {
    const { mineCommand } = await import("../../src/commands/mine");
    await mineCommand.parseAsync([subcommand], { from: "user" });
  }

  it("start points the etherbase at the session wallet, then starts one thread", async () => {
    await run("start");

    expect(sent).toEqual([
      ["miner_setEtherbase", [ADDRESS]],
      ["miner_start", [1]],
    ]);
  });

  it("stop only stops the miner", async () => {
    await run("stop");

    expect(sent).toEqual([["miner_stop", []]]);
  });
});
