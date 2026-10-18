import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { serverError } from "../helpers/ethersServerError";

// Issue #213: every command printed a saved RPC URL in full, credentials and
// all - on stdout, in error messages, in hints and in the ethers errors behind
// them. One case per route that prints a URL, run once with credentials (none
// may appear) and once without (the URL must appear exactly as given).

const CREDS_URL = "http://user:pw@127.0.0.1:18546/rpc?k=1";
const MASKED_URL = "http://user:***@127.0.0.1:18546/rpc?k=***";
const PLAIN_URL = "http://127.0.0.1:18546/rpc";
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** How the fake node behaves: answers, is down, or rejects every call but the chain ID. */
type Mode = "ok" | "down" | "401";
let mode: Mode;

const refused = () =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18546"), {
    code: "ECONNREFUSED",
  });

class FakeProvider {
  constructor(private url: string) {}
  private answer<T>(value: T): T {
    if (mode === "down") throw refused();
    if (mode === "401") throw serverError(this.url);
    return value;
  }
  async getNetwork() {
    if (mode === "down") throw refused();
    return { name: "unknown", chainId: 1912n };
  }
  async getBlockNumber() {
    return this.answer(1);
  }
  async getBlock() {
    return this.answer({
      number: 1,
      hash: "0x01",
      parentHash: "0x00",
      miner: ADDRESS,
      timestamp: Math.floor(Date.now() / 1000),
      difficulty: 0n,
      transactions: [],
    });
  }
  async getBalance() {
    return this.answer(0n);
  }
  async getCode() {
    return this.answer("0x");
  }
  async getTransactionCount() {
    return this.answer(0);
  }
  async send(method: string) {
    return this.answer(method === "eth_coinbase" ? ADDRESS : null);
  }
  destroy() {}
}

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

interface Route {
  /** argv after `cmu`. */
  argv: string[];
  mode: Mode;
  /** Run from the project directory, whose cmu.config.js has the URL. */
  project?: boolean;
  /** Save the network with an invalid symbol, as if hand-edited. */
  badSymbol?: boolean;
  /** What the URL turns into with credentials; the masked URL by default. */
  masked?: string;
  /** What appears for the plain URL; the URL itself by default. */
  plain?: string;
}

const SAVE_HINT_PLACEHOLDER =
  "cmu network save <url> --name creds --symbol CMU";

