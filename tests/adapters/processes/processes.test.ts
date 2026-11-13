import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  createProcesses,
  parseLsof,
} from "../../../src/adapters/processes/index.ts";

describe("parseLsof", () => {
  test("gives pid, ppid, command and cwd of each process", () => {
    const text = [
      "p12",
      "R1",
      "cnode",
      "fcwd",
      "n/work/shop/.projects/feat/web",
      "p34",
      "R12",
      "czsh",
      "fcwd",
      "n/home/me",
      "",
    ].join("\n");
    expect(parseLsof(text)).toEqual([
      {
        pid: 12,
        ppid: 1,
        command: "node",
        cwd: "/work/shop/.projects/feat/web",
      },
      { pid: 34, ppid: 12, command: "zsh", cwd: "/home/me" },
    ]);
  });

  test("leaves out a process with no cwd and keeps spaces in names", () => {
    const text = [
      "p5",
      "R1",
      "csecret",
      "p6",
      "R1",
      "cmy app",
      "fcwd",
      "n/a dir/b",
    ].join("\n");
    expect(parseLsof(text)).toEqual([
      { pid: 6, ppid: 1, command: "my app", cwd: "/a dir/b" },
    ]);
  });

  test("a missing ppid is 0", () => {
    expect(parseLsof("p7\ncx\nfcwd\nn/\n")).toEqual([
      { pid: 7, ppid: 0, command: "x", cwd: "/" },
    ]);
  });

  test("empty output gives no processes", () => {
    expect(parseLsof("")).toEqual([]);
  });
});

/** Real `lsof` runs only where it is installed. */
const noLsof = process.platform === "win32" || !Bun.which("lsof");

describe("createProcesses", () => {
  test("on Windows: null, lsof never starts", async () => {
    const processes = createProcesses({
      platform: "win32",
      command: "xr-no-such-lsof",
    });
    expect(await processes.cwds()).toBeNull();
  });

  test("lsof not installed: null", async () => {
    const processes = createProcesses({
      platform: "linux",
      command: "xr-no-such-lsof-command",
    });
    expect(await processes.cwds()).toBeNull();
  });

  test("self is the pid of this process", () => {
    expect(createProcesses({ platform: "linux" }).self).toBe(process.pid);
  });

  test.skipIf(process.platform === "win32")(
    "lsof exits non-zero: its output is still read",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "xr-lsof-"));
      const fake = join(dir, "fake-lsof");
      writeFileSync(
        fake,
        "#!/bin/sh\nprintf 'p1\\nR0\\ncx\\nfcwd\\nn/\\n'\nexit 1\n",
      );
      chmodSync(fake, 0o755);
      const list = await createProcesses({
        platform: "linux",
        command: fake,
      }).cwds();
      expect(list).toEqual([{ pid: 1, ppid: 0, command: "x", cwd: "/" }]);
    },
  );

  test("an aborted signal: fails, lsof never starts", async () => {
    const processes = createProcesses({ platform: "linux" });
    await expect(processes.cwds(AbortSignal.abort())).rejects.toThrow();
  });

  test.skipIf(noLsof)(
    "lsof itself never runs in the current folder of xr",
    async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "xr-cwd-")));
      const before = process.cwd();
      process.chdir(dir);
      try {
        const list = await createProcesses({
          platform: process.platform,
        }).cwds();
        const children = (list ?? []).filter(
          ({ ppid }) => ppid === process.pid,
        );
        for (const { cwd } of children) {
          expect(cwd === dir || cwd.startsWith(dir + sep)).toBe(false);
        }
      } finally {
        process.chdir(before);
      }
    },
  );

  test.skipIf(noLsof)(
    "a real run lists this process with its own cwd and parent",
    async () => {
      const list = await createProcesses({ platform: process.platform }).cwds();
      expect(list).not.toBeNull();
      const self = list?.find(({ pid }) => pid === process.pid);
      expect(self?.cwd).toBe(realpathSync(process.cwd()));
      expect(self?.ppid).toBe(process.ppid);
    },
  );
});
