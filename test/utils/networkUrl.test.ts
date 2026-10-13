import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { stripVTControlCharacters } from "util";

// Issue #186: the empty-url error always named cmu.config.ts, even when the
// project's config was cmu.config.js, and never named the network. These
// cover each config route, and that every command resolving its network
// through getDeployNetwork() reports the same message.

/** The dim `hint:` label every CLI hint carries (PR #109). */
const HINT_LABEL = "\x1b[2mhint:\x1b[0m";

type ConfigFile = "cmu.config.ts" | "cmu.config.js";

describe("getDeployNetwork config errors", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-net-url-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    // Silences the trust notice the commands print under --yes.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A config error must surface before any password prompt.
    vi.doMock("inquirer", () => ({
      default: {
        prompt: async () => {
          throw new Error("inquirer.prompt should not be called");
        },
      },
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(file: ConfigFile, defaultNetwork = "local"): void {
    if (file === "cmu.config.ts") {
      fs.mkdirSync(path.join(tmpDir, "node_modules"));
      fs.symlinkSync(
        path.resolve(__dirname, "../../node_modules/typescript"),
        path.join(tmpDir, "node_modules", "typescript"),
        "dir",
      );
    }
    const exporter =
      file === "cmu.config.ts" ? "export default" : "module.exports =";
    fs.writeFileSync(
      path.join(tmpDir, file),
      `${exporter} { defaultNetwork: "${defaultNetwork}", networks: { ` +
        `local: { url: "http://127.0.0.1:8585", chainId: 1912 }, ` +
        `mainnet: { url: "", chainId: 1912 }, ` +
        `staging: { url: "", chainId: 1912 } } };`,
    );
  }

  async function deployNetworkError(target?: string): Promise<Error> {
    const { getDeployNetwork } = await import("../../src/utils/network");
    return getDeployNetwork(target).catch((e: Error) => e) as Promise<Error>;
  }

  it.each<ConfigFile>(["cmu.config.ts", "cmu.config.js"])(
    "names the network and the loaded %s",
    async (file) => {
      writeConfig(file);

      const error = await deployNetworkError("mainnet");

      expect(stripVTControlCharacters(error.message)).toBe(
        "network 'mainnet' has no url.\n" +
          `hint: set networks.mainnet.url in ${file}.`,
      );
    },
  );

  it("names the network picked by defaultNetwork, not a fixed one", async () => {
    writeConfig("cmu.config.js", "staging");

    const error = await deployNetworkError();

    expect(stripVTControlCharacters(error.message)).toBe(
      "network 'staging' has no url.\n" +
        "hint: set networks.staging.url in cmu.config.js.",
    );
  });

  it("carries no escape code beyond the standard hint label", async () => {
    writeConfig("cmu.config.js");

    const error = await deployNetworkError("mainnet");

    expect(error.message.replace(HINT_LABEL, "hint:")).not.toContain("\x1b");
  });

  it("names the loaded config for a network it does not define", async () => {
    writeConfig("cmu.config.js");

    const error = await deployNetworkError("nope");

    expect(error.message).toMatch(
      /^network 'nope' is not defined in cmu\.config\.js\./,
    );
  });

  it("names both config files when neither exists", async () => {
    const error = await deployNetworkError("mainnet");

    expect(error.message).toMatch(
      /^network 'mainnet' was requested, but no cmu\.config\.ts or cmu\.config\.js was found\./,
    );
  });

  // `deploy --config` used to print the blank endpoint; it now fails with the
  // same error, before compiling's result is used or a key is resolved.
  it("reports the same message from every command that resolves through it", async () => {
    writeConfig("cmu.config.js");
    fs.mkdirSync(path.join(tmpDir, "deploy"));
    vi.doMock("../../src/commands/compile", () => ({
      runCompile: async () => {},
    }));
    const expected = (await deployNetworkError("mainnet")).message;

    const { runDeploy } = await import("../../src/commands/deploy");
    const { runExplorer } = await import("../../src/commands/explorer");
    const { runConsole } = await import("../../src/commands/console");
    const opts = { network: "mainnet", yes: true };
    const runs = [
      () => runDeploy({ ...opts, ping: true }),
      () => runDeploy({ ...opts, config: true }),
      () => runExplorer({ ...opts, block: "0" }),
      () => runConsole({ ...opts, signer: false }),
    ];
    const messages: string[] = [];
    for (const run of runs) {
      messages.push(
        await run().then(
          () => "resolved",
          (e: Error) => e.message,
        ),
      );
    }

    expect(messages).toEqual(Array(messages.length).fill(expected));
  });
});
