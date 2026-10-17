import { afterEach, describe, expect, it, vi } from "vitest";
import { isColorEnabled, stripColorWhenDisabled } from "../../src/utils/color";

// #217: the error:, warning: and hint: labels were written with ANSI colour
// codes whatever the output was: NO_COLOR, a pipe and a file all got them.

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

describe("isColorEnabled", () => {
  it.each([
    ["a terminal, no variables", TTY, {}, true],
    ["a pipe or file, no variables", PIPE, {}, false],
    ["a terminal, NO_COLOR=1", TTY, { NO_COLOR: "1" }, false],
    // no-color.org: only a non-empty NO_COLOR counts.
    ["a terminal, NO_COLOR empty", TTY, { NO_COLOR: "" }, true],
    ["a pipe, FORCE_COLOR=1", PIPE, { FORCE_COLOR: "1" }, true],
    ["a pipe, FORCE_COLOR empty", PIPE, { FORCE_COLOR: "" }, true],
    ["a pipe, FORCE_COLOR=3", PIPE, { FORCE_COLOR: "3" }, true],
    ["a pipe, FORCE_COLOR=true", PIPE, { FORCE_COLOR: "true" }, true],
    ["a terminal, FORCE_COLOR=0", TTY, { FORCE_COLOR: "0" }, false],
    ["a terminal, FORCE_COLOR=false", TTY, { FORCE_COLOR: "false" }, false],
    // Node's own rule: FORCE_COLOR wins over NO_COLOR.
    [
      "a pipe, NO_COLOR=1 and FORCE_COLOR=1",
      PIPE,
      { NO_COLOR: "1", FORCE_COLOR: "1" },
      true,
    ],
    [
      "a terminal, NO_COLOR=1 and FORCE_COLOR=0",
      TTY,
      { NO_COLOR: "1", FORCE_COLOR: "0" },
      false,
    ],
    ["a stream with no isTTY at all", {}, {}, false],
  ])("%s", (_name, stream, env, expected) => {
    expect(isColorEnabled(stream, env)).toBe(expected);
  });
});

/** A stream whose real write is a spy, wrapped as cmu wraps stdout. */
function gated(isTTY: boolean, env: NodeJS.ProcessEnv) {
  const sink = vi.fn<(...args: unknown[]) => boolean>(() => true);
  const stream = { isTTY, write: sink };
  stripColorWhenDisabled(stream, env);
  return { stream, sink };
}

describe("stripColorWhenDisabled", () => {
  const LABELS =
    "\n\x1b[31merror:\x1b[0m wallet login failed\n" +
    "\x1b[33mwarning:\x1b[0m careful\n" +
    "\x1b[2mhint:\x1b[0m try again\n";
  const PLAIN =
    "\nerror: wallet login failed\nwarning: careful\nhint: try again\n";

  it("drops the colour codes from a stream with colour off", () => {
    const { stream, sink } = gated(false, {});

    stream.write(LABELS);

    expect(sink).toHaveBeenCalledWith(PLAIN);
  });

  it("drops them under NO_COLOR on a terminal too", () => {
    const { stream, sink } = gated(true, { NO_COLOR: "1" });

    stream.write(LABELS);

    expect(sink).toHaveBeenCalledWith(PLAIN);
  });

  it("drops combined and multi-parameter codes", () => {
    const { stream, sink } = gated(false, {});

    stream.write("\x1b[1m\x1b[34m[1/2] Auditing\x1b[0m \x1b[1;32mok\x1b[39m");

    expect(sink).toHaveBeenCalledWith("[1/2] Auditing ok");
  });

  // A prompt still has to draw under NO_COLOR, and `mine status --watch`
  // still redraws its line in place.
  it("keeps cursor movement and line erasing", () => {
    const { stream, sink } = gated(true, { NO_COLOR: "1" });

    stream.write("\r\x1b[2K\x1b[1A\x1b[15G\x1b[?25h\x1b[33mwarning:\x1b[0m x");

    expect(sink).toHaveBeenCalledWith(
      "\r\x1b[2K\x1b[1A\x1b[15G\x1b[?25hwarning: x",
    );
  });

  it("leaves a stream with colour on alone", () => {
    const write = vi.fn(() => true);
    const stream = { isTTY: true, write };

    stripColorWhenDisabled(stream, {});
    stream.write(LABELS);

    expect(stream.write).toBe(write);
    expect(write).toHaveBeenCalledWith(LABELS);
  });

  it("passes the encoding and callback through", () => {
    const { stream, sink } = gated(false, {});
    const done = () => {};

    const result = stream.write("\x1b[2mhint:\x1b[0m x", "utf8", done);

    expect(sink).toHaveBeenCalledWith("hint: x", "utf8", done);
    expect(result).toBe(true);
  });

  it("passes a Buffer through untouched", () => {
    const { stream, sink } = gated(false, {});
    const bytes = Buffer.from("\x1b[31mx\x1b[0m");

    stream.write(bytes);

    expect(sink).toHaveBeenCalledWith(bytes);
  });

  it("wraps a stream only once", () => {
    const { stream } = gated(false, {});
    const wrapped = stream.write;

    stripColorWhenDisabled(stream, {});

    expect(stream.write).toBe(wrapped);
  });
});

describe("the colour gate cmu loads first", () => {
  afterEach(() => {
    vi.doUnmock("../../src/utils/color");
    vi.resetModules();
  });

  it("gates both stdout and stderr", async () => {
    const strip = vi.fn();
    vi.resetModules();
    vi.doMock("../../src/utils/color", () => ({
      stripColorWhenDisabled: strip,
    }));

    await import("../../src/colorGate");

    expect(strip.mock.calls).toEqual([[process.stdout], [process.stderr]]);
  });
});
