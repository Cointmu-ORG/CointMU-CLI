import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printWelcomeBanner } from "../../src/commands/create";

describe("printWelcomeBanner", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function output(): string {
    return (console.log as any).mock.calls.flat().join("\n");
  }

  it("names the project and the commands that come next", () => {
    printWelcomeBanner("my-dapp", "a quote");

    expect(output()).toContain("Created");
    expect(output()).toContain("my-dapp");
    expect(output()).toContain("Next steps:");
    expect(output()).toContain("cd my-dapp");
    expect(output()).toContain("cmu compile");
    expect(output()).toContain("cmu deploy");
  });

  it("signs off with the quote it was handed, not one of its own", () => {
    printWelcomeBanner("my-dapp", "chosen by the caller");

    expect(output()).toContain("chosen by the caller");
  });

  it("closes every colour escape it opens", () => {
    printWelcomeBanner("my-dapp", "a quote");

    // Counted by splitting rather than matching: a regex holding the escape
    // byte trips eslint's no-control-regex.
    const text = output();
    const count = (needle: string) => text.split(needle).length - 1;
    const ESC = "\u001b[";
    const opened = count(`${ESC}1m`) + count(`${ESC}32m`) + count(`${ESC}36m`);
    expect(count(`${ESC}0m`)).toBe(opened);
  });
});

// Regression: inquirer v14 dropped the "list" prompt type in favour of
// "select", so the language and template prompts died with
// `Prompt type "list" is not registered` the moment they were reached.
describe("runCreate prompts", () => {
  let tmpDir: string;
  let asked: Array<Record<string, unknown>>;

  beforeEach(async () => {
    const os = await import("os");
    const path = await import("path");
    const fs = await import("fs");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-create-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});

    asked = [];
    // The import at the top of this file already loaded create.ts with the
    // real template module bound to it; drop it so runCreate() below is loaded
    // against the mock instead of scaffolding for real.
    vi.resetModules();
    vi.doMock("../../src/utils/template", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/utils/template")>()),
      generateProject: async () => {},
    }));
    vi.doMock("inquirer", () => ({
      default: {
        prompt: async (questions: Array<Record<string, unknown>>) => {
          asked.push(...questions);
          return { language: "typescript", template: "blank" };
        },
      },
    }));
  });

  afterEach(async () => {
    const fs = await import("fs");
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("inquirer");
    vi.doUnmock("../../src/utils/template");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("asks for language and template with a prompt type inquirer registers", async () => {
    const { runCreate } = await import("../../src/commands/create");

    await runCreate("my-dapp", {});

    const types = asked.map((question) => question.type);
    expect(types).toEqual(["select", "select"]);
    expect(types).not.toContain("list");
  });
});
