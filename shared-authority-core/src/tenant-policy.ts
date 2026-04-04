/**
 * Tenant-level policy resolution. Merges tenant overrides with POLICY_DEFAULTS.
 * No worker reads raw policy — all go through resolve().
 */

import { POLICY_DEFAULTS, type PolicyKey } from './policy-defaults.js';

export type TenantOverrides = Partial<Record<PolicyKey, number>>;

export class TenantPolicy {
  private overrides: TenantOverrides;

  constructor(overrides: TenantOverrides = {}) {
    this.overrides = overrides;
  }

  resolve<K extends PolicyKey>(key: K): typeof POLICY_DEFAULTS[K] {
    if (key in this.overrides) {
      return this.overrides[key] as typeof POLICY_DEFAULTS[K];
    }
    return POLICY_DEFAULTS[key];
  }

  static fromRow(row: { policy_overrides?: string | null }): TenantPolicy {
    if (!row.policy_overrides) return new TenantPolicy();
    try {
      return new TenantPolicy(JSON.parse(row.policy_overrides));
    } catch {
      return new TenantPolicy();
    }
  }
}
