import { BASIC_MESSAGE, PROFILE } from "../contract/protocol.js";
import type { MessageContent } from "../contract/records.js";

/** Content for a basic message send. Text is kept exactly, including whitespace and line breaks. */
export function basicMessage(content: string): MessageContent {
  return { type: BASIC_MESSAGE, body: { content } };
}

/** Content for announcing our display name; it supplies neither a target nor permission to send. */
export function profileMessage(displayName: string): MessageContent {
  return { type: PROFILE, body: { profile: { displayName } } };
}
