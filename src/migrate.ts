import type { Attempt, PracticeProject, PracticeVersion, SenseGroup } from './types'

export const DRAFT_VERSION_ID = 'version-1'

/**
 * 把升级前的单份练习无损迁移为带版本的项目：
 * - 原句子与意群整体冻结为 v1（作为当前稿，仍可继续编辑）；
 * - 每轮旧尝试补上 versionId 指向 v1，分数、错词、反馈关系全部按原意群保留；
 * - 录音 Blob 等不参与结构化转换的数据原样带入。
 */
export function migrateLegacyProject(legacy: import('./types').LegacyPracticeProject): PracticeProject {
  const versionId = DRAFT_VERSION_ID
  const groups: SenseGroup[] = legacy.groups.map((group) => structuredClone(group))
  const attempts: Attempt[] = legacy.attempts.map((attempt) => ({
    ...structuredClone(attempt),
    audioBlob: attempt.audioBlob,
    versionId
  }))
  const version: PracticeVersion = {
    id: versionId,
    number: 1,
    note: '迁移自升级前的单份稿',
    createdAt: legacy.updatedAt || new Date().toISOString(),
    frozenAt: null,
    isDraft: true,
    sentence: legacy.sentence,
    groups,
    attemptIds: attempts.map((attempt) => attempt.id)
  }
  return {
    title: legacy.title,
    translation: legacy.translation,
    teacher: legacy.teacher,
    targetAttempts: legacy.targetAttempts,
    targetDuration: legacy.targetDuration,
    errorCategories: structuredClone(legacy.errorCategories),
    versions: [version],
    currentVersionId: versionId,
    attempts,
    updatedAt: legacy.updatedAt || new Date().toISOString()
  }
}

/** 兼容 localStorage 里可能残留的、以及更早期直接保存的项目结构。 */
export function normalizeLegacy(raw: { version?: number; project?: unknown } | import('./types').LegacyPracticeProject): { project: PracticeProject; migrated: boolean } | null {
  const container = raw as { version?: number; project?: PracticeProject | import('./types').LegacyPracticeProject }
  const candidate = container.project !== undefined ? container.project : (raw as import('./types').LegacyPracticeProject)
  if (!candidate || typeof candidate !== 'object') return null
  if (container.version === 2 && 'versions' in candidate && Array.isArray((candidate as PracticeProject).versions)) {
    return { project: candidate as PracticeProject, migrated: false }
  }
  const legacy = candidate as import('./types').LegacyPracticeProject
  if (!Array.isArray(legacy.groups) || !Array.isArray(legacy.attempts)) return null
  return { project: migrateLegacyProject(legacy), migrated: true }
}
