import { z } from "zod";

import type { RevisionMarker, State, StateValue } from "../state.js";
import { snapshot } from "./records.js";
import { epoch, hold, revision } from "./values.js";

const detail = z.string().nullable();

export const stateValue: z.ZodType<StateValue> = z.discriminatedUnion("phase", [
  z.object({ phase: z.enum(["booting", "unreadable"]), hold: hold.nullable(), detail }),
  z.object({ phase: z.enum(["elsewhere", "onboarding", "foreign"]), hold: z.null(), detail }),
  z.object({ phase: z.enum(["damaged", "locked"]), hold, detail }),
  z.object({ phase: z.literal("open"), hold, snapshot }),
]);

export const state: z.ZodType<State> = z.object({ epoch, revision, value: stateValue });

export const revisionMarker: z.ZodType<RevisionMarker> = z.object({ epoch, revision });
