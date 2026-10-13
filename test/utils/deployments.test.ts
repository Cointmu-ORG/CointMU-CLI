import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FakeChain, hashOf } from "../fakeChain";

// Address of the well-known Ganache key the deploy tests use; never fund it.
const DEPLOYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const STRANGER = "0x00000000000000000000000000000000000000aa";
const ARGS = "00".repeat(32);

/** Creation bytecode per artifact. Lib's user still has its placeholder. */
const BYTECODE = {
  Token: "60aa01",
  Vault: "60bb02",
  Lib: "60cc03",
  LibUser: `73__$0123456789abcdef0123456789abcdef01$__60dd04`,
  IThing: "",
};

let tmpDir: string;
let chain: FakeChain;
let out: string[];

function writeArtifacts(names = Object.keys(BYTECODE)) {
  const dir = path.join(tmpDir, "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify({
        abi: [],
        evm: { bytecode: { object: (BYTECODE as any)[name] } },
      }),
    );
  }
}

const recordFile = (network: string, name: string) =>
  path.join(tmpDir, "deployments", network, `${name}.json`);
const readRecord = (network: string, name: string) =>
  JSON.parse(fs.readFileSync(recordFile(network, name), "utf8"));
const output = () => out.join("\n");

/** Loads the SUT with ethers' provider swapped for the fake chain. */
async function load() {
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
  return import("../../src/utils/deployments");
}

const LOCAL = { name: "local", url: "http://127.0.0.1:8585", chainId: 1912 };

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-records-"));
  vi.stubEnv("HOME", tmpDir);
  vi.stubEnv("USERPROFILE", tmpDir);
  chain = new FakeChain();
  out = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
  }
  writeArtifacts();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("ethers");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("matchArtifact", () => {
  it("never matches an artifact with no bytecode", async () => {
    const { loadArtifactBytecodes, matchArtifact } = await load();
    const artifacts = await loadArtifactBytecodes(tmpDir);

    expect(artifacts.map((a) => a.name)).not.toContain("IThing");
    expect(matchArtifact("0xdeadbeef", artifacts)).toEqual({});
  });

  it("prefers the longest bytecode that prefixes the input", async () => {
    const { matchArtifact } = await load();
    const artifacts = [
      { name: "Short", bytecode: "60aa" },
      { name: "Long", bytecode: "60aa01" },
    ];

    expect(matchArtifact(`0x60AA01${ARGS}`, artifacts)).toEqual({
      name: "Long",
    });
  });

  it("names nothing when two artifacts tie", async () => {
    const { matchArtifact } = await load();
    const artifacts = [
      { name: "A", bytecode: "60aa01" },
      { name: "B", bytecode: "60aa01" },
    ];

    expect(matchArtifact("0x60aa01", artifacts)).toEqual({
      ambiguous: ["A", "B"],
    });
  });
});

describe("scanDeployments", () => {
  it("finds a raw creation from a hand-written script", async () => {
    const { scanDeployments } = await load();
    const address = chain.create(
      DEPLOYER,
      `0x${BYTECODE.Token}${ARGS}`,
      "0x6001",
    );

    const found = await scanDeployments(chain.provider(), DEPLOYER, 1, 1, 1);

    expect(found).toEqual([
      expect.objectContaining({
        address,
        blockNumber: 1,
        codeHash: hashOf("0x6001"),
        timestamp: new Date((1_700_000_000 + 1) * 1000).toISOString(),
      }),
    ]);
  });

  it("ignores creations sent by anyone else in the same range", async () => {
    const { scanDeployments } = await load();
    chain.create(STRANGER, `0x${BYTECODE.Token}`);
    const mine = chain.create(DEPLOYER, `0x${BYTECODE.Vault}`);
    chain.create(STRANGER, `0x${BYTECODE.Token}`);

    const found = await scanDeployments(chain.provider(), DEPLOYER, 1, 3, 1);

    expect(found.map((f) => f.address)).toEqual([mine]);
  });

  it("does not see a contract a factory created", async () => {
    const { scanDeployments } = await load();
    chain.factoryCreate(DEPLOYER, "0x00000000000000000000000000000000000000fa");

    expect(await scanDeployments(chain.provider(), DEPLOYER, 1, 1, 1)).toEqual(
      [],
    );
  });

  it("stops once it has seen every transaction the nonce delta promised", async () => {
    const { scanDeployments } = await load();
    chain.create(DEPLOYER, `0x${BYTECODE.Token}`);
    chain.create(STRANGER, `0x${BYTECODE.Token}`);
    chain.create(STRANGER, `0x${BYTECODE.Token}`);

    await scanDeployments(chain.provider(), DEPLOYER, 1, 3, 1);

    expect(chain.calls.filter((c) => c === "getBlock")).toHaveLength(1);
  });
});

