import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { stripVTControlCharacters } from "util";
import { decryptSessionKey, type SessionData } from "../../src/utils/session";
import {
  PASSWORD,
  KEY,
  tmpDir,
  logged,
  everything,
  useRealPbkdf2,
  output,
  clearLogged,
  readSession,
  writeSession,
  writeNetworks,
  KEY_B,
  ADDRESS_A,
  ADDRESS_B,
  walletsFile,
  readWallets,
  sessionFile,
  writeKeySession,
  expectNoKeyLeak,
  SESSION_HINT,
  storeHint,
  hintOf,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import {
  mockPrompt,
  walletCommands,
  asked,
  questions,
  askingCommands,
  ctrlC,
  save,
  use,
  type Commands,
} from "../helpers/walletSut";
import {
  TO,
  TX_HASH,
  GWEI,
  AMOUNT_WEI,
  MAX_FEE_1559,
  sendTransaction,
  wait,
  send,
  type Chain,
  mockChain,
  YES_ANSWERS,
  transfer,
  transferCli,
  sentRequest,
  transferSetUp,
} from "../helpers/walletTransfer";

beforeEach(setUp);
afterEach(tearDown);

// Issue #87 (c): `wallet create` printed a private key and mnemonic to stdout,
// where they survive in scrollback, tmux logs and CI output. --save encrypts
// the generated key into the store and prints only the mnemonic backup.

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
    // #194: points at named wallets, and never at the removed login.
    expect(output()).toContain("`cmu wallet create --save <name>`");
    expect(output()).toContain("`cmu wallet use <name>`");
    expect(output()).toContain("cmu wallet save <name>");
    expect(output()).not.toContain("login");
    expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(false);
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
    useRealPbkdf2();
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
    clearLogged();
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
    clearLogged();
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
});

// Issue #194: `login` and `create --login` were deprecated in 1.5.0 and removed
// in 1.6.0. A script still calling them gets one line naming the replacement,
// and nothing else happens first: no prompt, no session read, no new key.

const REMOVED =
  "removed; use wallet save + wallet use (or wallet create --save)";

describe("removed login paths", () => {
  describe.each([
    [["login"]],
    [["login", "extra", "--foo"]],
    [["create", "--login"]],
    [["create", "--login", "--save", "alice"]],
  ])("%j", (argv) => {
    it.each([true, false])(
      "exits 1 with the removal message before anything else (TTY: %s)",
      async (isTTY) => {
        const before = writeKeySession(ADDRESS_B);
        process.stdin.isTTY = isTTY;
        const { ethers } = await import("ethers");
        const createRandom = vi.spyOn(ethers.Wallet, "createRandom");
        const exit = vi
          .spyOn(process, "exit")
          .mockImplementation((() => undefined) as never);
        const { walletCommand } = await askingCommands();

        await walletCommand.parseAsync(argv, { from: "user" });

        expect(exit.mock.calls).toEqual([[1]]);
        expect(vi.mocked(console.error).mock.calls.flat()).toContain(REMOVED);
        expect(console.log).not.toHaveBeenCalled();
        expect(asked).toEqual([]);
        expect(output()).not.toContain("not a saved wallet");
        expect(createRandom).not.toHaveBeenCalled();
        expect(fs.readFileSync(sessionFile(), "utf8")).toBe(before);
        expect(fs.existsSync(walletsFile())).toBe(false);
        expectNoKeyLeak();
      },
    );
  });

  it("leaves both out of the help", async () => {
    const { walletCommand } = await walletCommands();
    const create = walletCommand.commands.find((c) => c.name() === "create");

    expect(walletCommand.helpInformation()).not.toMatch(/login/i);
    expect(create?.helpInformation()).toContain("--save <name>");
    expect(create?.helpInformation()).not.toMatch(/login/i);
  });

  // One check for every hint, present and future: the only code (not comment)
  // lines in src/ that may say "login" are the stub's own.
  it("no hint in src/ names login", () => {
    const STUB = [
      /^const REMOVED_LOGIN =$/,
      /\.command\("login", \{ hidden: true \}\)/,
      /new Option\("--login"\)/,
      /fail\("wallet login"/,
      /options\.login/,
      /login\?: boolean/,
    ];
    const src = path.resolve(__dirname, "../../src");
    const offenders = fs
      .readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        fs
          .readFileSync(path.join(src, file), "utf8")
          .split("\n")
          .map((line, i) => ({ at: `${file}:${i + 1}`, line: line.trim() }))
          .filter(({ line }) => /login/i.test(line))
          .filter(({ line }) => !/^(\/\/|\/?\*)/.test(line))
          .filter(({ line }) => !STUB.some((re) => re.test(line))),
      );

    expect(offenders).toEqual([]);
  });
});

