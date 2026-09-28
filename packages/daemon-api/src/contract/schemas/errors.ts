import { z } from "zod";

import type { ApiError } from "../errors.js";
import { messageId } from "./values.js";

export const effect = z.enum(["none", "possible"]);

/** Any code parses: the vocabulary is open, and an unknown code is a failure with the effect it states. */
export const apiError: z.ZodType<ApiError> = z.object({
  code: z.string().min(1),
  message: z.string(),
  effect,
  messageId: messageId.nullable(),
});
