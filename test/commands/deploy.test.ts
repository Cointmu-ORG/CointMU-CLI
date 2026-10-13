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

  it("rejects an empty url as a config error without waiting out the timeout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(pingNetwork("")).rejects.toThrow(
      /has no url[\s\S]*cmu\.config\.ts/,
    );
    // Never announces a ping it did not attempt.
    expect(log).not.toHaveBeenCalled();
  });
});

// runDeploy() used to call process.exit() from inside its --ping and --config
// branches, so neither could be observed without stubbing the process. It now
// resolves, and the command handler does the exiting.

describe("runDeploy exits", () => {
  let tmpDir: string;
  const prevKey = process.env.PRIVATE_KEY;

  beforeEach(() => {
    // The pingNetwork suite above registers an ethers mock with no Wallet, and
    // vi.resetModules() clears the module cache but not the mock registry.
    vi.doUnmock("ethers");
    // The import at the top of this file already loaded deploy.ts with the
    // real compile module bound to it. Without this, mockCompile() only works
    // when a suite above happened to reset modules first.
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-deploy-"));
    fs.mkdirSync(path.join(tmpDir, "deploy"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.PRIVATE_KEY =
      // well-known Ganache test key — never fund this
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  /** Stubs out compiling, which is not what these are about. */
  function mockCompile() {
    vi.doMock("../../src/commands/compile", () => ({
      runCompile: async () => {},
    }));
  }

  it("finishes --config without running any deploy script", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "deploy", "01_deploy.js"),
      "throw new Error('this script must not run');",
    );
    mockCompile();
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(
      runDeploy({ config: true, yes: true }),
    ).resolves.toBeUndefined();
  });

  // A locked .cmu-session resolves to no key at all under --config, which used
  // to be fatal. --config never signs, so it now reports the gap as a field.
  it("prints the config with no deployer when no key is reachable", async () => {
    delete process.env.PRIVATE_KEY;
    mockCompile();
    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => {
      logged.push(a.join(" "));
    });
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(
      runDeploy({ config: true, yes: true }),
    ).resolves.toBeUndefined();
    expect(logged).toContain("Deployer     : unavailable (no key)");
    expect(logged).toContain("Private key  : unavailable (no key)");
  });

  it("still prints the deployer under --config when a key is reachable", async () => {
    mockCompile();
    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => {
      logged.push(a.join(" "));
    });
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(
      runDeploy({ config: true, yes: true }),
    ).resolves.toBeUndefined();
    expect(logged).toContain(
      "Deployer     : 0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    expect(logged.some((l) => l.startsWith("Private key  : 0x59c"))).toBe(true);
  });

  // The relaxation above is scoped to --config: a real deploy has to sign, so
  // a missing key must still stop it before anything is broadcast.
  it("still refuses a real deploy with no key", async () => {
    delete process.env.PRIVATE_KEY;
    fs.writeFileSync(
      path.join(tmpDir, "deploy", "01_deploy.js"),
      "throw new Error('this script must not run');",
    );
    mockCompile();
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).rejects.toThrow(
      /no private key available for signing/,
    );
  });

  it("finishes --ping when the endpoint answers", async () => {
    mockCompile();
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getNetwork = async () => ({ name: "cointmu", chainId: 1912n });
        },
      },
    }));
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ ping: true, yes: true })).resolves.toBeUndefined();
  });

  it("throws rather than exiting when the deploy directory is missing", async () => {
    fs.rmSync(path.join(tmpDir, "deploy"), { recursive: true });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as any);
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).rejects.toThrow(
      /deploy\/ directory not found/,
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it("finishes when there is nothing in deploy/ to run", async () => {
    mockCompile();
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).resolves.toBeUndefined();
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
