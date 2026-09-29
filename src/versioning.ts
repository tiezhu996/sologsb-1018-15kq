import type { PracticeProject, PracticeVersion } from './types'

export function nextVersionNumber(project: PracticeProject): number {
  return project.versions.reduce((max, version) => Math.max(max, version.number), 0) + 1
}

export interface ForkResult {
  project: PracticeProject
  /** 承接本次编辑的草稿版本 id（可能是新建的，也可能是原地编辑的现有草稿）。 */
  draftId: string
  /** 是否冻结了旧稿并生成了新版本。 */
  created: boolean
}

/**
 * 句子或意群的结构性编辑前置动作：
 * 1. 当前稿已经录过尝试时，先把它整体冻结为只读历史版本，再克隆出新草稿承接改动；
 * 2. 当前稿还没有任何尝试时，直接在草稿上原地编辑——此时没有旧记录会被改动串段，
 *    连续修改也只沉淀为同一个版本，直到第一次录音。
 * 3. 冻结版本的尝试全部留在原版本上，文本/顺序/回听范围均不随新稿变化。
 */
export function forkForEdit(base: PracticeProject, note: string, mutator?: (version: PracticeVersion) => void): ForkResult {
  const draft = structuredClone(base)
  const current = draft.versions.find((version) => version.id === draft.currentVersionId)
  if (!current) throw new Error('current version missing')
  let draftId = current.id
  let created = false
  if (current.attemptIds.length > 0) {
    current.isDraft = false
    current.frozenAt = new Date().toISOString()
    const newVersion: PracticeVersion = {
      id: `version-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      number: nextVersionNumber(draft),
      note,
      createdAt: new Date().toISOString(),
      sourceVersionNumber: current.number,
      frozenAt: null,
      isDraft: true,
      sentence: current.sentence,
      groups: structuredClone(current.groups),
      attemptIds: []
    }
    draft.versions.push(newVersion)
    draft.currentVersionId = newVersion.id
    draftId = newVersion.id
    created = true
  }
  const target = draft.versions.find((version) => version.id === draftId)
  if (target && mutator) mutator(target)
  draft.updatedAt = new Date().toISOString()
  return { project: draft, draftId, created }
}

/**
 * 恢复历史版本：先冻结当前稿（无论它是否已有尝试），再按所选版本的句子与意群
 * 克隆出一份全新草稿。原历史版本与原当前稿都保持不动、可追溯；
 * 旧尝试归属各自的版本，不并入新稿。
 */
export function restoreAsDraft(base: PracticeProject, sourceVersionId: string): PracticeProject {
  if (sourceVersionId === base.currentVersionId) return structuredClone(base)
  const source = base.versions.find((version) => version.id === sourceVersionId)
  if (!source) throw new Error('source version missing')
  const draft = structuredClone(base)
  const current = draft.versions.find((version) => version.id === draft.currentVersionId)
  if (!current) throw new Error('current version missing')
  current.isDraft = false
  current.frozenAt = new Date().toISOString()
  const newVersion: PracticeVersion = {
    id: `version-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    number: nextVersionNumber(draft),
    note: `恢复自 v${source.number} 的新稿`,
    createdAt: new Date().toISOString(),
    sourceVersionNumber: source.number,
    frozenAt: null,
    isDraft: true,
    sentence: source.sentence,
    groups: structuredClone(source.groups),
    attemptIds: []
  }
  draft.versions.push(newVersion)
  draft.currentVersionId = newVersion.id
  draft.updatedAt = new Date().toISOString()
  return draft
}
