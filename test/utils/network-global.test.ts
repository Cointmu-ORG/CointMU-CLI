import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { stripVTControlCharacters } from "util";
import {
  linkRepoTypescript,
  removeFixtureProject,
} from "../helpers/fixtureTypescript";

// A folder without cmu.config resolves `-n <name>` from ~/.cmu-networks.json.
// A folder with one reads only that file, exactly as before: the override is
// per file, never per network.

const STAGING_URL = "http://127.0.0.1:8586";

describe("getDeployNetwork without a project config", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-net-global-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    // ~/.cmu-networks.json and ~/.cmu-session live in tmpDir, never the real home.
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.stubEnv("PRIVATE_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    removeFixtureProject(tmpDir);
  });

  function writeNetworks(entries: object[]): void {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify(entries),
    );
  }

  async function resolve(target?: string) {
    const { getDeployNetwork } = await import("../../src/utils/network");
    return getDeployNetwork(target, { noPrompt: true });
  }

  async function errorOf(target?: string): Promise<string> {
    const error = await resolve(target).then(
      () => new Error("resolved"),
      (e: Error) => e,
    );
    return stripVTControlCharacters(error.message);
  }

  it("resolves -n from ~/.cmu-networks.json, with no configured chain ID", async () => {
    writeNetworks([{ name: "staging", rpcUrl: STAGING_URL, symbol: "tCMU" }]);

    await expect(resolve("staging")).resolves.toEqual({
      name: "staging",
      url: STAGING_URL,
      chainId: undefined,
      symbol: "tCMU",
      privateKey: undefined,
    });
  });

  it("labels a saved network without a symbol ETH, as `network list` does", async () => {
    writeNetworks([{ name: "staging", rpcUrl: STAGING_URL }]);

    await expect(resolve("staging")).resolves.toMatchObject({
      symbol: "ETH",
    });
  });

  it("names ~/.cmu-networks.json for a network it does not hold", async () => {
    writeNetworks([{ name: "staging", rpcUrl: STAGING_URL }]);

    expect(await errorOf("nope")).toBe(
      "network 'nope' is not saved in ~/.cmu-networks.json, and this folder has no cmu.config.ts or cmu.config.js.\n" +
        "hint: list saved networks with `cmu network list`, save it with `cmu network save <url> --name nope`, or define it in a cmu.config.js here.",
    );
  });

  it("names ~/.cmu-networks.json for a saved network with no url", async () => {
    writeNetworks([{ name: "staging", rpcUrl: "" }]);

    expect(await errorOf("staging")).toBe(
      "network 'staging' in ~/.cmu-networks.json has no url.\n" +
        "hint: re-save it with `cmu network save <url> --name staging`.",
    );
  });

  it("rejects a hand-edited invalid symbol before any key is resolved", async () => {
    writeNetworks([{ name: "staging", rpcUrl: STAGING_URL, symbol: "$(x)" }]);

    expect(await errorOf("staging")).toMatch(
      /^network 'staging' has an invalid symbol "\$\(x\)" in ~\/\.cmu-networks\.json/,
    );
  });

  it("reports an unparseable ~/.cmu-networks.json without echoing it", async () => {
    const secret = "https://user:hunter2@rpc.example.com";
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      `[{"name":"staging","rpcUrl":"${secret}"`,
    );

    const message = await errorOf("staging");

    expect(message).toBe(
      "could not read ~/.cmu-networks.json: it is not valid JSON.\n" +
        "hint: fix it by hand, or remove it to start over with only the local network.",
    );
    expect(message).not.toContain("hunter2");
  });

  // Deploying anywhere but the devnet always takes an explicit -n, whatever
  // the session has selected with `cmu network use`.
  it("stays on the local devnet without -n, even when the session selects another network", async () => {
    writeNetworks([{ name: "staging", rpcUrl: STAGING_URL }]);
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({ address: "0xTest", activeNetwork: "staging" }),
    );

    expect(await resolve()).toEqual({
      name: "local",
      url: "http://127.0.0.1:8585",
      chainId: 1912,
      symbol: "CMU",
      privateKey: undefined,
    });
  });

  it("keeps -n local on the built-in devnet, not a saved 'local' entry", async () => {
    writeNetworks([{ name: "local", rpcUrl: STAGING_URL }]);

    expect((await resolve("local")).url).toBe("http://127.0.0.1:8585");
  });
});

describe("getDeployNetwork with a project config (unchanged)", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-net-project-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.stubEnv("PRIVATE_KEY", "");
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([{ name: "staging", rpcUrl: STAGING_URL }]),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    removeFixtureProject(tmpDir);
  });

  function writeConfig(file: "cmu.config.ts" | "cmu.config.js"): void {
    if (file === "cmu.config.ts") linkRepoTypescript(tmpDir);
    const exporter =
      file === "cmu.config.ts" ? "export default" : "module.exports =";
    fs.writeFileSync(
      path.join(tmpDir, file),
      `${exporter} { defaultNetwork: "local", networks: { ` +
        `local: { url: "http://127.0.0.1:8585", chainId: 1912 } } };`,
    );
  }

  async function errorOf(target: string): Promise<string> {
    const { getDeployNetwork } = await import("../../src/utils/network");
    const error = await getDeployNetwork(target, { noPrompt: true }).then(
      () => new Error("resolved"),
      (e: Error) => e,
    );
    return stripVTControlCharacters(error.message);
  }

  it.each(["cmu.config.ts", "cmu.config.js"] as const)(
    "never falls back to ~/.cmu-networks.json from a %s",
    async (file) => {
      writeConfig(file);

      expect(await errorOf("staging")).toBe(
        `network 'staging' is not defined in ${file}.\n` +
          "hint: add it under `networks`, or pick one that is already defined.",
      );
    },
  );

  // A config file that exports nothing was treated as no config at all; the
  // same request keeps the same message rather than reaching the global file.
  it("keeps the old message for a config that exports nothing", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      "module.exports = null;",
    );

    expect(await errorOf("staging")).toBe(
      "network 'staging' was requested, but no cmu.config.ts or cmu.config.js was found.\n" +
        "hint: run this from a CointMU project, or drop -n to deploy to the local network.",
    );
  });
});

describe("describeConfigSource", () => {
  it("names the global networks file when there is no project config", async () => {
    const { describeConfigSource } =
      await import("../../src/utils/deployTarget");

    expect(describeConfigSource(null)).toBe("~/.cmu-networks.json");
  });

  it("names the project config by its file name only", async () => {
    const { describeConfigSource } =
      await import("../../src/utils/deployTarget");
    const configPath = path.join(os.tmpdir(), "project", "cmu.config.js");

    expect(describeConfigSource(configPath)).toBe("./cmu.config.js");
  });
});
