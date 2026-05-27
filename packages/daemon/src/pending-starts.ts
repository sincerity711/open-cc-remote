export interface PendingStarts {
  add(request_id: string | undefined, cwd: string): void;
  consume(cwd: string): string | undefined;
}

interface Entry {
  request_id: string;
  cwd: string;
  expires_at: number;
}

export function createPendingStarts(opts: {
  ttlMs: number;
  now?: () => number;
}): PendingStarts {
  const now = opts.now ?? (() => Date.now());
  const queue: Entry[] = [];

  const purge = () => {
    const t = now();
    while (queue.length > 0 && queue[0]!.expires_at < t) queue.shift();
  };

  return {
    add(request_id, cwd) {
      if (!request_id) return;
      purge();
      queue.push({ request_id, cwd, expires_at: now() + opts.ttlMs });
    },
    consume(cwd) {
      purge();
      for (let i = 0; i < queue.length; i++) {
        if (queue[i]!.cwd === cwd) {
          const e = queue.splice(i, 1)[0]!;
          return e.request_id;
        }
      }
      return undefined;
    },
  };
}
