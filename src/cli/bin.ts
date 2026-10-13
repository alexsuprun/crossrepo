#!/usr/bin/env node
import { homedir } from "node:os";
import { main } from "./index.ts";
import { exitAfterFlush, sigintSource } from "./sigint.ts";

/** Replaced at build time by `bun build --define`. */
declare const XR_VERSION: string;

const sigint = sigintSource(process);

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
  interrupts: sigint.interrupts,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then((code) => {
  process.exitCode = code;
  // After a second Ctrl-C the runner gave up on the undo; do not let it run on.
  if (sigint.count >= 2) exitAfterFlush(process, code, (c) => process.exit(c));
});
