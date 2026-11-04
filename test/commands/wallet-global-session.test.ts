import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ADDRESS_A,
  ADDRESS_B,
  asked,
  cd,
  dirs,
  filesIn,
  KEY_A,
  KEY_B,
  outcome,
  output,
  PASSWORD,
  readJson,
  readText,
  runNetwork,
  sessionIn,
  setUp,
  tearDown,
  walletInfoSut,
  walletSut,
  writeCbcSession,
  writeLegacyGcmSession,
  writeNetworks,
  writeSession,
  writeWallets,
} from "../helpers/globalSessionEnv";

// `wallet use` writes the session in effect - the folder's .cmu-session when
// there is one, else ~/.cmu-session - and `--local` writes the folder's on
// purpose. Every confirmation, backup and hint is about the file written.
// Commands run through outcome(), so a mutant that makes one throw fails an
// assertion instead of crashing the test.

const OWNER_ONLY = 0o600;
const MODE_BITS = 0o777;
const GLOBAL = "~/.cmu-session";
const LOCAL = "./.cmu-session";

beforeEach(() => {
  setUp();
  writeWallets([
    { name: "a", address: ADDRESS_A, key: KEY_A },
    { name: "b", address: ADDRESS_B, key: KEY_B },
  ]);
});
afterEach(tearDown);

async function use(name: string, options = {}, answers = {}): Promise<void> {
  const { runWalletUse } = await walletSut({ password: PASSWORD, ...answers });
  await runWalletUse(name, options);
}

async function info(): Promise<string> {
  const { runWalletInfo } = await walletInfoSut();
  return outcome(runWalletInfo());
}

function text(dir: string): string {
  return readText(sessionIn(dir));
}

function backupsIn(dir: string): string[] {
  return filesIn(dir).filter((f) => f.startsWith(".cmu-session.bak-"));
}

describe("one wallet use for every folder", () => {
  it("makes a wallet chosen in one project active in another, without using it again", async () => {
    expect(await outcome(use("a"))).toBe("done");

    cd(dirs.projectB);

    expect(await info()).toBe("done");
    expect(output()).toContain(`Address      : ${ADDRESS_A}`);
    expect(output()).toContain(`Session file : ${GLOBAL}`);
  });

  it("writes ~/.cmu-session in a folder without its own, and says so", async () => {
    expect(await outcome(use("a"))).toBe("done");

    expect(readJson(sessionIn(dirs.home)).address).toBe(ADDRESS_A);
    expect(fs.existsSync(sessionIn(dirs.projectA))).toBe(false);
    expect(output()).toContain(`Session: ${GLOBAL}`);
  });

  it("writes the folder's own .cmu-session when it has one, leaving the global alone", async () => {
    const global = writeSession(dirs.home, ADDRESS_A, KEY_A);
    writeSession(dirs.projectA, ADDRESS_A, KEY_A);

    expect(await outcome(use("b"))).toBe("done");

    expect(readJson(sessionIn(dirs.projectA)).address).toBe(ADDRESS_B);
    expect(text(dirs.home)).toBe(global);
    expect(output()).toContain(`Session: ${LOCAL}`);
  });

  it.skipIf(process.platform === "win32")(
    "writes ~/.cmu-session owner-only",
    async () => {
      expect(await outcome(use("a"))).toBe("done");

      expect(fs.existsSync(sessionIn(dirs.home))).toBe(true);
      const mode = fs.statSync(sessionIn(dirs.home)).mode & MODE_BITS;
      expect(mode).toBe(OWNER_ONLY);
    },
  );

  it("leaves no temp file in the home directory or the folder", async () => {
    expect(await outcome(use("a"))).toBe("done");

    expect(filesIn(dirs.home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(filesIn(dirs.projectA)).toEqual([]);
  });

  it("refuses without a terminal and writes nothing", async () => {
    process.stdin.isTTY = false;

    expect(await outcome(use("a"))).toMatch(/cannot prompt for a password/);

    expect(fs.existsSync(sessionIn(dirs.home))).toBe(false);
  });
});

describe("a folder's override", () => {
  it("wins over the global session", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A);
    writeSession(dirs.projectB, ADDRESS_B, KEY_B);

    cd(dirs.projectB);

    expect(await info()).toBe("done");
    expect(output()).toContain(`Address      : ${ADDRESS_B}`);
    expect(output()).toContain(`Session file : ${LOCAL}`);
  });

  it("keeps working when an older cmu wrote it", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A);
    writeLegacyGcmSession(dirs.projectB, ADDRESS_B, KEY_B);

    cd(dirs.projectB);

    expect(await info()).toBe("done");
    expect(output()).toContain(`Address      : ${ADDRESS_B}`);
  });

  it("is created by --local, and the global session stays as it was", async () => {
    const global = writeSession(dirs.home, ADDRESS_A, KEY_A);
    cd(dirs.projectB);

    expect(await outcome(use("b", { local: true }))).toBe("done");

    expect(readJson(sessionIn(dirs.projectB)).address).toBe(ADDRESS_B);
    expect(text(dirs.home)).toBe(global);
    expect(output()).toContain(`Session: ${LOCAL}`);
    cd(dirs.projectA);
    expect(await info()).toBe("done");
    expect(output()).toContain(`Address      : ${ADDRESS_A}`);
  });

  it("starts from the network the global session had picked", async () => {
    writeNetworks(["local", "testnet"]);
    writeSession(dirs.home, ADDRESS_A, KEY_A, "testnet");

    expect(await outcome(use("b", { local: true }))).toBe("done");

    expect(readJson(sessionIn(dirs.projectA)).activeNetwork).toBe("testnet");
  });

  it("--local never asks about a key only the global session holds", async () => {
    // ADDRESS_B is not a saved wallet here, so replacing ~/.cmu-session would
    // ask - but --local does not replace it.
    writeWallets([{ name: "a", address: ADDRESS_A, key: KEY_A }]);
    const global = writeSession(dirs.home, ADDRESS_B, KEY_B);

    const result = await outcome(use("a", { local: true }));

    expect(asked).toEqual(["password"]);
    expect(result).toBe("done");
    expect(text(dirs.home)).toBe(global);
    expect(readJson(sessionIn(dirs.projectA)).address).toBe(ADDRESS_A);
  });
});

