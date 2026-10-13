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
  vi.doUnmock("../../src/utils/walletStorage");
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
 *
 * @param {string[]} [keys] - Further keys to look for, such as one the command
 *   generated itself.
 */
function expectNoKeyLeak(keys: string[] = []): void {
  const files = allFiles(tmpDir);
  const haystacks = [
    everything.join("\n"),
    ...files.map((file) => fs.readFileSync(file, "utf8")),
  ].map((text) => text.toLowerCase());
  // With and without 0x, lowercased like the haystacks; and the password.
  const secrets = [KEY, KEY_B, ...keys].flatMap((key) => [
    key.toLowerCase(),
    key.slice(2).toLowerCase(),
  ]);
  secrets.push(PASSWORD.toLowerCase());
  for (const secret of secrets) {
    for (const text of haystacks) {
      expect(text).not.toContain(secret);
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

// Issue #194: `wallet create --save <name>` generates a wallet straight into
// the store and prints only the address and the mnemonic. The store keeps the
// key and not the mnemonic, so the printed mnemonic is the one backup: it must
// derive the stored key, and it must never be printed for a wallet that did
// not end up saved.

describe("wallet create --save", () => {
  const ANSWERS = { password: PASSWORD, confirmPassword: PASSWORD };

  /** Spies on createRandom; the returned list fills with what it hands out. */
  async function spyCreateRandom() {
    const { ethers } = await import("ethers");
    const createRandom = ethers.Wallet.createRandom.bind(ethers.Wallet);
    const generated: ReturnType<typeof createRandom>[] = [];
    vi.spyOn(ethers.Wallet, "createRandom").mockImplementation(((
      ...args: Parameters<typeof createRandom>
    ) => {
      const wallet = createRandom(...args);
      generated.push(wallet);
      return wallet;
    }) as typeof createRandom);
    return generated;
  }

  /** Nothing a successful --save prints reached the output. */
  function expectNothingPrinted(): void {
    expect(output()).not.toContain("New CointMU wallet");
    expect(output()).not.toContain("Mnemonic");
    expect(output()).not.toContain("Address");
  }

  it("stores the key encrypted and prints a mnemonic that derives it", async () => {
    const generated = await spyCreateRandom();
    const { runWalletCreate } = await walletCommands(ANSWERS);
    await runWalletCreate({ save: "alice" });

    expect(generated).toHaveLength(1);
    const [wallet] = generated;
    const [entry] = readWallets().wallets;
    expect(entry.name).toBe("alice");
    expect(entry.address).toBe(wallet.address);
    expect(entry.iterations).toBe(600000);

    const line = logged.find((l) => l.startsWith("Mnemonic : "));
    expect(line).toBeDefined();
    const phrase = line!.slice("Mnemonic : ".length);
    const { ethers } = await import("ethers");
    expect(ethers.HDNodeWallet.fromPhrase(phrase).privateKey).toBe(
      decryptSessionKey(PASSWORD, entry),
    );
    // Printed once, and the key not at all.
    expect(everything.join("\n").split(phrase)).toHaveLength(2);
    expect(output()).toContain(`Address  : ${wallet.address}`);
    expect(output()).not.toContain("Private key");
    expectNoKeyLeak([wallet.privateKey]);

    // The store holds no mnemonic either; consecutive pairs, as above.
    const stored = fs.readFileSync(walletsFile(), "utf8");
    const words = phrase.split(" ");
    for (let i = 0; i < words.length - 1; i++) {
      expect(stored).not.toContain(`${words[i]} ${words[i + 1]}`);
    }

    expect(output()).toContain("cmu keeps no copy");
    expect(output()).toContain("the mnemonic is the only way");
    expect(output()).toContain("scrollback");
    // Saved, not activated.
    expect(output()).toContain("`cmu wallet use alice`");
    expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(false);
  });

  it("saves through the commander action", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { walletCommand } = await walletCommands(ANSWERS);
    await walletCommand.parseAsync(["create", "--save", "alice"], {
      from: "user",
    });

    expect(exit).not.toHaveBeenCalled();
    expect(readWallets().wallets.map((w) => w.name)).toEqual(["alice"]);
  });

  it("refuses a name that is already saved before prompting or generating", async () => {
    await save("alice");
    const before = fs.readFileSync(walletsFile(), "utf8");
    logged = [];
    const generated = await spyCreateRandom();

    const { runWalletCreate } = await walletCommands();
    await expect(runWalletCreate({ save: "alice" })).rejects.toThrow(
      "wallet 'alice' is already saved",
    );
    expect(generated).toEqual([]);
    expectNothingPrinted();
    expect(fs.readFileSync(walletsFile(), "utf8")).toBe(before);
  });

  it.each(["", "Deployer", "-x", "__proto__", "a b", "x".repeat(33)])(
    "refuses the invalid name %j before prompting or generating",
    async (name) => {
      const generated = await spyCreateRandom();
      const { runWalletCreate } = await walletCommands();
      await expect(runWalletCreate({ save: name })).rejects.toThrow(
        "invalid wallet name",
      );
      expect(generated).toEqual([]);
      expectNothingPrinted();
      expect(fs.existsSync(walletsFile())).toBe(false);
    },
  );

  it("refuses an unreadable wallets file before prompting, and leaves it", async () => {
    fs.writeFileSync(walletsFile(), "{ not json");
    const generated = await spyCreateRandom();

    const { runWalletCreate } = await walletCommands();
    await expect(runWalletCreate({ save: "alice" })).rejects.toThrow(
      "not a valid wallets file",
    );
    expect(generated).toEqual([]);
    expect(fs.readFileSync(walletsFile(), "utf8")).toBe("{ not json");
  });

  it("writes and prints nothing when the password confirmation does not match", async () => {
    const generated = await spyCreateRandom();
    const mismatch = { password: PASSWORD, confirmPassword: "correct horse 8" };

    let commands = await walletCommands(mismatch);
    await expect(commands.runWalletCreate({ save: "alice" })).rejects.toThrow(
      "passwords do not match",
    );
    expect(fs.existsSync(walletsFile())).toBe(false);

    await save("other", KEY_B);
    const before = fs.readFileSync(walletsFile(), "utf8");
    logged = [];
    commands = await walletCommands(mismatch);
    await expect(commands.runWalletCreate({ save: "alice" })).rejects.toThrow(
      "passwords do not match",
    );
    expect(fs.readFileSync(walletsFile(), "utf8")).toBe(before);

    expect(generated).toEqual([]);
    expectNothingPrinted();
    expectNoKeyLeak();
  });

  it("prints no mnemonic when the store cannot be written, even with --verbose", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const tmpPath = `${walletsFile()}.${process.pid}.tmp`;
    vi.doMock("../../src/utils/walletStorage", async (importOriginal) => ({
      ...(await importOriginal<
        typeof import("../../src/utils/walletStorage")
      >()),
      saveWallet: async () => {
        throw Object.assign(
          new Error(`EACCES: permission denied, open '${tmpPath}'`),
          { code: "EACCES", syscall: "open", path: tmpPath },
        );
      },
    }));
    const generated = await spyCreateRandom();
    const { fail } = await import("../../src/utils/errors");

    const { runWalletCreate } = await walletCommands(ANSWERS);
    await runWalletCreate({ save: "alice" }).catch(
      fail("wallet create", { verbose: true }),
    );

    expect(output()).toContain("wallet create failed");
    expect(output()).toContain("EACCES");
    expect(generated).toHaveLength(1);
    const [wallet] = generated;
    expectNothingPrinted();
    expect(output()).not.toContain(wallet.address);
    const words = wallet.mnemonic!.phrase.split(" ");
    for (let i = 0; i < words.length - 1; i++) {
      expect(output()).not.toContain(`${words[i]} ${words[i + 1]}`);
    }
    expect(fs.existsSync(walletsFile())).toBe(false);
    expectNoKeyLeak([wallet.privateKey]);
  });

  it("fails without a terminal the way wallet save does, before generating", async () => {
    process.stdin.isTTY = false;
    const generated = await spyCreateRandom();

    const { runWalletCreate, runWalletSave } = await walletCommands();
    const created = await runWalletCreate({ save: "alice" }).catch(
      (error: Error) => error,
    );
    const saved = await runWalletSave("bob").catch((error: Error) => error);

    expect(created).toBeInstanceOf(Error);
    expect((created as Error).message).toContain("non-interactive session");
    // The same error, naming what it would have prompted for.
    expect(
      (created as Error).message.replace("a password", "a private key"),
    ).toBe((saved as Error).message);
    expect(generated).toEqual([]);
    expect(fs.existsSync(walletsFile())).toBe(false);
  });

  it("refuses --save together with --login, through the CLI too", async () => {
    const generated = await spyCreateRandom();
    const { runWalletCreate } = await walletCommands();
    await expect(
      runWalletCreate({ save: "alice", login: true }),
    ).rejects.toThrow("--save and --login cannot be combined");

    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { walletCommand } = await walletCommands();
    await walletCommand.parseAsync(["create", "--save", "alice", "--login"], {
      from: "user",
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(output()).toContain("wallet create failed");
    expect(output()).toContain("cannot be combined");

    expect(generated).toEqual([]);
    expect(fs.existsSync(walletsFile())).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(false);
  });
});

// Issue #194: `login` and `create --login` keep working behind a deprecation
// notice on stderr. stdout and the exit code stay exactly as they were, so a
// script that reads them keeps working through the deprecation window.

describe("deprecated login paths", () => {
  const LOGIN_ANSWERS = { privateKey: KEY, password: PASSWORD };
  const DEPLOY_LINE =
    "`cmu deploy` will use this key automatically when PRIVATE_KEY is not set.";

  function stdout(): string[] {
    return vi.mocked(console.log).mock.calls.map((args) => args.join(" "));
  }

  function stderr(): string {
    return [
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]
      .map((args) => args.join(" "))
      .join("\n");
  }

  it("wallet login warns once on stderr, with stdout unchanged", async () => {
    const { runWalletLogin } = await walletCommands(LOGIN_ANSWERS);
    await runWalletLogin();

    expect(stderr().match(/is deprecated/g)).toHaveLength(1);
    expect(stderr()).toContain("`cmu wallet login` is deprecated");
    expect(stderr()).toContain(
      "`cmu wallet save <name>`, then run `cmu wallet use <name>`",
    );
    expect(stdout()).toEqual([
      "Session encrypted and saved.",
      `Logged in as ${ADDRESS_A}`,
      "Active network: local",
      DEPLOY_LINE,
    ]);
    expectNoKeyLeak();
  });

  it("wallet create --login warns once on stderr, with stdout unchanged", async () => {
    const { runWalletCreate } = await walletCommands(LOGIN_ANSWERS);
    await runWalletCreate({ login: true });

    expect(stderr().match(/is deprecated/g)).toHaveLength(1);
    expect(stderr()).toContain("`cmu wallet create --login` is deprecated");
    expect(stderr()).toContain(
      "`cmu wallet create --save <name>`, then `cmu wallet use <name>`",
    );
    const session = readSession();
    expect(stdout()).toEqual([
      "New CointMU wallet",
      "===========================",
      `Address : ${session.address}`,
      "===========================",
      "Session encrypted and saved.",
      "Active network: local",
      "\n\x1b[33mwarning:\x1b[0m the private key and mnemonic were not printed - this wallet",
      "exists only inside .cmu-session. Lose that file or its password and the funds",
      "in it cannot be recovered.",
      "\x1b[2mhint:\x1b[0m run `cmu wallet create` without --login for a printed backup.\n",
      DEPLOY_LINE,
    ]);
    expectNoKeyLeak([decryptSessionKey(PASSWORD, session)]);
  });

  describe.each([[["login"]], [["create", "--login"]]])(
    "through the commander action: %j",
    (argv) => {
      let exit: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        exit = vi
          .spyOn(process, "exit")
          .mockImplementation((() => undefined) as never);
      });

      it("exits as before on success", async () => {
        const { walletCommand } = await walletCommands(LOGIN_ANSWERS);
        await walletCommand.parseAsync(argv, { from: "user" });

        expect(exit).not.toHaveBeenCalled();
        expect(stderr()).toContain("is deprecated");
        expect(stdout().join("\n")).not.toContain("deprecated");
        expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(true);
      });

      it("exits 1 without a terminal, still warning on stderr", async () => {
        process.stdin.isTTY = false;
        const { walletCommand } = await walletCommands();
        await walletCommand.parseAsync(argv, { from: "user" });

        expect(exit).toHaveBeenCalledWith(1);
        expect(stderr()).toContain("is deprecated");
        expect(stderr()).toContain("non-interactive session");
        expect(stdout().join("\n")).not.toContain("deprecated");
      });
    },
  );
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

// Issue #179: `wallet transfer` moves funds, so its inputs are parsed more
// strictly than ethers does on its own (isAddress takes ICAP and bare hex;
// parseEther takes "-1", "0", "1." and ".5").

describe("transfer recipient parsing", () => {
  const lower = ADDRESS_A.toLowerCase();

  it.each([
    ["too short", "0x123"],
    ["no 0x prefix", ADDRESS_A.slice(2)],
    ["uppercase 0X prefix", `0X${ADDRESS_A.slice(2)}`],
    ["an ICAP address", "XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS"],
    ["an ENS name", "vitalik.eth"],
    ["leading space", ` ${ADDRESS_A}`],
    ["trailing newline", `${ADDRESS_A}\n`],
    ["empty", ""],
  ])("rejects %s", async (_, to) => {
    const { parseTransferAddress } = await walletCommands();
    await expect(parseTransferAddress(to)).rejects.toThrow("invalid recipient");
  });

  it("rejects a mixed-case address with a wrong checksum", async () => {
    const { parseTransferAddress } = await walletCommands();
    const typo = ADDRESS_A.replace("C51", "c51");
    await expect(parseTransferAddress(typo)).rejects.toThrow(
      "bad address checksum",
    );
  });

  it.each([
    ["checksummed", ADDRESS_A],
    ["all lowercase", lower],
    ["all uppercase", `0x${ADDRESS_A.slice(2).toUpperCase()}`],
  ])("accepts %s and returns the checksummed form", async (_, to) => {
    const { parseTransferAddress } = await walletCommands();
    await expect(parseTransferAddress(to)).resolves.toBe(ADDRESS_A);
  });
});

describe("transfer amount parsing", () => {
  it.each([
    "0",
    "0.0",
    "000",
    "-1",
    "+1",
    "1e3",
    "0x10",
    "1_000",
    " 1",
    "1 ",
    "1,5",
    "",
    ".",
    "1.",
    ".5",
    "Infinity",
    "NaN",
    "１",
    // An unescaped dot in the pattern would let these through.
    "1x5",
    // An end anchor that matched before a trailing newline would too.
    "1.5\n",
  ])("rejects %j", async (amount) => {
    const { parseTransferAmount } = await walletCommands();
    await expect(parseTransferAmount(amount)).rejects.toThrow(
      /invalid amount|greater than 0/,
    );
  });

  it("rejects more than 18 decimals with its own message", async () => {
    const { parseTransferAmount } = await walletCommands();
    await expect(parseTransferAmount("1.0000000000000000001")).rejects.toThrow(
      "more than 18 decimals",
    );
  });

  it.each([
    ["0.000000000000000001", 1n],
    ["1.5", 1500000000000000000n],
    ["00.5", 500000000000000000n],
    ["10", 10000000000000000000n],
  ])("accepts %j as %s wei", async (amount, wei) => {
    const { parseTransferAmount } = await walletCommands();
    await expect(parseTransferAmount(amount)).resolves.toBe(wei);
  });
});

describe("wallet transfer", () => {
  const TO = ADDRESS_B;
  const TX_HASH = `0x${"ab".repeat(32)}`;
  const GWEI = 1_000_000_000n;
  const ETH = 10n ** 18n;
  const AMOUNT_WEI = 1_500_000_000_000_000_000n; // "1.5"
  const MAX_FEE_1559 = 21_000n * 3n * GWEI;

  let sendTransaction: ReturnType<typeof vi.fn>;
  let wait: ReturnType<typeof vi.fn>;
  let asked: string[];

  type Chain = {
    balance: bigint;
    feeData: [bigint | null, bigint | null, bigint | null];
    code: string;
    gas: bigint;
    networkError?: Error;
    estimateError?: Error;
    sendError?: Error;
    refuse?: boolean;
    wait?: () => Promise<unknown>;
  };

  /**
   * Stubs the provider and the signer. With `refuse`, signing throws: the
   * refusal tests also assert it was never reached, which is the only proof
   * that nothing was signed.
   */
  async function mockChain(over: Partial<Chain> = {}): Promise<void> {
    const { ethers } = await import("ethers");
    const chain: Chain = {
      balance: 10n * ETH,
      // gasPrice, maxFeePerGas, maxPriorityFeePerGas
      feeData: [2n * GWEI, 3n * GWEI, 1n * GWEI],
      code: "0x",
      gas: 21_000n,
      ...over,
    };
    const P = ethers.JsonRpcProvider.prototype;
    vi.spyOn(P, "getNetwork").mockImplementation(async () => {
      if (chain.networkError) throw chain.networkError;
      return new ethers.Network("local", 1912n);
    });
    vi.spyOn(P, "getBalance").mockImplementation(async () => chain.balance);
    vi.spyOn(P, "getFeeData").mockImplementation(
      async () => new ethers.FeeData(...chain.feeData),
    );
    vi.spyOn(P, "getCode").mockImplementation(async () => chain.code);
    vi.spyOn(P, "estimateGas").mockImplementation(async () => {
      if (chain.estimateError) throw chain.estimateError;
      return chain.gas;
    });
    wait = vi.fn(chain.wait ?? (async () => ({ blockNumber: 42 })));
    sendTransaction = vi.fn(async () => {
      if (chain.refuse) throw new Error("must not sign");
      if (chain.sendError) throw chain.sendError;
      return { hash: TX_HASH, wait };
    });
    vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockImplementation(
      sendTransaction as never,
    );
  }

  /**
   * A fresh SUT whose prompts answer by question name. A question with no
   * answer fails the test, and every question asked is recorded, so a test
   * can prove which prompts ran - or that none did.
   */
  async function transferCommands(answers: Record<string, unknown> = {}) {
    vi.resetModules();
    asked = [];
    vi.doMock("inquirer", () => ({
      default: {
        prompt: async (questions: { name: string }[]) => {
          const result: Record<string, unknown> = {};
          for (const { name } of questions) {
            asked.push(name);
            if (!(name in answers))
              throw new Error(`unexpected prompt '${name}'`);
            if (answers[name] instanceof Error) throw answers[name];
            result[name] = answers[name];
          }
          return result;
        },
      },
    }));
    return import("../../src/commands/wallet");
  }

  const YES_ANSWERS = { password: PASSWORD, proceed: true };

  async function transfer(
    { to = TO, amount = "1.5", yes = false } = {},
    answers: Record<string, unknown> = YES_ANSWERS,
  ) {
    const { runWalletTransfer } = await transferCommands(answers);
    return runWalletTransfer(to, amount, { yes });
  }

  /** Runs the real commander action, with process.exit spied. */
  async function transferCli(
    argv: string[],
    answers: Record<string, unknown> = YES_ANSWERS,
  ) {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { walletCommand } = await transferCommands(answers);
    await walletCommand.parseAsync(["transfer", ...argv], { from: "user" });
    return exit;
  }

  function ctrlC(): Error {
    return Object.assign(
      new Error("User force closed the prompt with 0 null"),
      {
        name: "ExitPromptError",
      },
    );
  }

  function sentRequest(): Record<string, unknown> {
    return sendTransaction.mock.calls[0][0] as Record<string, unknown>;
  }

  beforeEach(async () => {
    // A port nothing listens on: every provider call is stubbed, and one
    // that slipped through must not reach a real devnet.
    writeNetworks(["local"]);
    await save("deployer");
    await use("deployer");
    logged = [];
  });

  describe("input routes", () => {
    it("TTY, confirmed: sends exactly what the summary showed", async () => {
      await mockChain();

      await expect(transfer()).resolves.toBe(0);

      expect(asked).toEqual(["password", "proceed"]);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(sentRequest()).toEqual({
        to: TO,
        value: AMOUNT_WEI,
        gasLimit: 21_000n,
        type: 2,
        maxFeePerGas: 3n * GWEI,
        maxPriorityFeePerGas: 1n * GWEI,
      });
      expect(sendTransaction.mock.contexts[0]).toMatchObject({
        address: ADDRESS_A,
      });
      expect(output()).toContain("Network : local (chain ID 1912)");
      expect(output()).toContain(
        `From    : ${ADDRESS_A} (.cmu-session, saved as 'deployer')`,
      );
      expect(output()).toContain(`To      : ${TO}`);
      expect(output()).toContain(`Amount  : 1.5 ETH (${AMOUNT_WEI} wei)`);
      expect(output()).toContain("Max fee : 0.000063 ETH");
      expectNoKeyLeak();
    });

    it("TTY, declined: aborts and sends nothing", async () => {
      await mockChain({ refuse: true });

      await expect(
        transfer({}, { password: PASSWORD, proceed: false }),
      ).rejects.toThrow("aborted: nothing was sent");

      expect(asked).toEqual(["password", "proceed"]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("TTY, Ctrl-C at the confirmation: sends nothing", async () => {
      await mockChain({ refuse: true });

      await expect(
        transfer({}, { password: PASSWORD, proceed: ctrlC() }),
      ).rejects.toThrow("aborted: nothing was sent");
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("TTY, Ctrl-C at the password: sends nothing", async () => {
      await mockChain({ refuse: true });

      await expect(transfer({}, { password: ctrlC() })).rejects.toThrow(
        "aborted: nothing was sent",
      );
      expect(asked).toEqual(["password"]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("TTY with --yes: asks for the password only, then sends", async () => {
      await mockChain();

      await expect(
        transfer({ yes: true }, { password: PASSWORD }),
      ).resolves.toBe(0);
      expect(asked).toEqual(["password"]);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["with --yes", true],
      ["without --yes", false],
    ])(
      "non-TTY %s: refuses at the password, prompts nothing, sends nothing",
      async (_, yes) => {
        await mockChain({ refuse: true });
        process.stdin.isTTY = false;

        await expect(transfer({ yes })).rejects.toThrow(
          "non-interactive session",
        );
        expect(asked).toEqual([]);
        expect(sendTransaction).not.toHaveBeenCalled();
      },
    );
  });

  // --yes skips the one confirmation question and nothing else.
  describe("--yes does not bypass validation", () => {
    async function expectRefused(
      args: { to?: string; amount?: string },
      message: string | RegExp,
    ) {
      await mockChain({ refuse: true });
      await expect(transfer({ ...args, yes: true })).rejects.toThrow(message);
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    }

    it.each([
      "0x123",
      ADDRESS_B.slice(2),
      `0X${ADDRESS_B.slice(2)}`,
      "XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS",
      "vitalik.eth",
      ` ${ADDRESS_B}`,
    ])("invalid recipient %j", (to) =>
      expectRefused({ to }, "invalid recipient"),
    );

    it("recipient with a wrong checksum", () =>
      expectRefused(
        { to: ADDRESS_B.replace("C44", "c44") },
        "bad address checksum",
      ));

    it.each([
      "0",
      "0.0",
      "-1",
      "+1",
      "1e3",
      "0x10",
      "1_000",
      " 1",
      "1,5",
      "",
      ".",
      "1.",
      ".5",
      "Infinity",
      "１",
      "1x5",
      "1.5\n",
    ])("invalid amount %j", (amount) =>
      expectRefused({ amount }, /invalid amount|greater than 0/),
    );

    it("amount with 19 decimals", () =>
      expectRefused(
        { amount: "1.0000000000000000001" },
        "more than 18 decimals",
      ));

    it("balance below the amount", async () => {
      await mockChain({ refuse: true, balance: AMOUNT_WEI - 1n });
      await expect(transfer({ yes: true })).rejects.toThrow(
        "insufficient balance",
      );
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("balance that covers the amount but not the max fee", async () => {
      await mockChain({
        refuse: true,
        balance: AMOUNT_WEI + MAX_FEE_1559 - 1n,
      });
      await expect(transfer({ yes: true })).rejects.toThrow(
        "covers the amount but not the max fee",
      );
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("the zero address", async () => {
      await mockChain({ refuse: true });
      await expect(
        transfer({
          to: "0x0000000000000000000000000000000000000000",
          yes: true,
        }),
      ).rejects.toThrow("--yes does not cover sending to the zero address");
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("recipients", () => {
    it.each([
      ["all lowercase", ADDRESS_B.toLowerCase()],
      ["all uppercase", `0x${ADDRESS_B.slice(2).toUpperCase()}`],
    ])("accepts %s and sends to the checksummed form", async (_, to) => {
      await mockChain();
      await transfer({ to });
      expect(sentRequest().to).toBe(ADDRESS_B);
    });

    it("warns that the zero address burns, then asks", async () => {
      await mockChain();
      await transfer({ to: "0x0000000000000000000000000000000000000000" });
      expect(output()).toContain("burned and cannot be recovered");
      expect(asked).toEqual(["password", "proceed"]);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("warns when sending to itself", async () => {
      await mockChain();
      await transfer({ to: ADDRESS_A, yes: true }, { password: PASSWORD });
      expect(output()).toContain("is the sending wallet");
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("warns when the recipient is a contract", async () => {
      await mockChain({ code: "0x6080604052" });
      await transfer({ yes: true }, { password: PASSWORD });
      expect(output()).toContain("is a contract");
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("refuses a contract that rejects the transfer, before any prompt", async () => {
      await mockChain({
        refuse: true,
        code: "0x6080604052",
        estimateError: new Error("execution reverted"),
      });
      await expect(transfer()).rejects.toThrow("would reject this transfer");
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("amount and balance", () => {
    it("sends the smallest amount, 1 wei", async () => {
      await mockChain();
      await transfer({ amount: "0.000000000000000001" });
      expect(sentRequest().value).toBe(1n);
    });

    it("accepts a balance of exactly amount + max fee", async () => {
      await mockChain({ balance: AMOUNT_WEI + MAX_FEE_1559 });
      await expect(transfer()).resolves.toBe(0);
    });
  });

  describe("fees", () => {
    it("legacy fee data: sends type 0 with gasPrice", async () => {
      await mockChain({ feeData: [2n * GWEI, null, null] });
      await transfer();
      expect(sentRequest()).toEqual({
        to: TO,
        value: AMOUNT_WEI,
        gasLimit: 21_000n,
        type: 0,
        gasPrice: 2n * GWEI,
      });
      expect(output()).toContain("Max fee : 0.000042 ETH");
    });

    it("refuses when the node returns no fee data", async () => {
      await mockChain({ refuse: true, feeData: [null, null, null] });
      await expect(transfer()).rejects.toThrow("no fee data");
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("after sending", () => {
    it("prints the block and the new balance in the balance format", async () => {
      await mockChain();
      await transfer();
      expect(output()).toContain(`Tx hash : ${TX_HASH}`);
      expect(output()).toContain("Block   : 42");
      expect(output()).toMatch(/Balance : 10\.0 ETH/);
    });

    it("waits for 1 confirmation with the named timeout", async () => {
      await mockChain();
      const { TRANSFER_CONFIRM_TIMEOUT_MS } = await transferCommands();
      await transfer();
      expect(wait).toHaveBeenCalledWith(1, TRANSFER_CONFIRM_TIMEOUT_MS);
    });

    it("prints the hash before waiting, and reports a timeout", async () => {
      const { ethers } = await import("ethers");
      let printedBeforeWait = "";
      await mockChain({
        wait: async () => {
          printedBeforeWait = output();
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });

      await expect(transfer()).resolves.toBe(2);

      expect(printedBeforeWait).toContain(TX_HASH);
      expect(output()).toContain("was sent but is not in a block after 120s");
      expect(output()).toContain("cmu mine start");
      expectNoKeyLeak();
    });
  });

  // The only proof of exit code 2: the devnet automines, so a smoke test
  // cannot make a confirmation time out.
  describe("exit codes through the commander action", () => {
    it("0 when sent and confirmed", async () => {
      await mockChain();
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(0);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it("2 when sent but not confirmed in time", async () => {
      const { ethers } = await import("ethers");
      await mockChain({
        wait: async () => {
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(2);
      expect(exit).not.toHaveBeenCalledWith(0);
    });

    it("2 when sent but the confirmation cannot be checked", async () => {
      await mockChain({
        wait: async () => {
          throw new Error("socket hang up");
        },
      });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(2);
    });

    it("1 when the transaction reverts", async () => {
      const { ethers } = await import("ethers");
      await mockChain({
        wait: async () => {
          throw ethers.makeError(
            "transaction execution reverted",
            "CALL_EXCEPTION",
          );
        },
      });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(1);
      expect(output()).toContain("was mined but reverted");
    });

    it("1 when refused, via the tf alias and -y", async () => {
      await mockChain({ refuse: true });
      const exit = await transferCli(["-y", TO, "1."], {});
      expect(exit).toHaveBeenCalledWith(1);
      expect(output()).toContain("wallet transfer failed");
      expect(sendTransaction).not.toHaveBeenCalled();

      logged = [];
      vi.resetModules();
      const { walletCommand } = await transferCommands({});
      await walletCommand.parseAsync(["tf", "-y", TO, "1."], { from: "user" });
      expect(output()).toContain("invalid amount");
    });

    it("1 when sending throws, with the may-have-been-broadcast hint", async () => {
      await mockChain({ sendError: new Error("socket hang up") });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(1);
      expect(output()).toContain("may still have been broadcast");
    });
  });

  describe("environment", () => {
    it("fails clearly when the node is down, without prompting", async () => {
      await mockChain({
        refuse: true,
        networkError: new Error("connect ECONNREFUSED"),
      });
      await expect(transfer()).rejects.toThrow("unreachable");
      expect(asked).toEqual([]);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("fails without a session", async () => {
      fs.rmSync(path.join(tmpDir, ".cmu-session"));
      await mockChain({ refuse: true });
      await expect(transfer()).rejects.toThrow("no active session");
      expect(asked).toEqual([]);
    });

    it("fails on a session without an encrypted key", async () => {
      writeSession("local");
      await mockChain({ refuse: true });
      await expect(transfer()).rejects.toThrow("holds no encrypted key");
      expect(asked).toEqual([]);
    });

    it("ignores PRIVATE_KEY, says so, and never prints its value", async () => {
      vi.stubEnv("PRIVATE_KEY", KEY_B);
      await mockChain();

      await transfer();

      expect(output()).toContain("PRIVATE_KEY is set");
      expect(sendTransaction.mock.contexts[0]).toMatchObject({
        address: ADDRESS_A,
      });
      expect(output()).toContain(`From    : ${ADDRESS_A}`);
      expectNoKeyLeak();
    });

    it("refuses a session whose address does not match its key", async () => {
      const session = readSession();
      session.address = ADDRESS_B;
      fs.writeFileSync(
        path.join(tmpDir, ".cmu-session"),
        JSON.stringify(session),
      );
      await mockChain({ refuse: true });

      await expect(transfer()).rejects.toThrow("has been modified");
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("no key or password leaks", () => {
    beforeEach(() => {
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    });

    it.each([
      ["a wrong password", {}, { password: "wrong password 1", proceed: true }],
      [
        "a failed send",
        { sendError: new Error("socket hang up") },
        YES_ANSWERS,
      ],
    ])("through --verbose after %s", async (_, chain, answers) => {
      await mockChain(chain as Partial<Chain>);
      const { fail } = await import("../../src/utils/errors");
      const { runWalletTransfer } = await transferCommands(answers);

      await runWalletTransfer(TO, "1.5").catch(
        fail("wallet transfer", { verbose: true }),
      );

      expect(output()).toContain("wallet transfer failed");
      expectNoKeyLeak();
    });
  });
});
