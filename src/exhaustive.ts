/**
 * 小规模穷举：对给定考生偏好与专业容量，枚举所有“可行且一人至多一专业”的
 * 分配，用公开优先序判定阻塞对，校验延迟接受结果稳定且容量可行。
 */
export interface ExStudent {
  id: number;
  prefs: number[];
  rankApplicant(otherId: number): number;
}

export interface ExMajor {
  id: number;
  capacity: number;
  prefers(a: number, b: number): boolean;
  qualified(studentId: number): boolean;
}

export interface MatchResult {
  match: Map<number, number>;
}

export function isFeasible(
  result: MatchResult,
  majors: ExMajor[],
  studentIds: number[],
): boolean {
  const counts = new Map<number, number>();
  for (const sid of studentIds) {
    const m = result.match.get(sid);
    if (m === undefined) continue;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  for (const major of majors) {
    if ((counts.get(major.id) ?? 0) > major.capacity) return false;
  }
  return true;
}

export function hasBlockingPair(
  result: MatchResult,
  students: ExStudent[],
  majors: ExMajor[],
): boolean {
  const occupants = new Map<number, number[]>();
  for (const [sid, mid] of result.match) {
    occupants.set(mid, [...(occupants.get(mid) ?? []), sid]);
  }
  for (const s of students) {
    const current = result.match.get(s.id);
    const curRank = current === undefined ? Infinity : s.prefs.indexOf(current);
    for (let r = 0; r < curRank && r < s.prefs.length; r++) {
      const mid = s.prefs[r];
      const major = majors.find((m) => m.id === mid)!;
      if (!major.qualified(s.id)) continue;
      const occ = occupants.get(mid) ?? [];
      if (occ.length < major.capacity) return true;
      const weakest = occ.reduce((w, o) => (major.prefers(w, o) ? o : w));
      if (major.prefers(s.id, weakest)) return true;
    }
  }
  return false;
}

/** 枚举所有可行匹配（考生可选择未录取或某个填报专业）。 */
export function enumerateFeasible(
  students: ExStudent[],
  majors: ExMajor[],
): Array<Map<number, number>> {
  const out: Array<Map<number, number>> = [];
  const counts = new Map<number, number>(majors.map((m) => [m.id, 0]));
  const current = new Map<number, number>();
  const majorById = new Map(majors.map((m) => [m.id, m]));

  function rec(i: number) {
    if (i === students.length) {
      out.push(new Map(current));
      return;
    }
    const s = students[i];
    rec(i + 1);
    for (const mid of s.prefs) {
      const major = majorById.get(mid)!;
      if (!major.qualified(s.id)) continue;
      if ((counts.get(mid) ?? 0) >= major.capacity) continue;
      counts.set(mid, (counts.get(mid) ?? 0) + 1);
      current.set(s.id, mid);
      rec(i + 1);
      current.delete(s.id);
      counts.set(mid, (counts.get(mid) ?? 0) - 1);
    }
  }
  rec(0);
  return out;
}
