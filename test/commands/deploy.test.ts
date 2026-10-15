import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { maskPrivateKey, pingNetwork } from "../../src/commands/deploy";

describe("maskPrivateKey", () => {
  it("shows the first 5 and last 4 chars of a normal-length key", () => {
    // well-known Ganache test key — never fund this
    const pk =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    expect(maskPrivateKey(pk)).toBe("0x59c...690d");
  });

  it("fully redacts a key too short to mask meaningfully", () => {
    expect(maskPrivateKey("0x1234")).toBe("***");
  });
});

describe("pingNetwork", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reports an unreachable endpoint when the provider outlasts NETWORK_TIMEOUT_MS", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          // Never settles, so pingNetwork's internal timeout must fire.
          getNetwork() {
            return new Promise(() => {});
          }
        },
      },
    }));

    await expect(pingNetwork("http://192.0.2.1:8545")).rejects.toThrow(
      /is unreachable/,
    );
  });

  it("reports the caller's network name, not ethers' 'unknown' for chain 1912", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getNetwork() {
            // What ethers actually returns for an unregistered chain.
            return Promise.resolve({ name: "unknown", chainId: 1912n });
          }
        },
      },
    }));

    await pingNetwork("http://127.0.0.1:8585", "local");

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Connected to 'local' (chain ID 1912).");
    expect(output).not.toContain("unknown");
  });

  it("falls back to the name ethers reports when the caller passes none", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getNetwork() {
            return Promise.resolve({ name: "sepolia", chainId: 11155111n });
          }
        },
      },
    }));

    await pingNetwork("http://127.0.0.1:8585");

    expect(log.mock.calls.flat().join("\n")).toContain(
      "Connected to 'sepolia'",
    );
  });

  it("rejects an empty url without waiting out the timeout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // cmu.config networks are rejected earlier, by getDeployNetwork(); what
    // reaches here is a saved network, so the hint must not name a config file.
    const error = await pingNetwork("", "staging").catch((e: Error) => e);
    expect((error as Error).message).toMatch(
      /^network 'staging' has no url\.\n.*`cmu network save <url> --name staging`/,
    );
    expect((error as Error).message).not.toMatch(/cmu\.config/);
    // Never announces a ping it did not attempt.
    expect(log).not.toHaveBeenCalled();
  });
});

