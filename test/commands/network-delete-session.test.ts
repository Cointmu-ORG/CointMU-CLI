import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ADDRESS_A,
  ADDRESS_B,
  asked,
  cd,
  dirs,
  KEY_A,
  KEY_B,
  outcome,
  output,
  readText,
  runNetwork,
  setUp,
  tearDown,
  writeNetworks,
  writeSession,
} from "../helpers/globalSessionEnv";

// #262: `network delete` checked only the session in effect, so from a folder
// with its own .cmu-session it deleted the network ~/.cmu-session - the
// session of every folder without an override - still pointed at. It now
// checks both files it can find. Another folder's override cannot be found:
// cmu keeps no list of projects, and the success hint says so.

const GLOBAL = "~/.cmu-session";
const LOCAL = "./.cmu-session";
const REFUSED = "process.exit(1)";

function savedNetworks(): string[] {
  const file = path.join(dirs.home, ".cmu-networks.json");
  return JSON.parse(readText(file)).map((n: { name: string }) => n.name);
}

/** The hint naming what `delete` cannot see; printed after every delete. */
const OTHER_FOLDERS_HINT =
  "another folder's .cmu-session still on 'testnet' is not checked: run `cmu network use <name>` there.";

beforeEach(() => {
  setUp();
  writeNetworks(["local", "testnet"]);
});
afterEach(tearDown);

describe("network delete refuses a network a session it can see uses", () => {
  it("in the session in effect: this folder's override", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A, "local");
    writeSession(dirs.projectA, ADDRESS_B, KEY_B, "testnet");

    expect(await outcome(runNetwork("delete", "testnet"))).toBe(REFUSED);

    expect(output()).toContain(
      `network 'testnet' is currently active in ${LOCAL} and cannot be deleted.`,
    );
    expect(output()).toContain(
      `switch ${LOCAL} away first with \`cmu network use <name>\`.`,
    );
    expect(output()).not.toContain(GLOBAL);
    expect(savedNetworks()).toEqual(["local", "testnet"]);
  });

  it("in ~/.cmu-session, from a folder whose own override is elsewhere", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A, "testnet");
    writeSession(dirs.projectA, ADDRESS_B, KEY_B, "local");

    expect(await outcome(runNetwork("delete", "testnet"))).toBe(REFUSED);

    expect(output()).toContain(
      `network 'testnet' is currently active in ${GLOBAL} and cannot be deleted.`,
    );
    // `network use` here would switch the override, not the global file.
    expect(output()).toContain(
      `switch ${GLOBAL} away first with \`cmu network use <name>\` in a folder without its own .cmu-session, such as your home folder.`,
    );
    expect(savedNetworks()).toEqual(["local", "testnet"]);
  });

  it("in ~/.cmu-session when it is the session in effect", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A, "testnet");
    cd(dirs.projectB);

    expect(await outcome(runNetwork("delete", "testnet"))).toBe(REFUSED);

    expect(output()).toContain(
      `network 'testnet' is currently active in ${GLOBAL} and cannot be deleted.`,
    );
    expect(output()).toContain(
      `switch ${GLOBAL} away first with \`cmu network use <name>\`.`,
    );
    expect(savedNetworks()).toEqual(["local", "testnet"]);
  });

  it("in both, naming each file", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A, "testnet");
    writeSession(dirs.projectA, ADDRESS_B, KEY_B, "testnet");

    expect(await outcome(runNetwork("delete", "testnet"))).toBe(REFUSED);

    expect(output()).toContain(
      `network 'testnet' is currently active in ${LOCAL} and ${GLOBAL} and cannot be deleted.`,
    );
    expect(output()).toContain(`switch ${LOCAL} away first`);
    expect(output()).toContain(`switch ${GLOBAL} away first`);
    expect(savedNetworks()).toEqual(["local", "testnet"]);
  });

  it("without a terminal too, and asks nothing", async () => {
    process.stdin.isTTY = false;
    writeSession(dirs.home, ADDRESS_A, KEY_A, "testnet");
    writeSession(dirs.projectA, ADDRESS_B, KEY_B, "local");

    expect(await outcome(runNetwork("delete", "testnet"))).toBe(REFUSED);

    expect(output()).toContain(`currently active in ${GLOBAL}`);
    expect(asked).toEqual([]);
    expect(savedNetworks()).toEqual(["local", "testnet"]);
  });
});

describe("network delete of a network no session it can see uses", () => {
  it.each([
    ["with a terminal", true],
    ["without a terminal", false],
  ])("deletes it %s, and says what it could not check", async (_, tty) => {
    process.stdin.isTTY = tty;
    writeSession(dirs.home, ADDRESS_A, KEY_A, "local");
    writeSession(dirs.projectA, ADDRESS_B, KEY_B, "local");

    expect(await outcome(runNetwork("delete", "testnet"))).toBe("done");

    expect(savedNetworks()).toEqual(["local"]);
    expect(output()).toContain("Deleted network 'testnet'");
    expect(output()).toContain(OTHER_FOLDERS_HINT);
    expect(asked).toEqual([]);
  });

  it("deletes it with no session at all", async () => {
    expect(await outcome(runNetwork("delete", "testnet"))).toBe("done");

    expect(savedNetworks()).toEqual(["local"]);
    expect(fs.readdirSync(dirs.projectA)).toEqual([]);
  });

  it("still refuses the built-in local network", async () => {
    writeSession(dirs.home, ADDRESS_A, KEY_A, "testnet");

    expect(await outcome(runNetwork("delete", "local"))).toBe(REFUSED);

    expect(output()).toContain(
      "network 'local' is the built-in fallback and cannot be deleted",
    );
    expect(savedNetworks()).toEqual(["local", "testnet"]);
  });
});
