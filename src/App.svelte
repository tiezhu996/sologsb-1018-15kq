<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { ProgressBar } from '@skeletonlabs/skeleton'
  import { createSampleProject } from './sample'
  import { clearPractice, loadPractice, savePractice } from './storage'
  import { collectVersionStats, ensureEditableDraft, getCurrentVersion, pickDefaultReviewVersionId, restoreVersionDraft } from './versions'
  import type { Attempt, Intonation, PracticeProject, PracticeVersion, SenseGroup, StressLevel } from './types'

  const intonationOptions: Array<{ value: Intonation; label: string }> = [
    { value: 'fall', label: '下降 ↘' },
    { value: 'rise', label: '上升 ↗' },
    { value: 'flat', label: '平稳 →' },
    { value: 'rise-fall', label: '先升后降 ↗↘' },
    { value: 'fall-rise', label: '先降后升 ↘↗' }
  ]

  let project: PracticeProject = createSampleProject()
  let loaded = false
  let saveStatus = '正在读取本机练习…'
  let online = true
  let selectedGroupId = ''
  let reviewVersionId = ''
  let selectedAttemptId = ''
  let reviewGroupId = ''
  let workspaceTab: 'annotate' | 'review' | 'progress' = 'annotate'
  let recording = false
  let recordingSeconds = 0
  let recordingFallback = false
  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let mediaChunks: Blob[] = []
  let recordingTimer: number | undefined
  let saveTimer: number | undefined
  let playbackTimer: number | undefined
  let audioElement: HTMLAudioElement | undefined
  let playing = false
  let playbackTime = 0
  let audioUrls = new Map<string, string>()
  let issueWord = ''
  let issueCategory = '声调'
  let issueNote = ''
  let feedbackText = ''
  let newCategory = ''
  let undoStack: PracticeProject[] = []
  let redoStack: PracticeProject[] = []

  $: currentVersion = getCurrentVersion(project)
  $: reviewVersion = project.versions.find((item) => item.id === reviewVersionId) ?? currentVersion
  $: reviewingHistory = reviewVersion.id !== currentVersion.id || reviewVersion.frozen
  $: selectedGroup = currentVersion.groups.find((group) => group.id === selectedGroupId) ?? currentVersion.groups[0]
  $: reviewGroup = reviewVersion.groups.find((group) => group.id === reviewGroupId) ?? reviewVersion.groups[0]
  $: selectedAttempt = reviewVersion.attempts.find((attempt) => attempt.id === selectedAttemptId) ?? reviewVersion.attempts.at(-1)
  $: selectedScore = selectedAttempt && reviewGroup ? selectedAttempt.scores.find((score) => score.groupId === reviewGroup?.id) : undefined
  $: totalAttempts = project.versions.reduce((sum, version) => sum + version.attempts.length, 0)
  $: completedAttempts = Math.min(totalAttempts, project.targetAttempts)
  $: progress = Math.round((completedAttempts / Math.max(project.targetAttempts, 1)) * 100)
  $: averageAccuracy = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / selectedAttempt.scores.length) : 0
  $: averageDeviation = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.deviation, 0) / selectedAttempt.scores.length) : 0
  $: totalIssues = project.versions.reduce((sum, version) => sum + version.attempts.reduce((count, attempt) => count + attempt.wordIssues.length, 0), 0)
  $: versionStats = collectVersionStats(project)
  $: totalIssueCategories = project.errorCategories.map((category) => ({
    category,
    count: project.versions.reduce((sum, version) => sum + version.attempts.reduce((count, attempt) => count + attempt.wordIssues.filter((issue) => issue.category === category).length, 0), 0)
  }))

  const clone = <T,>(value: T): T => structuredClone(value)
  const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  function editProject(mutator: (draft: PracticeProject) => void) {
    const before = clone(project)
    const draft = clone(project)
    mutator(draft)
    draft.updatedAt = new Date().toISOString()
    project = draft
    undoStack = [...undoStack.slice(-29), before]
    redoStack = []
    scheduleSave()
  }

  /**
   * 会改动句子或意群文本 / 数量 / 顺序的操作专用：
   * 先保证当前草稿可编辑（已有尝试则封存快照并派生新草稿），再执行修改。
   */
  function editStructure(mutator: (draftProject: PracticeProject, draftVersion: PracticeVersion) => void) {
    editProject((draft) => {
      const draftVersion = ensureEditableDraft(draft)
      mutator(draft, draftVersion)
    })
    if (currentVersion.id !== project.currentVersionId) {
      reviewVersionId = project.currentVersionId
      reviewGroupId = ''
    }
  }

  function scheduleSave() {
    saveStatus = online ? '正在保存…' : '离线编辑中，稍后继续保存'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      const target = await savePractice(project)
      saveStatus = target === 'indexeddb' ? '已保存到本机' : '已保存到离线备份'
    }, 250)
  }

  function undo() {
    const target = undoStack.pop()
    if (!target) return
    redoStack = [...redoStack, clone(project)]
    project = target
    normalizeSelection()
    scheduleSave()
  }

  function redo() {
    const target = redoStack.pop()
    if (!target) return
    undoStack = [...undoStack, clone(project)]
    project = target
    normalizeSelection()
    scheduleSave()
  }

  function normalizeSelection() {
    if (!project.versions.some((version) => version.id === reviewVersionId)) reviewVersionId = pickDefaultReviewVersionId(project)
    if (!project.versions.some((version) => version.id === reviewVersionId)) reviewVersionId = project.currentVersionId
    const version = project.versions.find((item) => item.id === reviewVersionId) ?? getCurrentVersion(project)
    if (!version.groups.some((group) => group.id === reviewGroupId)) reviewGroupId = version.groups[0]?.id ?? ''
    if (!version.attempts.some((attempt) => attempt.id === selectedAttemptId)) selectedAttemptId = version.attempts.at(-1)?.id ?? ''
    const current = getCurrentVersion(project)
    if (!current.groups.some((group) => group.id === selectedGroupId)) selectedGroupId = current.groups[0]?.id ?? ''
  }

  function selectGroup(groupId: string) {
    selectedGroupId = groupId
    stopPlayback()
  }

  function selectReviewVersion(versionId: string) {
    reviewVersionId = versionId
    const version = project.versions.find((item) => item.id === versionId)
    reviewGroupId = version?.groups[0]?.id ?? ''
    selectedAttemptId = version?.attempts.at(-1)?.id ?? ''
    stopPlayback()
  }

  function updateGroup(field: keyof SenseGroup, value: string | number | string[]) {
    // 意群文本属于结构改动：已有尝试时先存版本快照，避免旧尝试串到新文本上。
    if (field === 'text') {
      editStructure((_draftProject, draftVersion) => {
        const group = draftVersion.groups.find((item) => item.id === selectedGroupId)
        if (group) group.text = String(value)
      })
      return
    }
    editProject((draft) => {
      const group = getCurrentVersion(draft).groups.find((item) => item.id === selectedGroupId)
      if (group) (group as unknown as Record<string, unknown>)[field] = value
    })
  }

  function setStressLevel(level: number) {
    updateGroup('stressLevel', level as StressLevel)
  }

  function setIntonation(value: string) {
    updateGroup('intonation', value as Intonation)
  }

  function toggleStressWord(word: string) {
    if (!selectedGroup) return
    const words = selectedGroup.stressWords.includes(word) ? selectedGroup.stressWords.filter((item) => item !== word) : [...selectedGroup.stressWords, word]
    updateGroup('stressWords', words)
  }

  function addGroup() {
    const id = uid('group')
    editStructure((_draftProject, draftVersion) => {
      draftVersion.groups.push({ id, text: '新的意群', stressWords: [], stressLevel: 1, pauseMs: 300, intonation: 'flat', note: '' })
    })
    selectedGroupId = id
  }

  function deleteGroup() {
    if (!selectedGroup || currentVersion.groups.length <= 1) return
    const index = currentVersion.groups.findIndex((group) => group.id === selectedGroup.id)
    editStructure((_draftProject, draftVersion) => {
      draftVersion.groups = draftVersion.groups.filter((group) => group.id !== selectedGroup?.id)
    })
    const draftGroups = getCurrentVersion(project).groups
    selectedGroupId = draftGroups[Math.max(0, index - 1)]?.id ?? draftGroups[0]?.id ?? ''
  }

  function moveGroup(direction: -1 | 1) {
    if (!selectedGroup) return
    const index = currentVersion.groups.findIndex((group) => group.id === selectedGroup?.id)
    const next = index + direction
    if (next < 0 || next >= currentVersion.groups.length) return
    editStructure((_draftProject, draftVersion) => {
      const [group] = draftVersion.groups.splice(index, 1)
      draftVersion.groups.splice(next, 0, group)
    })
  }

  function splitSentence() {
    const current = getCurrentVersion(project)
    const parts = current.sentence.split(/[，。！？；、\n]+/).map((part) => part.trim()).filter(Boolean)
    if (parts.length < 2) return
    editStructure((_draftProject, draftVersion) => {
      draftVersion.groups = parts.map((text, index) => ({
        id: draftVersion.groups[index]?.id ?? uid('group'),
        text,
        stressWords: draftVersion.groups[index]?.stressWords ?? [],
        stressLevel: draftVersion.groups[index]?.stressLevel ?? 1,
        pauseMs: draftVersion.groups[index]?.pauseMs ?? 300,
        intonation: draftVersion.groups[index]?.intonation ?? 'flat',
        note: draftVersion.groups[index]?.note ?? ''
      }))
    })
    selectedGroupId = getCurrentVersion(project).groups[0]?.id ?? ''
  }

  function updateSentence(value: string) {
    editStructure((_draftProject, draftVersion) => { draftVersion.sentence = value })
  }

  async function startRecording() {
    if (recording) return
    recordingFallback = false
    mediaChunks = []
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('unsupported')
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRecorder = new MediaRecorder(mediaStream)
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) mediaChunks.push(event.data) }
      mediaRecorder.onstop = () => finishRecording(recordingFallback)
      mediaRecorder.start()
    } catch {
      recordingFallback = true
      mediaRecorder = null
    }
    recording = true
    recordingSeconds = 0
    window.clearInterval(recordingTimer)
    recordingTimer = window.setInterval(() => { recordingSeconds += 0.1 }, 100)
  }

  function stopRecording() {
    if (!recording) return
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    else finishRecording(true)
  }

  function finishRecording(simulated: boolean) {
    if (!recording) return
    recording = false
    window.clearInterval(recordingTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    mediaStream = null
    mediaRecorder = null
    const blob = !simulated && mediaChunks.length ? new Blob(mediaChunks, { type: mediaChunks[0].type || 'audio/webm' }) : undefined
    const attemptId = uid('attempt')
    editProject((draft) => {
      const draftVersion = getCurrentVersion(draft)
      const number = draftVersion.attempts.length + 1
      const duration = Number(Math.max(0.5, recordingSeconds).toFixed(1))
      const attempt: Attempt = {
        id: attemptId,
        number,
        label: simulated ? `第 ${number} 轮 · 离线模拟` : `第 ${number} 轮`,
        createdAt: new Date().toISOString(),
        duration,
        audioBlob: blob,
        audioMime: blob?.type ?? 'audio/webm',
        simulated,
        rangeStart: 0,
        rangeEnd: duration,
        scores: draftVersion.groups.map((group) => ({ groupId: group.id, accuracy: 70, rhythm: 70, deviation: 0, note: '' })),
        wordIssues: [],
        feedback: [],
        selfNote: ''
      }
      draftVersion.attempts.push(attempt)
    })
    if (blob) audioUrls.set(attemptId, URL.createObjectURL(blob))
    reviewVersionId = project.currentVersionId
    selectedAttemptId = attemptId
    reviewGroupId = selectedGroupId
    workspaceTab = 'review'
    recordingSeconds = Number(Math.max(0.5, recordingSeconds).toFixed(1))
  }

  function audioUrlFor(attempt?: Attempt) {
    if (!attempt?.audioBlob) return ''
    if (!audioUrls.has(attempt.id)) audioUrls.set(attempt.id, URL.createObjectURL(attempt.audioBlob))
    return audioUrls.get(attempt.id) ?? ''
  }

  function togglePlayback() {
    if (!selectedAttempt) return
    if (playing) {
      stopPlayback()
      return
    }
    playing = true
    playbackTime = selectedAttempt.rangeStart
    const url = audioUrlFor(selectedAttempt)
    if (url && audioElement) {
      audioElement.src = url
      audioElement.currentTime = selectedAttempt.rangeStart
      audioElement.play().catch(() => startPlaybackTimer())
    } else {
      startPlaybackTimer()
    }
  }

  function startPlaybackTimer() {
    window.clearInterval(playbackTimer)
    playbackTimer = window.setInterval(() => {
      playbackTime = Number((playbackTime + 0.1).toFixed(1))
      if (playbackTime >= (selectedAttempt?.rangeEnd ?? 0)) stopPlayback()
    }, 100)
  }

  function stopPlayback() {
    playing = false
    window.clearInterval(playbackTimer)
    audioElement?.pause()
  }

  function onAudioTimeUpdate() {
    if (!audioElement || !selectedAttempt) return
    playbackTime = audioElement.currentTime
    if (playbackTime >= selectedAttempt.rangeEnd) stopPlayback()
  }

  function updateScore(field: 'accuracy' | 'rhythm' | 'deviation', value: number) {
    if (reviewingHistory || !selectedAttempt || !reviewGroup) return
    editProject((draft) => {
      const version = getCurrentVersion(draft)
      const attempt = version.attempts.find((item) => item.id === selectedAttemptId)
      let score = attempt?.scores.find((item) => item.groupId === reviewGroupId)
      if (!attempt || !score) {
        attempt?.scores.push({ groupId: reviewGroupId, accuracy: 70, rhythm: 70, deviation: 0, note: '' })
        score = attempt?.scores.at(-1)
      }
      if (score) score[field] = value
    })
  }

  function updateScoreNote(value: string) {
    if (reviewingHistory || !selectedAttempt || !reviewGroup) return
    editProject((draft) => {
      const score = getCurrentVersion(draft).attempts.find((attempt) => attempt.id === selectedAttemptId)?.scores.find((item) => item.groupId === reviewGroupId)
      if (score) score.note = value
    })
  }

  function addWordIssue() {
    if (reviewingHistory || !selectedAttempt || !reviewGroup || !issueWord.trim()) return
    editProject((draft) => {
      const attempt = getCurrentVersion(draft).attempts.find((item) => item.id === selectedAttemptId)
      attempt?.wordIssues.push({ id: uid('issue'), groupId: reviewGroupId, word: issueWord.trim(), category: issueCategory, note: issueNote.trim() })
    })
    issueWord = ''
    issueNote = ''
  }

  function removeWordIssue(issueId: string) {
    if (reviewingHistory) return
    editProject((draft) => {
      const attempt = getCurrentVersion(draft).attempts.find((item) => item.id === selectedAttemptId)
      if (attempt) attempt.wordIssues = attempt.wordIssues.filter((issue) => issue.id !== issueId)
    })
  }

  function addFeedback() {
    if (reviewingHistory || !reviewGroup || !feedbackText.trim()) return
    editProject((draft) => {
      const attempt = getCurrentVersion(draft).attempts.find((item) => item.id === selectedAttemptId)
      attempt?.feedback.push({
        id: uid('feedback'),
        groupId: reviewGroupId,
        teacher: draft.teacher,
        text: feedbackText.trim(),
        createdAt: new Date().toISOString()
      })
    })
    feedbackText = ''
  }

  function updateRange(field: 'rangeStart' | 'rangeEnd', value: number) {
    if (reviewingHistory || !selectedAttempt) return
    editProject((draft) => {
      const attempt = getCurrentVersion(draft).attempts.find((item) => item.id === selectedAttemptId)
      if (!attempt) return
      attempt[field] = value
      if (attempt.rangeEnd <= attempt.rangeStart) {
        if (field === 'rangeStart') attempt.rangeEnd = Math.min(attempt.duration, value + 0.5)
        else attempt.rangeStart = Math.max(0, value - 0.5)
      }
    })
  }

  function updateSelfNote(value: string) {
    if (reviewingHistory || !selectedAttempt) return
    editProject((draft) => {
      const attempt = getCurrentVersion(draft).attempts.find((item) => item.id === selectedAttemptId)
      if (attempt) attempt.selfNote = value
    })
  }

  function addCategory() {
    if (!newCategory.trim() || project.errorCategories.includes(newCategory.trim())) return
    editProject((draft) => { draft.errorCategories.push(newCategory.trim()) })
    newCategory = ''
  }

  function restoreVersion(versionId: string) {
    const source = project.versions.find((version) => version.id === versionId)
    if (!source) return
    if (!confirm(`将以历史版本「${source.label}」的句子和意群生成新的草稿；原历史版本会保留，可随时追溯。确定继续吗？`)) return
    editProject((draft) => { restoreVersionDraft(draft, versionId) })
    const current = getCurrentVersion(project)
    selectedGroupId = current.groups[0]?.id ?? ''
    reviewVersionId = current.id
    reviewGroupId = selectedGroupId
    selectedAttemptId = current.attempts.at(-1)?.id ?? ''
    saveStatus = '已恢复为新草稿，原版本保留'
  }

  function resetSample() {
    if (!confirm('恢复示例会替换当前练习与全部历史版本，确定继续吗？')) return
    editProject((draft) => Object.assign(draft, clone(createSampleProject())))
    applySelectionToProject()
  }

  async function deleteAllData() {
    if (!confirm('这会清除本机全部练习、历史版本、录音与反馈，且不能撤销。')) return
    stopPlayback()
    await clearPractice()
    const sample = createSampleProject()
    project = sample
    undoStack = []
    redoStack = []
    applySelectionToProject()
    await savePractice(project)
  }

  function applySelectionToProject() {
    selectedGroupId = getCurrentVersion(project).groups[0]?.id ?? ''
    reviewVersionId = pickDefaultReviewVersionId(project)
    const version = project.versions.find((item) => item.id === reviewVersionId) ?? getCurrentVersion(project)
    reviewGroupId = version.groups[0]?.id ?? ''
    selectedAttemptId = version.attempts.at(-1)?.id ?? ''
  }

  function onKeydown(event: KeyboardEvent) {
    const command = event.ctrlKey || event.metaKey
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void savePractice(project).then(() => { saveStatus = '已保存到本机' })
    } else if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
    } else if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
    } else if (event.altKey && event.key.toLowerCase() === 'r') {
      event.preventDefault()
      recording ? stopRecording() : void startRecording()
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      moveGroup(event.key === 'ArrowUp' ? -1 : 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
      const groups = getCurrentVersion(project).groups
      const index = groups.findIndex((group) => group.id === selectedGroupId)
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (groups[next]) selectedGroupId = groups[next].id
    }
  }

  onMount(async () => {
    online = navigator.onLine
    const saved = await loadPractice()
    if (saved) project = saved
    applySelectionToProject()
    loaded = true
    saveStatus = saved ? '已恢复本机练习（历史版本已就绪）' : '示例练习已就绪'
    window.addEventListener('online', () => { online = true })
    window.addEventListener('offline', () => { online = false })
    window.addEventListener('keydown', onKeydown)
  })

  onDestroy(() => {
    window.clearTimeout(saveTimer)
    window.clearInterval(recordingTimer)
    window.clearInterval(playbackTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    audioUrls.forEach((url) => URL.revokeObjectURL(url))
    window.removeEventListener('keydown', onKeydown)
  })
</script>

<svelte:head>
  <title>{project.title} · 声律场</title>
</svelte:head>

<div class="app-shell min-h-screen">
  <header class="top-header">
    <div class="brand-block">
      <div class="brand-mark">律</div>
      <div>
        <strong>声律场</strong>
        <span>PROSODY PRACTICE</span>
      </div>
    </div>
    <div class="practice-title">
      <h1>{project.title}</h1>
      <span>{project.teacher} · {currentVersion.label}{currentVersion.frozen ? '（历史只读）' : '（当前草稿）'} · 手机与电脑自动适配</span>
    </div>
    <div class="header-actions">
      <span class:offline={!online} class="connection badge">{online ? '在线' : '离线编辑'}</span>
      <span class="save-state">{saveStatus}</span>
      <button class="btn btn-sm variant-ghost" on:click={undo} disabled={!undoStack.length}>撤销</button>
      <button class="btn btn-sm variant-ghost" on:click={redo} disabled={!redoStack.length}>重做</button>
      <button class="btn btn-sm variant-ghost" on:click={resetSample}>恢复示例</button>
    </div>
  </header>

  <section class="progress-strip">
    <div class="progress-copy">
      <span>练习进度 · {project.versions.length} 个版本</span>
      <strong>{completedAttempts} / {project.targetAttempts} 轮</strong>
    </div>
    <ProgressBar value={progress} />
    <div class="progress-metric"><span>回看准确度</span><strong>{averageAccuracy}%</strong></div>
    <div class="progress-metric"><span>回看偏差</span><strong>{averageDeviation}%</strong></div>
    <div class="progress-metric"><span>目标时长</span><strong>{project.targetDuration.toFixed(1)}s</strong></div>
  </section>

  <div class="mobile-tabs">
    <button class:active={workspaceTab === 'annotate'} on:click={() => workspaceTab = 'annotate'}>标注</button>
    <button class:active={workspaceTab === 'review'} on:click={() => workspaceTab = 'review'}>录音校对</button>
    <button class:active={workspaceTab === 'progress'} on:click={() => workspaceTab = 'progress'}>反馈进度</button>
  </div>

  <main class="workspace">
    <aside class:mobile-hidden={workspaceTab !== 'annotate'} class="group-column card">
      <div class="section-heading">
        <div><span class="eyebrow">TEXT · {currentVersion.label}</span><h2>原文与意群</h2></div>
        <button class="btn btn-sm variant-soft-primary" on:click={addGroup}>＋ 意群</button>
      </div>
      <div class="draft-tip">
        改动句子或意群文本前会自动保存版本快照；已有尝试继续留在旧版本按原意群回看。
      </div>
      <label class="label">
        <span>录入句子（当前草稿）</span>
        <textarea class="textarea" rows="4" value={currentVersion.sentence} on:input={(event) => updateSentence(event.currentTarget.value)}></textarea>
      </label>
      <label class="label">
        <span>英文释义 / 参考</span>
        <textarea class="textarea" rows="3" value={project.translation} on:input={(event) => editProject((draft) => { draft.translation = event.currentTarget.value })}></textarea>
      </label>
      <div class="inline-actions">
        <button class="btn btn-sm variant-soft" on:click={splitSentence}>按标点智能切分</button>
        <span>{currentVersion.groups.length} 个意群</span>
      </div>
      <div class="group-list">
        {#each currentVersion.groups as group, index (group.id)}
          <button class:active={group.id === selectedGroup?.id} class="group-item" on:click={() => selectGroup(group.id)}>
            <span class="group-index">{String(index + 1).padStart(2, '0')}</span>
            <span class="group-copy">
              <strong>{group.text}</strong>
              <small>重音 {group.stressWords.join('、') || '未设'} · 停 {group.pauseMs}ms · {intonationOptions.find((item) => item.value === group.intonation)?.label}</small>
            </span>
          </button>
        {/each}
      </div>
      <div class="sidebar-actions">
        <button class="btn btn-sm variant-ghost" on:click={() => moveGroup(-1)}>上移</button>
        <button class="btn btn-sm variant-ghost" on:click={() => moveGroup(1)}>下移</button>
        <button class="btn btn-sm variant-ghost text-error-500" on:click={deleteGroup}>删除意群</button>
      </div>
      <div class="shortcut-note">
        <strong>快捷操作</strong>
        <span>Alt + ↑/↓ 调整意群 · Alt+R 开始/停止录音</span>
        <span>← / → 切换意群 · ⌘S 保存 · ⌘Z 撤销</span>
      </div>
    </aside>

    {#if selectedGroup}
      <section class:mobile-hidden={workspaceTab !== 'annotate'} class="annotation-column">
        <div class="card annotation-card">
          <div class="section-heading">
            <div><span class="eyebrow">PROSODY MARKUP · {currentVersion.label}</span><h2>发音与韵律标注</h2></div>
            <span class="chapter-badge">意群 {currentVersion.groups.findIndex((group) => group.id === selectedGroup?.id) + 1}</span>
          </div>
          <label class="label">
            <span>意群文本（改动前自动存档）</span>
            <input class="input" value={selectedGroup.text} on:input={(event) => updateGroup('text', event.currentTarget.value)} />
          </label>
          <div class="token-board">
            <div class="token-label">点击文字切换重音词</div>
            <div class="token-list">
              {#each selectedGroup.text.split('') as char}
                <button class:stressed={selectedGroup.stressWords.some((word) => word.includes(char))} class="text-token" on:click={() => toggleStressWord(char)}>{char}</button>
              {/each}
            </div>
          </div>
          <div class="annotation-grid">
            <label class="label">
              <span>重音词（用逗号分隔）</span>
              <input class="input" value={selectedGroup.stressWords.join('，')} on:change={(event) => updateGroup('stressWords', event.currentTarget.value.split(/[，,]/).map((word) => word.trim()).filter(Boolean))} />
            </label>
            <div class="label">
              <span>重音强度</span>
              <div class="segmented">
                {#each [0, 1, 2, 3] as level}
                  <button class:active={selectedGroup.stressLevel === level} on:click={() => setStressLevel(level)}>{level === 0 ? '无' : '●'.repeat(level)}</button>
                {/each}
              </div>
            </div>
            <label class="label">
              <span>后接停顿：{selectedGroup.pauseMs}ms</span>
              <input class="range" type="range" min="0" max="1500" step="20" value={selectedGroup.pauseMs} on:input={(event) => updateGroup('pauseMs', Number(event.currentTarget.value))} />
            </label>
            <label class="label">
              <span>语调走向</span>
              <select class="select" value={selectedGroup.intonation} on:change={(event) => setIntonation(event.currentTarget.value)}>
                {#each intonationOptions as option}<option value={option.value}>{option.label}</option>{/each}
              </select>
            </label>
            <label class="label span-2">
              <span>学习提示</span>
              <input class="input" value={selectedGroup.note} on:input={(event) => updateGroup('note', event.currentTarget.value)} placeholder="例如：重音后短停，句尾自然下落" />
            </label>
          </div>
          <div class="prosody-preview">
            <div>
              <span class="eyebrow">PREVIEW</span>
              <strong>标注预览</strong>
            </div>
            <p>
              <span class="stress-line">{'●'.repeat(selectedGroup.stressLevel)}</span>
              <span>{selectedGroup.text}</span>
              <span class="pause-mark">{selectedGroup.pauseMs ? `／ ${selectedGroup.pauseMs}ms` : ''}</span>
              <span class="intonation-mark">{intonationOptions.find((item) => item.value === selectedGroup.intonation)?.label}</span>
            </p>
          </div>
        </div>

        <div class="card recorder-card">
          <div class="section-heading">
            <div><span class="eyebrow">RECORDING · {currentVersion.label}</span><h2>录下这一轮</h2></div>
            <span class:recording class="record-dot">{recording ? 'REC' : 'READY'}</span>
          </div>
          <div class="record-console">
            <div class="record-time">{Math.floor(recordingSeconds / 60).toString().padStart(2, '0')}:{Math.floor(recordingSeconds % 60).toString().padStart(2, '0')}.{Math.floor((recordingSeconds % 1) * 10)}</div>
            <div class="level-bars" aria-hidden="true">
              {#each Array(24) as _, index}<span style={`height:${recording ? 18 + ((index * 17) % 46) : 12}%`}></span>{/each}
            </div>
            <button class:variant-filled-error={recording} class:variant-filled-primary={!recording} class="btn record-button" on:click={() => recording ? stopRecording() : startRecording()}>
              {recording ? '■ 停止并保存尝试' : '● 开始录音'}
            </button>
            <p>{recordingFallback ? '当前浏览器未授权麦克风，将保存一轮可校对的离线模拟记录。' : '录音仅保存在当前设备 IndexedDB，不会上传。'}</p>
          </div>
        </div>
      </section>
    {/if}

    <aside class:mobile-hidden={workspaceTab !== 'review' && workspaceTab !== 'progress'} class="review-column">
      <div class="card versions-card">
        <div class="section-heading">
          <div><span class="eyebrow">VERSIONS</span><h2>练习版本</h2></div>
          <span class="chapter-badge">{project.versions.length} 个</span>
        </div>
        <label class="label">
          <span>回看 / 校对版本</span>
          <select class="select" value={reviewVersion.id} on:change={(event) => selectReviewVersion(event.currentTarget.value)}>
            {#each [...project.versions].reverse() as version}
              <option value={version.id}>
                {version.label}{version.id === project.currentVersionId ? '（当前草稿）' : '（历史只读）'} · {version.attempts.length} 轮
              </option>
            {/each}
          </select>
        </label>
        <div class="version-meta">
          <strong>{reviewVersion.label}{reviewingHistory ? ' · 历史快照' : ' · 当前草稿'}</strong>
          <small>{new Date(reviewVersion.createdAt).toLocaleString('zh-CN')}</small>
          {#if reviewVersion.note}<p>{reviewVersion.note}</p>{/if}
        </div>
        {#if reviewingHistory}
          <div class="readonly-banner">
            <span>历史版本只读：旧尝试按本版本保存时的意群文本与顺序回看，后续改动不会串段。</span>
            <button class="btn btn-sm variant-soft-primary" on:click={() => restoreVersion(reviewVersion.id)}>以此版本生成新草稿</button>
          </div>
        {/if}
      </div>

      <div class="card group-strip-card">
        <span class="eyebrow">SENSE GROUPS · {reviewVersion.label}</span>
        <div class="review-group-strip">
          {#each reviewVersion.groups as group, index (group.id)}
            <button class:active={group.id === reviewGroup?.id} on:click={() => reviewGroupId = group.id}>
              <i>{index + 1}</i>{group.text}
            </button>
          {/each}
        </div>
      </div>

      <div class="card attempts-card">
        <div class="section-heading">
          <div><span class="eyebrow">TAKES</span><h2>多轮尝试</h2></div>
          <span class="chapter-badge">{reviewVersion.attempts.length} 轮</span>
        </div>
        {#if reviewVersion.attempts.length === 0}
          <p class="empty-copy">{reviewingHistory ? '该历史版本没有尝试记录。' : '当前草稿还没有尝试，录下第一轮吧。'}</p>
        {/if}
        <div class="attempt-list">
          {#each [...reviewVersion.attempts].reverse() as attempt}
            <button class:active={attempt.id === selectedAttempt?.id} class="attempt-item" on:click={() => { selectedAttemptId = attempt.id; stopPlayback() }}>
              <span class="attempt-number">{attempt.number}</span>
              <span><strong>{attempt.label}</strong><small>{attempt.duration.toFixed(1)}s · {attempt.simulated ? '模拟' : '录音'}</small></span>
              <span class="attempt-score">{attempt.scores.length ? Math.round(attempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / attempt.scores.length) : 0}%</span>
            </button>
          {/each}
        </div>
      </div>

      {#if selectedAttempt && reviewGroup}
        <div class:recommended={workspaceTab !== 'progress'} class="card playback-card">
          <div class="section-heading">
            <div><span class="eyebrow">COMPARE · 意群 {reviewGroup.text}</span><h2>回听与偏差</h2></div>
            <button class="btn btn-sm variant-filled-primary" on:click={togglePlayback}>{playing ? '■ 停止' : '▶ 播放范围'}</button>
          </div>
          {#if reviewingHistory}<div class="inline-readonly">回听范围为该版本存档时的标记，只读展示。</div>{/if}
          <audio bind:this={audioElement} src={audioUrlFor(selectedAttempt)} on:timeupdate={onAudioTimeUpdate} on:ended={stopPlayback}></audio>
          <div class="playback-timeline">
            <div class="playhead" style={`left:${selectedAttempt.duration ? Math.min(100, playbackTime / selectedAttempt.duration * 100) : 0}%`}></div>
            <span class="range-fill" style={`left:${selectedAttempt.duration ? selectedAttempt.rangeStart / selectedAttempt.duration * 100 : 0}%;right:${selectedAttempt.duration ? 100 - selectedAttempt.rangeEnd / selectedAttempt.duration * 100 : 0}%`}></span>
          </div>
          <div class="range-controls">
            <label class:disabled-control={reviewingHistory}><span>回听起点 {selectedAttempt.rangeStart.toFixed(1)}s</span><input class="range" type="range" min="0" max={selectedAttempt.duration} step="0.1" value={selectedAttempt.rangeStart} disabled={reviewingHistory} on:input={(event) => updateRange('rangeStart', Number(event.currentTarget.value))} /></label>
            <label class:disabled-control={reviewingHistory}><span>回听终点 {selectedAttempt.rangeEnd.toFixed(1)}s</span><input class="range" type="range" min="0" max={selectedAttempt.duration} step="0.1" value={selectedAttempt.rangeEnd} disabled={reviewingHistory} on:input={(event) => updateRange('rangeEnd', Number(event.currentTarget.value))} /></label>
          </div>
          {#if selectedScore}
            <div class="score-grid">
              <label class:disabled-control={reviewingHistory}><span>准确度 {selectedScore.accuracy}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.accuracy} disabled={reviewingHistory} on:input={(event) => updateScore('accuracy', Number(event.currentTarget.value))} /></label>
              <label class:disabled-control={reviewingHistory}><span>节奏 {selectedScore.rhythm}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.rhythm} disabled={reviewingHistory} on:input={(event) => updateScore('rhythm', Number(event.currentTarget.value))} /></label>
              <label class:disabled-control={reviewingHistory}><span>偏差 {selectedScore.deviation}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.deviation} disabled={reviewingHistory} on:input={(event) => updateScore('deviation', Number(event.currentTarget.value))} /></label>
            </div>
            <label class="label"><span>本意群偏差说明{reviewingHistory ? '（历史只读）' : ''}</span><textarea class="textarea" rows="2" value={selectedScore.note} disabled={reviewingHistory} on:input={(event) => updateScoreNote(event.currentTarget.value)}></textarea></label>
          {/if}
          <label class="label"><span>本轮自评{reviewingHistory ? '（历史只读）' : ''}</span><textarea class="textarea" rows="2" value={selectedAttempt.selfNote} disabled={reviewingHistory} on:input={(event) => updateSelfNote(event.currentTarget.value)}></textarea></label>
        </div>

        <div class:recommended={workspaceTab === 'review'} class="card issues-card">
          <div class="section-heading">
            <div><span class="eyebrow">ERROR TAGS</span><h2>错词分类</h2></div>
          </div>
          {#if !reviewingHistory}
            <div class="issue-form">
              <input class="input" placeholder="错词或字" value={issueWord} on:input={(event) => issueWord = event.currentTarget.value} />
              <select class="select" value={issueCategory} on:change={(event) => issueCategory = event.currentTarget.value}>
                {#each project.errorCategories as category}<option value={category}>{category}</option>{/each}
              </select>
              <input class="input span-2" placeholder="问题说明（可选）" value={issueNote} on:input={(event) => issueNote = event.currentTarget.value} />
              <button class="btn btn-sm variant-filled-secondary span-2" on:click={addWordIssue}>添加错词记录</button>
            </div>
          {/if}
          <div class="issue-list">
            {#each selectedAttempt.wordIssues.filter((issue) => issue.groupId === reviewGroupId) as issue}
              <div class="issue-item">
                <span class="badge variant-filled-warning">{issue.category}</span>
                <strong>{issue.word}</strong>
                {#if !reviewingHistory}<button class="btn btn-sm variant-ghost text-error-500" on:click={() => removeWordIssue(issue.id)}>移除</button>{/if}
                <p>{issue.note || '暂无补充说明'}</p>
              </div>
            {/each}
            {#if !selectedAttempt.wordIssues.some((issue) => issue.groupId === reviewGroupId)}<p class="empty-copy">本轮意群还没有错词记录。</p>{/if}
          </div>
        </div>
      {/if}

      <div class:recommended={workspaceTab === 'progress'} class="card feedback-card">
        <div class="section-heading">
          <div><span class="eyebrow">TEACHER FEEDBACK · 意群 {reviewGroup?.text ?? ''}</span><h2>逐段反馈</h2></div>
        </div>
        <div class="feedback-list">
          {#each selectedAttempt?.feedback.filter((item) => item.groupId === reviewGroupId) ?? [] as feedback}
            <div class="feedback-item">
              <strong>{feedback.teacher}</strong>
              <p>{feedback.text}</p>
              <small>{new Date(feedback.createdAt).toLocaleString('zh-CN')}</small>
            </div>
          {/each}
          {#if !selectedAttempt || !selectedAttempt.feedback.some((item) => item.groupId === reviewGroupId)}<p class="empty-copy">本意群还没有反馈。</p>{/if}
        </div>
        {#if !reviewingHistory && selectedAttempt}
          <label class="label"><span>给当前意群留言</span><textarea class="textarea" rows="2" value={feedbackText} on:input={(event) => feedbackText = event.currentTarget.value} placeholder="教师反馈会绑定到这一轮和这个意群"></textarea></label>
          <button class="btn btn-sm variant-filled-tertiary" on:click={addFeedback}>留下反馈</button>
        {/if}
      </div>
    </aside>

    {#if workspaceTab === 'progress'}
      <section class="progress-dashboard card">
        <div class="section-heading">
          <div><span class="eyebrow">PROGRESS</span><h2>练习进度、版本历史与错词归类</h2></div>
        </div>
        <div class="progress-grid">
          <div><strong>{totalAttempts}</strong><span>累计尝试（全版本）</span></div>
          <div><strong>{project.versions.length}</strong><span>历史版本数</span></div>
          <div><strong>{totalIssues}</strong><span>错词记录（全版本）</span></div>
          <div><strong>{project.targetAttempts ? Math.round(Math.min(totalAttempts, project.targetAttempts) / project.targetAttempts * 100) : 0}%</strong><span>目标完成度</span></div>
        </div>

        <div class="version-history">
          <div class="table-heading"><span class="eyebrow">VERSION HISTORY</span><h3>各历史版本尝试与错词</h3></div>
          <div class="version-table">
            <div class="version-row version-row-head">
              <span>版本</span><span>来源 / 说明</span><span>保存时间</span><span>尝试数</span><span>错词总数</span><span>操作</span>
            </div>
            {#each [...versionStats].reverse() as stat}
              <div class="version-row">
                <span class="cell-name">
                  <strong>{stat.version.label}</strong>
                  <small>{stat.version.id === project.currentVersionId ? '当前草稿' : '历史只读'}</small>
                </span>
                <span class="cell-note">{stat.version.note || (stat.version.forkedFromId ? '由上一版本继续编辑' : '初始版本')}</span>
                <span class="cell-time">{new Date(stat.version.createdAt).toLocaleDateString('zh-CN')}<br /><small>{new Date(stat.version.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></span>
                <span class="cell-num">{stat.attemptCount}</span>
                <span class="cell-num">{stat.issueCount}</span>
                <span class="cell-actions">
                  <button class="btn btn-sm variant-soft" on:click={() => { selectReviewVersion(stat.version.id); workspaceTab = 'review' }}>回看尝试</button>
                  {#if stat.version.id !== project.currentVersionId}
                    <button class="btn btn-sm variant-soft-primary" on:click={() => restoreVersion(stat.version.id)}>恢复为新草稿</button>
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        </div>

        <div class="category-block">
          <div class="table-heading"><span class="eyebrow">ERROR CATEGORIES · 全版本</span><h3>错词分类统计</h3></div>
          <div class="category-list">
            {#each totalIssueCategories as category}
              <div><span>{category.category}</span><div class="mini-bar"><i style={`width:${Math.min(100, category.count * 18)}%`}></i></div><strong>{category.count}</strong></div>
            {/each}
          </div>
          <div class="inline-actions">
            <input class="input" bind:value={newCategory} placeholder="新增错词分类" />
            <button class="btn btn-sm variant-soft" on:click={addCategory}>添加分类</button>
            <button class="btn btn-sm variant-ghost text-error-500" on:click={deleteAllData}>清除本机数据</button>
          </div>
        </div>
      </section>
    {/if}
  </main>

  {#if !loaded}
    <div class="loading-overlay"><span class="loading-bar">正在恢复离线练习…</span></div>
  {/if}
</div>
