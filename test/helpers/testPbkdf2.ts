/**
 * PBKDF2 work factor for keys that tests encrypt only as fixtures. At the
 * real 600k each key costs most of a second of CPU, and suites running in
 * parallel then push slow tests past the 5 s timeout. Decryption reads the
 * factor stored with the key, so the code under test runs unchanged. The
 * tests that pin the real values (session.test.ts, wallet-save,
 * wallet-create) still encrypt with them.
 */
export const TEST_PBKDF2_ITERATIONS = 1000;
