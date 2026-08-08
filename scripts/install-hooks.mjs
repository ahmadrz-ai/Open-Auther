/**
 * Point git at .githooks so the secret-scanning pre-commit hook is active.
 * Never fails the install: a missing git or a non-repo checkout is fine.
 */

import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  console.log("hooks: core.hooksPath -> .githooks");
} catch {
  console.log("hooks: skipped (not a git repository)");
}
