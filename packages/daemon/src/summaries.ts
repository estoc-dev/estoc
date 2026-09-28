/**
 * One line for a message, from its content, by its type: what a view
 * shows where it has no renderer of its own for the type. Text, never
 * markup: a view shows it as it shows anything a peer wrote.
 */

import type { JsonObject } from "@estoc/event-store";
import { BASIC_MESSAGE, PROFILE, announcedName } from "@estoc/agent-core";

type Summarize = (body: JsonObject) => string | null;

const SUMMARIES: ReadonlyMap<string, Summarize> = new Map<string, Summarize>([
  [BASIC_MESSAGE, (body) => (typeof body["content"] === "string" ? body["content"] : null)],
  [
    PROFILE,
    (body) => {
      const name = announcedName({ body });
      return name === null ? null : `name: ${name}`;
    },
  ],
]);

const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g;

/** The one line a message of `type` with `body` is summarized as; null for a type with no summary, or a body that gives none. */
export function summaryOf(type: string, body: JsonObject): string | null {
  const summary = SUMMARIES.get(type)?.(body) ?? null;
  return summary === null ? null : summary.replace(LINE_BREAKS, " ");
}
