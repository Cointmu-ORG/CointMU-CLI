/**
 * Registers ts-node so a project's `cmu.config.ts` can be require()d.
 *
 * `compiler` is the bare package name "typescript" on purpose. ts-node
 * resolves that with its own project-local resolver, relative to the project
 * being loaded, which is where TypeScript actually lives - this CLI does not
 * depend on typescript at runtime, so resolving it relative to the CLI's own
 * install would find nothing in a global install.
 *
 * An earlier version passed "typescript@5", which is an npm install spec that
 * require() cannot resolve, and every TypeScript project failed to load
 * (64b2875). Keep this in one place so that fix cannot drift back out of one
 * of the call sites.
 *
 * @returns {Promise<void>} Resolves once the require hook is installed.
 */
export async function registerTsNode(): Promise<void> {
  const tsNode = await import("ts-node");
  tsNode.register({
    transpileOnly: true,
    compiler: "typescript",
    compilerOptions: { module: "CommonJS" },
  });
}
