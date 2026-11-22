import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { stripVTControlCharacters } from "util";

// `cmu console -n <name>` in a folder without cmu.config, against a network
// saved in ~/.cmu-networks.json. The REPL is replaced by one that exits at
// once, so the run gets as far as the banner and back.

const STAGING_URL = "http://127.0.0.1:8586";

describe("runConsole with a saved network", () => {
  let tmpDir: string;
  let logged: string[];

  beforeEach(() => {
    vi.resetModules();
    logged = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-console-global-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.stubEnv("PRIVATE_KEY", "");
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(stripVTControlCharacters(a.map(String).join(" ")));
    });
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([{ name: "staging", rpcUrl: STAGING_URL }]),
    );
    vi.doMock("node:repl", () => ({
      start: () => ({
        context: {},
        on: (_event: string, listener: () => void) => listener(),
      }),
    }));
    vi.doMock("ethers", async (importOriginal) => {
      const real: any = await importOriginal();
      return {
        ...real,
        ethers: {
          ...real.ethers,
          JsonRpcProvider: class {
            getNetwork = async () => ({ name: "unknown", chainId: 1912n });
            destroy = () => {};
          },
        },
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock("node:repl");
    vi.doUnmock("ethers");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints the chain ID the node reported, not 'undefined'", async () => {
    const { runConsole } = await import("../../src/commands/console");

    await runConsole({ network: "staging", signer: false });

    expect(logged).toContain("Network      : staging");
    expect(logged).toContain(`RPC endpoint : ${STAGING_URL}`);
    expect(logged).toContain("Chain ID     : 1912");
  });
});
