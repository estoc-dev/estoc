import type { ChannelRecord, Conversation, MessageRecord, ObservationRecord, SnapshotIndex } from "../core/types.js";

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
  if (c.claimedName !== null) return `“${c.claimedName.name}”`;
  return "Not named yet";
}

export function initialOf(c: Conversation): string {
  return initialOfName(c.petname ?? c.claimedName?.name ?? null);
}

export function initialOfName(name: string | null): string {
  return name === null || name === "" ? "?" : [...name][0]!.toUpperCase();
}

/** Something has gone wrong with a message of ours: it is not on its way, and a hand is asked for. */
export function failedToSend(message: MessageRecord): boolean {
  if (message.direction !== "out") return false;
  return message.manualAction === "retry" || message.delivery?.status === "terminal" || message.delivery?.status === "conflict";
}

/** The observations a channel names, as the snapshot holds them; none while no snapshot is indexed. */
export function observationsOf(index: SnapshotIndex | null, channel: ChannelRecord): ObservationRecord[] {
  if (index === null) return [];
  return channel.observationIds.flatMap((cid) => {
    const observation = index.observation(cid);
    return observation === null ? [] : [observation];
  });
}

/** Whether our end of the channel is a DID of this vault's, which a rotation away from it needs. */
export function ownsEnd(snapshot: { dids: { did: string | null }[] } | null, channel: ChannelRecord): boolean {
  return snapshot?.dids.some((did) => did.did !== null && shortFormOf(did.did) === channel.localDid) ?? false;
}

/** A channel's two ends, for a title. */
export function endsOf(channel: ChannelRecord): string {
  return `${channel.localDid} → ${channel.peerDid}`;
}
