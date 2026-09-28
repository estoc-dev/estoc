import { z } from "zod";

import { WIRE_VERSION, type Bootstrap, type Hello, type Incompatible, type Limits, type Welcome } from "../bootstrap.js";
import { count } from "./values.js";

const wire = z.literal(WIRE_VERSION);
const versions = z.array(count);

export const limits: z.ZodType<Limits> = z.object({
  maxFrameBytes: count.nullable(),
  maxBackupBytes: count,
  maxValueBytes: count,
  maxDepth: count,
});

const helloRecord = z.object({ kind: z.literal("hello"), wire, apis: versions });
const welcomeRecord = z.object({ kind: z.literal("welcome"), wire, api: count, implementation: z.string(), limits });
const incompatibleRecord = z.object({ kind: z.literal("incompatible"), wire, supported: versions, message: z.string() });

export const hello: z.ZodType<Hello> = helloRecord;
export const welcome: z.ZodType<Welcome> = welcomeRecord;
export const incompatible: z.ZodType<Incompatible> = incompatibleRecord;

export const bootstrap: z.ZodType<Bootstrap> = z.discriminatedUnion("kind", [helloRecord, welcomeRecord, incompatibleRecord]);
