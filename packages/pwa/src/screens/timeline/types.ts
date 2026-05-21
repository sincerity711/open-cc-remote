export type TimelineEvent =
  | {
      id: string;
      kind: "user" | "assistant";
      title: string;
      body: string;
      time: string;
    }
  | {
      id: string;
      kind: "thinking";
      title: string;
      body: string;
      tokens: string;
      time: string;
    }
  | {
      id: string;
      kind: "tool";
      tool: string;
      command: string;
      cwd: string;
      duration: string;
      result: "success" | "failure" | "running";
      summary: string;
      output: string;
      risk?: "warning" | "danger";
    }
  | {
      id: string;
      kind: "permission-inline";
      tool: string;
      command: string;
      risk: string;
    }
  | {
      id: string;
      kind: "permission-resolved";
      decision: "allowed" | "denied" | "expired";
      via: string;
      time: string;
    }
  | {
      id: string;
      kind: "subagent";
      name: string;
      status: "running" | "completed";
      summary: string;
      children: string[];
    }
  | {
      id: string;
      kind: "batch";
      summary: string;
      tools: string[];
      duration: string;
    }
  | {
      id: string;
      kind: "task";
      title: string;
      status: "created" | "completed";
      detail: string;
    }
  | {
      id: string;
      kind: "system" | "compact" | "session-boundary" | "metadata";
      title: string;
      detail: string;
    }
  | {
      id: string;
      kind: "error";
      title: string;
      detail: string;
    }
  | {
      id: string;
      kind: "raw";
      title: string;
      json: string;
    };

export type TimelineEventKind = TimelineEvent["kind"];