describe("replacing a key that is not saved", () => {
  beforeEach(() => {
    writeWallets([{ name: "a", address: ADDRESS_A, key: KEY_A }]);
  });

  it("asks about ~/.cmu-session, by name, before writing it", async () => {
    const global = writeSession(dirs.home, ADDRESS_B, KEY_B);

    expect(await outcome(use("a", {}, { replace: false }))).toBe(
      `aborted: ${GLOBAL} was not changed; it still holds ${ADDRESS_B}.`,
    );

    expect(output()).toContain(
      `${GLOBAL} holds the key for ${ADDRESS_B}, which is not a saved wallet.`,
    );
    expect(text(dirs.home)).toBe(global);
  });

  it("asks about the folder's override, by name, when that is the one written", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A);
    const local = writeSession(dirs.projectA, ADDRESS_B, KEY_B);

    expect(await outcome(use("a", {}, { replace: false }))).toBe(
      `aborted: ${LOCAL} was not changed; it still holds ${ADDRESS_B}.`,
    );

    expect(text(dirs.projectA)).toBe(local);
  });

  it("backs ~/.cmu-session up next to itself", async () => {
    const global = writeCbcSession(dirs.home, ADDRESS_B, KEY_B);

    expect(await outcome(use("a", {}, { replace: true }))).toBe("done");

    const backups = backupsIn(dirs.home);
    expect(backups).toHaveLength(1);
    expect(readText(path.join(dirs.home, backups[0]))).toBe(global);
    expect(backupsIn(dirs.projectA)).toEqual([]);
    expect(output()).toContain(
      `If you replace it, cmu keeps a copy as ${GLOBAL}.bak-<time> first.`,
    );
    expect(output()).toContain(`Kept the old session as ${GLOBAL}.bak-`);
    expect(output()).not.toContain(".gitignore");
  });

  it("backs the folder's override up in the folder, with the git hint", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A);
    writeCbcSession(dirs.projectA, ADDRESS_B, KEY_B);

    expect(await outcome(use("a", {}, { replace: true }))).toBe("done");

    expect(backupsIn(dirs.projectA)).toHaveLength(1);
    expect(backupsIn(dirs.home)).toEqual([]);
    expect(output()).toContain(`Kept the old session as ${LOCAL}.bak-`);
    expect(output()).toContain(".gitignore");
  });
});

describe("network use", () => {
  beforeEach(() => writeNetworks(["local", "testnet"]));

  it("switches the network in ~/.cmu-session, for every folder without its own", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A);

    expect(await outcome(runNetwork("use", "testnet"))).toBe("done");

    expect(readJson(sessionIn(dirs.home)).activeNetwork).toBe("testnet");
    expect(output()).toContain(`Active network is now testnet (${GLOBAL})`);
  });

  it("switches it only in the folder's override when there is one", async () => {
    const global = writeSession(dirs.home, ADDRESS_A, KEY_A);
    writeSession(dirs.projectA, ADDRESS_B, KEY_B);

    expect(await outcome(runNetwork("use", "testnet"))).toBe("done");

    expect(readJson(sessionIn(dirs.projectA)).activeNetwork).toBe("testnet");
    expect(text(dirs.home)).toBe(global);
    expect(output()).toContain(`Active network is now testnet (${LOCAL})`);
  });
});

describe("the other wallet commands name the session they read", () => {
  it("save --session keeps the key of ~/.cmu-session from any folder", async () => {
    writeWallets([{ name: "a", address: ADDRESS_A, key: KEY_A }]);
    writeSession(dirs.home, ADDRESS_B, KEY_B);
    cd(dirs.projectB);
    const { runWalletSave } = await walletSut();

    expect(await outcome(runWalletSave("keep", { session: true }))).toBe(
      "done",
    );

    expect(output()).toContain(
      `Saved wallet 'keep' (${ADDRESS_B}) from ${GLOBAL}.`,
    );
  });

  it("delete says which session keeps its copy", async () => {
    expect(await outcome(use("a"))).toBe("done");
    const { runWalletDelete } = await walletSut();

    expect(await outcome(runWalletDelete("a", { yes: true }))).toBe("done");

    expect(output()).toContain(`${GLOBAL} keeps its own copy and still works.`);
  });
});
