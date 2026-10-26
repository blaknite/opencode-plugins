import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@opencode/plugin/promise/plugin";
import {
  eventMessage,
  expiry,
  parseBuild,
  terminal,
  updates,
  type Snapshot,
  type Subscription,
} from "./core.ts";
import { AuthenticationError, fetchSnapshot } from "./buildkite.ts";

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
      const build = parseBuild(value);
      const expiresAt = expiry(hours, this.now());
      const id = createHash("sha256")
        .update(`${sessionID}:${build.pipeline}#${build.number}`)
        .digest("hex");
      const old = (await this.rows()).find((row) => row.id === id);
      let snapshot: Snapshot;
      try {
        snapshot = await this.fetch(build, signal);
      } catch (error) {
        if (error instanceof AuthenticationError)
          throw new Error(
            "Buildkite authentication failed. Ask the user to reauthenticate the bk CLI with `bk auth login`, then retry.",
          );
        throw new Error(
          "Could not read the Buildkite build. Check bk CLI access and build availability, then retry.",
        );
      }
      const row: Subscription = {
        id,
        sessionID,
        build,
        expiresAt,
        delivery: delivery ?? old?.delivery ?? "queue",
        snapshot,
        generation: old?.generation ?? randomUUID(),
        revision: old?.revision ?? 0,
      };
      if (terminal(snapshot)) await this.ctx.storage.remove(this.key(id));
      else
        await this.ctx.storage.set(this.key(id), {
          ...row,
          snapshot: old?.snapshot ?? snapshot,
        });
      return row;
    });
  }

  unsubscribe(sessionID: string, value?: string) {
    return this.serial(async () => {
      const build = value ? parseBuild(value) : undefined;
      const rows = (await this.rows()).filter(
        (row) =>
          row.sessionID === sessionID && (!build || row.build.url === build.url),
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
      const notified = new Set(
        rows.filter((row) => row.authNotified).map((row) => row.sessionID),
      );
      let failed = false;
      for (const row of rows) {
        try {
          if (this.controller.signal.aborted) return;
          let pending = snapshots.get(row.build.url);
          if (!pending) {
            pending = this.fetch(row.build, this.controller.signal);
            snapshots.set(row.build.url, pending);
          }
          let snapshot: Snapshot;
          try {
            snapshot = await pending;
          } catch (error) {
            if (
              error instanceof AuthenticationError &&
              !this.controller.signal.aborted &&
              !notified.has(row.sessionID)
            ) {
              const text =
                "Buildkite build watching cannot authenticate with the bk CLI. Ask the user to reauthenticate with `bk auth login`. Subscriptions are retained and will retry automatically. Do not attempt to authenticate on the user's behalf.";
              const id = `msg_${createHash("sha256")
                .update(`auth:${row.id}:${row.generation}:${row.revision ?? 0}`)
                .digest("hex")}`;
              await this.ctx.session.synthetic({
                sessionID: row.sessionID,
                id,
                text,
                delivery: row.delivery,
                resume: true,
              });
              row.authNotified = true;
              await this.ctx.storage.set(this.key(row.id), row);
              notified.add(row.sessionID);
            }
            throw error;
          }
          if (this.controller.signal.aborted) return;
          if (row.expiresAt !== null && row.expiresAt <= this.now()) {
            await this.ctx.storage.remove(this.key(row.id));
            continue;
          }
          if (row.authNotified) {
            delete row.authNotified;
            await this.ctx.storage.set(this.key(row.id), row);
          }
          const messages = updates(row, snapshot);
          if (messages.length) {
            const text = eventMessage(row, messages);
            const id = `msg_${createHash("sha256")
              .update(`${row.id}:${row.generation}:${row.revision ?? 0}:${JSON.stringify(snapshot)}:${text}`)
              .digest("hex")}`;
            await this.ctx.session.synthetic({
              sessionID: row.sessionID,
              id,
              text,
              delivery: row.delivery,
              resume: true,
            });
          }
          if (terminal(snapshot))
            await this.ctx.storage.remove(this.key(row.id));
          else {
            row.snapshot = snapshot;
            row.revision = (row.revision ?? 0) + 1;
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
            "buildkite-build: polling failed; retrying with backoff. Check bk CLI authentication, Buildkite availability, and session availability.",
          );
      } else {
        this.failures = 0;
        this.nextPoll = this.now() + 60_000;
      }
    });
  }
}
