#!/usr/bin/env node
import { main } from "./index.ts";

/** Replaced at build time by `bun build --define`. */
declare const XR_VERSION: string;

process.exitCode = main({
  version: XR_VERSION,
  argv: process.argv.slice(2),
  env: process.env,
  isTTY: {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
    stderr: process.stderr.isTTY === true,
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
