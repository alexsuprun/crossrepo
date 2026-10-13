import { describe, expect, test } from "bun:test";
import { nameOf } from "../../src/services/repo-add.ts";

describe("nameOf", () => {
  test("is the last part of the URL without .git", () => {
    expect(nameOf("file:///o/api.git")).toBe("api");
    expect(nameOf("https://github.com/acme/web.git/")).toBe("web");
    expect(nameOf("git@github.com:acme/api.git")).toBe("api");
    expect(nameOf("git@host:api")).toBe("api");
    expect(nameOf("C:\\repos\\svc.git")).toBe("svc");
    expect(nameOf("ssh://host/a/b//")).toBe("b");
  });

  test("a URL with no last part gives an empty name", () => {
    expect(nameOf("file:///")).toBe("");
    expect(nameOf(".git")).toBe("");
  });
});
