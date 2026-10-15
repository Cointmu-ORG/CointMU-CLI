import { describe, expect, it } from "vitest";
import { consoleCommand } from "../../src/commands/console";
import { ADDRESS } from "../helpers/consoleEnv";

// The REPL loop itself (repl.start, the preloaded context, the exit handler)
// is not covered here: driving it needs a real stdin and would leave vitest
// holding the handle, the same reason create.ts's inquirer flow is untested.
// Everything that can actually be wrong - artifact loading and the
// network/signer resolution - is reachable without opening a REPL.

describe("signerLabel", () => {
  async function label(signer: { address: string } | undefined, options = {}) {
    const { signerLabel } = await import("../../src/commands/console");
    return signerLabel(signer, options);
  }

  it("prints the signer's address when there is one", async () => {
    expect(await label({ address: ADDRESS })).toBe(ADDRESS);
  });

  it("names the flag, with no key hint, when --no-signer left it out", async () => {
    expect(await label(undefined, { signer: false })).toBe(
      "none (--no-signer)",
    );
  });

  it("says how to add a key when none was found", async () => {
    expect(await label(undefined)).toBe(
      "none (no key) - run `cmu wallet use <name>`, or set PRIVATE_KEY in .env or cmu.config.ts",
    );
  });
});

describe("consoleCommand", () => {
  it("offers the read-only escape hatch alongside --network", () => {
    const flags = consoleCommand.options.map((option) => option.flags);

    expect(consoleCommand.name()).toBe("console");
    expect(flags).toContain("-n, --network <name>");
    expect(flags).toContain("--no-signer");
    expect(flags).toContain("-y, --yes");
  });
});
