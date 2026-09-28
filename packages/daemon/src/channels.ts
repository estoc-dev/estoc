/**
 * A channel as a view names it: the canonical JSON text of its two
 * DIDs, `[localDid, peerDid]`, made here and handed back as it was.
 * A view never takes it apart; the daemon does, and takes back only
 * what it would have made itself. The DIDs named are not checked
 * here: a pair is checked by whatever it is used for, against the
 * vault, as a pair handed over on its own is.
 */

import { InvalidIdentifier, channelKey, channelOf as pairOf, type Channel, type Did } from "@estoc/vault";
import type { ChannelId } from "@estoc/daemon-api/contract";

export class InvalidChannelId extends Error {
  constructor(
    readonly channelId: string,
    why: string
  ) {
    super(`not a channel ID: ${why}`);
    this.name = "InvalidChannelId";
  }
}

export const channelIdOf = (channel: Channel): ChannelId => channelKey(channel) as ChannelId;

/** The pair a channel ID names: two distinct DIDs whose canonical text is this very text. */
export function channelOf(channelId: string): Channel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(channelId);
  } catch {
    throw new InvalidChannelId(channelId, "not JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((did) => typeof did === "string")) throw new InvalidChannelId(channelId, "not a pair of DIDs");
  const [localDid, peerDid] = parsed as [Did, Did];
  let channel: Channel;
  try {
    channel = pairOf(localDid, peerDid);
  } catch (err) {
    if (err instanceof InvalidIdentifier) throw new InvalidChannelId(channelId, err.message);
    throw err;
  }
  if (channelKey(channel) !== channelId) throw new InvalidChannelId(channelId, "not the canonical text of its pair");
  return channel;
}
