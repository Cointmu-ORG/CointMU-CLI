import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

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
