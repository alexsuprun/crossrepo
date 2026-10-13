import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepos } from "../helpers/git.ts";
import { isolate, writeFile } from "../helpers/isolate.ts";
import { smokeRuntimes } from "../helpers/smoke-runtimes.ts";

const bundle = fileURLToPath(new URL("../../dist/xr.js", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const runtimes = smokeRuntimes(process.env.XR_SMOKE_RUNTIMES, process.execPath);

/** The test env without color variables, plus `colors`. */
function envWith(colors: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...colors };
  for (const name of ["FORCE_COLOR", "NO_COLOR"]) {
    if (!(name in colors)) delete env[name];
  }
  return env;
}

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

  test("FORCE_COLOR=1 styles the error on a piped stderr", () => {
    const result = spawnSync(command, [bundle, "--nope"], {
      encoding: "utf8",
      env: envWith({ FORCE_COLOR: "1" }),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("\u001b[");
  });

  test("NO_COLOR=1 keeps the error plain", () => {
    const result = spawnSync(command, [bundle, "--nope"], {
      encoding: "utf8",
      env: envWith({ NO_COLOR: "1" }),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("\u001b[");
  });

  test("config show --json in a codebase prints one JSON object with entries", () => {
    const iso = isolate();
    try {
      const codebase = join(iso.root, "shop");
      const file = writeFile(
        join(codebase, ".crossrepo", "config.yaml"),
        "name: shop\n",
      );
      const userFile = writeFile(
        join(iso.home, ".crossrepo", "config.yaml"),
        "projects-dir: ~/p\n",
      );
      const result = spawnSync(command, [bundle, "config", "show", "--json"], {
        encoding: "utf8",
        cwd: codebase,
        // Bun 1.3.0 does not pass later process.env changes to a child without `env`.
        env: { ...process.env },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        warnings: [],
        entries: [
          { key: "name", value: "shop", source: file },
          {
            key: "projects-dir",
            value: "~/p",
            source: userFile,
            resolved: join(iso.home, "p"),
          },
        ],
      });
    } finally {
      iso.restore();
    }
  });

  test("codebase init --json makes a codebase of two repos", () => {
    const iso = isolate();
    try {
      const codebase = join(iso.root, "shop");
      const remotes = makeRepos(codebase, { web: {}, api: {} });
      const result = spawnSync(
        command,
        [bundle, "codebase", "init", "--json"],
        {
          encoding: "utf8",
          cwd: codebase,
          // Bun 1.3.0 does not pass later process.env changes to a child without `env`.
          env: { ...process.env },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        warnings: [],
        codebase,
        added: [
          { repo: "api", remote: remotes.api, defaultBranch: "main" },
          { repo: "web", remote: remotes.web, defaultBranch: "main" },
        ],
      });
      expect(
        readFileSync(join(codebase, ".crossrepo", "config.yaml"), "utf8"),
      ).toContain("repos:\n  api:\n");
      expect(readFileSync(join(codebase, "AGENTS.md"), "utf8")).toContain(
        "## Codebase",
      );
    } finally {
      iso.restore();
    }
  });

  test.skipIf(process.platform === "win32")(
    "a real SIGINT during codebase init undoes it and exits 130",
    async () => {
      const iso = isolate();
      try {
        const codebase = join(iso.root, "shop");
        makeRepos(codebase, { api: {} });
        const child = spawn(command, [bundle, "codebase", "init", "--json"], {
          cwd: codebase,
          env: { ...process.env, XR_TEST_STEP_DELAY_MS: "30000" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          if (stderr.includes("✓ Create .crossrepo/")) child.kill("SIGINT");
        });
        const [code, signal] = await new Promise<
          [number | null, string | null]
        >((resolve) => child.on("close", (c, s) => resolve([c, s])));
        expect({ code, signal }).toEqual({ code: 130, signal: null });
        expect(JSON.parse(stdout)).toEqual({
          ok: false,
          warnings: [],
          error: { code: "interrupted", message: "Stopped by Ctrl-C." },
        });
        expect(existsSync(join(codebase, ".crossrepo"))).toBe(false);
        expect(existsSync(join(codebase, "AGENTS.md"))).toBe(false);
      } finally {
        iso.restore();
      }
    },
    20_000,
  );

  test.skipIf(process.platform === "win32")(
    "a real SIGINT while git runs before the transaction ends xr by the signal",
    async () => {
      const iso = isolate();
      try {
        const codebase = join(iso.root, "shop");
        makeRepos(codebase, { api: {} });
        const marker = join(iso.root, "git-started");
        const bin = join(iso.root, "slow-bin");
        const script = writeFile(
          join(bin, "git"),
          [
            "#!/bin/sh",
            'if [ "$1" = version ]; then echo "git version 2.40.0"; exit 0; fi',
            `touch "${marker}"`,
            "exec sleep 5",
            "",
          ].join("\n"),
        );
        chmodSync(script, 0o755);
        const child = spawn(command, [bundle, "codebase", "init", "--json"], {
          cwd: codebase,
          env: {
            ...process.env,
            PATH: [bin, process.env.PATH].join(delimiter),
          },
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        const closed = new Promise<[number | null, string | null]>((resolve) =>
          child.on("close", (c, s) => resolve([c, s])),
        );
        while (!existsSync(marker)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        child.kill("SIGINT");
        const [code, signal] = await closed;
        expect({ code, signal }).toEqual({ code: null, signal: "SIGINT" });
        expect(stdout).toBe("");
        expect(existsSync(join(codebase, ".crossrepo"))).toBe(false);
      } finally {
        iso.restore();
      }
    },
    20_000,
  );

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
