import { createHash } from "node:crypto";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
  eventMessage,
  expiry,
  parsePullRequest,
  updates,
  type Snapshot,
  type Subscription,
} from "./core.ts";
import { fetchSnapshot } from "./github.ts";

export class Watcher {
  private tail: Promise<unknown> = Promise.resolve();
  private failures = 0;
  private nextPoll = 0;
  private controller = new AbortController();

  constructor(
    private ctx: Context,
    private fetch = fetchSnapshot,
    private now = Date.now,
  ) {}

  stop() {
    this.controller.abort();
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => {});
    return next;
  }

  private key(id: string) {
    return `subscriptions/${encodeURIComponent(this.ctx.location.directory)}/${id}`;
  }

  private async rows(): Promise<Subscription[]> {
    const rows: Subscription[] = [];
    let after: string | undefined;
    do {
      const page = await this.ctx.storage.scan({
        prefix: this.key(""),
        limit: 100,
        ...(after ? { after } : {}),
      });
      rows.push(...page.entries.map((entry) => entry.value as Subscription));
      after = page.next;
    } while (after);
    for (const row of rows) {
      if (row.expiresAt !== null && row.expiresAt <= this.now())
        await this.ctx.storage.remove(this.key(row.id));
    }
    return rows.filter(
      (row) => row.expiresAt === null || row.expiresAt > this.now(),
    );
  }

  subscribe(
    sessionID: string,
    value: string,
    hours?: number | null,
    delivery?: "queue" | "steer",
    signal?: AbortSignal,
  ) {
    return this.serial(async () => {
      const pr = parsePullRequest(value);
      const expiresAt = expiry(hours, this.now());
      const id = createHash("sha256")
        .update(`${sessionID}:${pr.repository}#${pr.number}`)
        .digest("hex");
      const old = (await this.rows()).find((row) => row.id === id);
      const snapshot = old?.snapshot ?? (await this.fetch(pr, signal));
      if (snapshot.state !== "OPEN")
        throw new Error("Cannot subscribe to a closed or merged PR.");
      const row: Subscription = {
        id,
        sessionID,
        pr,
        expiresAt,
        delivery: delivery ?? old?.delivery ?? "queue",
        snapshot,
        passedHeads:
          old?.passedHeads ?? (snapshot.allPassed ? [snapshot.head] : []),
      };
      await this.ctx.storage.set(this.key(id), row);
      return row;
    });
  }

  unsubscribe(sessionID: string, value?: string) {
    return this.serial(async () => {
      const pr = value ? parsePullRequest(value) : undefined;
      const rows = (await this.rows()).filter(
        (row) => row.sessionID === sessionID && (!pr || row.pr.url === pr.url),
      );
      for (const row of rows) await this.ctx.storage.remove(this.key(row.id));
      return rows.length;
    });
  }

  list(sessionID: string) {
    return this.serial(async () =>
      (await this.rows()).filter((row) => row.sessionID === sessionID),
    );
  }

  poll() {
    return this.serial(async () => {
      const rows = await this.rows();
      if (
        this.controller.signal.aborted ||
        this.now() < this.nextPoll ||
        !rows.length
      )
        return;
      const snapshots = new Map<string, Promise<Snapshot>>();
      let failed = false;
      for (const row of rows) {
        try {
          if (this.controller.signal.aborted) return;
          let pending = snapshots.get(row.pr.url);
          if (!pending) {
            pending = this.fetch(row.pr, this.controller.signal);
            snapshots.set(row.pr.url, pending);
          }
          const snapshot = await pending;
          if (this.controller.signal.aborted) return;
          if (row.expiresAt !== null && row.expiresAt <= this.now()) {
            await this.ctx.storage.remove(this.key(row.id));
            continue;
          }
          const messages = updates(row, snapshot);
          if (messages.length) {
            const text = eventMessage(row, messages);
            const id = `msg_${createHash("sha256")
              .update(`${row.id}:${JSON.stringify(snapshot)}:${text}`)
              .digest("hex")}`;
            await this.ctx.session.synthetic({
              sessionID: row.sessionID,
              id,
              text,
              delivery: row.delivery,
              resume: true,
            });
          }
          if (snapshot.state !== "OPEN")
            await this.ctx.storage.remove(this.key(row.id));
          else {
            row.snapshot = snapshot;
            if (snapshot.allPassed && !row.passedHeads.includes(snapshot.head))
              row.passedHeads.push(snapshot.head);
            await this.ctx.storage.set(this.key(row.id), row);
          }
        } catch {
          failed = true;
        }
      }
      if (failed) {
        this.failures++;
        this.nextPoll =
          this.now() +
          Math.min(60_000 * 2 ** Math.min(this.failures, 6), 3_600_000);
        if (!this.controller.signal.aborted)
          console.warn(
            "github-pr: polling failed; retrying with backoff. Check gh authentication, GitHub rate limits, and session availability.",
          );
      } else {
        this.failures = 0;
        this.nextPoll = this.now() + 60_000;
      }
    });
  }
}