/** Every route that prints the URL, with and without --verbose for failures. */
const ROUTES: Record<string, Route> = {
  "network save": {
    argv: ["network", "save", "{url}", "--name", "creds"],
    mode: "ok",
  },
  "network --save (deprecated flag)": {
    argv: ["network", "--save", "{url}", "--name", "creds"],
    mode: "ok",
  },
  "network save, invalid symbol hint": {
    argv: ["network", "save", "{url}", "--name", "creds", "--symbol", "!!"],
    mode: "ok",
    masked: SAVE_HINT_PLACEHOLDER,
  },
  "network save, invalid endpoint": {
    argv: ["network", "save", "{ftp}", "--name", "creds"],
    mode: "ok",
    masked: "ftp://user:***@127.0.0.1:18546/rpc?k=***",
    plain: "ftp://127.0.0.1:18546/rpc",
  },
  "network save, invalid endpoint without a scheme": {
    argv: ["network", "save", "{bare}", "--name", "creds"],
    mode: "ok",
    masked: "'user:***@127.0.0.1:18546/rpc?k=***'",
    plain: "'127.0.0.1:18546/rpc'",
  },
  "network list": { argv: ["network", "list"], mode: "ok" },
  "network (no flags)": { argv: ["network"], mode: "ok" },
  "network info": { argv: ["network", "info"], mode: "ok" },
  "network ping": { argv: ["network", "ping", "creds"], mode: "ok" },
  "network ping, down": { argv: ["network", "ping", "creds"], mode: "down" },
  "network ping, 401": { argv: ["network", "ping", "creds"], mode: "401" },
  "wallet info": { argv: ["wallet", "info"], mode: "ok" },
  "wallet balance, down": { argv: ["wallet", "balance"], mode: "down" },
  "wallet balance, 401": { argv: ["wallet", "balance"], mode: "401" },
  "wallet balance, invalid saved symbol hint": {
    argv: ["wallet", "balance"],
    mode: "ok",
    badSymbol: true,
    masked: "cmu network save <url> --name creds --symbol <SYMBOL>",
  },
  "mine status": { argv: ["mine", "status"], mode: "ok" },
  "mine status, down": { argv: ["mine", "status"], mode: "down" },
  "mine status, 401": { argv: ["mine", "status"], mode: "401" },
  "mine start, down": { argv: ["mine", "start"], mode: "down" },
  "mine start, 401": { argv: ["mine", "start"], mode: "401" },
  "mine stop, 401": { argv: ["mine", "stop"], mode: "401" },
  "node connect": { argv: ["node", "connect", "-n", "creds"], mode: "ok" },
  "node connect, 401": {
    argv: ["node", "connect", "-n", "creds"],
    mode: "401",
  },
  "explorer, down": {
    argv: ["explorer", "-b", "0", "--yes"],
    mode: "down",
    project: true,
  },
  "explorer, 401": {
    argv: ["explorer", "-b", "0", "--yes"],
    mode: "401",
    project: true,
  },
  console: {
    argv: ["console", "--no-signer", "--yes"],
    mode: "ok",
    project: true,
  },
  "console, down": {
    argv: ["console", "--no-signer", "--yes"],
    mode: "down",
    project: true,
  },
  "deploy --config": {
    argv: ["deploy", "--config", "--yes"],
    mode: "ok",
    project: true,
  },
  "deploy --ping, down": {
    argv: ["deploy", "--ping", "--yes"],
    mode: "down",
    project: true,
  },
};

const CASES = Object.entries(ROUTES).flatMap(([name, route]) => [
  [name, route, []] as const,
  ...(route.mode === "ok" && !route.masked
    ? []
    : [[`${name} --verbose`, route, ["--verbose"]] as const]),
]);

