import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { decryptSessionKey } from "../../src/utils/session";
import {
  PASSWORD,
  tmpDir,
  logged,
  everything,
  useRealPbkdf2,
  output,
  clearLogged,
  KEY_B,
  walletsFile,
  readWallets,
  expectNoKeyLeak,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { mockPrompt, walletCommands, save } from "../helpers/walletSut";

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
