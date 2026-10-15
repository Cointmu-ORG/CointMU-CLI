import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { ADDRESS } from "../helpers/explorerEnv";

// Issue #228: `explorer --contract` labels the balance with the symbol from
// networks.<name>.symbol in cmu.config. Same harness as explorer-run.test.ts.

describe("runExplorer", () => {
  let tmpDir: string;
  const prevKey = process.env.PRIVATE_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-explorer-symbol-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.PRIVATE_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("ethers");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  /** A whole ethers module, so no query needs a node. */
  function mockEthers(provider: Record<string, unknown>): void {
    const actual = require("ethers");
    vi.doMock("ethers", () => ({
      ethers: {
        ...actual.ethers,
        JsonRpcProvider: class {
          constructor() {
            return {
              getNetwork: async () => ({ name: "local", chainId: 1912n }),
              destroy: () => {},
              ...provider,
            };
          }
        },
      },
      formatEther: actual.formatEther,
      keccak256: actual.keccak256,
    }));
  }

  async function run(options = {}) {
    const { runExplorer } = await import("../../src/commands/explorer");
    return runExplorer(options);
  }

  describe("balance symbol", () => {
    function writeLocalConfig(fields: string): void {
      fs.writeFileSync(
        path.join(tmpDir, "cmu.config.js"),
        `module.exports = { defaultNetwork: "local", networks: { local: ` +
          `{ url: "http://127.0.0.1:8585", chainId: 1912${fields} } } };`,
      );
    }

    async function printedBalance(): Promise<string> {
      mockEthers({
        getCode: async () => "0x",
        getBalance: async () => 10n ** 18n,
      });
      await run({ contract: ADDRESS, yes: true });
      const printed = vi.mocked(console.log).mock.calls.join("\n");
      return printed.split("\n").find((l) => l.startsWith("Balance")) ?? "";
    }

    it("uses the symbol set in cmu.config", async () => {
      writeLocalConfig(`, symbol: "CMU"`);

      expect(await printedBalance()).toBe(
        "Balance      : 1.0 CMU (1000000000000000000 wei)",
      );
    });

    it("falls back to ETH for a config without one", async () => {
      writeLocalConfig("");

      expect(await printedBalance()).toBe(
        "Balance      : 1.0 ETH (1000000000000000000 wei)",
      );
    });

    it("uses CMU for the built-in local devnet when there is no config", async () => {
      expect(await printedBalance()).toBe(
        "Balance      : 1.0 CMU (1000000000000000000 wei)",
      );
    });

    it("refuses an invalid symbol in cmu.config, naming the key", async () => {
      writeLocalConfig(`, symbol: "C-M"`);
      mockEthers({
        getNetwork: async () => {
          throw new Error("must not connect");
        },
      });

      await expect(run({ contract: ADDRESS, yes: true })).rejects.toThrow(
        /invalid symbol "C-M"[\s\S]*networks\.local\.symbol in cmu\.config\.js/,
      );
    });
  });
});
