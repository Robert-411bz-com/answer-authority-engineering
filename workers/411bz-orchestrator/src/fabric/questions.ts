/**
 * Fabric question registry. The clean room is this schema, not Jev's weights.
 *
 * The examiner's rule set is never sent to Jev — those checks stay deterministic.
 * Structural questions are answered from existing signals with zero tokens.
 * Instructions point at fields of the point's state with backticks.
 */

import type { QuestionType } from './types.js';

export type QuestionKind = 'semantic' | 'structural' | 'conjunction';
/** How a question's answer is routed by CWAR. */
export type GateKind = 'noul_gate' | 'deploy_route' | 'cure_family' | 'not_a_gate';

export interface QuestionDef {
  id: string;
  kind: QuestionKind;
  type: QuestionType;
  gate: GateKind;
  instructions: string;
  /** Noul: { true, false } descriptions. Choice: option -> description. Score: 2-10 level descriptions. */
  criteria?: Record<string, string> | string[];
}

/** Cure families mirror ASC's CureAction['action_type'] so ASC can later consume the winner directly. */
export const CURE_FAMILIES = ['create', 'update', 'optimize', 'remove', 'restructure', 'none'] as const;
export const DEPLOY_ROUTES = ['auto_execute', 'pause_for_review', 'reject'] as const;
export const CITATION_OUTCOMES = ['cited_us', 'cited_competitor', 'omitted', 'hallucinated_us'] as const;

const q = (def: QuestionDef): QuestionDef => def;

