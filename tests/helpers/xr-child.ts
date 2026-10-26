/**
 * Runs `xr` from source in a child process, for a hook that starts `xr`.
 * Args: the `xr` argv. Exits with the `xr` exit code.
 */
import { homedir } from "node:os";
import { main } from "../../src/cli/index.ts";

process.exitCode = await main({
  version: "0.0.0",
  argv: process.argv.slice(2),
  env: process.env,
  isTTY: { stdin: false, stdout: false, stderr: false },
  cwd: process.cwd(),
  home: homedir(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
