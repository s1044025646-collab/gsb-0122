export type RoundStatus = 'open' | 'closed'
export type BatchStatus = 'created' | 'open' | 'admitted'
export type ProgramStatus = 'active' | 'suspended'
export type RunKind = 'trial' | 'formal'
export type RunStatus = 'computed' | 'confirmed'
export type EventType = 'apply' | 'hold' | 'reject' | 'final_unmatched'

export interface RuleVersion {
  id: number
  batch_id: number
  label: string
  tiebreak_keys: string[]
  created_at: string
}

export interface Program {
  id: number
  batch_id: number
  code: string
  name: string
  capacity: number
  status: ProgramStatus
  priority_rule_version: number
  priority_order: string
}

export interface Candidate {
  id: number
  batch_id: number
  anon_code: string
  score: number
  score_source: string
  status: string
}

export interface Preference {
  id: number
  round_id: number
  candidate_id: number
  rank_no: number
  program_id: number
  eligible: 0 | 1
  ineligible_reason: string | null
  source: string
  revision: number
}

export interface MatchInput {
  candidates: Candidate[]
  programs: Program[]
  preferences: Preference[]
  tiebreakKeys: string[]
}

export interface MatchEvent {
  type: EventType
  round: number
  candidate_id: number
  program_id: number | null
  detail: string
}

export interface MatchResult {
  events: MatchEvent[]
  assignments: Map<number, number>
  unmatched: Map<number, string>
}

export interface BlockingPair {
  candidate_id: number
  program_id: number
  reason: string
}

export interface ValidationIssue {
  candidate_id: number
  anon_code: string
  rank_no: number | null
  program_code: string | null
  code: string
  message: string
}
