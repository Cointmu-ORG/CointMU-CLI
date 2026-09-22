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
  const prevKey = process.env.PRIVATE_KEY;
  const realIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-console-ctx-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.PRIVATE_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("inquirer");
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
