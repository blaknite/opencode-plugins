import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function credentialPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "credentials", "jev-api-key");
}

export async function loadApiKey(
  envKey = process.env.TYPESAFE_API_KEY,
  path = credentialPath(),
): Promise<string | undefined> {
  if (envKey?.trim()) return envKey.trim();

  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot open the Jev credential file. Check its ownership, permissions, and that it is not a symlink.");
  }

  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("The Jev credential file must belong to your user and be readable only by you. Set its permissions to 600.");
    }
    return (await file.readFile("utf8")).trim() || undefined;
  } finally {
    await file.close();
  }
}
