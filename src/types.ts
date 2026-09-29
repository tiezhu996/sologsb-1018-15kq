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
  /** 该轮尝试所属的版本；旧尝试永远挂在当时冻结的版本下，不随新稿改动串段。 */
  versionId: string
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
 * 一个不可变（草稿除外）的句子/意群版本。
 * 历史版本冻结后文本、意群顺序与标注都不再变化，旧尝试按这里的内容回看。
 */
export interface PracticeVersion {
  id: string
  number: number
  note: string
  createdAt: string
  /** 恢复或派生自哪个版本号，用于判断空草稿是否仍与快照一致。 */
  sourceVersionNumber?: number
  /** null 表示仍是当前草稿；冻结时间写入后该版本只读。 */
  frozenAt: string | null
  isDraft: boolean
  sentence: string
  groups: SenseGroup[]
  /** 属于本版本的尝试 id，跨版本回看与按版本统计都以此为准。 */
  attemptIds: string[]
}

export interface PracticeProject {
  title: string
  translation: string
  teacher: string
  targetAttempts: number
  targetDuration: number
  errorCategories: string[]
  versions: PracticeVersion[]
  currentVersionId: string
  attempts: Attempt[]
  updatedAt: string
}

/** 升级前单份稿结构，仅用于本机数据无损迁移。 */
export interface LegacyPracticeProject {
  title: string
  sentence: string
  translation: string
  teacher: string
  targetAttempts: number
  targetDuration: number
  groups: SenseGroup[]
  attempts: Array<Omit<Attempt, 'versionId'>>
  errorCategories: string[]
  updatedAt: string
}

export interface PersistedPracticeV1 {
  project: LegacyPracticeProject
  version: 1
}

export interface PersistedPracticeV2 {
  project: PracticeProject
  version: 2
}

export type PersistedPractice = PersistedPracticeV1 | PersistedPracticeV2
