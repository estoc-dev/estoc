/**
 * The content of the messages a view sends on a person's behalf, and
 * the reading of the one protocol body a view names people by. What
 * the daemon makes of a received message is in its record; these read
 * and write only the bodies a view composes itself.
 */

import { BASIC_MESSAGE, PROFILE, type JsonObject, type MessageContent } from "../contract/index.js";

/** A line of chat. */
export function basicMessage(text: string): MessageContent {
  return { type: BASIC_MESSAGE, body: { content: text } };
}

/** An introduction: the name this vault goes by, which the peer holds as a claim of ours. */
export function profileMessage(displayName: string): MessageContent {
  return { type: PROFILE, body: { profile: { displayName } } };
}

/** The name a profile's body announces; null when it names none. */
export function announcedName(body: JsonObject): string | null {
  const profile = body["profile"];
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return null;
  const name = profile["displayName"];
  return typeof name === "string" && name !== "" ? name : null;
}
