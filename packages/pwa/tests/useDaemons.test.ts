import { test, expect } from "bun:test";
import { daemonsUrl, sortDaemons, type DaemonItem } from "../src/hooks/useDaemons";

test("daemonsUrl is a same-origin path (vite dev proxies, prod is same-origin)", () => {
  expect(daemonsUrl("ws://hub:7745")).toBe("/daemons");
  expect(daemonsUrl("wss://hub")).toBe("/daemons");
  expect(daemonsUrl("http://hub")).toBe("/daemons");
});

test("sortDaemons puts connected=true first then paired_at desc", () => {
  const list: DaemonItem[] = [
    { daemon_id: "a", display_name: null, hostname: null, paired_at: 100, last_seen_at: null, connected: false },
    { daemon_id: "b", display_name: null, hostname: null, paired_at: 200, last_seen_at: null, connected: true },
    { daemon_id: "c", display_name: null, hostname: null, paired_at: 50, last_seen_at: null, connected: true },
    { daemon_id: "d", display_name: null, hostname: null, paired_at: 300, last_seen_at: null, connected: false },
  ];
  expect(sortDaemons(list).map((d) => d.daemon_id)).toEqual(["b", "c", "d", "a"]);
});

test("sortDaemons does not mutate input", () => {
  const list: DaemonItem[] = [
    { daemon_id: "a", display_name: null, hostname: null, paired_at: 1, last_seen_at: null, connected: false },
    { daemon_id: "b", display_name: null, hostname: null, paired_at: 2, last_seen_at: null, connected: true },
  ];
  const original = [...list];
  sortDaemons(list);
  expect(list).toEqual(original);
});