describe("startRecording", () => {
  async function deploy(
    script: () => void,
    network: { name: string; url: string; chainId?: number } = LOCAL,
  ) {
    const { startRecording } = await load();
    const recording = await startRecording(network, DEPLOYER, tmpDir);
    script();
    await recording?.finish();
    return recording;
  }

  it("records two contracts deployed in one run", async () => {
    let token = "";
    let vault = "";
    await deploy(() => {
      token = chain.create(DEPLOYER, `0x${BYTECODE.Token}${ARGS}`, "0x6001");
      vault = chain.create(DEPLOYER, `0x${BYTECODE.Vault}`, "0x6002");
    });

    expect(readRecord("local", "Token")).toEqual({
      format: 1,
      contract: "Token",
      network: "local",
      chainId: 1912,
      address: token,
      deployer: DEPLOYER,
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      blockNumber: 1,
      timestamp: new Date((1_700_000_000 + 1) * 1000).toISOString(),
      codeHash: hashOf("0x6001"),
    });
    expect(readRecord("local", "Vault").address).toBe(vault);
    expect(output()).toContain("--- Deployed on 'local' (chain 1912) ---");
    expect(output()).toContain(
      `Token  ${token}  block 1  -> ${path.join("deployments", "local", "Token.json")}`,
    );
  });

  it("keeps the last of a contract deployed twice, and says so", async () => {
    let first = "";
    let second = "";
    await deploy(() => {
      first = chain.create(DEPLOYER, `0x${BYTECODE.Token}`);
      second = chain.create(DEPLOYER, `0x${BYTECODE.Token}`);
    });

    expect(readRecord("local", "Token").address).toBe(second);
    expect(output()).toContain(
      `Token was deployed 2 times; the record keeps the last one (${second}).`,
    );
    expect(output()).toContain(`Token  ${first}  block 1  not recorded`);
    expect(output()).toContain(`Token  ${second}  block 2  -> `);
  });

  it("lists a contract with an unlinked library as unrecognised, and records the library", async () => {
    let user = "";
    await deploy(() => {
      chain.create(DEPLOYER, `0x${BYTECODE.Lib}`);
      // The deploy linked a real address where the artifact has a placeholder.
      user = chain.create(DEPLOYER, `0x73${"ab".repeat(20)}60dd04`);
    });

    expect(fs.existsSync(recordFile("local", "Lib"))).toBe(true);
    expect(fs.existsSync(recordFile("local", "LibUser"))).toBe(false);
    expect(output()).toContain(
      `(unrecognised)  ${user}  block 2  no artifact matches its creation code`,
    );
  });

  it("scans nothing when the deployer's nonce did not move", async () => {
    await deploy(() => {
      chain.create(STRANGER, `0x${BYTECODE.Token}`);
    });

    expect(chain.calls).not.toContain("getBlock");
    expect(fs.existsSync(path.join(tmpDir, "deployments"))).toBe(false);
    expect(output()).toContain(
      `No contract creations from ${DEPLOYER} detected.`,
    );
  });

  it("records nothing, with a warning, past MAX_SCAN_BLOCKS", async () => {
    const { MAX_SCAN_BLOCKS } = await load();
    await deploy(() => {
      chain.create(DEPLOYER, `0x${BYTECODE.Token}`);
      for (let i = 0; i < MAX_SCAN_BLOCKS; i++) {
        chain.create(STRANGER, "0x00");
      }
    });

    expect(chain.calls).not.toContain("getBlock");
    expect(fs.existsSync(path.join(tmpDir, "deployments"))).toBe(false);
    expect(output()).toContain(
      `the deploy spanned ${MAX_SCAN_BLOCKS + 1} blocks, more than the ${MAX_SCAN_BLOCKS} scanned; nothing was recorded.`,
    );
  });

  it("turns recording off when the chain is not the configured chainId", async () => {
    const recording = await deploy(
      () => {
        chain.create(DEPLOYER, `0x${BYTECODE.Token}`);
      },
      { ...LOCAL, chainId: 31337 },
    );

    expect(recording).toBeUndefined();
    expect(chain.calls).toContain("destroy");
    expect(fs.existsSync(path.join(tmpDir, "deployments"))).toBe(false);
    expect(output()).toContain(
      "deployment records are off for this run: 'local' is configured as chain 31337, but http://127.0.0.1:8585 is chain 1912",
    );
  });

  // Real timers: networkDir() does real fs I/O before the timeout is armed,
  // which fake timers cannot advance past.
  it("turns recording off when the endpoint never answers", async () => {
    const { startRecording } = await load();
    const provider = chain.provider();
    provider.getNetwork = () => new Promise(() => {});
    chain.provider = () => provider;

    expect(await startRecording(LOCAL, DEPLOYER, tmpDir)).toBeUndefined();
    expect(output()).toContain("http://127.0.0.1:8585 did not answer");
  }, 10_000);

  it("writes atomically, leaving no temp file, and overwrites a current-format record", async () => {
    fs.mkdirSync(path.join(tmpDir, "deployments", "local"), {
      recursive: true,
    });
    fs.writeFileSync(
      recordFile("local", "Token"),
      '{"format":1,"address":"0xold"}',
    );

    let token = "";
    await deploy(() => {
      token = chain.create(DEPLOYER, `0x${BYTECODE.Token}`);
    });

    expect(readRecord("local", "Token").address).toBe(token);
    expect(fs.readdirSync(path.join(tmpDir, "deployments", "local"))).toEqual([
      "Token.json",
    ]);
  });

  it("leaves a newer-format record untouched", async () => {
    fs.mkdirSync(path.join(tmpDir, "deployments", "local"), {
      recursive: true,
    });
    const newer = '{"format":2,"address":"0xfuture"}\n';
    fs.writeFileSync(recordFile("local", "Token"), newer);

    await deploy(() => {
      chain.create(DEPLOYER, `0x${BYTECODE.Token}`);
    });

    expect(fs.readFileSync(recordFile("local", "Token"), "utf8")).toBe(newer);
    expect(output()).toMatch(
      /Token was not recorded: .*record format 2, newer than this cmu writes \(1\); left as is/,
    );
    expect(output()).toContain("Token  0x");
  });
});

