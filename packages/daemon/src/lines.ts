/**
 * The agent's lines as a view is shown them: the same three lists,
 * each connection's recipients without the arrangement it names again,
 * and no envelope bytes.
 */

import type { AgentLines, Connection } from "@estoc/agent-core";
import type { Source } from "@estoc/agent-core";
import type { ConnectionRecord, DeliverySource, Lines, MediationId } from "@estoc/daemon-api/contract";

const mediationIdOf = (mediationId: Connection["mediationId"]): MediationId => mediationId as string as MediationId;

const sourceOf = (source: Source): DeliverySource => (source.kind === "direct" ? { kind: "direct" } : { kind: "pickup", mediationId: mediationIdOf(source.mediationId), deliveryId: source.deliveryId });

function connectionRecord({ mediationId, unreachable, recipients, drained, live }: Connection): ConnectionRecord {
  return {
    mediationId: mediationIdOf(mediationId),
    unreachable,
    recipients: recipients === null ? null : { wanted: recipients.wanted, added: recipients.added, refused: recipients.refused.map(({ did, because }) => ({ did, because })) },
    drained,
    live,
  };
}

export function linesOf({ connections, waiting, discarded }: AgentLines): Lines {
  return {
    connections: connections.map(connectionRecord),
    waiting: waiting.map(({ key, source, reason, held }) => ({ key, source: sourceOf(source), reason, held })),
    discarded: discarded.map(({ source, reason }) => ({ source: sourceOf(source), reason })),
  };
}
