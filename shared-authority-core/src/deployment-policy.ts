/**
 * Deployment governor — validates deployment readiness before any content goes live.
 */

export interface DeploymentCheck {
  name: string;
  passed: boolean;
  reason?: string;
}

export interface DeploymentVerdict {
  allowed: boolean;
  checks: DeploymentCheck[];
  timestamp: string;
}

export function evaluateDeployment(checks: DeploymentCheck[]): DeploymentVerdict {
  return {
    allowed: checks.every(c => c.passed),
    checks,
    timestamp: new Date().toISOString(),
  };
}

export function createDeploymentChecks(params: {
  hasContentHash: boolean;
  proofGatePassed: boolean;
  confidenceAboveThreshold: boolean;
  cureRefsPresent: boolean;
}): DeploymentCheck[] {
  return [
    { name: 'content_hash_valid', passed: params.hasContentHash, reason: params.hasContentHash ? undefined : 'Missing content hash' },
    { name: 'proof_gate_passed', passed: params.proofGatePassed, reason: params.proofGatePassed ? undefined : 'Proof gate failed' },
    { name: 'confidence_threshold', passed: params.confidenceAboveThreshold, reason: params.confidenceAboveThreshold ? undefined : 'Below confidence threshold' },
    { name: 'cure_refs_present', passed: params.cureRefsPresent, reason: params.cureRefsPresent ? undefined : 'No cure references' },
  ];
}
