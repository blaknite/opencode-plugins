import { test, expect } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApiKey } from "./credentials.ts";

test("environment credentials take precedence over the file", async () => {
  expect(await loadApiKey(" env-key ", "/nonexistent/jev-key")).toBe("env-key");
});

test("reads private persistent credentials and picks up rotations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-test-"));
  const path = join(directory, "key");
  try {
    expect(await loadApiKey("", path)).toBeUndefined();
    await writeFile(path, " saved-key\n", { mode: 0o600 });
    expect(await loadApiKey("", path)).toBe("saved-key");
    await writeFile(path, "rotated-key");
    expect(await loadApiKey("", path)).toBe("rotated-key");
    await writeFile(path, "\n");
    expect(await loadApiKey("", path)).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects readable-by-others credential files and symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-test-"));
  const path = join(directory, "key");
  try {
    await writeFile(path, "private-key", { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(loadApiKey("", path)).rejects.toThrow("permissions to 600");
    await chmod(path, 0o600);
    await symlink(path, join(directory, "link"));
    await expect(loadApiKey("", join(directory, "link"))).rejects.toThrow("not a symlink");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
