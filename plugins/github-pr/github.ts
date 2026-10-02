import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { PullRequest, Snapshot } from "./core.ts";

export function gh(args: string[], signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              "GitHub request failed. Check gh authentication, repository access, and API rate limits.",
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("GitHub returned invalid JSON."));
        }
      },
    );
  });
}

type Review = {
  id: number;
  state: string;
  submitted_at: string | null;
  commit_id: string;
};
type Comment = {
  id: number;
  updated_at: string;
  pull_request_review_id?: number;
};
type Check = {
  __typename: string;
  context?: string;
  name?: string;
  workflowName?: string;
  detailsUrl?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  startedAt?: string;
  completedAt?: string;
};
type View = {
  headRefOid: string;
  state: Snapshot["state"];
  statusCheckRollup: Check[] | null;
};

export async function fetchSnapshot(
  pr: PullRequest,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const root = `repos/${pr.repository}`;
  const view = (await gh(
    [
      "pr",
      "view",
      String(pr.number),
      "--repo",
      pr.repository,
      "--json",
      "headRefOid,state,statusCheckRollup",
    ],
    signal,
  )) as View;
  const pages = async <T>(path: string): Promise<T[]> => {
    return (
      (await gh(
        ["api", `${root}/${path}?per_page=100`, "--paginate", "--slurp"],
        signal,
      )) as T[][]
    ).flat();
  };
  const reviews = await pages<Review>(`pulls/${pr.number}/reviews`);
  const comments = await pages<Comment>(`pulls/${pr.number}/comments`);
  const discussion = await pages<Comment>(`issues/${pr.number}/comments`);
  return snapshotFrom(view, reviews, comments, discussion);
}

export function snapshotFrom(
  view: View,
  reviews: Review[] = [],
  comments: Comment[] = [],
  discussion: Comment[] = [],
): Snapshot {
  const events: Record<string, string> = {};
  const states = new Set([
    "APPROVED",
    "CHANGES_REQUESTED",
    "COMMENTED",
    "DISMISSED",
  ]);
  for (const review of reviews) {
    if (!review.submitted_at || !states.has(review.state)) continue;
    events[`review:${review.id}`] =
      `Review ${review.id}: ${review.state} (commit ${review.commit_id}).`;
  }
  for (const comment of comments) {
    events[`line:${comment.id}`] =
      `Review comment ${comment.id} updated at ${comment.updated_at}${comment.pull_request_review_id ? ` (review ${comment.pull_request_review_id})` : ""}.`;
  }
  for (const comment of discussion) {
    events[`discussion:${comment.id}`] =
      `PR discussion comment ${comment.id} updated at ${comment.updated_at}.`;
  }
  const checks = view.statusCheckRollup ?? [];
  const failed = new Set([
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "CANCELLED",
  ]);
  for (const check of checks) {
    const state = check.conclusion || check.state || "";
    if (
      !failed.has(state) ||
      (check.__typename === "CheckRun" && check.status !== "COMPLETED")
    )
      continue;
    const identity = createHash("sha256")
      .update(
        JSON.stringify(
          check.__typename === "CheckRun"
            ? [
                check.name,
                check.workflowName,
                check.detailsUrl,
                check.startedAt,
              ]
            : [check.context],
        ),
      )
      .digest("hex")
      .slice(0, 16);
    const id = `check:${view.headRefOid}:${identity}`;
    events[id] =
      `Check ${identity}: ${state} (head ${view.headRefOid}; completed ${check.completedAt ?? "unknown"}).`;
  }
  const allPassed =
    checks.length > 0 &&
    checks.every((check) =>
      check.__typename === "CheckRun"
        ? check.status === "COMPLETED" &&
          ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? "")
        : check.state === "SUCCESS",
    );
  return { head: view.headRefOid, state: view.state, events, allPassed };
}
