import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readme = readFileSync(
  new URL("../../README.md", import.meta.url),
  "utf8",
);

// The README is a landing page: details go to the docs site, not here.
const MIN_LINES = 80;
const MAX_LINES = 120;
const REQUIRED_SECTIONS = [
  "Why",
  "Install",
  "Quick start",
  "Agents",
  "Platforms",
  "Hooks run as you",
  "Remote protocol",
  "Links",
];

const lineCount = readme.replace(/\n$/, "").split("\n").length;
const headings = readme
  .split("\n")
  .filter((line) => line.startsWith("## "))
  .map((line) => line.slice(3).trim());

describe("README.md", () => {
  test(`has ${MIN_LINES} to ${MAX_LINES} lines`, () => {
    expect(lineCount).toBeGreaterThanOrEqual(MIN_LINES);
    expect(lineCount).toBeLessThanOrEqual(MAX_LINES);
  });

  test("has the required ## sections in order", () => {
    const found = headings.filter((h) => REQUIRED_SECTIONS.includes(h));
    expect(found).toEqual(REQUIRED_SECTIONS);
  });

  // npm shows the README without the repo, so a relative link breaks there.
  test("has only absolute link targets", () => {
    const targets = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((t) => !t.startsWith("https://"))).toEqual([]);
  });

  test("has no 'Not ready yet' note", () => {
    expect(readme).not.toContain("Not ready yet");
  });
});
