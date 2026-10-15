import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import {
  PRIVATE_KEY,
  ADDRESS,
  ABI,
  expectNoKeyLeak,
} from "../helpers/consoleEnv";
import {
  TOKEN,
  RUNTIME_IMM_ARTIFACT,
  RUNTIME_IMM_CHAIN,
  tmpDir,
  out,
  provider,
  signer,
  setCode,
  getDeployedSetUp,
  getDeployedTearDown,
  writeArtifact,
  writeRecord,
  load,
} from "../helpers/consoleGetDeployed";

// getDeployed(name) resolves the address from deployments/<network>/ and
// checks the record against the chain first. The provider is a fake object:
// only getNetwork and getCode are ever asked.

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

describe("getDeployed", () => {
  beforeEach(getDeployedSetUp);
  afterEach(getDeployedTearDown);

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
    setCode("0x");

    await expect((await load())("Token")).rejects.toThrow(
      `the record for Token on 'local' is stale: there is no contract at ${TOKEN} (was the devnet restarted?).`,
    );
  });

  it("refuses a stale record whose address now holds other code", async () => {
    writeRecord("local");
    setCode("0x6001");

    await expect((await load())("Token")).rejects.toThrow(
      `the record for Token on 'local' is stale: the code at ${TOKEN} is not the code that was recorded.`,
    );
  });

  // The record's own codeHash is whatever its author wrote, so a record
  // pointing at someone else's contract passes the staleness checks; only
  // the local artifact can catch it.
  it("refuses code that is not what the artifact compiles to, without suggesting a way around it", async () => {
    setCode("0x60806040deadbeef");
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
    setCode(RUNTIME_IMM_CHAIN);
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
    setCode(`0x6080${"cd".repeat(32)}00`);
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
    setCode("0x");
    await attempt("Token");
    setCode("0x6001");
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
