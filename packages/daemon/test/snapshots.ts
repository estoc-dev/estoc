import { expect } from "vitest";

import { schemas, type Snapshot } from "@estoc/daemon-api/contract";

/** Every reference in `snapshot` names a record of it, and each contact has its one conversation. */
export function resolves(snapshot: Snapshot): void {
  const channels = new Set(snapshot.channels.map(({ channelId }) => channelId));
  const messages = new Set(snapshot.messages.map(({ messageId }) => messageId));
  const observations = new Set(snapshot.observations.map(({ sourceEventCid }) => sourceEventCid));
  const contacts = new Set(snapshot.contacts.map(({ contactId }) => contactId));
  const inChannels = (ids: readonly (string | null)[]) => ids.forEach((id) => id === null || expect(channels).toContain(id));
  const inMessages = (ids: readonly string[]) => ids.forEach((id) => expect(messages).toContain(id));
  const inObservations = (ids: readonly string[]) => ids.forEach((id) => expect(observations).toContain(id));
  for (const record of snapshot.channels) {
    inChannels([record.headChannelId]);
    inMessages(record.messageIds);
    inObservations(record.observationIds);
    if (record.peerName !== null) inMessages([record.peerName.messageId]);
  }
  for (const record of snapshot.messages) {
    inChannels([record.channelId]);
    record.contactIds.forEach((contactId) => expect(contacts).toContain(contactId));
  }
  for (const record of snapshot.observations) inChannels([record.channelId]);
  for (const record of snapshot.contacts) inChannels(record.preference?.channelIds ?? []);
  for (const record of snapshot.conversations) {
    if (record.contactId !== null) expect(contacts).toContain(record.contactId);
    inChannels([...record.channels.map(({ channelId }) => channelId), ...record.writeTo, record.defaultWriteTo]);
    inMessages(record.messageIds);
    inObservations(record.unadmittedObservationIds);
    if (record.claimedName !== null) inMessages([record.claimedName.messageId]);
  }
  for (const contactId of contacts) expect(snapshot.conversations.filter((record) => record.contactId === contactId)).toHaveLength(1);
  const { pending, unplaced } = snapshot;
  inChannels([...pending.pendingOutbounds, ...pending.missingResponses, ...pending.missingNotifications, ...pending.pendingProofs].map(({ channelId }) => channelId));
  inObservations(unplaced.observationIds);
  for (const output of unplaced.outputs) {
    inMessages([output.messageId]);
    inChannels(output.candidateChannelIds);
  }
}

/** The snapshot a daemon has published, as a view is handed it: it passes the API's schema and every reference in it resolves. */
export function published(daemon: { publisher: { current: { state: { value: { phase: string; snapshot?: Snapshot } } } } }): Snapshot {
  const { value } = daemon.publisher.current.state;
  if (value.phase !== "open") throw new Error(`no snapshot is published: the daemon is ${value.phase}`);
  const snapshot = value.snapshot!;
  expect(schemas.snapshot.parse(snapshot)).toEqual(snapshot);
  resolves(snapshot);
  return snapshot;
}
