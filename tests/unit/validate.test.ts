import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CHECKS,
  type Check,
  type CheckResult,
  checkEnv,
  formatReport,
  run,
  runChecks,
} from "../../scripts/validate.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.dir));

function result(name: string, ok: boolean, output = ""): CheckResult {
  return { name, script: name, ok, output, ms: 0 };
}

/** Await a body with console output captured. */
async function capture(
  body: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const outParts: string[] = [];
  const errParts: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) =>
    void outParts.push(`${args.map(String).join(" ")}\n`);
  console.error = (...args: unknown[]) =>
    void errParts.push(`${args.map(String).join(" ")}\n`);
  try {
    return {
      code: await body(),
      out: outParts.join(""),
      err: errParts.join(""),
    };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("CHECKS", () => {
  test("every check names a real package.json script", () => {
    const pkg = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    for (const check of CHECKS) {
      expect(pkg.scripts).toHaveProperty(check.script);
    }
  });

  test("does not recurse into itself", () => {
    expect(CHECKS.map((c) => c.script)).not.toContain("validate");
  });
});

describe("formatReport", () => {
  test("lists every check as ok and drops their output when all passed", () => {
    const report = formatReport([
      result("format", true, "noisy passing output"),
      result("lint", true, "more noise"),
    ]);
    expect(report.split("\n")).toEqual(["format - ok", "lint   - ok"]);
  });

  test("marks the failing check, shows its output, and hides passing output", () => {
    const report = formatReport([
      result("lint", true, "passing noise"),
      result("typecheck", false, "index.ts(3,1): error TS2322"),
    ]);
    expect(report).toContain("lint      - ok");
    expect(report).toContain("typecheck - ❌ FAIL");
    expect(report).toContain("error TS2322");
    expect(report).not.toContain("passing noise");
    expect(report).toContain("1 of 2 checks failed");
  });

  test("names every failure in the summary line", () => {
    const report = formatReport([
      result("lint", false, "a"),
      result("typecheck", false, "b"),
      result("test:refs", true),
    ]);
    expect(report).toMatch(/2 of 3 checks failed: lint, typecheck/);
  });

  test("truncates a long failure and says how much it dropped", () => {
    const output = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const report = formatReport([result("lint", false, output)], {
      maxLines: 10,
    });
    expect(report).toContain("line 9");
    expect(report).not.toContain("line 10");
    expect(report).toContain("40 more lines");
  });

  test("keeps the whole failure when maxLines is 0", () => {
    const output = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const report = formatReport([result("lint", false, output)], {
      maxLines: 0,
    });
    expect(report).toContain("line 49");
    expect(report).not.toContain("more lines");
  });

  test("stays plain when color is off", () => {
    const report = formatReport([
      result("lint", false, "boom"),
      result("typecheck", true),
    ]);
    expect(report).not.toContain("\u001B[");
  });

  test("colours the status list and the failure header when color is on", () => {
    const report = formatReport(
      [result("lint", false, "boom"), result("typecheck", true)],
      {
        color: true,
      },
    );
    expect(report).toContain("lint      - \u001B[31m❌ FAIL\u001B[0m");
    expect(report).toContain("typecheck - \u001B[32mok\u001B[0m");
    expect(report).toContain(
      "\u001B[31m--- FAIL: lint (bun run lint) ---\u001B[0m",
    );
    // The failing check's own output and the summary stay plain.
    expect(report).toContain("\nboom\n");
    expect(report).toContain("\n1 of 2 checks failed: lint");
  });

  test("greens every check in an all-passing list", () => {
    const report = formatReport(
      [result("lint", true), result("typecheck", true)],
      { color: true },
    );
    expect(report.split("\n")).toEqual([
      "lint      - \u001B[32mok\u001B[0m",
      "typecheck - \u001B[32mok\u001B[0m",
    ]);
  });
});

describe("runChecks", () => {
  const checks: Check[] = [
    { name: "one", script: "one" },
    { name: "two", script: "two" },
    { name: "three", script: "three" },
    { name: "four", script: "four" },
  ];

  test("returns results in check order however they finish", async () => {
    const delays: Record<string, number> = {
      one: 30,
      two: 1,
      three: 20,
      four: 5,
    };
    const results = await runChecks(checks, {
      jobs: 4,
      spawn: async (check) => {
        await Bun.sleep(delays[check.name] ?? 0);
        return { ok: true, output: check.name };
      },
    });
    expect(results.map((r) => r.name)).toEqual(["one", "two", "three", "four"]);
  });

  test("never runs more checks at once than the job limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await runChecks(checks, {
      jobs: 2,
      spawn: async () => {
        peak = Math.max(peak, ++inFlight);
        await Bun.sleep(5);
        inFlight--;
        return { ok: true, output: "" };
      },
    });
    expect(peak).toBe(2);
  });

  test("runs the remaining checks after one fails", async () => {
    const seen: string[] = [];
    const results = await runChecks(checks, {
      jobs: 1,
      spawn: async (check) => {
        seen.push(check.name);
        return { ok: check.name !== "one", output: "" };
      },
    });
    expect(seen).toHaveLength(4);
    expect(results.filter((r) => !r.ok).map((r) => r.name)).toEqual(["one"]);
  });
});

