import type { PersistedPractice, PracticeProject, PracticeVersion, SenseGroup, Attempt } from './types'

const DB_NAME = 'sologsb-1018-prosody'
const STORE = 'practice'
const KEY = 'current'
const FALLBACK_KEY = 'sologsb-1018-fallback'

interface LegacyProject {
  title: string
  sentence: string
  translation: string
  teacher: string
  targetAttempts: number
  targetDuration: number
  groups: SenseGroup[]
  attempts: Attempt[]
  errorCategories: string[]
  updatedAt: string
}

/** IndexedDB 历史上存储 { project, version: 1 }；localStorage 兜底分支存储裸 project。 */
type StoredV1 = { project: LegacyProject; version?: 1 } | LegacyProject

type StoredShape = PersistedPractice | StoredV1

function isLegacyProject(value: object): value is LegacyProject {
  return Array.isArray((value as LegacyProject).groups) && Array.isArray((value as LegacyProject).attempts) && !('versions' in value)
}

function asLegacyProject(saved: StoredV1): LegacyProject {
  return isLegacyProject(saved) ? saved : saved.project
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** 旧版单份练习无损升级为带历史的版本结构：原文、意群与全部尝试原样保留为初始版本。 */
function migrateV1(saved: StoredV1): PracticeProject {
  const legacy = asLegacyProject(saved)
  const initialVersion: PracticeVersion = {
    id: 'version-initial',
    number: 1,
    label: '初始版本',
    note: '由旧版单份练习自动迁移，原有意群、尝试与反馈均保持不变。',
    createdAt: legacy.updatedAt ?? new Date().toISOString(),
    forkedFromId: null,
    frozen: legacy.attempts.length > 0,
    sentence: legacy.sentence,
    groups: structuredClone(legacy.groups),
    attempts: legacy.attempts
  }
  let versions = [initialVersion]
  let currentVersionId = initialVersion.id
  // 初始版本若已有尝试则冻结，当前草稿指向由它复制出的新版本，继续沿用原意群编辑。
  if (initialVersion.frozen) {
    const draft: PracticeVersion = {
      id: 'version-draft-1',
      number: 2,
      label: '编辑草稿',
      note: '',
      createdAt: new Date().toISOString(),
      forkedFromId: initialVersion.id,
      frozen: false,
      sentence: initialVersion.sentence,
      groups: structuredClone(initialVersion.groups),
      attempts: []
    }
    versions = [initialVersion, draft]
    currentVersionId = draft.id
  }
  return {
    title: legacy.title,
    translation: legacy.translation,
    teacher: legacy.teacher,
    targetAttempts: legacy.targetAttempts,
    targetDuration: legacy.targetDuration,
    versions,
    currentVersionId,
    errorCategories: legacy.errorCategories,
    updatedAt: legacy.updatedAt ?? new Date().toISOString()
  }
}

function normalizeProject(value: StoredShape): PracticeProject {
  const persisted = value as PersistedPractice
  if (persisted.version === 2 && Array.isArray(persisted.project?.versions)) return persisted.project
  return migrateV1(value as StoredV1)
}

export async function loadPractice(): Promise<PracticeProject | null> {
  try {
    const db = await openDb()
    const value = await new Promise<StoredShape | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(KEY)
      request.onsuccess = () => resolve(request.result as StoredShape | undefined)
      request.onerror = () => reject(request.error)
    })
    db.close()
    if (value) return normalizeProject(value)
  } catch {
    const raw = localStorage.getItem(FALLBACK_KEY)
    if (raw) return normalizeProject(JSON.parse(raw) as StoredShape)
  }
  return null
}

export async function savePractice(project: PracticeProject): Promise<'indexeddb' | 'localstorage'> {
  const value: PersistedPractice = { project, version: 2 }
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(value, KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
    return 'indexeddb'
  } catch {
    const fallback: PracticeProject = {
      ...project,
      versions: project.versions.map((item) => ({
        ...item,
        attempts: item.attempts.map((attempt) => ({ ...attempt, audioBlob: undefined }))
      }))
    }
    localStorage.setItem(FALLBACK_KEY, JSON.stringify({ project: fallback, version: 2 }))
    return 'localstorage'
  }
}

export async function clearPractice(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).delete(KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // Ignore cleanup errors and clear the fallback below.
  }
  localStorage.removeItem(FALLBACK_KEY)
}
