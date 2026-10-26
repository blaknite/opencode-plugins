import { execFile } from "node:child_process";
import type { Build, Snapshot } from "./core.ts";

export class AuthenticationError extends Error {
  constructor() {
    super(
      "The bk CLI is not authenticated or its credentials/access are no longer valid. Ask the user to reauthenticate their Buildkite CLI with `bk auth login`, then retry subscribing. Do not look for tokens or use alternative credentials.",
    );
    this.name = "AuthenticationError";
  }
}

export function requestError(
  error: Error & { code?: string | number },
  stderr: string,
): Error {
  if (error.code === "ENOENT")
    return new Error(
      "The bk CLI is not installed or is not on the OpenCode service's PATH.",
    );
  if (
    /\b(?:401|403|unauthorized|forbidden)\b|not authenticated|no (?:stored )?(?:credentials|api token)|(?:token|credentials?).*(?:expired|invalid)|(?:authentication|permission) (?:failed|denied)|bk (?:auth login|configure)/i.test(
      stderr,
    )
  )
    return new AuthenticationError();
  return new Error(
    "Buildkite request failed. Check build access, network connectivity, bk CLI support for --summary, and API rate limits.",
  );
}

export function bk(args: string[], signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "bk",
      args,
      { signal, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(requestError(error, stderr));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("The bk CLI returned invalid JSON."));
        }
      },
    );
  });
}

export function normalize(value: unknown): Snapshot {
  if (!value || typeof value !== "object" || !("state" in value))
    throw new Error("The bk CLI returned an invalid build summary.");
  const { state } = value;
  if (
    typeof state !== "string" ||
    ![
      "creating",
      "scheduled",
      "running",
      "failing",
      "blocked",
      "canceling",
      "passed",
      "failed",
      "canceled",
      "skipped",
      "not_run",
    ].includes(state)
  )
    throw new Error("The bk CLI returned an unrecognized build state.");
  return { state, blocked: state === "blocked" };
}

export async function fetchSnapshot(
  build: Build,
  signal?: AbortSignal,
  run = bk,
): Promise<Snapshot> {
  return normalize(
    await run(
      [
        "build",
        "view",
        String(build.number),
        "--pipeline",
        build.pipeline,
        "--summary",
        "--json",
        "--no-input",
        "--no-pager",
      ],
      signal,
    ),
  );
}
