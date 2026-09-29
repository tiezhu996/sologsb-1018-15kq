/* 临时验证脚本：用 esbuild 转译 TS 后跑版本工作流断言。 */
const path = require('path')
const esbuild = require('esbuild')

function assert(condition, message) {
  if (!condition) { console.error('✗', message); process.exitCode = 1 } else console.log('✓', message)
}

function makeGroup(id, text) {
  return { id, text, stressWords: [], stressLevel: 1, pauseMs: 300, intonation: 'flat', note: '' }
}

function makeLegacyProject() {
  const groups = [makeGroup('g1', '旧意群一'), makeGroup('g2', '旧意群二')]
  return {
    title: '旧练习', sentence: '旧意群一旧意群二', translation: '', teacher: '老师',
    targetAttempts: 5, targetDuration: 10, groups,
    attempts: [{
      id: 'a1', number: 1, label: '第 1 轮', createdAt: '2026-09-01T00:00:00.000Z',
      duration: 5, audioMime: 'audio/webm', simulated: true, rangeStart: 0.5, rangeEnd: 4.2,
      scores: [{ groupId: 'g1', accuracy: 60, rhythm: 65, deviation: 20, note: '旧偏差' }],
      wordIssues: [{ id: 'w1', groupId: 'g1', word: '一', category: '声调', note: '旧错词' }],
      feedback: [{ id: 'f1', groupId: 'g1', teacher: '老师', text: '旧反馈', createdAt: '2026-09-01T01:00:00.000Z' }],
      selfNote: '旧自评'
    }],
    errorCategories: ['声调'], updatedAt: '2026-09-01T00:00:00.000Z'
  }
}

async function importTs(entry) {
  const built = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', 'src', entry)],
    bundle: true,
    format: 'cjs',
    write: false,
    platform: 'node'
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require)
  return mod.exports
}

