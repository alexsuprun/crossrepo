import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { syncPluginVersion } from "../../scripts/sync-plugin-version.ts";

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));

describe("plugin version", () => {
  test(".claude-plugin/plugin.json version equals package.json version", () => {
    expect({ plugin: plugin.version, package: pkg.version }).toEqual({
      plugin: pkg.version,
      package: pkg.version,
    });
  });

  test("the marketplace entry has no version", () => {
    expect(marketplace.plugins[0]).not.toHaveProperty("version");
    expect(marketplace).not.toHaveProperty("version");
  });

  test("the release workflow runs version-packages through changesets/action", () => {
    const steps = parse(read(".github/workflows/release.yml")).jobs.release
      .steps;
    const action = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("changesets/action@"),
    );
    // changesets/action v2 renamed the input `version` to `version-script` and fails on the old name.
    expect(action?.with).toMatchObject({
      "version-script": "bun run version-packages",
    });
    expect(action?.with).not.toHaveProperty("version");
  });
});

describe("syncPluginVersion", () => {
  test("replaces an old version in place", () => {
    const text =
      '{\n  "name": "xr",\n  "version": "0.1.0",\n  "license": "MIT"\n}\n';
    expect(syncPluginVersion(text, "0.3.0")).toBe(
      '{\n  "name": "xr",\n  "version": "0.3.0",\n  "license": "MIT"\n}\n',
    );
  });

  test("throws when plugin.json has no string version", () => {
    const missing = '{\n  "name": "xr",\n  "license": "MIT"\n}\n';
    const number =
      '{\n  "name": "xr",\n  "version": 1,\n  "license": "MIT"\n}\n';
    expect(() => syncPluginVersion(missing, "0.3.0")).toThrow();
    expect(() => syncPluginVersion(number, "0.3.0")).toThrow();
  });
});
