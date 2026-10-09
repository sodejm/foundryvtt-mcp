/** Features whose availability is verified against an external Foundry transport. */
export type CapabilityFeature =
  | 'compendiumSearch'
  | 'rulesLookup'
  | 'diagnostics'
  | 'contentGeneration';

/** A verified feature state. Callers must not infer availability from configuration alone. */
export type CapabilityStatus =
  | 'available'
  | 'unavailable'
  | 'unauthorized'
  | 'unreachable'
  | 'incompatible';

/** Transport used to verify a capability. */
export type CapabilityTransport = 'rest';

/** Public, redacted result of an active capability check. */
export interface Capability {
  feature: CapabilityFeature;
  status: CapabilityStatus;
  reason: string;
  remediation: string | null;
  verifiedAt: string;
  transport: CapabilityTransport;
}

/** Versioned report of Foundry-backed integrations, verified at request time. */
export interface CapabilityReport {
  schemaVersion: 1;
  capabilities: Capability[];
}
