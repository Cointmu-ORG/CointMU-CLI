import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import {
  PASSWORD,
  KEY,
  ADDRESS_B,
  tmpDir,
  clearLogged,
  sessionFile,
  writeKeySession,
  expectNoKeyLeak,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import {
  askingCommands,
  asked,
  ctrlC,
  sigint,
  save,
  type Commands,
} from "../helpers/walletSut";

beforeEach(setUp);
afterEach(tearDown);

// #215: Ctrl-C at a save, create --save, use or delete prompt printed
// inquirer's "User force closed the prompt with SIGINT" (or "with 0 null" for
// a closed input) instead of saying that nothing changed, as transfer does.

const NOTHING_SAVED = "aborted: nothing was saved.";
const SESSION_UNCHANGED = "aborted: .cmu-session was not changed.";
const NOTHING_DELETED = "aborted: nothing was deleted.";

type Route = {
  /** Puts the files in place; runs before the snapshot. */
  setup: () => Promise<void>;
  /** The answers given before the cancelled prompt. */
  answers: Record<string, unknown>;
  /** The prompt the user cancels. */
  cancelAt: string;
  run: (commands: Commands) => Promise<unknown>;
  message: string;
};

const nothing = async () => {};
const savedDeployer = async () => {
  await save("deployer");
};
const saveAlice = (c: Commands) => c.runWalletSave("alice");
const createAlice = (c: Commands) => c.runWalletCreate({ save: "alice" });
const useDeployer = (c: Commands) => c.runWalletUse("deployer");

const routes: Record<string, Route> = {
  "save, private key": {
    setup: nothing,
    answers: {},
    cancelAt: "privateKey",
    run: saveAlice,
    message: NOTHING_SAVED,
  },
  "save, password": {
    setup: nothing,
    answers: { privateKey: KEY },
    cancelAt: "password",
    run: saveAlice,
    message: NOTHING_SAVED,
  },
  "save, password confirmation": {
    setup: nothing,
    answers: { privateKey: KEY, password: PASSWORD },
    cancelAt: "confirmPassword",
    run: saveAlice,
    message: NOTHING_SAVED,
  },
  "create --save, password": {
    setup: nothing,
    answers: {},
    cancelAt: "password",
    run: createAlice,
    message: NOTHING_SAVED,
  },
  "create --save, password confirmation": {
    setup: nothing,
    answers: { password: PASSWORD },
    cancelAt: "confirmPassword",
    run: createAlice,
    message: NOTHING_SAVED,
  },
  "use, password": {
    setup: savedDeployer,
    answers: {},
    cancelAt: "password",
    run: useDeployer,
    message: SESSION_UNCHANGED,
  },
  "use, replacing a session with an unsaved key": {
    setup: async () => {
      await save("deployer");
      writeKeySession(ADDRESS_B);
    },
    answers: {},
    cancelAt: "replace",
    run: useDeployer,
    message: `aborted: .cmu-session was not changed; it still holds ${ADDRESS_B}.`,
  },
  "use, replacing a session that is not valid JSON": {
    setup: async () => {
      await save("deployer");
      fs.writeFileSync(sessionFile(), "{not json");
    },
    answers: {},
    cancelAt: "replace",
    run: useDeployer,
    message: SESSION_UNCHANGED,
  },
  // Yes to the replace means a backup is due, but only right before the
  // write: a cancelled password must not leave one behind.
  "use, password after agreeing to replace a session that is not valid JSON": {
    setup: async () => {
      await save("deployer");
      fs.writeFileSync(sessionFile(), "{not json");
    },
    answers: { replace: true },
    cancelAt: "password",
    run: useDeployer,
    message: SESSION_UNCHANGED,
  },
  "delete, confirmation": {
    setup: savedDeployer,
    answers: {},
    cancelAt: "proceed",
    run: (c) => c.runWalletDelete("deployer"),
    message: NOTHING_DELETED,
  },
};

/** Every file a command could touch, by name, with its exact contents. */
function snapshot(): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(tmpDir)
      .sort()
      .map((name) => [name, fs.readFileSync(`${tmpDir}/${name}`, "utf8")]),
  );
}

describe.each([
  ["Ctrl-C", sigint],
  ["a closed input", ctrlC],
])("wallet prompts cancelled with %s", (_kind, cancel) => {
  it.each(Object.keys(routes))(
    "%s: says what was left alone and changes nothing",
    async (routeName) => {
      const { setup, answers, cancelAt, run, message } = routes[routeName];
      await setup();
      clearLogged();
      const before = snapshot();
      const commands = await askingCommands({
        ...answers,
        [cancelAt]: cancel(),
      });

      const error = await run(commands).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect((error as Error | undefined)?.message).toBe(message);
      expect(asked).toEqual([...Object.keys(answers), cancelAt]);
      // HOME and the cwd are both tmpDir: this covers ~/.cmu-wallets.json,
      // .cmu-session, and any .cmu-session.bak-* or temp file left behind.
      expect(snapshot()).toEqual(before);
      expectNoKeyLeak();
    },
  );
});
