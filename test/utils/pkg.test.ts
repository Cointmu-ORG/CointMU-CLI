import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import * as path from "path";
import { readPkg } from "../../src/utils/pkg";

// index.ts, `cmu version` and `cmu update` each read package.json on their
// own, from a fixed "../package.json" that only held one level below the root.

describe("readPkg", () => {
  afterEach(() => {
    vi.doUnmock("fs");
    vi.resetModules();
  });

  it("finds the CLI's own package.json from two levels below the root", () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
    );

    expect(readPkg()).toMatchObject({
      version: pkg.version,
      codename: pkg.codename,
      description: pkg.description,
    });
  });

  it("falls back to placeholders rather than throwing when there is none", async () => {
    vi.doMock("fs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("fs")>()),
      existsSync: () => false,
    }));
    const { readPkg: readMissing } = await import("../../src/utils/pkg");

    expect(readMissing()).toEqual({
      version: "unknown",
      codename: "unknown",
      description: "",
    });
  });
});
