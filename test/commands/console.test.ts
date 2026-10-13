import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { encryptSessionKey } from "../../src/utils/session";
import { consoleCommand } from "../../src/commands/console";

// The REPL loop itself (repl.start, the preloaded context, the exit handler)
// is not covered here: driving it needs a real stdin and would leave vitest
// holding the handle, the same reason create.ts's inquirer flow is untested.
// Everything that can actually be wrong - artifact loading and the
// network/signer resolution - is reachable without opening a REPL.

// well-known Ganache test key — never fund this
const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SESSION_PASSWORD = "correct horse";
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

const ABI = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

/** Every file under dir, recursively. */
function allFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The signer's key, with or without 0x, is nowhere in texts (what was printed,
 * errors thrown) or in any file under dir (HOME and the project).
 */
function expectNoKeyLeak(texts: string[], dir: string): void {
  const haystacks = [
    texts.join("\n"),
    ...allFiles(dir).map((f) => fs.readFileSync(f, "utf8")),
  ].map((t) => t.toLowerCase());
  for (const secret of [PRIVATE_KEY, PRIVATE_KEY.slice(2)]) {
    for (const text of haystacks) {
      expect(text).not.toContain(secret.toLowerCase());
    }
  }
}

describe("getContract", () => {
  let tmpDir: string;
  // A dead endpoint: building a provider, a wallet or a contract dials
  // nothing, and no test here calls one.
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:59999");
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-console-"));
    fs.mkdirSync(path.join(tmpDir, "artifacts"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeArtifact(name: string, body: unknown): void {
    fs.writeFileSync(
      path.join(tmpDir, "artifacts", `${name}.json`),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  }

  async function loadGetContract(ctx: { provider: any; signer?: any }) {
    const { makeGetContract } = await import("../../src/commands/console");
    return makeGetContract(ctx);
  }

  it("attaches the compiled ABI to the given address, connected to the signer", async () => {
    writeArtifact("Token", { abi: ABI, evm: { bytecode: { object: "0x60" } } });

    const getContract = await loadGetContract({ provider, signer });
    const token = getContract("Token", ADDRESS);

    expect(token.target).toBe(ADDRESS);
    expect(token.runner).toBe(signer);
    expect(token.interface.getFunction("totalSupply")).toBeTruthy();
  });

  it("falls back to the provider when the console has no signer", async () => {
    writeArtifact("Token", { abi: ABI });

    const getContract = await loadGetContract({ provider });
    const token = getContract("Token", ADDRESS);

    expect(token.runner).toBe(provider);
  });

  it("points at `cmu compile` when the artifact is missing", async () => {
    const getContract = await loadGetContract({ provider });

    expect(() => getContract("Ghost", ADDRESS)).toThrow(/cmu compile/);
  });

  it("reports an artifact with no abi, and one that is not JSON at all", async () => {
    writeArtifact("NoAbi", { evm: { bytecode: { object: "0x60" } } });
    writeArtifact("Broken", "{ not json");

    const getContract = await loadGetContract({ provider });

    expect(() => getContract("NoAbi", ADDRESS)).toThrow(/no abi/);
    expect(() => getContract("Broken", ADDRESS)).toThrow(/no abi/);
  });

  it("requires an explicit address", async () => {
    writeArtifact("Token", { abi: ABI });

    const getContract = await loadGetContract({ provider });

    expect(() => (getContract as any)("Token")).toThrow(/requires an address/);
    // The hint names the whole fix: the recorded path, and the explicit one.
    expect(() => (getContract as any)("Token")).toThrow(
      'await getDeployed("Name")',
    );
  });

  it("rejects a name-shaped address instead of resolving it as ENS", async () => {
    writeArtifact("Token", { abi: ABI });

    const getContract = await loadGetContract({ provider });

    expect(() => getContract("Token", "Token")).toThrow(
      /not a valid contract address/,
    );
  });
});

describe("resolveConsoleContext", () => {
  let tmpDir: string;
  let out: string[];
  const prevKey = process.env.PRIVATE_KEY;
  const realIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    // trust.ts remembers a confirmation per process; a fresh module per test
    // keeps one test's --yes from skipping the next test's prompt.
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-console-ctx-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    });
    delete process.env.PRIVATE_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("inquirer");
    vi.doUnmock("crypto");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.stdin.isTTY = realIsTTY;
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  function writeConfig(prelude = ""): void {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      `${prelude}module.exports = { defaultNetwork: "local", ` +
        `networks: { local: { url: "http://127.0.0.1:8585", chainId: 1912 } } };`,
    );
  }

  function writeSessionFile(): void {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({
        address: "0xTest",
        activeNetwork: "local",
        ...encryptSessionKey(SESSION_PASSWORD, PRIVATE_KEY),
      }),
    );
  }

  async function resolve(options = {}) {
    const { resolveConsoleContext } =
      await import("../../src/commands/console");
    return resolveConsoleContext(options);
  }

  it("starts read-only when no key is available anywhere", async () => {
    const ctx = await resolve();

    expect(ctx.signer).toBeUndefined();
    expect(ctx.network.name).toBe("local");
    expect(ctx.network.url).toBe("http://127.0.0.1:8585");
    ctx.provider.destroy();
  });

  it("connects a signer from the PRIVATE_KEY env var", async () => {
    process.env.PRIVATE_KEY = PRIVATE_KEY;

    const ctx = await resolve();

    expect(ctx.signer?.address).toBe(new ethers.Wallet(PRIVATE_KEY).address);
    expect(ctx.signer?.provider).toBe(ctx.provider);
    ctx.provider.destroy();
  });

  it("skips the session password prompt with --no-signer", async () => {
    writeSessionFile();
    vi.doMock("inquirer", () => ({
      default: {
        prompt: async () => {
          throw new Error("inquirer.prompt should not be called");
        },
      },
    }));

    // Resolving (instead of throwing from the mocked prompt) proves no prompt.
    const ctx = await resolve({ signer: false });

    expect(ctx.signer).toBeUndefined();
    ctx.provider.destroy();
  });

  // The prompt is only one of the ways a key gets in. --no-signer promises a
  // read-only console, so a key already sitting in the environment (or in
  // wallet.privateKey) must not be turned into a signer either.
  it("stays read-only with --no-signer when PRIVATE_KEY is set", async () => {
    process.env.PRIVATE_KEY = PRIVATE_KEY;

    const ctx = await resolve({ signer: false });

    expect(ctx.signer).toBeUndefined();
    ctx.provider.destroy();
  });

  it("stays read-only with --no-signer when the config carries a key", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      `module.exports = { defaultNetwork: "local", ` +
        `wallet: { privateKey: ${JSON.stringify(PRIVATE_KEY)} }, ` +
        `networks: { local: { url: "http://127.0.0.1:8585", chainId: 1912 } } };`,
    );

    const ctx = await resolve({ signer: false, yes: true });

    expect(ctx.signer).toBeUndefined();
    ctx.provider.destroy();
  });

  it("refuses to start on a key it cannot use", async () => {
    process.env.PRIVATE_KEY = "0xnotakey";

    await expect(resolve()).rejects.toThrow(/invalid private key/);
  });

  // cmu.config.js is require()d to resolve the network, i.e. arbitrary code
  // execution from the project directory. It must not run before the user has
  // confirmed, exactly as in `cmu compile`.
  it("blocks in a non-TTY session and never loads the config", async () => {
    const marker = path.join(tmpDir, "executed.txt");
    writeConfig(
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    process.stdin.isTTY = false;

    await expect(resolve()).rejects.toThrow(/non-interactive session/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("fails before the REPL on a network the config does not define", async () => {
    writeConfig();

    await expect(resolve({ network: "mars", yes: true })).rejects.toThrow(
      /is not defined/,
    );
  });

  // Issue #185: --no-signer decrypts nothing, so its trust prompt must not
  // claim a key decrypted from the session; without the flag it still must.
  it("prints the read-only trust wording with --no-signer", async () => {
    writeConfig();
    process.env.PRIVATE_KEY = PRIVATE_KEY;

    const ctx = await resolve({ signer: false, yes: true });
    ctx.provider.destroy();

    const prompt = out.join("\n");
    expect(prompt).toContain("does not unlock your session");
    expect(prompt).not.toContain("decrypted from");
    expectNoKeyLeak(out, tmpDir);
  });

  it("keeps the key-decryption trust wording without --no-signer", async () => {
    writeConfig();
    process.env.PRIVATE_KEY = PRIVATE_KEY;

    const ctx = await resolve({ yes: true });
    ctx.provider.destroy();

    expect(out.join("\n")).toContain("decrypted from\n    your session");
    expectNoKeyLeak(out, tmpDir);
  });

  /** Passes node's crypto through, counting the calls a decryption makes. */
  function spyOnDecryption() {
    const spies = { pbkdf2Sync: vi.fn(), createDecipheriv: vi.fn() };
    vi.doMock("crypto", async (importOriginal) => {
      const real = await importOriginal<typeof import("crypto")>();
      const wrapped = {
        ...real,
        pbkdf2Sync: spies.pbkdf2Sync.mockImplementation(real.pbkdf2Sync),
        createDecipheriv: spies.createDecipheriv.mockImplementation(
          real.createDecipheriv,
        ),
      };
      return { ...wrapped, default: wrapped };
    });
    return spies;
  }

  function mockPassword(answer: () => Promise<{ password: string }>): void {
    vi.doMock("inquirer", () => ({ default: { prompt: answer } }));
  }

  it("never decrypts a locked session with --no-signer", async () => {
    writeConfig();
    writeSessionFile();
    const spies = spyOnDecryption();
    mockPassword(async () => {
      throw new Error("inquirer.prompt should not be called");
    });

    const ctx = await resolve({ signer: false, yes: true });
    ctx.provider.destroy();

    expect(ctx.signer).toBeUndefined();
    expect(spies.pbkdf2Sync).not.toHaveBeenCalled();
    expect(spies.createDecipheriv).not.toHaveBeenCalled();
    expectNoKeyLeak(out, tmpDir);
  });

  // The control for the test above: the same spies do see a decryption when
  // the flag is absent, so their silence there means something.
  it("decrypts the session, seen by the same spies, without --no-signer", async () => {
    writeConfig();
    writeSessionFile();
    const spies = spyOnDecryption();
    mockPassword(async () => ({ password: SESSION_PASSWORD }));

    const ctx = await resolve({ yes: true });
    ctx.provider.destroy();

    expect(ctx.signer?.address).toBe(new ethers.Wallet(PRIVATE_KEY).address);
    expect(spies.createDecipheriv).toHaveBeenCalledTimes(1);
  });
});

describe("signerLabel", () => {
  async function label(signer: { address: string } | undefined, options = {}) {
    const { signerLabel } = await import("../../src/commands/console");
    return signerLabel(signer, options);
  }

  it("prints the signer's address when there is one", async () => {
    expect(await label({ address: ADDRESS })).toBe(ADDRESS);
  });

  it("names the flag, with no key hint, when --no-signer left it out", async () => {
    expect(await label(undefined, { signer: false })).toBe(
      "none (--no-signer)",
    );
  });

  it("says how to add a key when none was found", async () => {
    expect(await label(undefined)).toBe(
      "none (no key) - run `cmu wallet use <name>`, or set PRIVATE_KEY in .env or cmu.config.ts",
    );
  });
});

describe("consoleCommand", () => {
  it("offers the read-only escape hatch alongside --network", () => {
    const flags = consoleCommand.options.map((option) => option.flags);

    expect(consoleCommand.name()).toBe("console");
    expect(flags).toContain("-n, --network <name>");
    expect(flags).toContain("--no-signer");
    expect(flags).toContain("-y, --yes");
  });
});

// getDeployed(name) resolves the address from deployments/<network>/ and
// checks the record against the chain first. The provider is a fake object:
// only getNetwork and getCode are ever asked.
describe("getDeployed", () => {
  const TOKEN = "0x00000000000000000000000000000000000000c1";
  /** Runtime code as it sits on-chain, and as the artifact has it. */
  const RUNTIME = "0x6080604052348015600f57600080fd5b50";
  /** With a 32-byte immutable at byte 2: zero in the artifact, set on-chain. */
  const RUNTIME_IMM_ARTIFACT = `0x6080${"00".repeat(32)}5b`;
  const RUNTIME_IMM_CHAIN = `0x6080${"ab".repeat(32)}5b`;

  let tmpDir: string;
  let out: string[];
  let code: string;
  let liveChainId: bigint;
  const provider = {
    getNetwork: async () => ({ chainId: liveChainId }),
    getCode: vi.fn(async () => code),
  };
  const signer = new ethers.Wallet(PRIVATE_KEY);

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-getdeployed-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    out = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
        out.push(a.map(String).join(" "));
      });
    }
    code = RUNTIME;
    liveChainId = 1912n;
    provider.getCode.mockClear();
    writeArtifact("Token", RUNTIME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeArtifact(
    name: string,
    runtime: string | undefined,
    immutableReferences: unknown = {},
  ): void {
    fs.mkdirSync(path.join(tmpDir, "artifacts"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "artifacts", `${name}.json`),
      JSON.stringify({
        abi: ABI,
        evm: {
          bytecode: { object: "60aa" },
          ...(runtime && {
            deployedBytecode: { object: runtime, immutableReferences },
          }),
        },
      }),
    );
  }

  function writeRecord(
    network: string,
    overrides: Record<string, unknown> = {},
    name = "Token",
  ): string {
    const dir = path.join(tmpDir, "deployments", network);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        format: 1,
        contract: name,
        network,
        chainId: 1912,
        address: TOKEN,
        deployer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        txHash: `0x${"11".repeat(32)}`,
        blockNumber: 3,
        timestamp: "2026-10-13T08:00:00.000Z",
        codeHash: ethers.keccak256(code),
        ...overrides,
      }),
    );
    return file;
  }

  async function load(network = "local") {
    const { makeGetDeployed } = await import("../../src/commands/console");
    return makeGetDeployed({ provider, signer, network });
  }

  it("resolves the recorded contract and says where the address came from", async () => {
    writeRecord("local");
    const getDeployed = await load();

    const token: any = await getDeployed("Token");

    expect(token.target).toBe(TOKEN);
    expect(token.runner).toBe(signer);
    expect(token.interface.getFunction("totalSupply")).toBeTruthy();
    expect(out).toContain(
      `getDeployed: Token -> ${TOKEN} on 'local' (chain 1912), recorded 2026-10-13T08:00:00.000Z from ${path.join("deployments", "local", "Token.json")}`,
    );
  });

  it("finds nothing on a second network that shares the chainId", async () => {
    // local and kampus are both chain 1912; the record is keyed by name.
    writeRecord("kampus");

    await expect((await load("local"))("Token")).rejects.toThrow(
      "no deployment record for 'Token' on 'local'",
    );
    await expect((await load("kampus"))("Token")).resolves.toBeDefined();
  });

  it("refuses a record for another chain", async () => {
    writeRecord("local", { chainId: 31337 });

    await expect((await load())("Token")).rejects.toThrow(
      "the record for Token on 'local' is for chain 31337, but 'local' is chain 1912.",
    );
  });

  it("refuses a stale record with no code behind it", async () => {
    writeRecord("local");
    code = "0x";

    await expect((await load())("Token")).rejects.toThrow(
      `the record for Token on 'local' is stale: there is no contract at ${TOKEN} (was the devnet restarted?).`,
    );
  });

  it("refuses a stale record whose address now holds other code", async () => {
    writeRecord("local");
    code = "0x6001";

    await expect((await load())("Token")).rejects.toThrow(
      `the record for Token on 'local' is stale: the code at ${TOKEN} is not the code that was recorded.`,
    );
  });

  // The record's own codeHash is whatever its author wrote, so a record
  // pointing at someone else's contract passes the staleness checks; only
  // the local artifact can catch it.
  it("refuses code that is not what the artifact compiles to, without suggesting a way around it", async () => {
    code = "0x60806040deadbeef";
    writeRecord("local");

    const error = await (
      await load()
    )("Token").then(
      () => undefined,
      (e: Error) => e,
    );

    expect(error?.message).toBe(
      `Token at ${TOKEN}: the compiled artifact no longer matches the deployed code (did the source change since the last deploy?).\n` +
        "\x1b[2mhint:\x1b[0m run `cmu deploy` again.",
    );
    expect(error?.message).not.toMatch(/getContract|explicit|address\)/);
  });

  it("masks immutables, and only as solc emits them", async () => {
    code = RUNTIME_IMM_CHAIN;
    writeRecord("local");
    writeArtifact("Token", RUNTIME_IMM_ARTIFACT, {
      "7": [{ start: 2, length: 32 }],
    });
    await expect((await load())("Token")).resolves.toBeDefined();

    // Without the mask the immutable's value is a mismatch...
    writeArtifact("Token", RUNTIME_IMM_ARTIFACT, {});
    await expect((await load())("Token")).rejects.toThrow(
      /no longer matches the deployed code/,
    );
    // ...and a range that is not a zeroed 32-byte slot cannot excuse one.
    writeArtifact("Token", RUNTIME_IMM_ARTIFACT, {
      "7": [{ start: 0, length: 34 }],
    });
    await expect((await load())("Token")).rejects.toThrow(
      /no longer matches the deployed code/,
    );
    writeArtifact("Token", `0x6080${"ab".repeat(32)}00`, {
      "7": [{ start: 2, length: 32 }],
    });
    code = `0x6080${"cd".repeat(32)}00`;
    writeRecord("local");
    await expect((await load())("Token")).rejects.toThrow(
      /no longer matches the deployed code/,
    );
  });

  it("asks for a recompile when the artifact predates deployedBytecode", async () => {
    writeRecord("local");
    writeArtifact("Token", undefined);

    await expect((await load())("Token")).rejects.toThrow(
      "artifacts/Token.json has no deployed bytecode to check the contract against.\n" +
        "\x1b[2mhint:\x1b[0m run `cmu compile`.",
    );
  });

  it("refuses an artifact with library placeholders as unverifiable", async () => {
    writeRecord("local");
    writeArtifact("Token", `0x73__$0123456789abcdef0123456789abcdef01$__00`);

    await expect((await load())("Token")).rejects.toThrow(
      /Token links libraries, so its deployed code cannot be checked/,
    );
  });

  it("refuses a newer-format record", async () => {
    writeRecord("local", { format: 2 });

    await expect((await load())("Token")).rejects.toThrow(
      /record format 2, newer than this cmu reads \(1\)[\s\S]*cmu update/,
    );
    expect(provider.getCode).not.toHaveBeenCalled();
  });

  it("refuses malformed records and one filed under the wrong network", async () => {
    writeRecord("local", { address: "not-an-address" });
    await expect((await load())("Token")).rejects.toThrow(
      /not a usable deployment record/,
    );

    writeRecord("local", { network: "kampus" });
    await expect((await load())("Token")).rejects.toThrow(
      /not a usable deployment record/,
    );
    expect(provider.getCode).not.toHaveBeenCalled();
  });

  it("never reads the flat deployments/<Contract>.json, only names it in the hint", async () => {
    fs.mkdirSync(path.join(tmpDir, "deployments"));
    fs.writeFileSync(
      path.join(tmpDir, "deployments", "Token.json"),
      JSON.stringify({ address: TOKEN, abi: ABI }),
    );

    await expect((await load())("Token")).rejects.toThrow(
      /no deployment record for 'Token' on 'local'[\s\S]*deployments\/Token\.json is from an older scaffold and is not read/,
    );
    expect(provider.getCode).not.toHaveBeenCalled();
  });

  it("rejects a name that is not a contract name before touching the disk", async () => {
    await expect((await load())("../../etc/passwd")).rejects.toThrow(
      /is not a contract name/,
    );
  });

  it("leaves getContract(name, address) synchronous and unchanged", async () => {
    writeRecord("local");
    const { makeGetContract } = await import("../../src/commands/console");
    const getContract = makeGetContract({ provider, signer });

    const token: any = getContract("Token", ADDRESS);

    expect(token).not.toBeInstanceOf(Promise);
    expect(token.target).toBe(ADDRESS);
    // Still no lookup, even with a record right there.
    expect(() => (getContract as any)("Token")).toThrow(/requires an address/);
    expect(provider.getCode).not.toHaveBeenCalled();
  });

  it("leaks the signer's key nowhere, resolving or refusing", async () => {
    const getDeployed = await load();
    const errors: string[] = [];
    const attempt = (name: string) =>
      getDeployed(name).catch((e: Error) => errors.push(e.message));

    writeRecord("local");
    await attempt("Token");
    code = "0x";
    await attempt("Token");
    code = "0x6001";
    writeRecord("local");
    await attempt("Token");
    await attempt("Ghost");

    expect(out.some((l) => l.startsWith("getDeployed: Token"))).toBe(true);
    expect(errors).toHaveLength(3);
    expectNoKeyLeak([...out, ...errors], tmpDir);
  });

  it("expectNoKeyLeak catches a planted key", () => {
    expect(() =>
      expectNoKeyLeak([`x ${PRIVATE_KEY.slice(2)}`], tmpDir),
    ).toThrow();
    fs.writeFileSync(path.join(tmpDir, "leak.txt"), PRIVATE_KEY);
    expect(() => expectNoKeyLeak(out, tmpDir)).toThrow();
  });
});
