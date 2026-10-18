import * as fs from "fs";
import * as path from "path";

// ts-node resolves "typescript" from the project it loads a cmu.config.ts for,
// so a fixture project needs one. These give it the repo's own copy.

const REPO_TYPESCRIPT = path.resolve(
  __dirname,
  "../../node_modules/typescript",
);

/** Where a fixture project's link to the repo's typescript lives. */
function typescriptLink(projectDir: string): string {
  return path.join(projectDir, "node_modules", "typescript");
}

/**
 * Links `<projectDir>/node_modules/typescript` to the repo's typescript.
 *
 * A junction rather than a "dir" symlink: Windows creates directory symlinks
 * only with Developer Mode or as an administrator, and junctions need neither.
 * POSIX ignores the type.
 *
 * @param {string} projectDir - The fixture project.
 */
export function linkRepoTypescript(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, "node_modules"), { recursive: true });
  fs.symlinkSync(REPO_TYPESCRIPT, typescriptLink(projectDir), "junction");
}

/**
 * Removes a fixture project, unlinking its typescript link on its own first so
 * the recursive removal never has a link to follow into the repo's
 * node_modules.
 *
 * @param {string} projectDir - The fixture project.
 */
export function removeFixtureProject(projectDir: string): void {
  try {
    fs.unlinkSync(typescriptLink(projectDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  fs.rmSync(projectDir, { recursive: true, force: true });
}
