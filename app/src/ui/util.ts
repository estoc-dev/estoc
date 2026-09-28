import type { Conversation, MessageRecord, ObservationRecord } from "../core/types.js";

/** did:peer:4 long forms run ~800 characters; show head and tail. */
export function shortDid(did: string): string {
  return did.length <= 36 ? did : `${did.slice(0, 22)}…${did.slice(-8)}`;
}

export function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A time as a list shows it: the hour today, the day this week, the date otherwise. */
export function whenOf(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return timeOf(then.getTime());
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString([], { weekday: "short" });
  if (then.getFullYear() === now.getFullYear()) return then.toLocaleDateString([], { day: "numeric", month: "short" });
  return then.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/** A day heading in a thread. */
export function dayOf(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(then, now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(then, yesterday)) return "Yesterday";
  return then.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short", ...(then.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

export async function bytesOf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** The short form of a did:peer:4, which is how a channel names its ends; any other DID as it is. */
export function shortFormOf(did: string): string {
  return did.startsWith("did:peer:4") ? did.split(":").slice(0, 3).join(":") : did;
}

export function dispositionOf({ disposition }: ObservationRecord): string {
  switch (disposition.status) {
    case "admitted":
      return "taken in";
    case "refused":
      return `refused: ${disposition.because}`;
    case "ignored-superseded":
      return "ignored: they had moved to another address";
    case "pending-admission":
      return `not taken in yet: ${disposition.because}`;
  }
}

/** Our name for them; failing that what they call themself, quoted as the claim it is. */
export function labelOf(c: Conversation): string {
  if (c.petname !== null) return c.petname;
  if (c.claimedName !== null) return `“${c.claimedName}”`;
  return "Not named yet";
}

/** The letter a conversation is shown under; none while nobody has given it a name. */
export function initialOf(c: Conversation): string {
  const name = c.petname ?? c.claimedName;
  return name === null || name === "" ? "?" : [...name][0]!.toUpperCase();
}

/** Something has gone wrong with a message of ours: it is not on its way, and a hand is asked for. */
export function failedToSend(message: MessageRecord): boolean {
  if (message.direction !== "out") return false;
  return message.manualAction === "retry" || message.outcome?.status === "terminal" || message.outcome?.status === "conflict";
}
