import { vi } from "vitest";
import { KEY, PASSWORD } from "./walletEnv";

/** Mocks inquirer so a password prompt answers, or fails the test outright. */
export function mockPrompt(answer?: Record<string, string>) {
  vi.doMock("inquirer", () => ({
    default: {
      prompt: async () => {
        if (!answer) throw new Error("inquirer.prompt should not be called");
        return answer;
      },
    },
  }));
}

/** A fresh SUT whose prompts all answer from `answers`. */
export async function walletCommands(answers?: Record<string, unknown>) {
  vi.resetModules();
  mockPrompt(answers as Record<string, string>);
  return import("../../src/commands/wallet");
}

/** Every question the last askingCommands() SUT asked, in order. */
export let asked: string[];
/** The same questions, whole, for the options they were asked with. */
export let questions: Record<string, unknown>[];

/**
 * A fresh SUT whose prompts answer by question name. A question with no
 * answer fails the test, an Error answer is thrown (Ctrl-C), and every
 * question asked is recorded, so a test can prove which prompts ran, in which
 * order - or that none did.
 */
export async function askingCommands(answers: Record<string, unknown> = {}) {
  vi.resetModules();
  asked = [];
  questions = [];
  vi.doMock("inquirer", () => ({
    default: {
      prompt: async (batch: { name: string }[]) => {
        const result: Record<string, unknown> = {};
        for (const question of batch) {
          const { name } = question;
          asked.push(name);
          questions.push(question);
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

/** What inquirer throws when the user presses Ctrl-C at a prompt. */
export function ctrlC(): Error {
  return Object.assign(new Error("User force closed the prompt with 0 null"), {
    name: "ExitPromptError",
  });
}

/**
 * What inquirer throws for Ctrl-C itself. ctrlC() above carries the message a
 * closed input (Ctrl-D on an empty line) gets; both are ExitPromptError.
 */
export function sigint(): Error {
  return Object.assign(new Error("User force closed the prompt with SIGINT"), {
    name: "ExitPromptError",
  });
}

export async function save(
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

export async function use(name: string, password = PASSWORD): Promise<void> {
  const { runWalletUse } = await walletCommands({ password });
  await runWalletUse(name);
}

export type Commands = typeof import("../../src/commands/wallet");
