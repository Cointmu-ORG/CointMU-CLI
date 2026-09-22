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

/** Everything the command wrote to stdout and stderr, as one string. */
function output(): string {
  return logged.join("\n");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-wallet-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  logged = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  // networkStorage keys .cmu-networks.json off os.homedir(); without this the
  // suite would read the developer's real saved networks.
  vi.stubEnv("HOME", tmpDir);
  vi.stubEnv("USERPROFILE", tmpDir);
});

afterEach(() => {
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
