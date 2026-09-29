export type Intonation = 'fall' | 'rise' | 'flat' | 'rise-fall' | 'fall-rise'
export type StressLevel = 0 | 1 | 2 | 3

export interface SenseGroup {
  id: string
  text: string
  stressWords: string[]
  stressLevel: StressLevel
  pauseMs: number
  intonation: Intonation
  note: string
}

export interface GroupScore {
  groupId: string
  accuracy: number
  rhythm: number
  deviation: number
  note: string
}

export interface WordIssue {
  id: string
  groupId: string
  word: string
  category: string
  note: string
}

export interface SegmentFeedback {
  id: string
  groupId: string
  teacher: string
  text: string
  createdAt: string
}

export interface Attempt {
  id: string
  number: number
  label: string
  createdAt: string
  duration: number
  audioBlob?: Blob
  audioMime: string
  simulated: boolean
  rangeStart: number
  rangeEnd: number
  scores: GroupScore[]
  wordIssues: WordIssue[]
  feedback: SegmentFeedback[]
  selfNote: string
}

/**
 * 一个练习版本保存当时的句子、意群顺序与全部尝试。
 * 仅当前草稿（currentVersionId 指向、frozen=false）可以编辑与录音；
 * 历史版本冻结后只读，旧尝试始终按该版本的意群文本与顺序回看。
 */
export interface PracticeVersion {
  id: string
  number: number
  label: string
  note: string
  createdAt: string
  forkedFromId: string | null
  frozen: boolean
  sentence: string
  groups: SenseGroup[]
  attempts: Attempt[]
}

export interface PracticeProject {
  title: string
  translation: string
  teacher: string
  targetAttempts: number
  targetDuration: number
  versions: PracticeVersion[]
  currentVersionId: string
  errorCategories: string[]
  updatedAt: string
}

export interface PersistedPractice {
  project: PracticeProject
  version: 2
}
