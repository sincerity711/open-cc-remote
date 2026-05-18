import { watch, openSync, readSync, closeSync, statSync, existsSync, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";

export interface WatcherOptions {
  path: string;
  startOffset?: number;
  onLine: (line: string, offset: number) => void;
  onError?: (err: Error) => void;
}

export interface WatcherHandle {
  close(): void;
}

export function startWatcher(opts: WatcherOptions): WatcherHandle {
  const dir = dirname(opts.path);
  const fileName = basename(opts.path);

  let offset = opts.startOffset !== undefined
    ? opts.startOffset
    : (existsSync(opts.path) ? statSync(opts.path).size : 0);
  let buffer = "";
  let closed = false;
  let watcher: FSWatcher | null = null;

  const drain = () => {
    if (closed) return;
    if (!existsSync(opts.path)) return;
    let size: number;
    try { size = statSync(opts.path).size; } catch { return; }

    if (size < offset) {
      // File truncated or replaced. Reset.
      offset = 0;
      buffer = "";
    }
    if (size <= offset) return;

    const chunkSize = size - offset;
    let fd: number;
    try { fd = openSync(opts.path, "r"); } catch (e) {
      opts.onError?.(e as Error);
      return;
    }
    try {
      const buf = Buffer.alloc(chunkSize);
      readSync(fd, buf, 0, chunkSize, offset);
      offset = size;
      buffer += buf.toString("utf8");

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const remainingBytes = Buffer.byteLength(buffer, "utf8");
        const lineOffset = offset - remainingBytes;
        opts.onLine(line, lineOffset);
      }
    } catch (e) {
      opts.onError?.(e as Error);
    } finally {
      try { closeSync(fd); } catch {}
    }
  };

  drain();

  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename === fileName) {
        setImmediate(drain);
      }
    });
    watcher.on("error", (e: Error) => opts.onError?.(e));
  } catch (e) {
    opts.onError?.(e as Error);
  }

  return {
    close() {
      closed = true;
      try { watcher?.close(); } catch {}
    },
  };
}
