import assert from "node:assert/strict";
import test from "node:test";
import { OptimisticMoves } from "../src/lib/optimistic-moves";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("rapid moves show the latest stage immediately but persist in order", async () => {
  let visible = new Map<string, string>();
  const queue = new OptimisticMoves((targets) => {
    visible = targets;
  });
  const first = deferred();
  const second = deferred();
  const writes: string[] = [];
  let confirmed = "Applied";
  const a = queue.move(
    "company:candidate",
    "Interview",
    async () => {
      writes.push("Interview");
      await first.promise;
    },
    () => {
      confirmed = "Interview";
    },
  );
  const b = queue.move(
    "company:candidate",
    "Hired",
    async () => {
      writes.push("Hired");
      await second.promise;
    },
    () => {
      confirmed = "Hired";
    },
  );
  assert.equal(visible.get("company:candidate"), "Hired");
  await Promise.resolve();
  assert.deepEqual(writes, ["Interview"]);
  first.resolve();
  await a;
  assert.equal(confirmed, "Interview");
  assert.equal(visible.get("company:candidate"), "Hired");
  second.resolve();
  await b;
  assert.deepEqual(writes, ["Interview", "Hired"]);
  assert.equal(confirmed, "Hired");
  assert.equal(visible.size, 0);
});

test("failed latest move rolls back to the last confirmed stage", async () => {
  let visible = new Map<string, string>();
  let confirmed = "Applied";
  const queue = new OptimisticMoves((targets) => {
    visible = targets;
  });
  await queue.move(
    "a:c",
    "Interview",
    async () => {},
    () => {
      confirmed = "Interview";
    },
  );
  await assert.rejects(
    queue.move(
      "a:c",
      "Hired",
      async () => {
        throw new Error("Offline");
      },
      () => {
        confirmed = "Hired";
      },
    ),
  );
  assert.equal(visible.size, 0);
  assert.equal(confirmed, "Interview");
});

test("failure does not discard a newer move or block other companies", async () => {
  let visible = new Map<string, string>();
  const queue = new OptimisticMoves((targets) => {
    visible = targets;
  });
  const failed = deferred();
  const next = deferred();
  const a = queue.move(
    "a:c",
    "Interview",
    () => failed.promise,
    () => {},
  );
  const rejected = assert.rejects(a);
  const b = queue.move(
    "a:c",
    "Hired",
    () => next.promise,
    () => {},
  );
  await queue.move(
    "b:c",
    "Rejected",
    async () => {},
    () => {},
  );
  assert.equal(visible.get("a:c"), "Hired");
  assert.equal(visible.has("b:c"), false);
  failed.reject(new Error("Server rejected the earlier move"));
  await rejected;
  assert.equal(visible.get("a:c"), "Hired");
  next.resolve();
  await b;
  assert.equal(visible.size, 0);
});
