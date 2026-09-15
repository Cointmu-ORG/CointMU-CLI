import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decryptSessionKey, type SessionData } from "../../src/utils/session";

// Issue #87 (c): `wallet create` printed a private key and mnemonic to stdout,
// where they survive in scrollback, tmux logs and CI output. --login encrypts
// the generated key into a session without printing anything recoverable.

const PASSWORD = "correct horse 9";

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
});

afterEach(() => {
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
