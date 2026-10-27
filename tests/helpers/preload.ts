import { afterAll } from "bun:test";
import { removeRepoTemplates } from "./git.ts";

// Here, not in git.ts: an afterAll there binds to the first test file only when the files share one module.
afterAll(removeRepoTemplates);
