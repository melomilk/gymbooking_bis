// demoApi keeps all data in localStorage; Node has none, so provide an in-memory one.
// Each test starts with an empty storage -> demoApi re-seeds a fresh database.
import { beforeEach } from "vitest";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

beforeEach(() => store.clear());