;(async () => {
  const { forkForEdit, restoreAsDraft } = await importTs('versioning.ts')
  const { migrateLegacyProject } = await importTs('migrate.ts')
  const { createSampleProject } = await importTs('sample.ts')

  // 1. 无损迁移
  const migrated = migrateLegacyProject(makeLegacyProject())
  assert(migrated.versions.length === 1, '迁移后只有 v1')
  const v1 = migrated.versions[0]
  assert(v1.id === migrated.currentVersionId && v1.isDraft === true, 'v1 是当前草稿')
  assert(migrated.attempts[0].versionId === v1.id, '旧尝试补上 versionId 指向 v1')
  assert(v1.attemptIds.length === 1 && v1.attemptIds[0] === 'a1', 'v1 挂有旧尝试 id')
  assert(v1.groups[1].text === '旧意群二' && migrated.attempts[0].scores[0].note === '旧偏差', '旧意群、评分、错词、反馈原样保留')

  // 2. 有尝试时结构性编辑 -> 冻结 v1 + 新建 v2
  const { project: forked, draftId } = forkForEdit(migrated, '编辑原句', (v) => {
    v.sentence = '新句子'
    v.groups = [makeGroup('g1', '保留的意群'), makeGroup('g3', '新增的意群')]
  })
  assert(forked.versions.length === 2, '编辑后产生第二个版本')
  assert(draftId === forked.currentVersionId, '编辑落在当前草稿')
  const frozen = forked.versions.find((x) => x.id === v1.id)
  assert(frozen.isDraft === false && frozen.frozenAt !== null, 'v1 已冻结为历史版本')
  assert(frozen.groups[1].text === '旧意群二', '冻结版本的意群文本不被新编辑改动')
  const draft2 = forked.versions.find((x) => x.id === draftId)
  assert(draft2.number === 2 && draft2.sentence === '新句子' && draft2.attemptIds.length === 0, 'v2 是承接编辑的空草稿')
  assert(forked.attempts[0].versionId === v1.id, '旧尝试仍归属 v1，不随编辑串段')
  assert(forked.attempts[0].rangeStart === 0.5 && forked.attempts[0].rangeEnd === 4.2, '旧尝试回听范围保持当时标记')
  assert(frozen.groups.some((g) => g.id === 'g1'), 'v1 保留旧尝试评分对应的意群 id')
  assert(!draft2.groups.some((g) => g.id === 'g2'), 'v2 删除意群不影响 v1')

  // 4. 刚 fork 出的空草稿（以及恢复出的空草稿）没有尝试，连续编辑都原地合并，不重复快照
  const { project: editedNew, created } = forkForEdit(forked, '微调', (v) => { v.groups[0].text = '改过的意群一' })
  assert(created === false, '空草稿首次编辑不新增版本')
  assert(editedNew.versions.length === 2, '仍为两个版本')
  const second = forkForEdit(editedNew, '再改', (v) => { v.groups[0].text = '再改' })
  assert(second.created === false && second.project.versions.length === 2, '空草稿连续修改仍合并在同一版本（不会每个键击产生快照）')

  // 5. 新草稿录了一轮尝试后，再动结构必须先冻结产生 v3
  let withAttempt = second.project
  const draft2Id = withAttempt.currentVersionId
  withAttempt = structuredClone(withAttempt)
  withAttempt.attempts.push({
    id: 'a2', versionId: draft2Id, number: 1, label: '第 1 轮', createdAt: '', duration: 3,
    audioMime: '', simulated: true, rangeStart: 0, rangeEnd: 3,
    scores: [{ groupId: 'g1', accuracy: 80, rhythm: 80, deviation: 10, note: '' }],
    wordIssues: [], feedback: [], selfNote: ''
  })
  withAttempt.versions.find((v) => v.id === draft2Id).attemptIds.push('a2')
  const afterRecord = forkForEdit(withAttempt, '录音后改句', (v) => { v.sentence = '再调整' })
  assert(afterRecord.created === true && afterRecord.project.versions.length === 3, '已有尝试后再编辑，冻结产生 v3')
  assert(afterRecord.project.attempts.find((a) => a.id === 'a2').versionId === draft2Id, '新尝试留在冻结的 v2，不串到 v3')

  // 6. 恢复历史版本：空稿原地改写；有尝试的稿则冻结并克隆
  const restored = restoreAsDraft(afterRecord.project, v1.id)
  const restoredDraft = restored.versions.find((x) => x.id === restored.currentVersionId)
  assert(restored.versions.length === 4, '当前稿有尝试，恢复时冻结当前稿并克隆出新版本')
  assert(restoredDraft.number === 4 && restoredDraft.isDraft && restoredDraft.attemptIds.length === 0, '新草稿不带走旧尝试')
  assert(restoredDraft.sentence === '旧意群一旧意群二' && restoredDraft.groups.length === 2, '句子与意群克隆自 v1')
  assert(restored.versions.find((x) => x.id === v1.id).isDraft === false, '原 v1 仍保留为历史版本可追溯')
  assert(restored.attempts.every((a) => a.versionId !== restoredDraft.id), '旧尝试均不并入新草稿')
  const restoreEmpty = restoreAsDraft(second.project, v1.id)
  assert(restoreEmpty.versions.length === 3, '即使当前稿为空，恢复也始终冻结它并生成新草稿')
  assert(restoreEmpty.versions.find((v) => v.id === restoreEmpty.currentVersionId).sentence === '旧意群一旧意群二', '新草稿内容来自所选 v1')

  // 7. 示例项目：首次结构编辑即冻结 v1（示例带 2 轮尝试）
  const sample = createSampleProject()
  const sampleEdit = forkForEdit(sample, '改示例', (v) => { v.sentence = '改了' })
  assert(sampleEdit.created === true && sampleEdit.project.versions[0].frozenAt !== null, '示例稿编辑前冻结，旧尝试不串段')
  assert(sampleEdit.project.attempts.every((a) => a.versionId === 'version-1'), '示例旧尝试全部留在 v1')

  console.log(process.exitCode ? '\n部分断言失败' : '\n全部断言通过')
})().catch((error) => { console.error(error); process.exit(1) })
