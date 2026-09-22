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

  it("fully redacts a key shorter than MIN_KEY_LENGTH", () => {
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
});

// runDeploy() used to call process.exit() from inside its --ping and --config
// branches, so neither could be observed without stubbing the process. It now
// returns the code and the command handler does the exiting.

describe("runDeploy exit codes", () => {
  let tmpDir: string;
  const prevKey = process.env.PRIVATE_KEY;

  beforeEach(() => {
    // The pingNetwork suite above registers an ethers mock with no Wallet, and
    // vi.resetModules() clears the module cache but not the mock registry.
    vi.doUnmock("ethers");
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

  it("returns 0 from --config without running any deploy script", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "deploy", "01_deploy.js"),
      "throw new Error('this script must not run');",
    );
    mockCompile();
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ config: true, yes: true })).resolves.toBe(0);
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

    await expect(runDeploy({ config: true, yes: true })).resolves.toBe(0);
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

    await expect(runDeploy({ config: true, yes: true })).resolves.toBe(0);
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

  it("returns 0 from --ping when the endpoint answers", async () => {
    mockCompile();
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getNetwork = async () => ({ name: "cointmu", chainId: 1912n });
        },
      },
    }));
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ ping: true, yes: true })).resolves.toBe(0);
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

  it("returns 0 when there is nothing in deploy/ to run", async () => {
    mockCompile();
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).resolves.toBe(0);
  });
});
