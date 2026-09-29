import { createHash } from 'node:crypto'
import type {
  BlockingPair,
  MatchEvent,
  MatchInput,
  MatchResult,
  Program,
} from './types.ts'

export interface PriorityProfile {
  score: number
  candidateId: number
}

/**
 * 按专业冻结的优先序比较两名申请人。
 * key 支持：score_desc / score_asc / candidate_id_asc / candidate_id_desc。
 * 返回正数表示 a 优先于 b。
 */
export function comparePriority(
  a: PriorityProfile,
  b: PriorityProfile,
  keys: string[],
): number {
  for (const key of keys) {
    switch (key) {
      case 'score_desc':
        if (a.score !== b.score) return a.score > b.score ? 1 : -1
        break
      case 'score_asc':
        if (a.score !== b.score) return a.score < b.score ? 1 : -1
        break
      case 'candidate_id_desc':
        if (a.candidateId !== b.candidateId) return a.candidateId > b.candidateId ? 1 : -1
        break
      case 'candidate_id_asc':
      default:
        if (a.candidateId !== b.candidateId) return a.candidateId < b.candidateId ? 1 : -1
        break
    }
  }
  return 0
}

interface Proposal {
  candidateId: number
  rankNo: number
  programId: number
  eligible: boolean
  ineligibleReason: string | null
}

/**
 * 考生发起的延迟接受（Gale-Shapley 考生方提议）。
 * 多轮：每轮所有未暂留考生沿其按序志愿提议一次；
 * 专业在容量内按冻结优先序暂留申请人，其余拒绝。
 * 绝不会把未填报专业补入志愿。
 */
export function runDeferredAcceptance(input: MatchInput): MatchResult {
  const events: MatchEvent[] = []
  const candidateById = new Map(input.candidates.map((c) => [c.id, c]))
  const programById = new Map(input.programs.map((p) => [p.id, p]))

  const prefsByCandidate = new Map<number, Proposal[]>()
  for (const pref of input.preferences) {
    const list = prefsByCandidate.get(pref.candidate_id) ?? []
    list.push({
      candidateId: pref.candidate_id,
      rankNo: pref.rank_no,
      programId: pref.program_id,
      eligible: pref.eligible === 1,
      ineligibleReason: pref.ineligible_reason,
    })
    prefsByCandidate.set(pref.candidate_id, list)
  }
  for (const list of prefsByCandidate.values()) {
    list.sort((x, y) => x.rankNo - y.rankNo)
  }

  const nextProposalIdx = new Map<number, number>()
  const heldByProgram = new Map<number, number[]>()
  const assignment = new Map<number, number>()
  const rejectedAt = new Map<number, string>()

  const activeCandidates = input.candidates
    .filter((c) => c.status === 'active')
    .map((c) => c.id)
    .sort((a, b) => a - b)
  for (const id of activeCandidates) {
    nextProposalIdx.set(id, 0)
    heldByProgram.set(id, [])
  }
  for (const program of input.programs) {
    heldByProgram.set(program.id, [])
  }

  let round = 0
  let progress = true
  while (progress) {
    round += 1
    progress = false

    for (const candidateId of activeCandidates) {
      if (assignment.has(candidateId)) continue
      const proposals = prefsByCandidate.get(candidateId) ?? []
      const idx = nextProposalIdx.get(candidateId) ?? 0
      if (idx >= proposals.length) continue

      const proposal = proposals[idx]!
      nextProposalIdx.set(candidateId, idx + 1)
      progress = true
      const candidate = candidateById.get(candidateId)!
      const program = programById.get(proposal.programId)

      if (!program || program.status !== 'active') {
        events.push({
          type: 'reject',
          round,
          candidate_id: candidateId,
          program_id: proposal.programId,
          detail: `志愿${proposal.rankNo}：专业${program?.code ?? proposal.programId}不可投档（已停招/不存在）`,
        })
        rejectedAt.set(candidateId, `专业${program?.code ?? proposal.programId}不可投档`)
        continue
      }

      events.push({
        type: 'apply',
        round,
        candidate_id: candidateId,
        program_id: program.id,
        detail: `第${round}轮申请志愿${proposal.rankNo} 专业${program.code}（分数 ${candidate.score}）`,
      })

      if (!proposal.eligible) {
        events.push({
          type: 'reject',
          round,
          candidate_id: candidateId,
          program_id: program.id,
          detail: `资格不符：${proposal.ineligibleReason ?? '未通过资格审核'}`,
        })
        rejectedAt.set(candidateId, `专业${program.code}资格不符（${proposal.ineligibleReason ?? '未通过资格审核'}）`)
        continue
      }

      const held = heldByProgram.get(program.id)!
      held.push(candidateId)
      const capacity = program.capacity
      const keys = parseKeys(program.priority_order, input.tiebreakKeys)
      held.sort((x, y) =>
        comparePriority(
          { score: candidateById.get(x)!.score, candidateId: x },
          { score: candidateById.get(y)!.score, candidateId: y },
          keys,
        ) * -1 || x - y,
      )

      if (held.length <= capacity || capacity <= 0) {
        if (capacity <= 0) {
          const pos = held.indexOf(candidateId)
          held.splice(pos, 1)
          events.push({
            type: 'reject',
            round,
            candidate_id: candidateId,
            program_id: program.id,
            detail: `专业${program.code}容量为 0，无法暂留`,
          })
          rejectedAt.set(candidateId, `专业${program.code}容量为0`)
          continue
        }
        events.push({
          type: 'hold',
          round,
          candidate_id: candidateId,
          program_id: program.id,
          detail: `专业${program.code}暂留（已暂留 ${held.length}/${capacity}）`,
        })
      } else {
        const retained = held.slice(0, capacity)
        const dropped = held.slice(capacity)
        heldByProgram.set(program.id, retained)
        events.push({
          type: 'hold',
          round,
          candidate_id: candidateId,
          program_id: program.id,
          detail: `专业${program.code}暂留（已暂留 ${capacity}/${capacity}）`,
        })
        for (const loserId of dropped) {
          events.push({
            type: 'reject',
            round,
            candidate_id: loserId,
            program_id: program.id,
            detail: loserId === candidateId
              ? `专业${program.code}按优先序比较后拒绝（容量 ${capacity}）`
              : `被更高优先序申请人挤出 专业${program.code}（容量 ${capacity}）`,
          })
          rejectedAt.set(loserId, `专业${program.code}按优先序比较后落选（容量${capacity}）`)
        }
      }
    }

    const heldSet = new Set<number>()
    for (const holders of heldByProgram.values()) {
      for (const id of holders) heldSet.add(id)
    }
    assignment.clear()
    for (const [programId, holders] of heldByProgram) {
      for (const id of holders) assignment.set(id, programId)
    }
    void heldSet
  }

  const unmatched = new Map<number, string>()
  for (const candidateId of activeCandidates) {
    if (!assignment.has(candidateId)) {
      const proposals = prefsByCandidate.get(candidateId)
      const reason = rejectedAt.get(candidateId)
      if (!proposals || proposals.length === 0) {
        unmatched.set(candidateId, '未填报任何志愿')
        events.push({
          type: 'final_unmatched',
          round,
          candidate_id: candidateId,
          program_id: null,
          detail: '最终未录取：未填报任何志愿',
        })
      } else if (reason) {
        unmatched.set(candidateId, `志愿全部落选：${reason}`)
        events.push({
          type: 'final_unmatched',
          round,
          candidate_id: candidateId,
          program_id: null,
          detail: `最终未录取：志愿全部落选，最后原因为「${reason}」`,
        })
      } else {
        unmatched.set(candidateId, '志愿全部落选')
        events.push({
          type: 'final_unmatched',
          round,
          candidate_id: candidateId,
          program_id: null,
          detail: '最终未录取：志愿全部落选',
        })
      }
    }
  }

  return { events, assignments: assignment, unmatched }
}

