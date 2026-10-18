import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Issue #231: `cmu --version` loaded solc (~570 ms) and ethers just to print
// their version strings. A bundled build bakes them in and only loads a module
// when the installed copy is a different version than the one baked.

const ROOT = path.resolve(__dirname, "../..");
const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

const PKG = readJson("package.json");
const SOLC_INSTALLED = readJson("node_modules/solc/package.json").version;
const ETHERS_INSTALLED = readJson("node_modules/ethers/package.json").version;

const MOCK_SOLC_VERSION = "9.9.9+commit.mock";
const MOCK_ETHERS_VERSION = "9.9.9-mock";
const BAKED_SOLC_FULL = `${SOLC_INSTALLED}+commit.baked`;
const BUILD_ID = "abc1234";

/** The eight lines runVersion() prints, given what it should report. */
const expectedLines = (build: string, solidity: string, ethers: string) => [
  "cmu",
  `version      : ${PKG.version}`,
  `codename     : ${PKG.codename}`,
  `build        : ${build}`,
  `architecture : ${process.arch}`,
  `node         : ${process.version}`,
  `solidity     : ${solidity}`,
  `ethers       : ${ethers}`,
];

describe("runVersion", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let solcLoaded: ReturnType<typeof vi.fn>;
  let ethersLoaded: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    solcLoaded = vi.fn();
    ethersLoaded = vi.fn();
    vi.doMock("solc", () => {
      solcLoaded();
      return { default: { version: () => MOCK_SOLC_VERSION } };
    });
    vi.doMock("ethers", () => {
      ethersLoaded();
      return { ethers: { version: MOCK_ETHERS_VERSION } };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.doUnmock("solc");
    vi.doUnmock("ethers");
    vi.resetModules();
  });

  /** What a bundled build has inlined; each value can be overridden. */
  const stubBaked = (
    solcPkg = SOLC_INSTALLED,
    ethersVersion = ETHERS_INSTALLED,
  ) => {
    vi.stubGlobal("__CMU_BUILD_ID__", BUILD_ID);
    vi.stubGlobal("__CMU_SOLC_VERSION__", {
      pkg: solcPkg,
      full: BAKED_SOLC_FULL,
    });
    vi.stubGlobal("__CMU_ETHERS_VERSION__", ethersVersion);
  };

  const run = async () => {
    const { runVersion } = await import("../../src/commands/version");
    await runVersion();
    return log.mock.calls.map((call) => call.join(" "));
  };

  it("prints the baked versions without loading solc or ethers", async () => {
    stubBaked();

    expect(await run()).toEqual(
      expectedLines(BUILD_ID, BAKED_SOLC_FULL, ETHERS_INSTALLED),
    );
    expect(solcLoaded).not.toHaveBeenCalled();
    expect(ethersLoaded).not.toHaveBeenCalled();
  });

  it("loads solc when the installed version differs from the baked one", async () => {
    stubBaked("0.0.0-baked");

    expect(await run()).toEqual(
      expectedLines(BUILD_ID, MOCK_SOLC_VERSION, ETHERS_INSTALLED),
    );
    expect(solcLoaded).toHaveBeenCalledOnce();
    expect(ethersLoaded).not.toHaveBeenCalled();
  });

  it("loads ethers when the installed version differs from the baked one", async () => {
    stubBaked(SOLC_INSTALLED, "0.0.0-baked");

    expect(await run()).toEqual(
      expectedLines(BUILD_ID, BAKED_SOLC_FULL, MOCK_ETHERS_VERSION),
    );
    expect(solcLoaded).not.toHaveBeenCalled();
    expect(ethersLoaded).toHaveBeenCalledOnce();
  });

  it("loads both modules when running unbundled", async () => {
    expect(await run()).toEqual(
      expectedLines("unknown", MOCK_SOLC_VERSION, MOCK_ETHERS_VERSION),
    );
    expect(solcLoaded).toHaveBeenCalledOnce();
    expect(ethersLoaded).toHaveBeenCalledOnce();
  });
});
