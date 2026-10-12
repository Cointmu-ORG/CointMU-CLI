import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decryptSessionKey, type SessionData } from "../../src/utils/session";

// Issue #87 (c): `wallet create` printed a private key and mnemonic to stdout,
// where they survive in scrollback, tmux logs and CI output. --login encrypts
// the generated key into a session without printing anything recoverable.

const PASSWORD = "correct horse 9";
// Hardhat account #1, so the address in the assertions is a known value.
const KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let tmpDir: string;
let logged: string[];
/** Everything printed during the test; unlike `logged`, never reset midway. */
let everything: string[];
const realIsTTY = process.stdin.isTTY;

/** Everything the command wrote to stdout and stderr, as one string. */
function output(): string {
  return logged.join("\n");
}

beforeEach(() => {
  // The SUT is imported after mockPrompt(), so it must not come from a cache
  // a previous test filled with the real inquirer.
  vi.resetModules();
  // Prompts refuse to run without a TTY, and vitest's stdin usually is not one.
  process.stdin.isTTY = true;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-wallet-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  logged = [];
  everything = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    everything.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  // networkStorage keys .cmu-networks.json off os.homedir(); without this the
  // suite would read the developer's real saved networks.
  vi.stubEnv("HOME", tmpDir);
  vi.stubEnv("USERPROFILE", tmpDir);
});

afterEach(() => {
  process.stdin.isTTY = realIsTTY;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("inquirer");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Mocks inquirer so a password prompt answers, or fails the test outright. */
function mockPrompt(answer?: Record<string, string>) {
  vi.doMock("inquirer", () => ({
    default: {
      prompt: async () => {
        if (!answer) throw new Error("inquirer.prompt should not be called");
        return answer;
      },
    },
  }));
}

/** Reads back the session the command under test wrote. */
function readSession(): SessionData {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, ".cmu-session"), "utf8"));
}

/** Writes a session that already picked a network, as `network use` would. */
function writeSession(activeNetwork: string): void {
  fs.writeFileSync(
    path.join(tmpDir, ".cmu-session"),
    JSON.stringify({ address: "0xTest", activeNetwork }),
  );
}

function writeNetworks(names: string[]): void {
  fs.writeFileSync(
    path.join(tmpDir, ".cmu-networks.json"),
    JSON.stringify(
      names.map((name) => ({ name, rpcUrl: "http://127.0.0.1:9999" })),
    ),
  );
}

describe("wallet create", () => {
  it("still prints the key and mnemonic by default, with a sensitivity reminder", async () => {
    // Fails loudly if the default path ever starts prompting.
    mockPrompt();
    const { runWalletCreate } = await import("../../src/commands/wallet");

    await runWalletCreate({});

    expect(output()).toContain("Private key : 0x");
    expect(output()).toContain("Mnemonic    :");
    expect(output()).toContain("shown once");
    expect(output()).toContain("warning:");
    expect(output()).toContain("scrollback");
    expect(output()).toContain("--login");
    expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(false);
  });
});