function parseKeys(programOrder: string, fallback: string[]): string[] {
  const keys = programOrder.split(',').map((s) => s.trim()).filter(Boolean)
  return keys.length > 0 ? keys : fallback
}

/**
 * 阻塞配对核对：
 * 存在未录取考生 c 与专业 p，c 把 p 填为（资格符合的）志愿，
 * 且 p 仍有名额，或 p 更偏好 c 甚于其当前录取的某人，则结果被阻塞。
 */
export function findBlockingPairs(input: MatchInput, result: MatchResult): BlockingPair[] {
  const blocking: BlockingPair[] = []
  const programById = new Map(input.programs.map((p) => [p.id, p]))
  const candidateById = new Map(input.candidates.map((c) => [c.id, c]))

  const admittedByProgram = new Map<number, number[]>()
  for (const [candidateId, programId] of result.assignments) {
    const list = admittedByProgram.get(programId) ?? []
    list.push(candidateId)
    admittedByProgram.set(programId, list)
  }

  const eligibleProgramsByCandidate = new Map<number, number[]>()
  for (const pref of input.preferences) {
    if (pref.eligible !== 1) continue
    const list = eligibleProgramsByCandidate.get(pref.candidate_id) ?? []
    list.push(pref.program_id)
    eligibleProgramsByCandidate.set(pref.candidate_id, list)
  }

  for (const [candidateId, _reason] of result.unmatched) {
    void _reason
    const candidate = candidateById.get(candidateId)!
    for (const programId of eligibleProgramsByCandidate.get(candidateId) ?? []) {
      const program = programById.get(programId)
      if (!program || program.status !== 'active') continue
      const admitted = admittedByProgram.get(programId) ?? []
      const keys = parseKeys(program.priority_order, input.tiebreakKeys)
      if (admitted.length < program.capacity) {
        blocking.push({
          candidate_id: candidateId,
          program_id: programId,
          reason: `专业${program.code}尚余名额（${admitted.length}/${program.capacity}）且考生资格符合`,
        })
        continue
      }
      const weakest = [...admitted].sort(
        (x, y) =>
          comparePriority(
            { score: candidateById.get(x)!.score, candidateId: x },
            { score: candidateById.get(y)!.score, candidateId: y },
            keys,
          ) || x - y,
      )[0]!
      if (
        comparePriority(
          { score: candidate.score, candidateId },
          { score: candidateById.get(weakest)!.score, candidateId: weakest },
          keys,
        ) > 0
      ) {
        blocking.push({
          candidate_id: candidateId,
          program_id: programId,
          reason: `专业${program.code}更偏好该考生甚于已录取考生 #${weakest}`,
        })
      }
    }
  }
  return blocking
}

/**
 * 计算输入摘要，用于重放确定性核对：相同输入（含规则版本）必须产生相同事件流。
 */
export function digestInput(input: MatchInput, ruleVersionId: number, kind: string): string {
  const canonical = JSON.stringify({
    kind,
    ruleVersionId,
    tiebreakKeys: input.tiebreakKeys,
    candidates: input.candidates
      .map((c) => [c.id, c.score, c.status])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
    programs: input.programs
      .map((p) => [p.id, p.capacity, p.status, p.priority_order])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
    preferences: input.preferences
      .map((p) => [p.candidate_id, p.rank_no, p.program_id, p.eligible, p.ineligible_reason])
      .sort((a, b) =>
        Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1])),
  })
  return createHash('sha256').update(canonical).digest('hex')
}
