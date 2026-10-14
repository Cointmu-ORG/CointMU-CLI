// Imports the module under test statically, as every session test file
// already does, so makeSession() encrypts with the same module instance.
import { encryptSessionKey, type SessionData } from "../../src/utils/session";
import { TEST_PBKDF2_ITERATIONS } from "./testPbkdf2";

export const PASSWORD = "correct horse";
// well-known Ganache test key — never fund this
export const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export function makeSession(
  overrides: Partial<SessionData> = {},
  iterations = TEST_PBKDF2_ITERATIONS,
): SessionData {
  return {
    address: "0xTest",
    activeNetwork: "local",
    ...encryptSessionKey(PASSWORD, PRIVATE_KEY, iterations),
    ...overrides,
  };
}
