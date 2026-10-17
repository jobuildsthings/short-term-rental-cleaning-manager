/**
 * Audit log helper (Workstream B).
 *
 * The audit trail is append-only and metadata-only for sensitive domains:
 * NEVER put access-instruction values, feed URLs, or message bodies in
 * `metadata`. Record that something happened, when, and by whom.
 */
import type { Tx } from "./db";
import { auditLog } from "./schema";

export type AuditActorType = "user" | "system";

export interface AuditEntry {
  actorType: AuditActorType;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function audit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorType: entry.actorType,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? null,
  });
}
