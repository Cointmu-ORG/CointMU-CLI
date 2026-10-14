import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { hashOf } from "../fakeChain";
import {
  DEPLOYER,
  STRANGER,
  ARGS,
  BYTECODE,
  tmpDir,
  chain,
  recordFile,
  readRecord,
  output,
  load,
  LOCAL,
  setUp,
  tearDown,
} from "../helpers/deploymentsEnv";

beforeEach(setUp);
afterEach(tearDown);

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