describe("wallet use", () => {
  it("writes a session for the wallet that opens with its password", async () => {
    await save("deployer");
    clearLogged();
    await use("deployer");

    const session = readSession();
    expect(session.address).toBe(ADDRESS_A);
    expect(session.activeNetwork).toBe("local");
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
    clearLogged();

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

  it("hints at the wallet's own password on a wrong one, not the session's", async () => {
    await save("deployer");

    const error = await use("deployer", "wrong password 1").catch(
      (e: Error) => e,
    );

    expect(hintOf(error)).toBe(storeHint("deployer"));
    expect((error as Error).message).not.toContain("wallet login");
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
});

// #182: login, create --login and use replaced a session whose key was saved
// nowhere else without asking. `use`, the one writer left since #194, must ask
// first - before any prompt for a password - and leave the file alone unless
// told yes. A session from 1.5.x `login` is exactly such a key.
describe("replacing an unsaved session", () => {
  const paths = {
    use: {
      answers: { password: PASSWORD },
      run: async (answers: Record<string, unknown>) =>
        (await askingCommands(answers)).runWalletUse("deployer"),
    },
  };

  /**
   * Makes any session write fail the test loudly, and returns the spy: a
   * refusal must not reach writeSessionFile at all.
   */
  function blockSessionWrites() {
    const write = vi.fn(async () => {
      throw new Error("writeSessionFile must not be called");
    });
    vi.doMock("../../src/utils/session", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/utils/session")>()),
      writeSessionFile: write,
    }));
    return write;
  }

  /** The refusal left the session byte-identical, with no temp file. */
  function expectUntouched(
    before: string,
    write: ReturnType<typeof blockSessionWrites>,
  ): void {
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(sessionFile(), "utf8")).toBe(before);
    expectNoKeyLeak();
  }

  beforeEach(async () => {
    await save("deployer"); // KEY, the key use writes
    clearLogged();
  });

  describe.each(Object.keys(paths) as (keyof typeof paths)[])(
    "%s",
    (pathName) => {
      const { answers, run } = paths[pathName];

      it("asks before any other prompt, and replaces the session on yes", async () => {
        writeKeySession(ADDRESS_B);

        await run({ ...answers, replace: true });

        expect(asked[0]).toBe("replace");
        expect(questions[0]).toMatchObject({
          type: "confirm",
          message: "Replace it anyway?",
          default: false,
        });
        expect(asked.length).toBeGreaterThan(1);
        expect(output()).toContain(
          `warning:\x1b[0m .cmu-session holds the key for ${ADDRESS_B}, which is not a saved wallet.`,
        );
        expect(output()).toContain("cannot recover it");
        expect(output()).toContain("`cmu wallet save <name> --session`");
        const session = readSession();
        expect(session.address).not.toBe(ADDRESS_B);
        expectNoKeyLeak([decryptSessionKey(PASSWORD, session)]);
      });

      it.each([
        [
          "no",
          false,
          `aborted: .cmu-session was not changed; it still holds ${ADDRESS_B}.`,
        ],
        ["Ctrl-C", ctrlC(), "force closed the prompt"],
      ])(
        "leaves the session untouched on %s, without prompting for a secret",
        async (_, replace, message) => {
          const before = writeKeySession(ADDRESS_B);
          const write = blockSessionWrites();

          await expect(run({ ...answers, replace })).rejects.toThrow(message);

          expect(asked).toEqual(["replace"]);
          expectUntouched(before, write);
        },
      );

      it("refuses without a terminal, before any prompt", async () => {
        const before = writeKeySession(ADDRESS_B);
        const write = blockSessionWrites();
        process.stdin.isTTY = false;

        const error = await run(answers).catch((e: Error) => e);

        expect((error as Error).message).toContain(
          "cannot prompt for confirmation in a non-interactive session",
        );
        expect((error as Error).message).toContain(
          "`cmu wallet save <name> --session`",
        );
        expect(asked).toEqual([]);
        expectUntouched(before, write);
      });

      it.each([
        ["there is no session", async () => {}],
        [
          "the session's key is saved",
          async () => {
            writeKeySession(ADDRESS_B);
            await save("b", KEY_B);
          },
        ],
        [
          "the session's key is saved, address in another case",
          async () => {
            writeKeySession(ADDRESS_B.toLowerCase());
            await save("b", KEY_B);
          },
        ],
        [
          "the session is corrupt",
          async () => fs.writeFileSync(sessionFile(), "{ not json"),
        ],
        ["the session holds no key", async () => writeSession("local")],
        [
          "the session predates AES-GCM",
          async () => writeKeySession(ADDRESS_B, KEY_B, { authTag: undefined }),
        ],
      ])("replaces silently when %s", async (_, setup) => {
        await setup();

        await run(answers); // no `replace` answer: asking would throw

        expect(asked).not.toContain("replace");
        expect(output()).not.toContain("not a saved wallet");
        const session = readSession();
        expect(session.address).not.toBe(ADDRESS_B);
        expect(decryptSessionKey(PASSWORD, session)).toMatch(
          /^0x[0-9a-f]{64}$/,
        );
      });

      it("refuses on an unreadable store, since the key's safety is unknown", async () => {
        const before = writeKeySession(ADDRESS_B);
        fs.writeFileSync(walletsFile(), "{");
        const write = blockSessionWrites();

        await expect(run(answers)).rejects.toThrow("not a valid wallets file");

        expect(asked).toEqual([]);
        expectUntouched(before, write);
      });
    },
  );

  describe("use, after yes", () => {
    it("leaves the session untouched on a wrong password", async () => {
      const before = writeKeySession(ADDRESS_B);
      const write = blockSessionWrites();

      await expect(
        paths.use.run({ replace: true, password: "wrong password 1" }),
      ).rejects.toThrow("wrong password for wallet 'deployer'");

      expect(asked).toEqual(["replace", "password"]);
      expectUntouched(before, write);
    });

    it("leaves the session untouched when the decrypted address does not match", async () => {
      const before = writeKeySession(ADDRESS_B);
      const file = readWallets();
      file.wallets[0].address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
      fs.writeFileSync(walletsFile(), JSON.stringify(file));
      const write = blockSessionWrites();

      await expect(
        paths.use.run({ replace: true, password: PASSWORD }),
      ).rejects.toThrow("has been modified");

      expect(asked).toEqual(["replace", "password"]);
      expectUntouched(before, write);
    });

    it("does not leak the key through --verbose after a refusal", async () => {
      writeKeySession(ADDRESS_B);
      const { fail } = await import("../../src/utils/errors");
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

      await paths.use
        .run({ replace: false, password: PASSWORD })
        .catch(fail("wallet use", { verbose: true }));

      expect(output()).toContain("wallet use failed");
      expect(output()).toContain("aborted");
      expectNoKeyLeak();
    });

    it("stays silent once the session key was kept with save --session", async () => {
      writeKeySession(ADDRESS_B);
      process.stdin.isTTY = false;
      await (await walletCommands()).runWalletSave("keep", { session: true });
      process.stdin.isTTY = true;

      await paths.use.run({ password: PASSWORD });

      expect(asked).toEqual(["password"]);
      expect(readSession().address).toBe(ADDRESS_A);
    });
  });
});

describe("wallet delete", () => {
  it("removes the entry after --yes", async () => {
    await save("a");
    await save("b", KEY_B);

    const { runWalletDelete, runWalletList } = await walletCommands();
    await runWalletDelete("a", { yes: true });
    clearLogged();
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
    clearLogged();

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

  // #188: one case per requireInteractive() call site. PRIVATE_KEY stands in
  // for a session key but cannot save, select or delete a wallet, so none may
  // suggest it; they either have a flag of their own or no way around a
  // terminal. (transfer: see its suite.)
  const TERMINAL = "hint: run this in a terminal.";
  it.each([
    [
      "create --save",
      TERMINAL,
      (m: Commands) => m.runWalletCreate({ save: "other" }),
    ],
    ["save", TERMINAL, (m: Commands) => m.runWalletSave("other")],
    ["use", TERMINAL, (m: Commands) => m.runWalletUse("deployer")],
    [
      "delete",
      "hint: re-run with --yes to delete without asking.",
      (m: Commands) => m.runWalletDelete("deployer"),
    ],
  ])("%s names the right way out", async (_, hint, run) => {
    const error = await run(await walletCommands()).catch((e: Error) => e);

    expect(hintOf(error)).toBe(hint);
    expect((error as Error).message).not.toContain("PRIVATE_KEY");
    expectNoKeyLeak();
  });

  it("use over an unsaved session names `save --session`, not PRIVATE_KEY", async () => {
    writeKeySession(ADDRESS_B);
    const { runWalletUse } = await walletCommands();

    const error = await runWalletUse("deployer").catch((e: Error) => e);

    expect(hintOf(error)).toBe(
      "hint: keep the key first with `cmu wallet save <name> --session`, or run this in a terminal to confirm.",
    );
    expect((error as Error).message).not.toContain("PRIVATE_KEY");
    expectNoKeyLeak();
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
  beforeEach(transferSetUp);

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

    // #194: a session left by 1.5.x `login` - a key saved nowhere else -
    // keeps signing with the session's password after the removal.
    it("TTY: signs from a session left by 1.5.x login", async () => {
      writeKeySession(ADDRESS_B, KEY_B);
      await mockChain();

      await expect(transfer({ to: ADDRESS_A })).resolves.toBe(0);

      expect(asked).toEqual(["password", "proceed"]);
      expect(sendTransaction.mock.contexts[0]).toMatchObject({
        address: ADDRESS_B,
      });
      expect(output()).toContain(`From    : ${ADDRESS_B} (.cmu-session)`);
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

    it("TTY, wrong password: hints at the session, sends nothing", async () => {
      await mockChain({ refuse: true });

      const error = await transfer(
        {},
        { password: "wrong password 1", proceed: true },
      ).catch((e: Error) => e);

      expect(hintOf(error)).toBe(SESSION_HINT);
      expect((error as Error).message).not.toContain("wallet login");
      expect(asked).toEqual(["password"]);
      expect(sendTransaction).not.toHaveBeenCalled();
      expectNoKeyLeak();
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

        const error = await transfer({ yes }).catch((e: Error) => e);

        expect((error as Error).message).toContain("non-interactive session");
        expect(hintOf(error)).toBe(
          "hint: transfer signs with the .cmu-session key and needs its password; run it in a terminal.",
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
      const { TRANSFER_CONFIRM_TIMEOUT_MS } = await askingCommands();
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
      expectNoKeyLeak();
    });
  });

  // The hint after a missed confirmation depends on what eth_mining says.
  describe("unconfirmed hint", () => {
    const OLD_HINT =
      "blocks only appear while something mines - `cmu mine start`";
    const RECHECK = "check `cmu wallet balance` before sending again";

    async function timeOut(mining?: () => Promise<unknown>): Promise<string> {
      const { ethers } = await import("ethers");
      await mockChain({
        mining,
        wait: async () => {
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });
      await expect(transfer()).resolves.toBe(2);
      expectNoKeyLeak();
      const hint = output()
        .split("\n")
        .find((l) => l.includes("hint:"));
      expect(hint).toBeDefined();
      expect(hint).toContain(RECHECK);
      expect(hint).not.toContain(OLD_HINT);
      return hint as string;
    }

    it("on the local DevNet (no eth_mining) points at the node, not at mining", async () => {
      const hint = await timeOut(async () => {
        throw Object.assign(new Error("could not coalesce error"), {
          code: "UNKNOWN_ERROR",
          error: { code: -32004, message: "Method is not supported" },
        });
      });
      expect(hint).toContain(
        "the local DevNet puts each transaction in a block",
      );
      expect(hint).toContain("`cmu node start`");
      expect(hint).not.toContain("cmu mine");
    });

    it("on a geth node that is not mining offers mine start with its etherbase cost", async () => {
      const hint = await timeOut(async () => false);
      expect(hint).toContain("`cmu mine status`");
      expect(hint).toContain(
        "`cmu mine start` would move the node's etherbase to your wallet for everyone",
      );
    });

    it("on a geth node that is mining says to wait, not to start mining", async () => {
      const hint = await timeOut(async () => true);
      expect(hint).toContain("this node is mining");
      expect(hint).toContain("ethash builds its DAG");
      expect(hint).not.toContain("cmu mine start");
    });

    it("falls back when eth_mining fails", async () => {
      const hint = await timeOut(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8585");
      });
      expect(hint).toContain("the node did not answer a follow-up check");
    });

    it("gives up on eth_mining after the probe timeout", async () => {
      const { ethers } = await import("ethers");
      const { MINING_PROBE_TIMEOUT_MS } = await askingCommands();
      await mockChain({
        mining: () => new Promise(() => {}),
        wait: async () => {
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = transfer();
        await vi.waitFor(() =>
          expect(send).toHaveBeenCalledWith("eth_mining", []),
        );
        await vi.advanceTimersByTimeAsync(MINING_PROBE_TIMEOUT_MS);
        await expect(result).resolves.toBe(2);
      } finally {
        vi.useRealTimers();
      }
      expect(output()).toContain("the node did not answer a follow-up check");
      expect(output()).toContain(RECHECK);
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

    it("2 when sent, not confirmed, and eth_mining fails too", async () => {
      const { ethers } = await import("ethers");
      await mockChain({
        mining: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:8585");
        },
        wait: async () => {
          throw ethers.makeError("wait for transaction timeout", "TIMEOUT");
        },
      });
      const exit = await transferCli([TO, "1.5"]);
      expect(exit).toHaveBeenCalledWith(2);
      expect(exit).toHaveBeenCalledTimes(1);
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

      clearLogged();
      vi.resetModules();
      const { walletCommand } = await askingCommands({});
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

    // The network here comes from .cmu-networks.json, not a cmu.config, so the
    // hint must send the user to `network save`, never to a config file.
    it("points a saved network with no url at network save, not a config file", async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".cmu-networks.json"),
        JSON.stringify([{ name: "local", rpcUrl: "" }]),
      );
      await mockChain({ refuse: true });

      const error = await transfer().catch((e: Error) => e);

      expect(stripVTControlCharacters((error as Error).message)).toBe(
        "network 'local' has no url.\n" +
          "hint: re-save it with `cmu network save <url> --name local`.",
      );
      expect(asked).toEqual([]);
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
      const { runWalletTransfer } = await askingCommands(answers);

      await runWalletTransfer(TO, "1.5").catch(
        fail("wallet transfer", { verbose: true }),
      );

      expect(output()).toContain("wallet transfer failed");
      expectNoKeyLeak();
    });
  });
});
