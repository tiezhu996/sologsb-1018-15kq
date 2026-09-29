import type { PracticeProject, PracticeVersion } from './types'

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export function getCurrentVersion(project: PracticeProject): PracticeVersion {
  return project.versions.find((item) => item.id === project.currentVersionId) ?? project.versions[project.versions.length - 1]
}

/**
 * 句子 / 意群结构（文本、数量、顺序）变化前调用。
 * 当前草稿已经录过尝试时，先把它冻结为历史快照，再复制出新草稿；
 * 旧尝试随快照保留，继续按当时的意群文本与顺序回看，不会被后续改动串段。
 * 草稿还没有尝试时直接原地修改，避免产生空版本。
 */
export function ensureEditableDraft(draftProject: PracticeProject): PracticeVersion {
  const current = getCurrentVersion(draftProject)
  if (current.attempts.length === 0 && !current.frozen) return current

  current.frozen = true
  const number = draftProject.versions.length + 1
  const next: PracticeVersion = {
    id: uid('version'),
    number,
    label: `版本 ${number}`,
    note: `基于「${current.label}」继续编辑；改动前的尝试已保留在原版本。`,
    createdAt: new Date().toISOString(),
    forkedFromId: current.id,
    frozen: false,
    sentence: current.sentence,
    groups: structuredClone(current.groups),
    attempts: []
  }
  draftProject.versions.push(next)
  draftProject.currentVersionId = next.id
  return next
}

/**
 * 恢复历史版本：以它的句子与意群生成新的草稿，被恢复的原版本保持不变、可追溯。
 * 当前草稿若已有尝试则先冻结；若仍是空草稿则直接复用，不堆积空版本。
 */
export function restoreVersionDraft(draftProject: PracticeProject, sourceId: string): PracticeVersion {
  const source = draftProject.versions.find((item) => item.id === sourceId)
  const current = getCurrentVersion(draftProject)
  if (!source) return current

  const snapshot = {
    sentence: source.sentence,
    groups: structuredClone(source.groups)
  }

  let target = current
  if (current.attempts.length > 0 || current.frozen) {
    current.frozen = true
    const number = draftProject.versions.length + 1
    target = {
      id: uid('version'),
      number,
      label: `版本 ${number}`,
      note: `从历史版本「${source.label}」恢复的新草稿，原版本已保留。`,
      createdAt: new Date().toISOString(),
      forkedFromId: source.id,
      frozen: false,
      attempts: [],
      ...snapshot
    }
    draftProject.versions.push(target)
    draftProject.currentVersionId = target.id
  } else {
    target.sentence = snapshot.sentence
    target.groups = structuredClone(snapshot.groups)
    target.forkedFromId = source.id
    target.note = `从历史版本「${source.label}」恢复的新草稿，原版本已保留。`
    target.createdAt = new Date().toISOString()
  }
  return target
}

/** 结构签名只覆盖句子与意群的文本 / 顺序 / 数量；韵律标注微调不触发新版本。 */
export function structureSignature(version: PracticeVersion): string {
  return JSON.stringify({ sentence: version.sentence, groups: version.groups.map((group) => ({ id: group.id, text: group.text })) })
}

/** 默认回看最近有尝试的版本；都没有尝试时落在当前草稿，保证迁移数据打开即见旧尝试。 */
export function pickDefaultReviewVersionId(project: PracticeProject): string {
  let candidate: string = project.currentVersionId
  let latest = 0
  for (const version of project.versions) {
    const lastAttempt = version.attempts.at(-1)
    const stamp = lastAttempt ? Date.parse(lastAttempt.createdAt) || 0 : 0
    if (stamp > latest) {
      latest = stamp
      candidate = version.id
    }
  }
  return candidate
}

export interface VersionStats {
  version: PracticeVersion
  attemptCount: number
  issueCount: number
  averageAccuracy: number
}

export function collectVersionStats(project: PracticeProject): VersionStats[] {
  return project.versions.map((version) => {
    const issueCount = version.attempts.reduce((sum, attempt) => sum + attempt.wordIssues.length, 0)
    const scores = version.attempts.flatMap((attempt) => attempt.scores)
    const averageAccuracy = scores.length ? Math.round(scores.reduce((sum, score) => sum + score.accuracy, 0) / scores.length) : 0
    return { version, attemptCount: version.attempts.length, issueCount, averageAccuracy }
  })
}