describe("wallet create --login", () => {
  it("encrypts the generated key into a session without printing it", async () => {
    mockPrompt({ password: PASSWORD });
    const { ethers } = await import("ethers");

    // Capture the wallet the command generates, so the assertions below can
    // name the exact key and mnemonic that must not appear in the output.
    const createRandom = ethers.Wallet.createRandom.bind(ethers.Wallet);
    let generated: ReturnType<typeof createRandom> | undefined;
    vi.spyOn(ethers.Wallet, "createRandom").mockImplementation(((
      ...args: Parameters<typeof createRandom>
    ) => {
      generated = createRandom(...args);
      return generated;
    }) as typeof createRandom);

    const { runWalletCreate } = await import("../../src/commands/wallet");
    await runWalletCreate({ login: true });

    expect(generated).toBeDefined();
    const sessionFile = path.join(tmpDir, ".cmu-session");
    expect(fs.existsSync(sessionFile)).toBe(true);
    const session: SessionData = JSON.parse(
      fs.readFileSync(sessionFile, "utf8"),
    );

    // The session really holds the wallet that was generated and printed.
    expect(decryptSessionKey(PASSWORD, session)).toBe(generated!.privateKey);
    expect(session.address).toBe(generated!.address);
    expect(output()).toContain(generated!.address);

    // Nothing recoverable reached stdout: not the key (with or without its 0x
    // prefix), not a single mnemonic word, not even the labels the default
    // path prints them under.
    expect(output()).not.toContain(generated!.privateKey);
    expect(output()).not.toContain(generated!.privateKey.slice(2));
    expect(output()).not.toContain("Private key");
    expect(output()).not.toContain("Mnemonic");

    // Word pairs, not single words: BIP-39 is plain English, so a lone "when"
    // or "key" collides with the command's own prose. Any real leak prints the
    // phrase, and every leaked phrase contains its consecutive pairs.
    const phrase = generated!.mnemonic?.phrase;
    expect(phrase).toBeTruthy();
    expect(output()).not.toContain(phrase);
    const words = phrase!.split(" ");
    for (let i = 0; i < words.length - 1; i++) {
      expect(output()).not.toContain(`${words[i]} ${words[i + 1]}`);
    }

    expect(output()).toContain("Session encrypted and saved.");
    expect(output()).toContain("warning:");
    expect(output()).toContain("were not printed");
  });

  it("writes the session with owner-only permissions", async () => {
    mockPrompt({ password: PASSWORD });
    const { runWalletCreate } = await import("../../src/commands/wallet");

    await runWalletCreate({ login: true });

    const mode = fs.statSync(path.join(tmpDir, ".cmu-session")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// Issue #126: createEncryptedSession() hardcoded activeNetwork: "local", so a
// login threw away whatever `cmu network use <name>` had selected - silently,
// since no line of the login output mentioned the network at all. Both callers
// route through that one helper, so both are pinned here.

describe("active network across a login", () => {
  const run = {
    "wallet login": async () => {
      const { runWalletLogin } = await import("../../src/commands/wallet");
      await runWalletLogin();
    },
    "wallet create --login": async () => {
      const { runWalletCreate } = await import("../../src/commands/wallet");
      await runWalletCreate({ login: true });
    },
  };

  describe.each(Object.keys(run) as (keyof typeof run)[])("%s", (command) => {
    beforeEach(() => {
      mockPrompt({ privateKey: KEY, password: PASSWORD });
    });

    it("keeps an active network that is still saved", async () => {
      writeSession("testnet");
      writeNetworks(["local", "testnet"]);

      await run[command]();

      expect(readSession().activeNetwork).toBe("testnet");
      expect(output()).toContain("Active network: testnet");
    });

    it("falls back to local when the picked network is gone, and says so", async () => {
      writeSession("testnet");
      writeNetworks(["local"]);

      await run[command]();

      expect(readSession().activeNetwork).toBe("local");
      expect(output()).toContain("warning:");
      expect(output()).toContain("'testnet' is no longer saved");
      expect(output()).toContain("Active network: local");
    });

    it("defaults to local on a first login, with no session to carry over", async () => {
      await run[command]();

      expect(readSession().activeNetwork).toBe("local");
      expect(output()).not.toContain("warning: network");
    });

    it("does not lose the key while carrying the network over", async () => {
      writeSession("testnet");
      writeNetworks(["local", "testnet"]);

      await run[command]();

      const session = readSession();
      expect(session.address).not.toBe("0xTest");
      expect(decryptSessionKey(PASSWORD, session)).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  it("logs in as the address the entered key belongs to", async () => {
    mockPrompt({ privateKey: KEY, password: PASSWORD });
    writeSession("testnet");
    writeNetworks(["local", "testnet"]);

    const { runWalletLogin } = await import("../../src/commands/wallet");
    await runWalletLogin();

    const session = readSession();
    expect(session.address).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(decryptSessionKey(PASSWORD, session)).toBe(KEY);
    expect(output()).toContain(`Logged in as ${session.address}`);
  });
});

// inquirer cannot read a masked answer from a pipe: a closed stdin fails with
// "force closed the prompt", and a pipe that stays open hangs forever.
describe("without a terminal", () => {
  it.each([
    [
      "wallet login",
      async () => {
        const { runWalletLogin } = await import("../../src/commands/wallet");
        await runWalletLogin();
      },
    ],
    [
      "wallet create --login",
      async () => {
        const { runWalletCreate } = await import("../../src/commands/wallet");
        await runWalletCreate({ login: true });
      },
    ],
  ])("%s fails instead of prompting", async (_, run) => {
    process.stdin.isTTY = false;
    mockPrompt();

    await expect(run()).rejects.toThrow("non-interactive session");
    expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(false);
  });
});

// Issue #177: named wallets in ~/.cmu-wallets.json. HOME and the cwd are both
// tmpDir (see beforeEach), so the store and the session sit side by side and
// the developer's real ~/.cmu-wallets.json is never read or written.

// Hardhat account #2: a second known key for the two-wallet cases.
const KEY_B =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ADDRESS_A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ADDRESS_B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function walletsFile(): string {
  return path.join(tmpDir, ".cmu-wallets.json");
}

function readWallets(): {
  version: number;
  wallets: Record<string, unknown>[];
} {
  return JSON.parse(fs.readFileSync(walletsFile(), "utf8"));
}

/** A fresh SUT whose prompts all answer from `answers`. */
async function walletCommands(answers?: Record<string, unknown>) {
  vi.resetModules();
  mockPrompt(answers as Record<string, string>);
  return import("../../src/commands/wallet");
}

async function save(
  name: string,
  privateKey = KEY,
  password = PASSWORD,
  confirmPassword = password,
): Promise<void> {
  const { runWalletSave } = await walletCommands({
    privateKey,
    password,
    confirmPassword,
  });
  await runWalletSave(name);
}

async function use(name: string, password = PASSWORD): Promise<void> {
  const { runWalletUse } = await walletCommands({ password });
  await runWalletUse(name);
}

/** Every file under dir, recursively. */
function allFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The private keys appear nowhere: not in anything printed during the test
 * (stdout or stderr, even before a `logged = []`), and not in any
 * file the commands left under tmpDir (HOME and cwd), with or without 0x.
 */
function expectNoKeyLeak(): void {
  const files = allFiles(tmpDir);
  const haystacks = [
    everything.join("\n"),
    ...files.map((file) => fs.readFileSync(file, "utf8")),
  ].map((text) => text.toLowerCase());
  for (const key of [KEY, KEY_B]) {
    for (const text of haystacks) {
      expect(text).not.toContain(key.slice(2));
    }
  }
  expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
}

describe("wallet save / list", () => {
  it("saves an encrypted entry and lists it by name and address", async () => {
    await save("deployer");

    const file = readWallets();
    expect(file.version).toBe(1);
    expect(file.wallets).toHaveLength(1);
    const [entry] = file.wallets;
    expect(entry.name).toBe("deployer");
    expect(entry.address).toBe(ADDRESS_A);
    expect(entry.iterations).toBe(600000);
    expect(decryptSessionKey(PASSWORD, entry)).toBe(KEY);

    logged = [];
    const { runWalletList } = await walletCommands();
    await runWalletList();
    expect(output()).toContain("deployer");
    expect(output()).toContain(ADDRESS_A);
    expect(output()).not.toContain("[*]");
    expectNoKeyLeak();
  });

  it("says so when nothing is saved, without creating the file", async () => {
    const { runWalletList } = await walletCommands();
    await runWalletList();

    expect(output()).toContain("No saved wallets.");
    expect(fs.existsSync(walletsFile())).toBe(false);
  });

  it("refuses a name that is already saved, before prompting", async () => {
    await save("deployer");
    const before = fs.readFileSync(walletsFile(), "utf8");

    const { runWalletSave } = await walletCommands();
    await expect(runWalletSave("deployer")).rejects.toThrow(
      "wallet 'deployer' is already saved",
    );
    expect(fs.readFileSync(walletsFile(), "utf8")).toBe(before);
  });

  it.each(["", "Deployer", "-x", "__proto__", "a b", "x".repeat(33)])(
    "refuses the invalid name %j before prompting",
    async (name) => {
      const { runWalletSave } = await walletCommands();
      await expect(runWalletSave(name)).rejects.toThrow("invalid wallet name");
      expect(fs.existsSync(walletsFile())).toBe(false);
    },
  );

  it("warns when the same key is saved under a second name, and saves it", async () => {
    await save("one");
    logged = [];
    await save("two");

    expect(output()).toContain("warning:");
    expect(output()).toContain("already saved as 'one'");
    expect(readWallets().wallets.map((w) => w.name)).toEqual(["one", "two"]);
  });

  it("writes nothing when the password confirmation does not match", async () => {
    await expect(
      save("deployer", KEY, PASSWORD, "correct horse 8"),
    ).rejects.toThrow("passwords do not match");
    expect(fs.existsSync(walletsFile())).toBe(false);

    await save("other", KEY_B);
    const before = fs.readFileSync(walletsFile(), "utf8");
    await expect(save("deployer", KEY, PASSWORD, "nope")).rejects.toThrow(
      "passwords do not match",
    );
    expect(fs.readFileSync(walletsFile(), "utf8")).toBe(before);
    expectNoKeyLeak();
  });
});

describe("wallet use", () => {
  it("writes a session for the wallet that opens with its password", async () => {
    await save("deployer");
    logged = [];
    await use("deployer");

    const session = readSession();
    expect(session.address).toBe(ADDRESS_A);
    expect(decryptSessionKey(PASSWORD, session)).toBe(KEY);
    expect(output()).toContain(
      `Active wallet is now 'deployer' (${ADDRESS_A})`,
    );
    expectNoKeyLeak();
  });

  it("marks the wallet the session holds in list", async () => {
    await save("a");
    await save("b", KEY_B);
    await use("b");
    logged = [];

    const { runWalletList } = await walletCommands();
    await runWalletList();

    const line = (name: string) =>
      logged.find((l) => l.includes(` ${name} `)) ?? "";
    expect(line("b")).toContain("[*]");
    expect(line("a")).not.toContain("[*]");
  });

  it("keeps each project's active wallet independent", async () => {
    await save("a");
    await save("b", KEY_B);
    const p1 = path.join(tmpDir, "p1");
    const p2 = path.join(tmpDir, "p2");
    fs.mkdirSync(p1);
    fs.mkdirSync(p2);

    vi.mocked(process.cwd).mockReturnValue(p1);
    await use("a");
    vi.mocked(process.cwd).mockReturnValue(p2);
    await use("b");

    const sessionIn = (dir: string): SessionData =>
      JSON.parse(fs.readFileSync(path.join(dir, ".cmu-session"), "utf8"));
    expect(sessionIn(p1).address).toBe(ADDRESS_A);
    expect(sessionIn(p2).address).toBe(ADDRESS_B);
  });

  // Regression guard for #126 on the new path into the session.
  it("keeps an active network that is still saved", async () => {
    await save("deployer");
    writeSession("testnet");
    writeNetworks(["local", "testnet"]);

    await use("deployer");

    expect(readSession().activeNetwork).toBe("testnet");
    expect(output()).toContain("Active network: testnet");
  });

  it("falls back to local when the picked network is gone, and says so", async () => {
    await save("deployer");
    writeSession("testnet");
    writeNetworks(["local"]);

    await use("deployer");

    expect(readSession().activeNetwork).toBe("local");
    expect(output()).toContain("'testnet' is no longer saved");
  });

  it("rejects a wrong password and leaves the session alone", async () => {
    await save("deployer");
    writeSession("testnet");
    const before = fs.readFileSync(path.join(tmpDir, ".cmu-session"), "utf8");

    await expect(use("deployer", "wrong password 1")).rejects.toThrow(
      "wrong password for wallet 'deployer'",
    );
    expect(fs.readFileSync(path.join(tmpDir, ".cmu-session"), "utf8")).toBe(
      before,
    );
    expectNoKeyLeak();
  });

  it.each([
    ["a wrong password", () => {}, "wrong password 1"],
    [
      "an edited address",
      () => {
        const file = readWallets();
        file.wallets[0].address = ADDRESS_B;
        fs.writeFileSync(walletsFile(), JSON.stringify(file));
      },
      PASSWORD,
    ],
  ])(
    "does not leak the key through --verbose after %s",
    async (_, corrupt, password) => {
      await save("deployer");
      corrupt();
      const { fail } = await import("../../src/utils/errors");
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

      await use("deployer", password).catch(
        fail("wallet use", { verbose: true }),
      );

      expect(output()).toContain("wallet use failed");
      expectNoKeyLeak();
    },
  );

  it("refuses an entry whose plaintext address was edited", async () => {
    await save("deployer");
    const file = readWallets();
    file.wallets[0].address = ADDRESS_B;
    fs.writeFileSync(walletsFile(), JSON.stringify(file));

    await expect(use("deployer")).rejects.toThrow("has been modified");
    expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(false);
  });

  it("refuses a wallet that is not saved", async () => {
    const { runWalletUse } = await walletCommands();
    await expect(runWalletUse("ghost")).rejects.toThrow(
      "wallet 'ghost' is not saved",
    );
  });

  it("warns when it replaces a session whose key is not saved", async () => {
    await save("deployer");
    writeSession("local"); // address 0xTest, as a `wallet login` would leave

    await use("deployer");

    expect(output()).toContain("warning:");
    expect(output()).toContain("replacing the session for 0xTest");
  });

  it("does not warn when the replaced session's key is saved", async () => {
    await save("a");
    await save("b", KEY_B);
    await use("a");
    await use("a");
    await use("b");

    expect(output()).not.toContain("replacing the session");
  });
});

describe("wallet delete", () => {
  it("removes the entry after --yes", async () => {
    await save("a");
    await save("b", KEY_B);

    const { runWalletDelete, runWalletList } = await walletCommands();
    await runWalletDelete("a", { yes: true });
    logged = [];
    await runWalletList();

    expect(readWallets().wallets.map((w) => w.name)).toEqual(["b"]);
    expect(output()).not.toMatch(/\| a /);
  });

  it("asks first, and a no deletes nothing", async () => {
    await save("a");
    const { runWalletDelete } = await walletCommands({ proceed: false });

    await runWalletDelete("a");

    expect(output()).toContain("Nothing deleted.");
    expect(readWallets().wallets).toHaveLength(1);
  });

  it("leaves a session that already uses the wallet working", async () => {
    await save("deployer");
    await use("deployer");
    logged = [];

    const { runWalletDelete } = await walletCommands({ proceed: true });
    await runWalletDelete("deployer");

    expect(readWallets().wallets).toEqual([]);
    expect(decryptSessionKey(PASSWORD, readSession())).toBe(KEY);
    expect(output()).toContain("keep their own encrypted copy");
  });

  it("refuses a wallet that is not saved", async () => {
    const { runWalletDelete } = await walletCommands();
    await expect(runWalletDelete("ghost", { yes: true })).rejects.toThrow(
      "wallet 'ghost' is not saved",
    );
  });
});

describe("named wallets without a terminal", () => {
  beforeEach(async () => {
    await save("deployer");
    process.stdin.isTTY = false;
  });

  it("save fails instead of prompting", async () => {
    const { runWalletSave } = await walletCommands();
    await expect(runWalletSave("other")).rejects.toThrow(
      "non-interactive session",
    );
  });

  it("use fails instead of prompting", async () => {
    const { runWalletUse } = await walletCommands();
    await expect(runWalletUse("deployer")).rejects.toThrow(
      "non-interactive session",
    );
    expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(false);
  });

  it("delete without --yes fails instead of prompting", async () => {
    const { runWalletDelete } = await walletCommands();
    await expect(runWalletDelete("deployer")).rejects.toThrow("--yes");
    expect(readWallets().wallets).toHaveLength(1);
  });

  it("delete --yes and list still work", async () => {
    const { runWalletDelete, runWalletList } = await walletCommands();
    await runWalletDelete("deployer", { yes: true });
    await runWalletList();
    expect(output()).toContain("No saved wallets.");
  });
});

// chmod on Windows only flips the read-only attribute; owner-only access there
// comes from the ACL inherited from %USERPROFILE%, which this cannot assert.
describe.skipIf(process.platform === "win32")("file permissions", () => {
  const mode = (file: string) => fs.statSync(file).mode & 0o777;

  it("writes the wallets file and the session owner-only", async () => {
    await save("deployer");
    expect(mode(walletsFile())).toBe(0o600);

    await use("deployer");
    expect(mode(path.join(tmpDir, ".cmu-session"))).toBe(0o600);
  });

  it("tightens a wallets file that already had a looser mode", async () => {
    await save("a");
    fs.chmodSync(walletsFile(), 0o644);
    await save("b", KEY_B);
    expect(mode(walletsFile())).toBe(0o600);

    fs.chmodSync(walletsFile(), 0o644);
    const { runWalletDelete } = await walletCommands();
    await runWalletDelete("a", { yes: true });
    expect(mode(walletsFile())).toBe(0o600);
  });
});

describe("an unreadable wallets file", () => {
  it.each([
    [
      "a newer version",
      JSON.stringify({ version: 2, wallets: [] }),
      "newer version",
    ],
    ["malformed JSON", "{ not json", "not a valid wallets file"],
    ["a bare array", "[]", "not a valid wallets file"],
    ["null", "null", "not a valid wallets file"],
  ])(
    "with %s is refused and never overwritten",
    async (_, content, message) => {
      fs.writeFileSync(walletsFile(), content);

      const { runWalletList, runWalletSave } = await walletCommands();
      await expect(runWalletList()).rejects.toThrow(message);
      await expect(runWalletSave("deployer")).rejects.toThrow(message);
      expect(fs.readFileSync(walletsFile(), "utf8")).toBe(content);
    },
  );
});
