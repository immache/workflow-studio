import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createCurrentStandardWorkflow, createBlankWorkflow } from '../../data/presets/current-standard-workflow'
import { createModularWorkflow } from '../../data/modules/standard-workflow-modules'
import { exportHtmlDocuments } from '../../domain/export-html'
import { exportMarkdownDocuments, exportReadme } from '../../domain/export-markdown'
import { createWorkflowZip, packageName, serializeWorkflowJson } from '../../domain/export-zip'
import { parseImportedWorkflow, parseWorkflowJson } from '../../domain/import-export'
import { scoreWorkflow } from '../../domain/scoring'
import { fieldValueToText, scalarValue, SCHEMA_VERSION, type WorkflowSchema } from '../../domain/schema'
import { simulateRecovery } from '../../domain/simulation'
import { validateWorkflow, warningSchemaHash } from '../../domain/validation'
import { useWorkflowStore } from '../../store/workflow-store'

async function zipFile(entries: Record<string, string>): Promise<File> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content)
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  return new File([blob], 'workflow.zip', { type: 'application/zip' })
}

function addStructuredFilenameReferences(workflow: WorkflowSchema, filename: string): void {
  const document = workflow.documents.find((candidate) => candidate.id === 'status')
  const section = document?.sections[0]
  const field = section?.fields[0]
  const recoveryStep = workflow.rules.recoveryOrder.find((step) => step.documentId === 'agents')
  const sourceRule = workflow.rules.sourcePriority[0]
  const source = sourceRule?.orderedSources.find((candidate) => !candidate.documentId)
  const updateTrigger = workflow.rules.updateTriggers.find((trigger) => trigger.targetDocumentId === 'status')
  const completionCheck = workflow.rules.completionChecks[0]
  if (!document || !section || !field || !recoveryStep || !sourceRule || !source || !updateTrigger || !completionCheck) {
    throw new Error('missing structured filename reference fixture')
  }

  workflow.name = `${filename} 工作流`
  workflow.description = `${filename} 工作流说明`
  recoveryStep.condition = `${filename} 恢复规则`
  sourceRule.reason = `${filename} 来源规则`
  source.label = `${filename} 来源标签`
  updateTrigger.trigger = `${filename} 更新条件`
  updateTrigger.requiredAction = `${filename} 更新动作`
  completionCheck.label = `${filename} 完成检查`
  completionCheck.description = `${filename} 完成说明`
  document.title = `${filename} 状态标题`
  document.description = `${filename} 文档说明`
  document.readPolicy.whenToRead = [`${filename} 读取说明`]
  document.readPolicy.skipWhen = [`${filename} 跳过说明`]
  document.updatePolicy.updateTriggers = [`${filename} 文档更新条件`]
  document.updatePolicy.ownerHint = `${filename} 维护说明`
  section.title = `${filename} 章节标题`
  section.purpose = `${filename} 章节说明`
  field.label = `${filename} 字段标题`
  field.guidance = `${filename} 字段说明`
  field.defaultValue = `${filename} 默认值`
  field.value = {
    kind: 'list',
    value: [
      scalarValue(`${filename} 字段值`),
      { kind: 'table', columns: ['reference'], rows: [{ reference: `${filename} 表格值` }] },
    ],
  }
  field.options = [{
    value: `${filename} 选项值`,
    label: `${filename} 选项标题`,
    description: `${filename} 选项说明`,
  }]
  field.validation.allowedValues = [`${filename} 允许值`]
  field.validation.customRules = [{
    id: 'filename-reference',
    description: `${filename} 校验说明`,
    severity: 'warning',
    predicate: 'non-empty',
  }]
}

