/**
 * The agent's lines as a view is shown them: the same three lists,
 * each connection's reconciliation without the arrangement it names
 * again, and no envelope bytes.
 */

import type { AgentLines, Connection } from "@estoc/agent-core";
import type { Source } from "@estoc/agent-core";
import type { ConnectionRecord, DeliverySource, Lines, MediationId } from "@estoc/daemon-api/contract";

const mediationIdOf = (mediationId: Connection["mediationId"]): MediationId => mediationId as string as MediationId;

const sourceOf = (source: Source): DeliverySource => (source.kind === "direct" ? { kind: "direct" } : { kind: "pickup", mediationId: mediationIdOf(source.mediationId), deliveryId: source.deliveryId });

function connectionRecord({ mediationId, unreachable, reconciled, unknownRegistrations, drained, live }: Connection): ConnectionRecord {
  return {
    mediationId: mediationIdOf(mediationId),
    unreachable,
    reconciled: reconciled === null ? null : { desired: reconciled.desired, held: reconciled.held, added: reconciled.added, removed: reconciled.removed, refused: reconciled.refused, unknown: reconciled.unknown },
    unknownRegistrations,
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
