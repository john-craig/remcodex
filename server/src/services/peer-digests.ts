export const PEER_DIGEST_LIMITS = Object.freeze({
  maxBytes: 4 * 1024,
  cadenceMs: 5 * 60 * 1_000,
});

export type CoordinationDigestKind = "milestone" | "blocker" | "completion" | "delivery_failure" | "authorization_failure";

export interface CoordinationDigestEntry {
  kind: CoordinationDigestKind;
  workPackageId: string;
  summary: string;
  occurredAt: string;
}

export interface CoordinationDigest {
  recipient: "orchestrator";
  generatedAt: string;
  entries: CoordinationDigestEntry[];
}

export function buildCoordinationDigest(
  entries: CoordinationDigestEntry[],
  generatedAt = new Date().toISOString(),
  maxBytes = PEER_DIGEST_LIMITS.maxBytes,
): CoordinationDigest {
  const bounded: CoordinationDigestEntry[] = [];
  for (const entry of entries) {
    if (!entry.workPackageId || !entry.summary || !Number.isFinite(Date.parse(entry.occurredAt))) continue;
    const candidate = { ...entry, summary: entry.summary.slice(0, 512) };
    const next: CoordinationDigest = { recipient: "orchestrator", generatedAt, entries: [...bounded, candidate] };
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) break;
    bounded.push(candidate);
  }
  return { recipient: "orchestrator", generatedAt, entries: bounded };
}