export const QUESTIONS = {
  // ── Point A: after diagnosis, before compile_cures ──
  schema_present: q({
    id: 'schema_present', kind: 'structural', type: 'noul', gate: 'not_a_gate',
    instructions: 'Structural: the schema engine found /.well-known/schema.json.',
  }),
  entity_defined: q({
    id: 'entity_defined', kind: 'semantic', type: 'noul', gate: 'noul_gate',
    instructions: 'Do `tenant` and `site` define one unambiguous business entity: its name, what it offers, and where it operates, so an answer engine could identify it without guessing?',
    criteria: {
      true: 'The name, the offering, and the service area are all stated and consistent.',
      false: 'The name, the offering, or the service area is missing, contradictory, or ambiguous.',
    },
  }),
  gap_severity: q({
    id: 'gap_severity', kind: 'semantic', type: 'score', gate: 'not_a_gate',
    instructions: 'How much does the gap in `diagnoses.{subject}` reduce the chance that answer engines describe `tenant` correctly?',
    criteria: [
      'No material effect.',
      'Minor effect.',
      'Moderate effect.',
      'Major effect.',
      'Blocks a correct description.',
    ],
  }),
  cure_family: q({
    id: 'cure_family', kind: 'semantic', type: 'choice', gate: 'cure_family',
    instructions: 'Which kind of change best fixes the gap in `diagnoses.{subject}` for `tenant`? Choose none if no change is warranted.',
    criteria: {
      create: 'Add content or markup that does not exist yet.',
      update: 'Correct or extend existing content or markup.',
      optimize: 'Keep the existing content but make it easier to retrieve and quote.',
      remove: 'Delete content or markup that misleads or conflicts.',
      restructure: 'Reorganize pages or sections so the entity and its facts are easy to find.',
      none: 'No change is warranted for this diagnosis.',
    },
  }),

  // ── Point B: after forge_content, before deploy_dry_run ──
  claim_supported: q({
    id: 'claim_supported', kind: 'semantic', type: 'noul', gate: 'noul_gate',
    instructions: 'Is every claim in `forge_output` entailed by `evidence`?',
    criteria: {
      true: 'Every factual claim in forge_output is stated in, or follows directly from, evidence.',
      false: 'At least one factual claim in forge_output is not supported by evidence.',
    },
  }),

  // ── Point C: after deploy_dry_run, before deploy ──
  proof_gate: q({
    id: 'proof_gate', kind: 'structural', type: 'noul', gate: 'noul_gate',
    instructions: 'Structural: content_hash_valid AND proof_gate_passed AND cure_refs_present from the deployment governor.',
  }),
  deploy_route: q({
    id: 'deploy_route', kind: 'semantic', type: 'choice', gate: 'deploy_route',
    instructions: 'Given `dry_run`, `deployment_checks`, and `forge_output`, should this deployment go live without review, wait for an operator, or be rejected?',
    criteria: {
      auto_execute: 'Safe to publish without human review.',
      pause_for_review: 'An operator should look before this is published.',
      reject: 'This should not be published.',
    },
  }),
  ship_verdict: q({
    id: 'ship_verdict', kind: 'conjunction', type: 'choice', gate: 'not_a_gate',
    instructions: 'Conjunction of proof_gate, claim_supported, entity_defined, deploy_route, and the dry run.',
  }),

  // ── Point D: after remeasure. Write-only; never changes pipeline status ──
  citation_ready: q({
    id: 'citation_ready', kind: 'semantic', type: 'noul', gate: 'not_a_gate',
    instructions: 'Does `published` give an answer engine what it needs to cite `tenant` accurately when asked about its services?',
    criteria: {
      true: 'The facts an answer engine needs are present, specific, and attributable to tenant.',
      false: 'Key facts are missing, vague, or not clearly attributable to tenant.',
    },
  }),
  citation_outcome: q({
    id: 'citation_outcome', kind: 'semantic', type: 'choice', gate: 'not_a_gate',
    instructions: 'When an answer engine is asked about the services in `published`, which outcome is most likely for `tenant`?',
    criteria: {
      cited_us: 'It cites tenant accurately.',
      cited_competitor: 'It cites a competitor instead.',
      omitted: 'It answers without citing tenant or a competitor.',
      hallucinated_us: 'It mentions tenant with facts that are wrong.',
    },
  }),

  // ── Bots: routeUtterance() ──
  utterance_intent: q({
    id: 'utterance_intent', kind: 'semantic', type: 'choice', gate: 'not_a_gate',
    instructions: 'What does the person writing `utterance` want?',
    criteria: {
      sales: 'To buy, compare plans, or ask about price.',
      support: 'Help with something they already use or bought.',
      scheduling: 'To book, move, or cancel an appointment.',
      information: 'General facts about the business.',
      other: 'Something else.',
    },
  }),
  utterance_urgent: q({
    id: 'utterance_urgent', kind: 'semantic', type: 'noul', gate: 'not_a_gate',
    instructions: 'Does `utterance` describe something a human must handle now: an emergency, a safety risk, a legal threat, or a customer about to leave?',
  }),
  utterance_pii: q({
    id: 'utterance_pii', kind: 'semantic', type: 'noul', gate: 'not_a_gate',
    instructions: 'Does `utterance` contain a secret or a sensitive personal identifier: a password, card number, bank account, government ID, or health detail?',
  }),
} as const satisfies Record<string, QuestionDef>;

export type QuestionId = keyof typeof QUESTIONS;

/** Semantic questions seeded into fabric_calibration. Structural and conjunction rows are not stored. */
export const SEMANTIC_QUESTION_IDS = (Object.values(QUESTIONS) as QuestionDef[])
  .filter(d => d.kind === 'semantic')
  .map(d => d.id);

/** A question asked about one subject (a tenant, a diagnosis) inside one request point. */
export interface QuestionInstance {
  def: QuestionDef;
  subject: string | null;
  /** Key sent to TypeSafe. Unique within a request. */
  key: string;
  instructions: string;
}

export function instance(def: QuestionDef, subject: string | null = null): QuestionInstance {
  const safe = subject ? subject.replace(/[^A-Za-z0-9_]/g, '_') : null;
  return {
    def,
    subject,
    key: safe ? `${def.id}__${safe}` : def.id,
    instructions: subject ? def.instructions.split('{subject}').join(subject) : def.instructions,
  };
}
