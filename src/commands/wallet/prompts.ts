import { validatePasswordStrength } from "../../utils/session";

/**
 * Refuses to prompt when stdin is not a terminal. inquirer cannot read a
 * masked answer from a pipe: a closed stdin fails with an unhelpful "force
 * closed the prompt", and a pipe that stays open hangs forever.
 *
 * @param {string} what - What the prompt would have asked for.
 * @param {string} [hint] - What to do instead.
 * @throws {Error} When stdin is not a TTY.
 */
export function requireInteractive(
  what: string,
  hint = "run this in a terminal.",
): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      `cannot prompt for ${what} in a non-interactive session.\n` +
        `\x1b[2mhint:\x1b[0m ${hint}`,
    );
  }
}

/**
 * Prompts for a private key, masked, and rejects anything that is not one.
 * The validation message never echoes the input.
 *
 * @returns {Promise<string>} The entered private key.
 */
export async function promptPrivateKey(): Promise<string> {
  requireInteractive("a private key");
  const inquirer = (await import("inquirer")).default;
  const { ethers } = await import("ethers");

  const { privateKey } = await inquirer.prompt([
    {
      type: "password",
      name: "privateKey",
      message: "Private key:",
      mask: "*",
      validate: (input: string) => {
        try {
          new ethers.Wallet(input);
          return true;
        } catch {
          return "invalid private key - expected a 32-byte hex key (0x-prefixed).";
        }
      },
    },
  ]);
  return privateKey;
}

/**
 * Prompts for a new password that passes validatePasswordStrength().
 *
 * @param {string} [message] - The prompt text.
 * @param {boolean} [confirm] - Ask twice and require both to match. For a
 *   saved wallet, where a typo would lock the entry for good: decrypting with
 *   the same mistyped password round-trips fine and cannot catch it.
 * @returns {Promise<string>} The entered password.
 * @throws {Error} When confirm is set and the two entries differ.
 */
export async function promptNewPassword(
  message = "New session password:",
  confirm = false,
): Promise<string> {
  requireInteractive("a password");
  const inquirer = (await import("inquirer")).default;

  const { password } = await inquirer.prompt([
    {
      type: "password",
      name: "password",
      message,
      mask: "*",
      validate: validatePasswordStrength,
    },
  ]);
  if (!confirm) return password;

  const { confirmPassword } = await inquirer.prompt([
    {
      type: "password",
      name: "confirmPassword",
      message: "Confirm password:",
      mask: "*",
    },
  ]);
  if (password !== confirmPassword) {
    throw new Error(
      "passwords do not match.\n" +
        "\x1b[2mhint:\x1b[0m nothing was saved; run the command again.",
    );
  }
  return password;
}

/** What save and create --save say when their prompts are cancelled. */
export const NOTHING_SAVED = "aborted: nothing was saved.";

/**
 * Runs a prompt, turning Ctrl-C (inquirer's ExitPromptError) into the same
 * "aborted" a No answer gives, so either way it is plain that nothing changed.
 * A closed input (Ctrl-D) throws the same error and gets the same message.
 *
 * @param {() => Promise<T>} prompt - The prompt to run.
 * @param {string} aborted - The message to throw instead, naming what the
 *   command left alone.
 * @returns {Promise<T>} Its answers.
 */
export async function promptOrAbort<T>(
  prompt: () => Promise<T>,
  aborted: string,
): Promise<T> {
  try {
    return await prompt();
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      throw new Error(aborted, { cause: error });
    }
    throw error;
  }
}
