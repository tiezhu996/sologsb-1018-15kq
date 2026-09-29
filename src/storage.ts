import { normalizeLegacy } from './migrate'
import type { PersistedPractice, PersistedPracticeV2, PracticeProject } from './types'

export interface LoadedPractice {
  project: PracticeProject
  migrated: boolean
}

const DB_NAME = 'sologsb-1018-prosody'
const STORE = 'practice'
const KEY = 'current'
const FALLBACK_KEY = 'sologsb-1018-fallback'

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

/**
 * 读取本机练习。v1 容器（含旧单份稿）会在读取时无损迁移为版本化项目；
 * 迁移结果不立即写回，首次保存时自然升级为 v2。
 */
export async function loadPractice(): Promise<LoadedPractice | null> {
  try {
    const db = await openDb()
    const value = await new Promise<PersistedPractice | PracticeProject | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(KEY)
      request.onsuccess = () => resolve(request.result as PersistedPractice | PracticeProject | undefined)
      request.onerror = () => reject(request.error)
    })
    db.close()
    if (value) return normalizeLegacy(value as Parameters<typeof normalizeLegacy>[0])
  } catch {
    const raw = localStorage.getItem(FALLBACK_KEY)
    if (raw) {
      try {
        return normalizeLegacy(JSON.parse(raw) as Parameters<typeof normalizeLegacy>[0])
      } catch {
        return null
      }
    }
  }
  return null
}

export async function savePractice(project: PracticeProject): Promise<'indexeddb' | 'localstorage'> {
  const value: PersistedPracticeV2 = { project, version: 2 }
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
    const fallback = {
      ...project,
      attempts: project.attempts.map((attempt) => ({ ...attempt, audioBlob: undefined }))
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
