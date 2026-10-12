import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { smokeRuntimes } from "../helpers/smoke-runtimes.ts";

const bundle = fileURLToPath(new URL("../../dist/xr.js", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const runtimes = smokeRuntimes(process.env.XR_SMOKE_RUNTIMES, process.execPath);

describe.each(runtimes)("dist/xr.js under %s", (_name, command) => {
  test("--version prints the package.json version and exits 0", () => {
    const result = spawnSync(command, [bundle, "--version"], {
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${packageJson.version}\n`);
    expect(result.stderr).toBe("");
  });

  test("--nope prints an error on stderr only and exits 2", () => {
    const result = spawnSync(command, [bundle, "--nope"], {
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown option '--nope'");
  });

  test("--json --nope prints one JSON error object on stdout and exits 2", () => {
    const result = spawnSync(command, [bundle, "--json", "--nope"], {
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      warnings: [],
      error: { code: "usage" },
    });
  });
});

test("dist/xr.js starts with the node shebang", () => {
  expect(readFileSync(bundle, "utf8").split("\n")[0]).toBe(
    "#!/usr/bin/env node",
  );
});
