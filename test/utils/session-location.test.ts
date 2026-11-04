import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ADDRESS_A,
  ADDRESS_B,
  cd,
  dirs,
  filesIn,
  KEY_A,
  KEY_B,
  PASSWORD,
  readJson,
  sessionIn,
  sessionSut,
  locationSut,
  setUp,
  tearDown,
  writeCbcSession,
  writeLegacyGcmSession,
  writeSession,
} from "../helpers/globalSessionEnv";

const OWNER_ONLY = 0o600;
const MODE_BITS = 0o777;

// The active session is global (~/.cmu-session) and a folder may override it
// with its own .cmu-session. The override is read whenever it exists.

beforeEach(setUp);
afterEach(tearDown);

describe("where the session file is", () => {
  it("keeps the global session in the home directory", async () => {
    const { getGlobalSessionFilePath } = await locationSut();

    expect(getGlobalSessionFilePath()).toBe(sessionIn(dirs.home));
  });

  it("uses the global session in a folder without its own", async () => {
    const { getSessionFilePath } = await locationSut();

    expect(getSessionFilePath()).toBe(sessionIn(dirs.home));
  });

  it("uses the folder's own .cmu-session when there is one", async () => {
    writeSession(dirs.projectA, ADDRESS_B, KEY_B);
    const { getSessionFilePath } = await locationSut();

    expect(getSessionFilePath()).toBe(sessionIn(dirs.projectA));
  });

  it("names the global file ~/.cmu-session and an override ./.cmu-session", async () => {
    const { describeSessionFile, getLocalSessionFilePath } =
      await locationSut();

    expect(describeSessionFile(sessionIn(dirs.home))).toBe("~/.cmu-session");
    expect(describeSessionFile(getLocalSessionFilePath())).toBe(
      "./.cmu-session",
    );
  });

  it("calls the session global when the working folder is the home directory", async () => {
    cd(dirs.home);
    const { describeSessionFile, getSessionFilePath } = await locationSut();

    expect(describeSessionFile(getSessionFilePath())).toBe("~/.cmu-session");
  });
});

describe("reading the session in effect", () => {
  it("reads a session written in one folder from any other", async () => {
    const { readSession, writeSessionFile, getSessionFilePath } =
      await sessionSut();
    await writeSessionFile(getSessionFilePath(), {
      address: ADDRESS_A,
      activeNetwork: "local",
    });

    cd(dirs.projectB);

    expect(fs.existsSync(sessionIn(dirs.projectA))).toBe(false);
    expect((await readSession())?.address).toBe(ADDRESS_A);
  });

  it("unlocks the global key from another folder with its password", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A);
    cd(dirs.projectB);
    const { resolvePrivateKey } = await sessionSut({ password: PASSWORD });

    expect(await resolvePrivateKey()).toBe(KEY_A);
  });

  it("prefers the folder's override to the global session", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A);
    writeSession(dirs.projectB, ADDRESS_B, KEY_B);
    const { readSession } = await sessionSut();

    cd(dirs.projectB);
    expect((await readSession())?.address).toBe(ADDRESS_B);
    cd(dirs.projectA);
    expect((await readSession())?.address).toBe(ADDRESS_A);
  });

  it("keeps an existing project session working as an override", async () => {
    // Written by an older cmu: no iterations field, so the 100k legacy factor.
    writeLegacyGcmSession(dirs.projectB, ADDRESS_B, KEY_B);
    writeSession(dirs.home, ADDRESS_A, KEY_A);
    cd(dirs.projectB);
    const { resolvePrivateKey } = await sessionSut({ password: PASSWORD });

    expect(await resolvePrivateKey()).toBe(KEY_B);
  });

  it("does not fall back to the global key behind a project session it cannot open", async () => {
    const before = writeCbcSession(dirs.projectB, ADDRESS_B, KEY_B);
    writeSession(dirs.home, ADDRESS_A, KEY_A);
    cd(dirs.projectB);
    const { resolvePrivateKey } = await sessionSut({ password: PASSWORD });

    const result = await resolvePrivateKey().catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
    expect(fs.readFileSync(sessionIn(dirs.projectB), "utf8")).toBe(before);
  });

  it("still refuses to prompt for the global password without a terminal", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A);
    process.stdin.isTTY = false;
    const { resolvePrivateKey } = await sessionSut();

    await expect(resolvePrivateKey()).rejects.toThrow(
      /cannot prompt for the session password in a non-interactive session/,
    );
  });
});

describe("writing the global session", () => {
  it.skipIf(process.platform === "win32")(
    "is owner-only, even when an older global file was looser",
    async () => {
      fs.writeFileSync(sessionIn(dirs.home), "{}", { mode: 0o644 });
      fs.chmodSync(sessionIn(dirs.home), 0o644);
      const { writeSessionFile, getSessionFilePath } = await sessionSut();

      await writeSessionFile(getSessionFilePath(), {
        address: ADDRESS_A,
        activeNetwork: "local",
      });

      const mode = fs.statSync(sessionIn(dirs.home)).mode & MODE_BITS;
      expect(mode).toBe(OWNER_ONLY);
    },
  );

  it("leaves no temp file behind in the home directory or the folder", async () => {
    const { writeSessionFile, getSessionFilePath } = await sessionSut();

    await writeSessionFile(getSessionFilePath(), {
      address: ADDRESS_A,
      activeNetwork: "local",
    });

    expect(filesIn(dirs.home)).toEqual([".cmu-session"]);
    expect(filesIn(dirs.projectA)).toEqual([]);
    expect(readJson(path.join(dirs.home, ".cmu-session")).address).toBe(
      ADDRESS_A,
    );
  });
});
