import { describe, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createMultiPrompt,
  createPrompt,
  type PickRequest,
} from "../../../src/adapters/prompt/index.ts";
import { XrError } from "../../../src/errors/index.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_C = "\x03";

function request(choices: string[]): PickRequest {
  return {
    argument: "name",
    message: "Pick the repo to remove",
    choices,
    missing: "Give the name of the repo to remove.",
    listLabel: "Choices",
    hint: "xr codebase repo remove <name>",
    empty: {
      message: "There is no repo to remove.",
      hint: "xr codebase repo add <url>|<folder>",
    },
  };
}

/** A prompt on fake streams; `keys` are typed into the input once the picker listens. */
function fakeTerminal({
  interactive,
  keys = [],
}: {
  interactive: boolean;
  keys?: string[];
}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  let read = false;
  output.on("data", (chunk) => {
    written += chunk;
  });
  input.on("resume", () => {
    read = true;
  });
  for (const key of keys) input.write(key);
  return {
    prompt: {
      ...createPrompt({ interactive, input, output }),
      ...createMultiPrompt({ interactive, input, output }),
    },
    written: () => written,
    read: () => read,
  };
}

async function failure(promise: Promise<unknown>): Promise<XrError> {
  try {
    await promise;
  } catch (thrown) {
    if (thrown instanceof XrError) return thrown;
    throw thrown;
  }
  throw new Error("the pick did not fail");
}

describe("createPrompt interactive", () => {
  test("Enter picks the first choice; the picker writes to the output", async () => {
    const terminal = fakeTerminal({ interactive: true, keys: [ENTER] });
    expect(await terminal.prompt.pick(request(["api", "web"]))).toBe("api");
    expect(terminal.written()).toContain("Pick the repo to remove");
    expect(terminal.written()).toContain("web");
  });

  test("arrow down and Enter picks the second choice", async () => {
    const terminal = fakeTerminal({ interactive: true, keys: [DOWN, ENTER] });
    expect(await terminal.prompt.pick(request(["api", "web"]))).toBe("web");
  });

  for (const [name, key] of [
    ["Escape", ESCAPE],
    ["Ctrl-C", CTRL_C],
  ] as const) {
    test(`${name} cancels: interrupted`, async () => {
      const terminal = fakeTerminal({ interactive: true, keys: [key] });
      const error = await failure(terminal.prompt.pick(request(["api"])));
      expect(error.code).toBe("interrupted");
      expect(error.message).toBe("Stopped by Ctrl-C.");
    });
  }
});

describe("createPrompt default output", () => {
  test("the picker writes to process.stderr, never to process.stdout", async () => {
    const input = new PassThrough();
    input.write(ENTER);
    let stderr = "";
    let stdout = "";
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    );
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    );
    try {
      const prompt = createPrompt({ interactive: true, input });
      expect(await prompt.pick(request(["api", "web"]))).toBe("api");
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
    expect(stderr).toContain("Pick the repo to remove");
    expect(stdout).toBe("");
  });
});

describe("createPrompt not interactive", () => {
  test("missing-argument lists the choices; nothing is read or written", async () => {
    const terminal = fakeTerminal({ interactive: false, keys: [ENTER] });
    const error = await failure(terminal.prompt.pick(request(["api", "web"])));
    expect(error.code).toBe("missing-argument");
    expect(error.message).toBe(
      "Give the name of the repo to remove. Choices: api, web.",
    );
    expect(error.hint).toBe("xr codebase repo remove <name>");
    expect(error.details).toEqual({
      argument: "name",
      choices: ["api", "web"],
    });
    expect(terminal.written()).toBe("");
    expect(terminal.read()).toBe(false);
  });
});

describe("createPrompt with no choices", () => {
  for (const interactive of [true, false]) {
    test(`interactive ${interactive}: missing-argument with the empty message, no picker`, async () => {
      const terminal = fakeTerminal({ interactive, keys: [ENTER] });
      const error = await failure(terminal.prompt.pick(request([])));
      expect(error.code).toBe("missing-argument");
      expect(error.message).toBe("There is no repo to remove.");
      expect(error.hint).toBe("xr codebase repo add <url>|<folder>");
      expect(error.details).toEqual({ argument: "name", choices: [] });
      expect(terminal.written()).toBe("");
      expect(terminal.read()).toBe(false);
    });
  }
});

describe("createPrompt pickMany", () => {
  const SPACE = " ";

  test("Space marks, Enter gives the marked choices in list order", async () => {
    const terminal = fakeTerminal({
      interactive: true,
      keys: [DOWN, SPACE, "\x1b[A", SPACE, ENTER],
    });
    expect(
      await terminal.prompt.pickMany(request(["api", "web", "db"])),
    ).toEqual(["api", "web"]);
    expect(terminal.written()).toContain("Pick the repo to remove");
  });

  test("at least one is needed: Enter with none marked does not end the picker", async () => {
    const terminal = fakeTerminal({
      interactive: true,
      keys: [ENTER, SPACE, ENTER],
    });
    expect(await terminal.prompt.pickMany(request(["api", "web"]))).toEqual([
      "api",
    ]);
  });

  for (const [name, key] of [
    ["Escape", ESCAPE],
    ["Ctrl-C", CTRL_C],
  ] as const) {
    test(`${name} cancels: interrupted`, async () => {
      const terminal = fakeTerminal({ interactive: true, keys: [key] });
      const error = await failure(terminal.prompt.pickMany(request(["api"])));
      expect(error.code).toBe("interrupted");
    });
  }

  test("not interactive: missing-argument with the choices; nothing is read", async () => {
    const terminal = fakeTerminal({ interactive: false, keys: [ENTER] });
    const error = await failure(
      terminal.prompt.pickMany(request(["api", "web"])),
    );
    expect(error.code).toBe("missing-argument");
    expect(error.details).toEqual({
      argument: "name",
      choices: ["api", "web"],
    });
    expect(terminal.read()).toBe(false);
  });

  for (const interactive of [true, false]) {
    test(`no choices, interactive ${interactive}: the empty message`, async () => {
      const terminal = fakeTerminal({ interactive, keys: [ENTER] });
      const error = await failure(terminal.prompt.pickMany(request([])));
      expect(error.code).toBe("missing-argument");
      expect(error.message).toBe("There is no repo to remove.");
      expect(terminal.read()).toBe(false);
    });
  }
});
