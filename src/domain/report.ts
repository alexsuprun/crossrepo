// Plain copies of the Report types in `src/output/`, which commands may not import.

export type Tone = "ok" | "warn" | "error" | "muted";

/** A path shows relative to the codebase or `~` in text modes; a code shows as a command. */
export type Text = string | { path: string } | { code: string };

export type RepoStatus = "ok" | "skipped" | "failed" | "conflict";

export interface FieldItem {
  key: string;
  value: Text | Text[];
  source?: Text;
  extra?: Record<string, Text>;
}

/** What a part of the Report is, never how it looks (AD-3). */
export type Block =
  | { type: "value"; key: string; value: Text }
  | { type: "fields"; key: string; items: FieldItem[] }
  /** Rows of records. Each record has the same keys, which are the JSON field names. */
  | { type: "table"; key: string; items: Record<string, Text>[] }
  | {
      type: "repos";
      items: { repo: string; status: RepoStatus; message?: Text }[];
    }
  | { type: "checks"; items: { id: string; status: string; fix?: Text }[] }
  | {
      type: "leftovers";
      items: { what: string; path: Text; command: Text }[];
    }
  | { type: "section"; key: string; title: Text; blocks: Block[] }
  | { type: "note"; tone: Tone; text: Text };

export interface Report {
  blocks: Block[];
  error?: { code: string; message: string; hint?: string; blocks?: Block[] };
}

export interface Warning {
  code: string;
  message: string;
  hint?: string;
}

export type LiveEvent =
  | { type: "step-start"; text: string }
  | { type: "step-end"; text: string; ok: boolean }
  | { type: "repo"; repo: string; status: RepoStatus; message?: string }
  | { type: "warning"; warning: Warning };