describe("networkDir", () => {
  it.each(["../x", "a/b", "..", "a\\b", "", ".hidden", "x".repeat(65)])(
    "rejects %j as a directory name",
    async (name) => {
      const { networkDir } = await load();
      await expect(networkDir(tmpDir, name)).rejects.toThrow(
        /cannot be used as a deployments\/ directory/,
      );
    },
  );

  it.each([
    "con",
    "CON",
    "prn",
    "aux",
    "Nul",
    "com1",
    "Com1",
    "COM9",
    "lpt1",
    "LPT9",
  ])("rejects the Windows device name %s", async (name) => {
    const { networkDir } = await load();
    await expect(networkDir(tmpDir, name)).rejects.toThrow(
      /not a Windows device name/,
    );
  });

  it.each(["com10", "console", "kampus", "local", "my_net-2"])(
    "accepts %s",
    async (name) => {
      const { networkDir } = await load();
      await expect(networkDir(tmpDir, name)).resolves.toBe(
        path.join(tmpDir, "deployments", name),
      );
    },
  );

  it("treats 'Local' as a collision once deployments/local exists", async () => {
    const { networkDir } = await load();
    fs.mkdirSync(path.join(tmpDir, "deployments", "local"), {
      recursive: true,
    });

    await expect(networkDir(tmpDir, "Local")).rejects.toThrow(
      "network 'Local' collides with the existing deployments/local/ on a case-insensitive filesystem.",
    );
    await expect(networkDir(tmpDir, "local")).resolves.toBeDefined();
  });

  it("records nothing outside deployments/ for a traversal name", async () => {
    const { startRecording } = await load();

    expect(
      await startRecording({ ...LOCAL, name: "../escape" }, DEPLOYER, tmpDir),
    ).toBeUndefined();
    expect(fs.readdirSync(tmpDir).sort()).toEqual(["artifacts"]);
    expect(chain.calls).not.toContain("getBlockNumber");
  });
});