describe("run", () => {
  const checks: Check[] = [{ name: "lint", script: "lint" }];

  test("prints the ok list and exits 0 when every check passes", async () => {
    const { code, out } = await capture(() =>
      run([], { checks, spawn: async () => ({ ok: true, output: "chatter" }) }),
    );
    expect(code).toBe(0);
    expect(out.trim()).toBe("lint - ok");
  });

  test("prints the failure and exits 1 when a check fails", async () => {
    const { code, out, err } = await capture(() =>
      run([], { checks, spawn: async () => ({ ok: false, output: "boom" }) }),
    );
    expect(code).toBe(1);
    expect(out).toContain("boom");
    expect(out).toContain("lint");
    expect(err).toBe("");
  });

  test("rejects an unknown argument", async () => {
    const { code, err } = await capture(() => run(["--nope"], { checks }));
    expect(code).toBe(2);
    expect(err).toContain("--nope");
  });

  test("--list prints the check names and exits 0", async () => {
    const { code, out } = await capture(() => run(["--list"], { checks }));
    expect(code).toBe(0);
    expect(out.trim()).toBe("lint");
  });

  test("--full keeps a long failure whole", async () => {
    const output = Array.from({ length: 300 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const { out } = await capture(() =>
      run(["--full"], { checks, spawn: async () => ({ ok: false, output }) }),
    );
    expect(out).toContain("line 299");
  });

  test("--jobs takes a positive integer", async () => {
    const spawn = async () => ({ ok: true, output: "" });
    expect(
      (await capture(() => run(["-j", "1"], { checks, spawn }))).code,
    ).toBe(0);
    const { code, err } = await capture(() =>
      run(["--jobs", "0"], { checks, spawn }),
    );
    expect(code).toBe(2);
    expect(err).toContain("--jobs");
  });

  test("runs the package.json scripts of the project root", async () => {
    const root = mkdtempSync(join(tmpdir(), "xr-validate-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: { pass: "echo fine", fail: "echo broken && exit 3" },
        }),
      );
      const { code, out } = await capture(() =>
        run([], {
          projectRoot: root,
          checks: [
            { name: "pass", script: "pass" },
            { name: "fail", script: "fail" },
          ],
        }),
      );
      expect(code).toBe(1);
      expect(out).toContain("pass - ok");
      expect(out).toContain("broken");
      expect(out).not.toContain("fine");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a check that throws counts as a failure", async () => {
    const { code, out } = await capture(() =>
      run([], {
        checks,
        spawn: async () => {
          throw new Error("spawn broke");
        },
      }),
    );
    expect(code).toBe(1);
    expect(out).toContain("spawn broke");
  });

  test("--help lists the checks and exits 0", async () => {
    const { code, out } = await capture(() => run(["--help"], { checks }));
    expect(code).toBe(0);
    expect(out).toContain("lint");
  });
});

describe("checkEnv", () => {
  test("drops the GIT_* variables a git hook sets, so checks cannot reach the hook's repo", () => {
    const env = checkEnv({
      GIT_DIR: "/repo/.git/worktrees/x",
      GIT_INDEX_FILE: "/repo/.git/worktrees/x/index",
      GIT_WORK_TREE: "/repo",
      PATH: "/bin",
    });
    expect(Object.keys(env).filter((key) => key.startsWith("GIT_"))).toEqual(
      [],
    );
    expect(env.PATH).toBe("/bin");
  });

  test("turns colour off for captured output", () => {
    expect(checkEnv({})).toMatchObject({
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CI: "",
    });
  });
});