describe("RPC credentials in command output", () => {
  let tmpDir: string;
  let output: string[];

  beforeEach(() => {
    vi.resetModules();
    output = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-net-creds-"));
    fs.mkdirSync(path.join(tmpDir, "home"));
    fs.mkdirSync(path.join(tmpDir, "proj", "deploy"), { recursive: true });
    vi.stubEnv("HOME", path.join(tmpDir, "home"));
    vi.stubEnv("USERPROFILE", path.join(tmpDir, "home"));
    vi.stubEnv("PRIVATE_KEY", "");
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        output.push(args.join(" "));
      });
    }
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitError(code);
    }) as never);
    vi.doMock("ethers", async (importOriginal) => {
      const real = await importOriginal<typeof import("ethers")>();
      return {
        ...real,
        ethers: { ...real.ethers, JsonRpcProvider: FakeProvider },
      };
    });
    vi.doMock("../../src/commands/compile", () => ({
      runCompile: async () => {},
    }));
    // console opens a REPL once the endpoint answers; end it straight away.
    vi.doMock("node:repl", () => ({
      start: () => ({
        context: {},
        on: (event: string, listener: () => void) => {
          if (event === "exit") listener();
        },
      }),
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock("ethers");
    vi.doUnmock("../../src/commands/compile");
    vi.doUnmock("node:repl");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setUp(route: Route, url: string): string {
    mode = route.mode;
    fs.writeFileSync(
      path.join(tmpDir, "home", ".cmu-networks.json"),
      JSON.stringify([
        { name: "local", rpcUrl: "http://127.0.0.1:8585" },
        {
          name: "creds",
          rpcUrl: url,
          ...(route.badSymbol ? { symbol: "!!" } : {}),
        },
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({ address: ADDRESS, activeNetwork: "creds" }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "proj", "cmu.config.js"),
      `module.exports = { defaultNetwork: "creds", networks: { creds: { url: ${JSON.stringify(url)}, chainId: 1912 } } };\n`,
    );
    const cwd = route.project ? path.join(tmpDir, "proj") : tmpDir;
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    return cwd;
  }

  /** Runs argv through a root program like src/index.ts builds. */
  async function cli(argv: string[]): Promise<string> {
    const { Command } = await import("commander");
    const program = new Command()
      .name("cmu")
      .option("-v, --verbose")
      .exitOverride();
    for (const command of [
      (await import("../../src/commands/network")).networkCommand,
      (await import("../../src/commands/wallet")).walletCommand,
      (await import("../../src/commands/mine")).mineCommand,
      (await import("../../src/commands/node")).nodeCommand,
      (await import("../../src/commands/explorer")).explorerCommand,
      (await import("../../src/commands/console")).consoleCommand,
      (await import("../../src/commands/deploy")).deployCommand,
    ]) {
      program.addCommand(command);
    }
    try {
      await program.parseAsync(argv, { from: "user" });
    } catch (error) {
      if (!(error instanceof ExitError)) throw error;
    }
    return output.join("\n");
  }

  const argvFor = (route: Route, url: string, extra: readonly string[]) =>
    [...route.argv, ...extra].map((arg) =>
      arg
        .replace("{url}", url)
        .replace("{ftp}", url.replace(/^http:/, "ftp:"))
        .replace("{bare}", url.replace(/^http:\/\//, "")),
    );

  it.each(CASES)("%s prints no credentials", async (_name, route, extra) => {
    setUp(route, CREDS_URL);

    const printed = await cli(argvFor(route, CREDS_URL, extra));

    expect(printed).not.toContain("user:pw");
    expect(printed).not.toContain("k=1");
    expect(printed).toContain(route.masked ?? MASKED_URL);
  });

  it.each(CASES)(
    "%s prints a URL without credentials as it is",
    async (_name, route, extra) => {
      setUp(route, PLAIN_URL);

      const printed = await cli(argvFor(route, PLAIN_URL, extra));

      expect(printed).toContain(route.plain ?? PLAIN_URL);
      expect(printed).not.toContain("***");
      // The placeholder is only for URLs with secrets; the deprecation notice
      // of `network --save` has its own `<url>`.
      expect(printed).not.toContain("<url> --name creds");
    },
  );
});

describe("RPC credentials in deployment-record warnings", () => {
  let warnings: string[];

  beforeEach(() => {
    vi.resetModules();
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(" "));
    });
    vi.doMock("ethers", async (importOriginal) => {
      const real = await importOriginal<typeof import("ethers")>();
      return {
        ...real,
        ethers: { ...real.ethers, JsonRpcProvider: FakeProvider },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("ethers");
    vi.resetModules();
  });

  async function record(url: string, chainId: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-net-creds-rec-"));
    try {
      const { startRecording } = await import("../../src/utils/deployments");
      await startRecording({ name: "creds", url, chainId }, ADDRESS, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return warnings.join("\n");
  }

  it.each([
    ["the node rejects the request", "401" as Mode, 1912],
    ["the chain ID does not match", "ok" as Mode, 1],
  ])("masks the URL when %s", async (_label, nodeMode, chainId) => {
    mode = nodeMode;

    const printed = await record(CREDS_URL, chainId);

    expect(printed).toContain("deployment records are off");
    expect(printed).not.toContain("user:pw");
    expect(printed).not.toContain("k=1");
    expect(printed).toContain(MASKED_URL);
  });

  it("prints a URL without credentials as it is", async () => {
    mode = "ok";

    expect(await record(PLAIN_URL, 1)).toContain(
      `but ${PLAIN_URL} is chain 1912`,
    );
  });
});