// What a deploy run records, end to end through runDeploy(): the scripts are
// replaced by functions acting on a fake chain, the way a real script's
// transactions would land on the devnet.
describe("runDeploy deployment records", () => {
  // well-known Ganache test key — never fund this
  const KEY =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const DEPLOYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const OTHER = "0x00000000000000000000000000000000000000bb";
  const TOKEN_BYTECODE = "60aa01";

  let tmpDir: string;
  let chain: InstanceType<typeof import("../fakeChain").FakeChain>;
  let everything: string[];
  /** One function per deploy script, run in place of the child process. */
  let scripts: (() => void)[];
  const prevKey = process.env.PRIVATE_KEY;

  beforeEach(async () => {
    vi.resetModules();
    const { FakeChain } = await import("../fakeChain");
    chain = new FakeChain();
    everything = [];
    scripts = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-deploy-rec-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    fs.mkdirSync(path.join(tmpDir, "deploy"));
    fs.mkdirSync(path.join(tmpDir, "artifacts"));
    fs.writeFileSync(
      path.join(tmpDir, "artifacts", "Token.json"),
      JSON.stringify({
        abi: [],
        evm: { bytecode: { object: TOKEN_BYTECODE } },
      }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
        everything.push(a.map(String).join(" "));
      });
    }
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation((chunk: any) => {
        everything.push(String(chunk));
        return true;
      });
    }
    process.env.PRIVATE_KEY = KEY;

    vi.doMock("../../src/commands/compile", () => ({
      runCompile: async () => {},
    }));
    vi.doMock("../../src/utils/exec", () => ({
      run: async (_cmd: string, _args: string[], opts: { label: string }) => {
        const script = scripts.shift();
        if (!script) throw new Error(`${opts.label} exited with code 1`);
        script();
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
              return chain.provider();
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
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  function addScripts(...bodies: (() => void)[]) {
    bodies.forEach((body, i) => {
      fs.writeFileSync(path.join(tmpDir, "deploy", `0${i + 1}_x.js`), "");
      scripts.push(body);
    });
  }

  const record = () => path.join(tmpDir, "deployments", "local", "Token.json");

  /** Every file under dir, recursively. */
  function allFiles(dir: string): string[] {
    return fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name));
  }

  /**
   * The private key, with or without 0x, appears nowhere: not in anything
   * printed (console or raw stdout/stderr), and not in any file under tmpDir,
   * which is HOME and the project both.
   */
  function expectNoKeyLeak(): void {
    const haystacks = [
      everything.join("\n"),
      ...allFiles(tmpDir).map((file) => fs.readFileSync(file, "utf8")),
    ].map((text) => text.toLowerCase());
    for (const secret of [KEY.toLowerCase(), KEY.slice(2).toLowerCase()]) {
      for (const text of haystacks) {
        expect(text).not.toContain(secret);
      }
    }
  }

  it("records what a script deployed before a later script failed", async () => {
    let token = "";
    addScripts(() => {
      token = chain.create(DEPLOYER, `0x${TOKEN_BYTECODE}`);
    });
    // A second script file with no body behind it exits 1.
    fs.writeFileSync(path.join(tmpDir, "deploy", "02_fails.js"), "");
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).rejects.toThrow(
      "02_fails.js exited with code 1",
    );
    expect(JSON.parse(fs.readFileSync(record(), "utf8")).address).toBe(token);
  });

  it("warns and still succeeds when the record cannot be written", async () => {
    fs.mkdirSync(path.join(tmpDir, "deployments"));
    // A file where the network's directory should be.
    fs.writeFileSync(path.join(tmpDir, "deployments", "local"), "");
    addScripts(() => {
      chain.create(DEPLOYER, `0x${TOKEN_BYTECODE}`);
    });
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).resolves.toBeUndefined();
    expect(everything.join("\n")).toMatch(/warning:.* Token was not recorded:/);
    expect(everything.join("\n")).toContain("Token  0x");
  });

  it("records nothing for a contract deployed with another signer", async () => {
    addScripts(() => {
      chain.create(OTHER, `0x${TOKEN_BYTECODE}`);
    });
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "deployments"))).toBe(false);
    expect(everything.join("\n")).toContain(
      `No contract creations from ${DEPLOYER} detected.`,
    );
  });

  it("leaks the key nowhere on success or on a --verbose failure", async () => {
    addScripts(
      () => {
        chain.create(DEPLOYER, `0x${TOKEN_BYTECODE}`);
      },
      () => {
        chain.create(DEPLOYER, `0x${TOKEN_BYTECODE}`);
        throw new Error("02_x.js exited with code 1");
      },
    );
    const { runDeploy } = await import("../../src/commands/deploy");
    const { fail } = await import("../../src/utils/errors");
    vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    await runDeploy({ yes: true, verbose: true }).catch(
      fail("deploy", { verbose: true }),
    );

    expect(everything.join("\n")).toContain("deploy failed");
    expect(fs.existsSync(record())).toBe(true);
    expectNoKeyLeak();
  });

  // The check above only means something if it can fail: plant the key where
  // a leak would put it and make sure it is caught, in output and on disk.
  it("expectNoKeyLeak catches a planted key", () => {
    everything.push(`oops ${KEY.slice(2)}`);
    expect(() => expectNoKeyLeak()).toThrow();

    everything.length = 0;
    fs.mkdirSync(path.join(tmpDir, "deployments", "local"), {
      recursive: true,
    });
    fs.writeFileSync(record(), JSON.stringify({ deployer: KEY }));
    expect(() => expectNoKeyLeak()).toThrow();
  });
});
