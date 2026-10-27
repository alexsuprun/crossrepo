#!/usr/bin/env bun
/**
 * Copies the version of package.json into .claude-plugin/plugin.json.
 * Run after `changeset version` (the `version-packages` script).
 */

import { readFileSync, writeFileSync } from "node:fs";

const VERSION_LINE = /^ {2}"version": "[^"]*"/m;

/** Sets the string `"version"` of plugin.json text in place; throws when there is none. */
export function syncPluginVersion(text: string, version: string): string {
  if (!VERSION_LINE.test(text)) {
    throw new Error('plugin.json has no string "version" to update');
  }
  return text.replace(VERSION_LINE, `  "version": ${JSON.stringify(version)}`);
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url);
  const { version } = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  );
  const path = new URL(".claude-plugin/plugin.json", root);
  writeFileSync(path, syncPluginVersion(readFileSync(path, "utf8"), version));
}
