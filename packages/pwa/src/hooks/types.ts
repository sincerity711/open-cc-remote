export type Resource<T> =
  | { status: "loading" }
  | { status: "error"; error: string; retry: () => void }
  | { status: "ready"; data: T };
