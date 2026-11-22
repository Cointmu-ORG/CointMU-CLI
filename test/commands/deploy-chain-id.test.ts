import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { stripVTControlCharacters } from "util";

// ~/.cmu-networks.json stores no chain ID, so `cmu deploy -n <saved>` reads it
// from the node before any deploy script runs. CMU_CHAIN_ID must never reach a
// script as "undefined".

// well-known Ganache test key — never fund this
const KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const DEPLOYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TOKEN_BYTECODE = "60aa01";
const STAGING_URL = "http://127.0.0.1:8586";

describe("runDeploy chain ID", () => {
  let tmpDir: string;
  let chain: InstanceType<typeof import("../fakeChain").FakeChain>;
  let logged: string[];
  /** The env each deploy script was started with, in order. */
  let scriptEnvs: Record<string, string | undefined>[];
  /** Provider calls made before the first script started. */
  let callsBeforeScript: string[] | undefined;
  /** Replaces the fake chain's getNetwork() when set. */
  let getNetwork: (() => Promise<unknown>) | undefined;

  beforeEach(async () => {
    vi.resetModules();
    const { FakeChain } = await import("../fakeChain");
    chain = new FakeChain();
    logged = [];
    scriptEnvs = [];
    callsBeforeScript = undefined;
    getNetwork = undefined;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-deploy-chain-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.stubEnv("PRIVATE_KEY", KEY);
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
        logged.push(stripVTControlCharacters(a.map(String).join(" ")));
      });
    }
    fs.mkdirSync(path.join(tmpDir, "deploy"));
    fs.writeFileSync(path.join(tmpDir, "deploy", "01_token.js"), "");
    fs.mkdirSync(path.join(tmpDir, "artifacts"));
    fs.writeFileSync(
      path.join(tmpDir, "artifacts", "Token.json"),
      JSON.stringify({
        abi: [],
        evm: { bytecode: { object: TOKEN_BYTECODE } },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([{ name: "staging", rpcUrl: STAGING_URL }]),
    );

    vi.doMock("../../src/commands/compile", () => ({
      runCompile: async () => {},
    }));
    vi.doMock("../../src/utils/exec", () => ({
      run: async (_cmd: string, _args: string[], opts: { env: any }) => {
        callsBeforeScript ??= [...chain.calls];
        scriptEnvs.push(opts.env);
        chain.create(DEPLOYER, `0x${TOKEN_BYTECODE}`);
      },
    }));
    vi.doMock("ethers", async (importOriginal) => {
      const real: any = await importOriginal();
      return {
        ...real,
        ethers: {
          ...real.ethers,
          JsonRpcProvider: class {
            constructor() {
              const provider = chain.provider();
              if (getNetwork) provider.getNetwork = getNetwork;
              return provider;
            }
          },
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("ethers");
    vi.doUnmock("../../src/utils/exec");
    vi.doUnmock("../../src/commands/compile");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runDeploy(options: Record<string, unknown>) {
    const deploy = await import("../../src/commands/deploy");
    return deploy.runDeploy({ yes: true, ...options });
  }

  async function failureOf(options: Record<string, unknown>): Promise<string> {
    const error = await runDeploy(options).then(
      () => new Error("resolved"),
      (e: Error) => e,
    );
    return stripVTControlCharacters(error.message);
  }

  function writeConfig(network: string): void {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      `module.exports = { networks: { ${network} } };`,
    );
  }

  it("reads a saved network's chain ID from the node before the first script", async () => {
    await runDeploy({ network: "staging" });

    expect(scriptEnvs).toHaveLength(1);
    expect(scriptEnvs[0].CMU_CHAIN_ID).toBe("1912");
    expect(scriptEnvs[0].CMU_RPC_URL).toBe(STAGING_URL);
    expect(callsBeforeScript).toContain("getNetwork");
    expect(logged).toContain("Chain ID     : 1912");
    expect(
      fs.existsSync(path.join(tmpDir, "deployments", "staging", "Token.json")),
    ).toBe(true);
  });

  it("stops before any script when the node cannot be reached, with the url masked", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([
        { name: "staging", rpcUrl: "http://u:hunter2@127.0.0.1:8586/?key=abc" },
      ]),
    );
    getNetwork = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    const message = await failureOf({ network: "staging" });

    expect(message).toContain("http://u:***@127.0.0.1:8586/?key=***");
    expect(message).toMatch(/is unreachable/);
    expect([message, ...logged].join("\n")).not.toContain("hunter2");
    expect(scriptEnvs).toEqual([]);
  });

  it("stops before any script when the node reports no usable chain ID", async () => {
    getNetwork = async () => ({ name: "unknown", chainId: undefined });

    const message = await failureOf({ network: "staging" });

    expect(message).toBe(
      `RPC endpoint ${STAGING_URL} did not report a usable chain ID.\n` +
        "hint: check that it is an Ethereum JSON-RPC endpoint - `cmu network list`.",
    );
    expect(scriptEnvs).toEqual([]);
  });

  it("exits non-zero when the chain ID cannot be read", async () => {
    getNetwork = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as any);
    const { fail } = await import("../../src/utils/errors");

    await runDeploy({ network: "staging" }).catch(fail("deploy"));

    expect(exit).toHaveBeenCalledWith(1);
  });

  // --config never signs and never dials: a saved network's chain ID is
  // simply not known yet, and the banner says so instead of "undefined".
  it("prints an unknown chain ID under --config without dialing the node", async () => {
    await runDeploy({ network: "staging", config: true });

    expect(logged).toContain(
      "Chain ID     : not configured (read from the node when deploying)",
    );
    expect(chain.calls).not.toContain("getNetwork");
  });

  // Regression: a cmu.config chain ID is used as configured, with no extra
  // ping and no change to what is printed.
  it("keeps a configured chain ID and prints no extra ping", async () => {
    writeConfig(`local: { url: "http://127.0.0.1:8585", chainId: 4242 }`);

    await runDeploy({});

    expect(scriptEnvs[0].CMU_CHAIN_ID).toBe("4242");
    expect(logged).toContain("Chain ID     : 4242");
    expect(logged.some((line) => line.startsWith("Pinging"))).toBe(false);
  });

  it("reads the chain ID from the node for a config network that sets none", async () => {
    writeConfig(`local: { url: "http://127.0.0.1:8585" }`);

    await runDeploy({});

    expect(scriptEnvs[0].CMU_CHAIN_ID).toBe("1912");
  });
});
