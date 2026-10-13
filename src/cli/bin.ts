#!/usr/bin/env node
import { homedir } from "node:os";
import { main } from "./index.ts";

/** Replaced at build time by `bun build --define`. */
declare const XR_VERSION: string;

main({
  version: XR_VERSION,
  argv: process.argv.slice(2),
  env: process.env,
  isTTY: {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
    stderr: process.stderr.isTTY === true,
  },
  cwd: process.cwd(),
  home: homedir(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then((code) => {
  process.exitCode = code;
});