describe('Workflow Studio domain model', () => {
  it('creates the built-in current workflow preset without blocking errors', () => {
    const workflow = createCurrentStandardWorkflow()
    const issues = validateWorkflow(workflow)

    expect(workflow.documents.map((document) => document.filename)).toEqual([
      'AGENTS.md',
      'SPEC.html',
      'STATUS.html',
      'USER.html',
      'MEMORY.html',
      'CONTEXT.html',
    ])
    const sectionsByFile = Object.fromEntries(workflow.documents.map((document) => [document.filename, document.sections.map((section) => section.id)]))
    expect(sectionsByFile['SPEC.html']).toEqual(expect.arrayContaining(['users-scenarios', 'open-questions']))
    expect(sectionsByFile['STATUS.html']).toEqual(expect.arrayContaining(['recovery-pointers']))
    expect(sectionsByFile['USER.html']).toEqual(expect.arrayContaining(['user-maintenance-rules']))
    expect(sectionsByFile['CONTEXT.html']).toEqual(expect.arrayContaining(['entry-fields', 'basic-terms', 'custom-term-template', 'context-maintenance-rules']))
    expect(issues.filter((issue) => issue.severity === 'error')).toHaveLength(0)
    expect(scoreWorkflow(workflow, issues).total).toBeGreaterThanOrEqual(80)
  })

  it('keeps blank workflows honest with validation errors', () => {
    const workflow = createBlankWorkflow()
    const issues = validateWorkflow(workflow)

    expect(workflow.documents.map((document) => document.filename)).toEqual(['AGENTS.md', 'STATUS.html', 'MEMORY.html'])
    expect(issues.some((issue) => issue.severity === 'error')).toBe(true)
  })

  it('generates optional blank workflow materials from selections', () => {
    const workflow = createBlankWorkflow(['plan', 'context'])

    expect(workflow.documents.map((document) => document.filename)).toEqual([
      'AGENTS.md',
      'SPEC.html',
      'STATUS.html',
      'MEMORY.html',
      'CONTEXT.html',
    ])
    expect(workflow.rules.recoveryOrder.map((step) => step.documentId)).toEqual(['protocol', 'blank-plan', 'blank-status', 'memory', 'blank-context'])
  })

  it('allows blank workflows to export after required recovery fields are filled', async () => {
    const workflow = createBlankWorkflow()
    const fields = workflow.documents.flatMap((document) => document.sections).flatMap((section) => section.fields)
    const recoveryOrder = fields.find((field) => field.id === 'recovery-order')
    const nextAtomicStep = fields.find((field) => field.id === 'blank-next-atomic-step')
    if (!recoveryOrder || !nextAtomicStep) throw new Error('missing blank workflow fixture')

    recoveryOrder.value = scalarValue('AGENTS.md -> STATUS.html')
    nextAtomicStep.value = scalarValue('继续完善状态快照中的当前目标。')

    expect(validateWorkflow(workflow).filter((issue) => issue.severity === 'error')).toHaveLength(0)
    expect(simulateRecovery(workflow, 'new-session')).toMatchObject({
      status: 'pass',
      readDocuments: ['AGENTS.md', 'STATUS.html'],
    })
    await expect(createWorkflowZip(workflow)).resolves.toMatchObject({
      files: expect.objectContaining({
        'workflow.json': expect.any(String),
        'documents/AGENTS.md': expect.any(String),
        'documents/STATUS.html': expect.any(String),
        'documents/MEMORY.html': expect.any(String),
      }),
    })
  })

  it('keeps empty repeatable fields as list values in the editable store', async () => {
    await useWorkflowStore.getState().createBlankProject()
    const workflow = useWorkflowStore.getState().workflow
    const document = workflow.documents.find((candidate) => candidate.id === 'blank-status')
    const section = document?.sections.find((candidate) => candidate.id === 'blank-anchor')
    const field = section?.fields.find((candidate) => candidate.id === 'blank-work-entry')
    if (!document || !section || !field) throw new Error('missing blank status fixture')

    useWorkflowStore.getState().updateField(document.id, section.id, field.id, { repeatable: true })

    const updatedField = useWorkflowStore.getState().workflow.documents
      .find((candidate) => candidate.id === document.id)
      ?.sections.find((candidate) => candidate.id === section.id)
      ?.fields.find((candidate) => candidate.id === field.id)
    if (!updatedField) throw new Error('missing updated field')
    expect(updatedField.repeatable).toBe(true)
    expect(updatedField.value.kind).toBe('list')
    if (updatedField.value.kind === 'list') {
      expect(updatedField.value.value).toHaveLength(0)
    }
  })

  it('syncs an untouched generated protocol document list when a content document changes', async () => {
    await useWorkflowStore.getState().createModularProject({
      name: '协议同步测试',
      description: '验证文档职责会同步到入口协议。',
      selectedDocumentIds: ['status', 'spec'],
      firstAction: '先读取 STATUS.html，再确认下一原子步骤。',
      recoveryRisk: '文档职责与入口协议摘要不同步。',
    })
    const before = useWorkflowStore.getState().workflow
    const status = before.documents.find((document) => document.role === 'status')
    const protocol = before.documents.find((document) => document.role === 'protocol')
    const documentList = protocol?.sections.flatMap((section) => section.fields).find((field) => field.id === 'protocol-documents')
    if (!status || !protocol || !documentList) throw new Error('missing modular protocol fixture')

    useWorkflowStore.getState().updateDocument(status.id, {
      filename: 'NOW.html',
      description: '只记录这一轮仍有效的目标、证据与下一步。',
    })
    const syncedList = useWorkflowStore.getState().workflow.documents
      .find((document) => document.id === protocol.id)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.id === 'protocol-documents')
    if (!syncedList) throw new Error('missing synced protocol list')

    expect(fieldValueToText(syncedList.value)).toContain('NOW.html：只记录这一轮仍有效的目标、证据与下一步。')
    expect(syncedList.defaultValue).toBe(fieldValueToText(syncedList.value))

    useWorkflowStore.getState().updateFieldText(protocol.id, 'protocol-doc-list', 'protocol-documents', '这是经过人工审查的自定义清单。')
    useWorkflowStore.getState().updateDocument(status.id, { description: '这次职责修改不应覆盖人工清单。' })
    const preservedList = useWorkflowStore.getState().workflow.documents
      .find((document) => document.id === protocol.id)
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.id === 'protocol-documents')

    expect(fieldValueToText(preservedList?.value ?? { kind: 'empty' })).toBe('这是经过人工审查的自定义清单。')
  })

  it('rewrites every structured filename reference when the store renames a document', async () => {
    await useWorkflowStore.getState().createPresetProject()
    const before = useWorkflowStore.getState().workflow
    const renamedDocument = before.documents.find((document) => document.id === 'spec')
    if (!renamedDocument) throw new Error('missing plan document fixture')
    const previousFilename = renamedDocument.filename
    const nextFilename = 'PLAN.html'
    addStructuredFilenameReferences(before, previousFilename)

    useWorkflowStore.getState().updateDocument(renamedDocument.id, { filename: nextFilename })
    const workflow = useWorkflowStore.getState().workflow
    const status = workflow.documents.find((document) => document.id === 'status')
    const section = status?.sections[0]
    const field = section?.fields[0]
    if (!status || !section || !field) throw new Error('missing renamed reference fixture')

    expect(workflow.documents.find((document) => document.id === renamedDocument.id)?.filename).toBe(nextFilename)
    expect(workflow.name).toBe(`${nextFilename} 工作流`)
    expect(workflow.description).toBe(`${nextFilename} 工作流说明`)
    expect(status).toMatchObject({
      title: `${nextFilename} 状态标题`,
      description: `${nextFilename} 文档说明`,
      readPolicy: {
        whenToRead: [`${nextFilename} 读取说明`],
        skipWhen: [`${nextFilename} 跳过说明`],
      },
      updatePolicy: {
        updateTriggers: [`${nextFilename} 文档更新条件`],
        ownerHint: `${nextFilename} 维护说明`,
      },
    })
    expect(section).toMatchObject({
      title: `${nextFilename} 章节标题`,
      purpose: `${nextFilename} 章节说明`,
    })
    expect(field).toMatchObject({
      label: `${nextFilename} 字段标题`,
      guidance: `${nextFilename} 字段说明`,
      defaultValue: `${nextFilename} 默认值`,
      options: [{
        value: `${nextFilename} 选项值`,
        label: `${nextFilename} 选项标题`,
        description: `${nextFilename} 选项说明`,
      }],
      validation: {
        allowedValues: [`${nextFilename} 允许值`],
        customRules: [expect.objectContaining({ description: `${nextFilename} 校验说明` })],
      },
    })
    expect(field.value).toEqual({
      kind: 'list',
      value: [
        scalarValue(`${nextFilename} 字段值`),
        { kind: 'table', columns: ['reference'], rows: [{ reference: `${nextFilename} 表格值` }] },
      ],
    })
    expect(workflow.rules.recoveryOrder.find((step) => step.documentId === 'agents')?.condition).toBe(`${nextFilename} 恢复规则`)
    expect(workflow.rules.sourcePriority[0]).toMatchObject({
      reason: `${nextFilename} 来源规则`,
      orderedSources: expect.arrayContaining([expect.objectContaining({ label: `${nextFilename} 来源标签` })]),
    })
    expect(workflow.rules.updateTriggers.find((trigger) => trigger.targetDocumentId === 'status')).toMatchObject({
      trigger: `${nextFilename} 更新条件`,
      requiredAction: `${nextFilename} 更新动作`,
    })
    expect(workflow.rules.completionChecks[0]).toMatchObject({
      label: `${nextFilename} 完成检查`,
      description: `${nextFilename} 完成说明`,
    })
    expect(JSON.stringify(workflow)).not.toContain(previousFilename)
  })

  it('cleans structured and field-value references when the store removes a document', async () => {
    await useWorkflowStore.getState().createPresetProject()
    const before = useWorkflowStore.getState().workflow
    const removed = before.documents.find((document) => document.id === 'spec')
    if (!removed) throw new Error('missing plan document fixture')
    const removedSection = removed.sections[0]
    const removedField = removedSection.fields[0]
    const status = before.documents.find((document) => document.id === 'status')
    if (!status) throw new Error('missing status fixture')
    addStructuredFilenameReferences(before, removed.filename)
    before.rules.sourcePriority.push({
      id: 'field-source-reference',
      scope: 'field',
      targetId: removedField.id,
      orderedSources: [],
      tieBreaker: 'manual-review',
      reason: `参见 ${removed.filename}`,
    })
    before.acceptedWarnings.push({
      issueId: 'removed-field-warning',
      ruleId: 'test-warning',
      target: { documentId: status.id, sectionId: removedSection.id, fieldId: removedField.id },
      acceptedAt: new Date().toISOString(),
      schemaHash: 'test',
    })
    expect(before.rules.recoveryOrder.some((step) => step.documentId === removed.id)).toBe(true)
    expect(before.documents.flatMap((document) => document.sections).flatMap((section) => section.fields).some((field) => fieldValueToText(field.value).includes(removed.filename))).toBe(true)

    useWorkflowStore.getState().removeDocument(removed.id)
    const workflow = useWorkflowStore.getState().workflow
    const survivingStatus = workflow.documents.find((document) => document.id === status.id)
    const survivingSection = survivingStatus?.sections[0]
    const survivingField = survivingSection?.fields[0]
    if (!survivingStatus || !survivingSection || !survivingField) throw new Error('missing surviving reference fixture')

    expect(workflow.documents.some((document) => document.id === removed.id)).toBe(false)
    expect(workflow.rules.recoveryOrder.some((step) => step.documentId === removed.id)).toBe(false)
    expect(workflow.rules.sourcePriority.some((rule) => rule.targetId === removed.id || rule.orderedSources.some((source) => source.documentId === removed.id))).toBe(false)
    expect(workflow.rules.sourcePriority.some((rule) => rule.targetId === removedField.id)).toBe(false)
    expect(workflow.rules.updateTriggers.some((trigger) => trigger.targetDocumentId === removed.id)).toBe(false)
    expect(workflow.rules.completionChecks.some((check) => check.relatedDocumentIds.includes(removed.id))).toBe(false)
    expect(workflow.documents.some((document) => document.readPolicy.dependsOnDocumentIds.includes(removed.id))).toBe(false)
    expect(workflow.documents.flatMap((document) => document.sections).flatMap((section) => section.fields).some((field) => fieldValueToText(field.value).includes(removed.filename))).toBe(false)
    expect(workflow.name).toBe('工作流')
    expect(workflow.description).toBe('工作流说明')
    expect(survivingStatus).toMatchObject({
      title: '状态标题',
      description: '文档说明',
      readPolicy: { whenToRead: ['读取说明'], skipWhen: ['跳过说明'] },
      updatePolicy: { updateTriggers: ['文档更新条件'], ownerHint: '维护说明' },
    })
    expect(survivingSection).toMatchObject({ title: '章节标题', purpose: '章节说明' })
    expect(survivingField).toMatchObject({
      label: '字段标题',
      guidance: '字段说明',
      defaultValue: '默认值',
      options: [{ value: '选项值', label: '选项标题', description: '选项说明' }],
      validation: {
        allowedValues: ['允许值'],
        customRules: [expect.objectContaining({ description: '校验说明' })],
      },
    })
    expect(survivingField.value).toEqual({
      kind: 'list',
      value: [
        scalarValue('字段值'),
        { kind: 'table', columns: ['reference'], rows: [{ reference: '表格值' }] },
      ],
    })
    expect(workflow.rules.recoveryOrder.find((step) => step.documentId === 'agents')?.condition).toBe('恢复规则')
    expect(workflow.rules.sourcePriority[0]).toMatchObject({
      reason: '来源规则',
      orderedSources: expect.arrayContaining([expect.objectContaining({ label: '来源标签' })]),
    })
    expect(workflow.rules.updateTriggers.find((trigger) => trigger.targetDocumentId === 'status')).toMatchObject({
      trigger: '更新条件',
      requiredAction: '更新动作',
    })
    expect(workflow.rules.completionChecks[0]).toMatchObject({ label: '完成检查', description: '完成说明' })
    expect(JSON.stringify(workflow)).not.toContain(removed.filename)
    expect(workflow.acceptedWarnings.some((warning) => warning.target.fieldId === removedField.id || warning.target.sectionId === removedSection.id)).toBe(false)
  })

  it('simulates a new session recovery path', () => {
    const workflow = createCurrentStandardWorkflow()
    const nextStepField = workflow.documents
      .flatMap((document) => document.sections)
      .flatMap((section) => section.fields)
      .find((field) => field.id === 'next-atomic-step')
    if (!nextStepField) throw new Error('missing next atomic step fixture')
    nextStepField.id = 'status-current-next-atomic-step'
    nextStepField.value = scalarValue('运行领域回归测试并检查结果。')
    const result = simulateRecovery(workflow, 'new-session')

    expect(result.status).toBe('pass')
    expect(result.readDocuments).toContain('AGENTS.md')
    expect(result.nextAtomicStep).toBe('运行领域回归测试并检查结果。')
  })

  it('reads optional recovery documents only for the scenario that needs them', () => {
    const workflow = createCurrentStandardWorkflow()

    const newSession = simulateRecovery(workflow, 'new-session')
    const unclearTerm = simulateRecovery(workflow, 'unclear-term')
    const insufficientHistory = simulateRecovery(workflow, 'insufficient-history')

    expect(newSession.readDocuments).toEqual(['AGENTS.md', 'STATUS.html', 'SPEC.html'])
    expect(newSession.steps.filter((step) => step.outcome === 'skip').map((step) => step.action)).toEqual([
      '按需跳过 USER.html',
      '按需跳过 MEMORY.html',
      '按需跳过 CONTEXT.html',
    ])
    expect(unclearTerm.readDocuments).toEqual(['AGENTS.md', 'STATUS.html', 'SPEC.html', 'CONTEXT.html'])
    expect(insufficientHistory.readDocuments).toEqual(['AGENTS.md', 'STATUS.html', 'SPEC.html', 'MEMORY.html'])
  })

  it('reports source conflicts with selected source details', () => {
    const result = simulateRecovery(createCurrentStandardWorkflow(), 'goal-conflict')

    expect(result.status).toBe('risky')
    expect(result.conflicts[0]?.selectedSource?.label).toBe('最新明确用户指令')
    expect(result.conflicts[0]?.resolution).toBe('resolved')
  })

  it('requires an explicit global source rule for conflict simulations', () => {
    const workflow = createCurrentStandardWorkflow()
    workflow.rules.sourcePriority = [{
      id: 'field-only-source-rule',
      scope: 'field',
      targetId: workflow.documents[0].sections[0].fields[0].id,
      orderedSources: [{ sourceType: 'memory-history', label: 'MEMORY.html', documentId: 'memory', priority: 1, recencyPolicy: 'manual' }],
      tieBreaker: 'manual-review',
      reason: '仅适用于一个字段。',
    }]

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'recovery-global-source-priority-present', severity: 'error' }),
    ]))
    expect(simulateRecovery(workflow, 'goal-conflict')).toMatchObject({
      status: 'blocked',
      blockers: expect.arrayContaining([expect.stringContaining('全局来源优先级')]),
    })
  })

  it('reads a document-backed winning source before resolving a goal conflict', () => {
    const workflow = createCurrentStandardWorkflow()
    const sourceRule = workflow.rules.sourcePriority.find((rule) => rule.scope === 'global')
    if (!sourceRule) throw new Error('missing global source-priority fixture')
    const memorySource = sourceRule.orderedSources.find((source) => source.documentId === 'memory')
    if (!memorySource) throw new Error('missing memory source fixture')
    sourceRule.orderedSources = [memorySource, ...sourceRule.orderedSources.filter((source) => source !== memorySource)]

    const result = simulateRecovery(workflow, 'goal-conflict')

    expect(result.conflicts[0]).toMatchObject({
      resolution: 'resolved',
      selectedSource: { documentId: 'memory' },
    })
    expect(result.readDocuments).toContain('MEMORY.html')
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: '为裁决冲突读取 MEMORY.html', outcome: 'read' }),
    ]))
  })

  it('generates static HTML and Markdown documents with visible guidance', () => {
    const workflow = createCurrentStandardWorkflow()
    const html = exportHtmlDocuments(workflow)
    const markdown = exportMarkdownDocuments(workflow)

    expect(html['SPEC.html']).toContain('data-guidance="true"')
    expect(html['SPEC.html']).toContain('<span class="semantic-unit">项目使命</span>')
    expect(html['SPEC.html']).toContain('--muted:#64625C')
    expect(html['SPEC.html']).not.toContain('<script')
    expect(html['SPEC.html']).not.toContain('https://')
    expect(html['AGENTS.md']).toMatch(/^# /)
    expect(html['AGENTS.md']).not.toContain('<!doctype html>')
    expect(markdown['SPEC.md']).toContain('### 项目使命')
    expect(markdown['SPEC.md']).toContain('说明：')
  })

  it('keeps AGENTS.md alongside HTML content documents in HTML maintenance packages', async () => {
    const pkg = await createWorkflowZip(createCurrentStandardWorkflow())
    const primaryFiles = Object.keys(pkg.files).filter((filename) => filename.startsWith('documents/')).sort()

    expect(primaryFiles).toEqual([
      'documents/AGENTS.md',
      'documents/CONTEXT.html',
      'documents/MEMORY.html',
      'documents/SPEC.html',
      'documents/STATUS.html',
      'documents/USER.html',
    ])
    expect(pkg.files['documents/AGENTS.md']).toContain('AGENTS.md -> STATUS.html -> SPEC.html')
    expect(pkg.files['documents/SPEC.html']).toContain('<!doctype html>')
    expect(pkg.files['documents/AGENTS.html']).toBeUndefined()
  })

  it('exports every Markdown document as .md and rewrites document references', () => {
    const markdown = exportMarkdownDocuments(createCurrentStandardWorkflow())

    expect(Object.keys(markdown).sort()).toEqual([
      'AGENTS.md',
      'CONTEXT.md',
      'MEMORY.md',
      'SPEC.md',
      'STATUS.md',
      'USER.md',
    ])
    expect(markdown['AGENTS.md']).toContain('AGENTS.md -> STATUS.md -> SPEC.md')
    expect(markdown['AGENTS.md']).not.toMatch(/(?:SPEC|STATUS|USER|MEMORY|CONTEXT)\.html/)
  })

  it('forces the protocol export name and rewrites references in all rendered prose', () => {
    const workflow = createCurrentStandardWorkflow()
    const protocol = workflow.documents.find((document) => document.role === 'protocol')
    const plan = workflow.documents.find((document) => document.role === 'plan')
    if (!protocol || !plan) throw new Error('missing export projection fixture')
    protocol.filename = 'ENTRY.html'
    plan.description = '先参见 STATUS.html。'
    plan.sections[0].purpose = '本章依赖 STATUS.html。'
    plan.sections[0].fields[0].guidance = '内容应与 STATUS.html 一致。'

    const markdown = exportMarkdownDocuments(workflow)
    const readme = exportReadme(workflow, 'markdown')

    expect(markdown['AGENTS.md']).toBeTruthy()
    expect(markdown['ENTRY.md']).toBeUndefined()
    expect(markdown['SPEC.md']).toContain('STATUS.md')
    expect(markdown['SPEC.md']).not.toContain('STATUS.html')
    expect(readme).toContain('STATUS.md')
    expect(readme).not.toContain('STATUS.html')
  })

  it('round-trips workflow.json and exported ZIP packages', async () => {
    const workflow = createCurrentStandardWorkflow()
    const parsed = await parseWorkflowJson(JSON.stringify(workflow))
    const pkg = await createWorkflowZip(workflow)
    const file = new File([pkg.blob], 'workflow.zip', { type: 'application/zip' })
    const imported = await parseImportedWorkflow(file)

    expect(parsed.schemaVersion).toBe(workflow.schemaVersion)
    expect(pkg.files['workflow.json']).toBeTruthy()
    expect(pkg.files['README.md']).toContain('文件清单')
    expect(exportReadme(workflow)).toContain('推荐读取顺序')
    expect(imported.documents.map((document) => document.filename)).toContain('STATUS.html')
  })

  it('normalizes global source priorities during import and export', async () => {
    const workflow = createCurrentStandardWorkflow()
    const globalRule = workflow.rules.sourcePriority.find((rule) => rule.scope === 'global')
    if (!globalRule) throw new Error('missing global source-priority fixture')
    globalRule.orderedSources.forEach((source, index) => {
      source.priority = 100 - index * 3
    })

    const imported = await parseWorkflowJson(JSON.stringify(workflow))
    const importedRule = imported.rules.sourcePriority.find((rule) => rule.scope === 'global')
    const exported = JSON.parse(serializeWorkflowJson(workflow)) as WorkflowSchema
    const exportedRule = exported.rules.sourcePriority.find((rule) => rule.scope === 'global')

    expect(importedRule?.orderedSources.map((source) => source.priority)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(exportedRule?.orderedSources.map((source) => source.priority)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('rejects duplicate IDs in every imported rule collection', async () => {
    const cases: Array<{ name: string; duplicate: (workflow: WorkflowSchema) => void }> = [
      {
        name: 'recoveryOrder',
        duplicate: (workflow) => {
          workflow.rules.recoveryOrder[1].id = workflow.rules.recoveryOrder[0].id
        },
      },
      {
        name: 'sourcePriority',
        duplicate: (workflow) => {
          const rule = workflow.rules.sourcePriority[0]
          workflow.rules.sourcePriority.push({ ...rule, orderedSources: rule.orderedSources.map((source) => ({ ...source })) })
        },
      },
      {
        name: 'updateTriggers',
        duplicate: (workflow) => {
          workflow.rules.updateTriggers[1].id = workflow.rules.updateTriggers[0].id
        },
      },
      {
        name: 'completionChecks',
        duplicate: (workflow) => {
          workflow.rules.completionChecks[1].id = workflow.rules.completionChecks[0].id
        },
      },
    ]

    for (const testCase of cases) {
      const workflow = createCurrentStandardWorkflow()
      testCase.duplicate(workflow)
      await expect(
        parseWorkflowJson(JSON.stringify(workflow)),
        `${testCase.name} should reject duplicate rule IDs`,
      ).rejects.toThrow(/导入校验失败：ID 重复/)
    }
  })

  it('rejects table rows with undeclared keys or non-string cells', async () => {
    const workflow = createCurrentStandardWorkflow()
    const field = workflow.documents[1].sections[0].fields[0]
    field.value = { kind: 'table', columns: ['name'], rows: [{ name: 7 }] } as never
    await expect(parseWorkflowJson(JSON.stringify(workflow))).rejects.toThrow(/单元格必须是字符串/)

    field.value = { kind: 'table', columns: ['name'], rows: [{ extra: 'value' }] }
    await expect(parseWorkflowJson(JSON.stringify(workflow))).rejects.toThrow(/键必须来自 columns/)
  })

  it('applies packageNamePattern when naming ZIP exports', () => {
    const workflow = createCurrentStandardWorkflow()
    workflow.name = '客户支持 / Alpha'
    workflow.exportSettings = { ...workflow.exportSettings, packageNamePattern: '归档-{name}-2026.zip' }

    expect(packageName(workflow)).toBe('归档-客户支持-Alpha-2026.zip')
  })

  it('blocks unsafe document filenames before ZIP export', async () => {
    const workflow = createCurrentStandardWorkflow()
    workflow.documents[1].filename = '../SPEC.html'

    expect(validateWorkflow(workflow).some((issue) => issue.ruleId === 'export-safe-filename' && issue.severity === 'error')).toBe(true)
    await expect(createWorkflowZip(workflow)).rejects.toThrow(/导出被阻止/)
  })

  it('blocks filenames that collide only after export projection', async () => {
    const workflow = createCurrentStandardWorkflow()
    const preference = workflow.documents.find((document) => document.id === 'user')
    if (!preference) throw new Error('missing preference document fixture')
    preference.filename = 'SPEC.md'

    const collisionRules = validateWorkflow(workflow)
      .filter((issue) => issue.severity === 'error' && issue.ruleId.includes('filename-collision'))
      .map((issue) => issue.ruleId)

    expect(collisionRules).toEqual(expect.arrayContaining([
      'export-html-filename-collision',
      'export-markdown-filename-collision',
    ]))
    await expect(createWorkflowZip(workflow)).rejects.toThrow(/导出文件名冲突/)
  })

  it('warns when realtime status is intentionally omitted and blocks an empty configured next step', async () => {
    const noStatus = createModularWorkflow({
      name: '静态流程',
      description: '不跟踪运行状态。',
      selectedDocumentIds: ['spec', 'memory'],
      firstAction: '读取入口协议。',
      recoveryRisk: '无持续状态。',
    })
    expect(validateWorkflow(noStatus).some((issue) => issue.ruleId === 'recovery-realtime-status' && issue.severity === 'warning')).toBe(true)
    await expect(createWorkflowZip(noStatus)).resolves.toBeTruthy()

    const noNextStep = createCurrentStandardWorkflow()
    const nextStepField = noNextStep.documents.flatMap((document) => document.sections).flatMap((section) => section.fields).find((field) => field.id === 'next-atomic-step')
    if (!nextStepField) throw new Error('missing test fixture')
    nextStepField.value = { kind: 'empty' }
    expect(validateWorkflow(noNextStep).some((issue) => issue.ruleId === 'recovery-next-atomic-step-value' && issue.severity === 'error')).toBe(true)
  })

  it('generates role-specific maintenance guidance for modular workflows', () => {
    const workflow = createModularWorkflow({
      name: '维护规则测试',
      description: '验证生成的长期说明。',
      selectedDocumentIds: ['spec', 'status', 'memory'],
      firstAction: '读取 STATUS.html 后执行下一原子步骤。',
      recoveryRisk: '状态与历史混淆。',
    })
    const memory = workflow.documents.find((document) => document.role === 'history')
    const protocol = workflow.documents.find((document) => document.role === 'protocol')
    const memoryGuidance = memory?.sections.flatMap((section) => section.fields).map((field) => field.guidance).join('\n') ?? ''
    const updateRules = protocol?.sections
      .flatMap((section) => section.fields)
      .find((field) => field.id === 'protocol-update-rules-field')

    expect(memoryGuidance).toContain('仍有效参考')
    expect(memoryGuidance).toContain('已失效归档')
    expect(fieldValueToText(updateRules?.value ?? { kind: 'empty' })).toMatch(/AGENTS\.md：[\s\S]*STATUS\.html：当前目标、已验证事实、阻塞、下一原子步骤或恢复指针变化时/)
    expect(workflow.rules.updateTriggers).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetDocumentId: 'agents', trigger: expect.stringContaining('来源优先级') }),
      expect.objectContaining({ targetDocumentId: 'content-status', trigger: expect.stringContaining('下一原子步骤') }),
      expect.objectContaining({ targetDocumentId: 'content-memory', requiredAction: expect.stringContaining('追加或归档') }),
    ]))
    expect(validateWorkflow(workflow).filter((issue) => issue.ruleId === 'maintenance-update-trigger-coverage')).toHaveLength(0)
  })

  it('requires the protocol document to be first in recovery order', () => {
    const workflow = createCurrentStandardWorkflow()
    const protocolStep = workflow.rules.recoveryOrder.shift()
    if (!protocolStep) throw new Error('missing protocol recovery step fixture')
    workflow.rules.recoveryOrder.push(protocolStep)

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'recovery-protocol-first', severity: 'error' }),
    ]))
    expect(simulateRecovery(workflow, 'new-session').status).toBe('blocked')
  })

  it.each([
    ['STATUS.html', 'status', 'remove'],
    ['STATUS.html', 'status', 'optional'],
    ['SPEC.html', 'spec', 'remove'],
    ['SPEC.html', 'spec', 'optional'],
  ] as const)('blocks ZIP export when %s (%s) is %s in recovery order', async (_filename, documentId, mode) => {
    const workflow = createCurrentStandardWorkflow()
    if (mode === 'remove') {
      workflow.rules.recoveryOrder = workflow.rules.recoveryOrder.filter((step) => step.documentId !== documentId)
    } else {
      const step = workflow.rules.recoveryOrder.find((candidate) => candidate.documentId === documentId)
      if (!step) throw new Error('missing required recovery step fixture')
      step.required = false
    }

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'recovery-required-document-order',
        severity: 'error',
        target: expect.objectContaining({ documentId }),
      }),
    ]))
    await expect(createWorkflowZip(workflow)).rejects.toThrow(/导出被阻止：必读文档未进入恢复路径/)
  })

  it('marks recovery as risky when the optional status entry is missing', () => {
    const workflow = createCurrentStandardWorkflow()
    workflow.documents = workflow.documents.filter((document) => document.id !== 'status')
    workflow.rules.recoveryOrder = workflow.rules.recoveryOrder.filter((step) => step.documentId !== 'status')

    const result = simulateRecovery(workflow, 'new-session')

    expect(result.status).toBe('risky')
    expect(result.nextAtomicStep).toBeUndefined()
  })

  it('does not accept a protocol or history field as the next atomic step', () => {
    const workflow = createCurrentStandardWorkflow()
    const statusStep = workflow.documents.find((document) => document.role === 'status')
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.id === 'next-atomic-step')
    const historyField = workflow.documents.find((document) => document.role === 'history')
      ?.sections.flatMap((section) => section.fields)[0]
    if (!statusStep || !historyField) throw new Error('missing recovery semantic fixture')
    statusStep.value = { kind: 'empty' }
    historyField.id = 'memory-next-atomic-step'
    historyField.label = '下一原子步骤'
    historyField.lifecycle = 'realtime'
    historyField.value = scalarValue('继续执行已经过期的历史动作。')

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'recovery-next-atomic-step-value', severity: 'error' }),
    ]))
    expect(simulateRecovery(workflow, 'new-session').nextAtomicStep).toBeUndefined()
  })

  it('blocks deletion of core modules from the managed AGENTS protocol', () => {
    const workflow = createCurrentStandardWorkflow()
    const protocol = workflow.documents.find((document) => document.role === 'protocol')
    if (!protocol) throw new Error('missing protocol fixture')
    protocol.sections = protocol.sections.filter((section) => section.id !== 'source-priority')

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'structure-protocol-core-modules', severity: 'error' }),
    ]))
  })

  it('applies field-level validation rules', () => {
    const workflow = createCurrentStandardWorkflow()
    const field = workflow.documents[0].sections[0].fields[0]
    field.value = scalarValue('短')
    field.validation.minLength = 10

    expect(validateWorkflow(workflow).some((issue) => issue.ruleId === 'field-validation-min-length' && issue.severity === 'error')).toBe(true)

    field.validation.minLength = undefined
    field.validation.maxLength = 2
    field.value = scalarValue('过长内容')
    expect(validateWorkflow(workflow).some((issue) => issue.ruleId === 'field-validation-max-length' && issue.severity === 'error')).toBe(true)

    field.validation.maxLength = undefined
    field.validation.pattern = '^AGENTS'
    field.value = scalarValue('STATUS.html')
    expect(validateWorkflow(workflow).some((issue) => issue.ruleId === 'field-validation-pattern' && issue.severity === 'error')).toBe(true)

    field.validation.pattern = undefined
    field.validation.allowedValues = ['AGENTS.md']
    field.value = scalarValue('STATUS.html')
    expect(validateWorkflow(workflow).some((issue) => issue.ruleId === 'field-validation-allowed-values' && issue.severity === 'error')).toBe(true)

    field.validation.allowedValues = undefined
    field.validation.customRules = [{ id: 'email', description: '必须是邮箱', severity: 'error', predicate: 'valid-email' }]
    field.value = scalarValue('not-email')
    expect(validateWorkflow(workflow).some((issue) => issue.ruleId === 'field-validation-custom-email' && issue.severity === 'error')).toBe(true)
  })

  it('invalidates accepted warnings when the target structure changes', () => {
    const workflow = createCurrentStandardWorkflow()
    const rule = workflow.rules.sourcePriority[0]
    rule.orderedSources[0].sourceType = 'workspace-fact'
    const warning = validateWorkflow(workflow).find((issue) => issue.ruleId === 'recovery-source-priority-user-first')
    if (!warning) throw new Error('missing warning fixture')
    workflow.acceptedWarnings.push({
      issueId: warning.id,
      ruleId: warning.ruleId,
      target: warning.target,
      acceptedAt: new Date().toISOString(),
      schemaHash: warningSchemaHash(workflow, warning.target),
      reason: 'test',
    })
    expect(validateWorkflow(workflow).find((issue) => issue.id === warning.id)?.accepted).toBe(true)
    rule.reason = 'changed'
    expect(validateWorkflow(workflow).find((issue) => issue.id === warning.id)?.accepted).toBe(false)
  })

  it('ignores accepted warnings whose saved target no longer resolves to the active issue', () => {
    const workflow = createCurrentStandardWorkflow()
    const rule = workflow.rules.sourcePriority[0]
    rule.orderedSources[0].sourceType = 'workspace-fact'
    const warning = validateWorkflow(workflow).find((issue) => issue.ruleId === 'recovery-source-priority-user-first')
    if (!warning) throw new Error('missing warning fixture')
    workflow.acceptedWarnings.push({
      issueId: warning.id,
      ruleId: warning.ruleId,
      target: { documentId: 'missing-document' },
      acceptedAt: new Date().toISOString(),
      schemaHash: warningSchemaHash(workflow, warning.target),
      reason: 'test',
    })

    expect(validateWorkflow(workflow).find((issue) => issue.id === warning.id)?.accepted).toBe(false)
  })

  it('rejects malformed schemas and oversized JSON imports', async () => {
    await expect(parseWorkflowJson(JSON.stringify({ schemaVersion: SCHEMA_VERSION, name: 'bad' }))).rejects.toThrow(/workflowId|documents/)
    await expect(parseWorkflowJson(`{"schemaVersion":"${SCHEMA_VERSION}","payload":"${'x'.repeat(5 * 1024 * 1024)}"}`)).rejects.toThrow(/超过 5MB/)
    const lowVersion = createCurrentStandardWorkflow()
    lowVersion.schemaVersion = '0.9.0'
    await expect(parseWorkflowJson(JSON.stringify(lowVersion))).resolves.toMatchObject({ schemaVersion: SCHEMA_VERSION })
    await expect(parseWorkflowJson(JSON.stringify({ ...lowVersion, schemaVersion: '0.8.0' }))).rejects.toThrow(/迁移失败/)
    await expect(parseWorkflowJson(JSON.stringify({ ...lowVersion, schemaVersion: '9.0.0' }))).resolves.toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      sourceSchemaVersion: '9.0.0',
      readOnlyReason: expect.stringContaining('只读'),
    })
    const invalidNested = createCurrentStandardWorkflow()
    invalidNested.documents[0].sections[0].fields[0].type = 'invalid' as never
    await expect(parseWorkflowJson(JSON.stringify(invalidNested))).rejects.toThrow(/field.type/)
  })

  it('rejects malformed field options during import', async () => {
    const workflow = createCurrentStandardWorkflow()
    workflow.documents[0].sections[0].fields[0].options = [{ value: 'invalid' }] as never

    await expect(parseWorkflowJson(JSON.stringify(workflow))).rejects.toThrow(/field\.option\.label/)
  })

  it('prevents higher-version read-only placeholders from being downgraded through export', async () => {
    const readOnly = await parseWorkflowJson(JSON.stringify({
      schemaVersion: '99.0.0',
      name: '未来版本工作流',
      description: '包含当前版本无法理解的数据。',
      futureSentinel: { preserve: true },
    }))

    expect(readOnly.readOnlyReason).toContain('只读')
    expect(() => serializeWorkflowJson(readOnly)).toThrow(/不能降级导出/)
    await expect(createWorkflowZip(readOnly)).rejects.toThrow(/不能降级导出/)
  })

  it('blocks managed protocols that do not mention the current exported document filename', async () => {
    const workflow = createCurrentStandardWorkflow()
    const status = workflow.documents.find((document) => document.role === 'status')
    if (!status) throw new Error('missing status fixture')
    status.filename = 'NOW.html'

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'recovery-protocol-filename-coverage', severity: 'error' }),
    ]))
    await expect(createWorkflowZip(workflow)).rejects.toThrow(/入口协议缺少实际文件引用/)
    await expect(parseWorkflowJson(JSON.stringify(workflow))).rejects.toThrow(/入口协议缺少实际文件引用/)
  })

  it.each([
    ['missing-preference', 'preference'],
    ['unclear-term', 'context'],
    ['insufficient-history', 'history'],
  ] as const)('blocks %s simulation when its document is absent from the recovery path', (scenario, role) => {
    const workflow = createCurrentStandardWorkflow()
    const document = workflow.documents.find((candidate) => candidate.role === role)
    if (!document) throw new Error(`missing ${role} fixture`)
    workflow.rules.recoveryOrder = workflow.rules.recoveryOrder.filter((step) => step.documentId !== document.id)

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'recovery-document-coverage', severity: 'error' }),
    ]))
    expect(simulateRecovery(workflow, scenario)).toMatchObject({
      status: 'blocked',
      readDocuments: expect.not.arrayContaining([document.filename]),
      blockers: expect.arrayContaining([expect.stringContaining(document.filename)]),
    })
  })

  it('uses the global source-priority rule for stale-status simulation', () => {
    const workflow = createCurrentStandardWorkflow()
    workflow.rules.sourcePriority.unshift({
      id: 'field-only-source-rule',
      scope: 'field',
      targetId: workflow.documents[0].sections[0].fields[0].id,
      orderedSources: [],
      tieBreaker: 'manual-review',
      reason: '只适用于单个字段。',
    })
    const globalRule = workflow.rules.sourcePriority.find((rule) => rule.scope === 'global')
    const memorySource = globalRule?.orderedSources.find((source) => source.documentId === 'memory')
    if (!globalRule || !memorySource) throw new Error('missing global source-priority fixture')
    globalRule.orderedSources = [memorySource, ...globalRule.orderedSources.filter((source) => source !== memorySource)]

    const result = simulateRecovery(workflow, 'stale-status')
    expect(result.conflicts.find((conflict) => conflict.id === 'stale-status-source-priority')).toMatchObject({
      resolution: 'resolved',
      selectedSource: { documentId: 'memory' },
    })
    expect(result.readDocuments).toContain('MEMORY.html')
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: '读取 STATUS.html，仅用于识别过期状态' }),
      expect.objectContaining({ action: '忽略 STATUS.html 的过期状态，按来源优先级选择 MEMORY.html' }),
    ]))
  })

  it('edits the global source rule even when a field rule appears first', async () => {
    await useWorkflowStore.getState().createPresetProject()
    const workflow = useWorkflowStore.getState().workflow
    const globalRule = workflow.rules.sourcePriority.find((rule) => rule.scope === 'global')
    if (!globalRule) throw new Error('missing global source-priority fixture')
    useWorkflowStore.setState({
      workflow: {
        ...workflow,
        rules: {
          ...workflow.rules,
          sourcePriority: [{
            id: 'field-first-source-rule',
            scope: 'field',
            targetId: workflow.documents[0].sections[0].fields[0].id,
            orderedSources: [],
            tieBreaker: 'manual-review',
            reason: '字段规则不应被全局编辑器修改。',
          }, ...workflow.rules.sourcePriority],
        },
      },
    })

    useWorkflowStore.getState().updateSourcePriorityReason('更新全局来源裁决说明。')
    const updated = useWorkflowStore.getState().workflow

    expect(updated.rules.sourcePriority.find((rule) => rule.scope === 'global')?.reason).toBe('更新全局来源裁决说明。')
    expect(updated.rules.sourcePriority.find((rule) => rule.scope === 'field')?.reason).toBe('字段规则不应被全局编辑器修改。')
  })

  it('rejects empty entity IDs and unsupported custom predicates', () => {
    const workflow = createCurrentStandardWorkflow()
    const field = workflow.documents[0].sections[0].fields[0]
    field.id = '   '
    field.validation.customRules = [{
      id: 'unsupported-condition',
      description: '执行任意自定义判断',
      severity: 'error',
      predicate: 'custom',
    }]

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'structure-nonempty-ids', severity: 'error' }),
      expect.objectContaining({ ruleId: 'field-validation-custom-unsupported-unsupported-condition', severity: 'error' }),
    ]))
  })

  it('rejects duplicate custom validation rule IDs', async () => {
    const workflow = createCurrentStandardWorkflow()
    const field = workflow.documents[0].sections[0].fields[0]
    field.validation.customRules = [
      { id: 'duplicate-custom-rule', description: '第一条规则', severity: 'error', predicate: 'valid-email' },
      { id: 'duplicate-custom-rule', description: '第二条规则', severity: 'warning', predicate: 'valid-url' },
    ]

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'structure-unique-ids', severity: 'error' }),
    ]))
    await expect(parseWorkflowJson(JSON.stringify(workflow))).rejects.toThrow(/ID 重复/)
  })

  it('rejects history statuses outside the schema enum', async () => {
    const workflow = createCurrentStandardWorkflow()
    workflow.rules.historyPolicy.allowedStatuses = ['not-a-schema-status'] as never

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'maintenance-history-status-values', severity: 'error' }),
    ]))
    await expect(parseWorkflowJson(JSON.stringify(workflow))).rejects.toThrow(/historyPolicy\.allowedStatuses/)
  })

  it('bounds direct JSON file imports before reading oversized files and honors cancellation', async () => {
    const tooLargeJson = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'workflow.json', { type: 'application/json' })
    await expect(parseImportedWorkflow(tooLargeJson)).rejects.toThrow(/超过 5MB/)

    const controller = new AbortController()
    controller.abort()
    await expect(parseImportedWorkflow(new File([JSON.stringify(createCurrentStandardWorkflow())], 'workflow.json'), { signal: controller.signal })).rejects.toThrow(/已取消/)
  })

  it('rejects unsafe ZIP import paths and duplicate workflow entries', async () => {
    const workflowJson = JSON.stringify(createCurrentStandardWorkflow())
    await expect(parseImportedWorkflow(await zipFile({ '..\\workflow.json': workflowJson }))).rejects.toThrow(/非法路径/)
    await expect(parseImportedWorkflow(await zipFile({ '/workflow.json': workflowJson }))).rejects.toThrow(/非法路径/)
    await expect(parseImportedWorkflow(await zipFile({ '\\\\server\\workflow.json': workflowJson }))).rejects.toThrow(/非法路径/)
    await expect(parseImportedWorkflow(await zipFile({ 'C:/workflow.json': workflowJson }))).rejects.toThrow(/非法路径/)
    await expect(parseImportedWorkflow(await zipFile({ 'workflow.json': workflowJson, 'nested/workflow.json': workflowJson }))).rejects.toThrow(/必须且只能包含一个/)
    await expect(parseImportedWorkflow(await zipFile({ '__MACOSX/workflow.json': workflowJson }))).rejects.toThrow(/非法路径/)
  })

  it('rejects ZIP packages with too many entries', async () => {
    const entries: Record<string, string> = { 'workflow.json': JSON.stringify(createCurrentStandardWorkflow()) }
    for (let index = 0; index < 201; index += 1) {
      entries[`documents/file-${index}.txt`] = 'x'
    }
    await expect(parseImportedWorkflow(await zipFile(entries))).rejects.toThrow(/条目数超过 200/)
  })

  it('rejects oversized, expanded, and aborted ZIP imports', async () => {
    const tooLargeZip = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'workflow.zip', { type: 'application/zip' })
    await expect(parseImportedWorkflow(tooLargeZip)).rejects.toThrow(/超过 10MB/)

    const workflowJson = JSON.stringify(createCurrentStandardWorkflow())
    await expect(parseImportedWorkflow(await zipFile({ 'workflow.json': workflowJson, 'documents/big.txt': 'x'.repeat(26 * 1024 * 1024) }))).rejects.toThrow(/超过 25MB/)

    const controller = new AbortController()
    controller.abort()
    await expect(parseImportedWorkflow(await zipFile({ 'workflow.json': workflowJson }), { signal: controller.signal })).rejects.toThrow(/已取消/)
  })
})
