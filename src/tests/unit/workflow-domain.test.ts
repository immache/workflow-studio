import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createCurrentStandardWorkflow, createBlankWorkflow } from '../../data/presets/current-standard-workflow'
import { exportHtmlDocuments } from '../../domain/export-html'
import { exportMarkdownDocuments, exportReadme } from '../../domain/export-markdown'
import { createWorkflowZip, packageName } from '../../domain/export-zip'
import { parseImportedWorkflow, parseWorkflowJson } from '../../domain/import-export'
import { scoreWorkflow } from '../../domain/scoring'
import { fieldValueToText, scalarValue, SCHEMA_VERSION } from '../../domain/schema'
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

  it('cleans structured and field-value references when the store removes a document', async () => {
    await useWorkflowStore.getState().createPresetProject()
    const before = useWorkflowStore.getState().workflow
    const removed = before.documents.find((document) => document.id === 'spec')
    if (!removed) throw new Error('missing plan document fixture')
    expect(before.rules.recoveryOrder.some((step) => step.documentId === removed.id)).toBe(true)
    expect(before.documents.flatMap((document) => document.sections).flatMap((section) => section.fields).some((field) => fieldValueToText(field.value).includes(removed.filename))).toBe(true)

    useWorkflowStore.getState().removeDocument(removed.id)
    const workflow = useWorkflowStore.getState().workflow

    expect(workflow.documents.some((document) => document.id === removed.id)).toBe(false)
    expect(workflow.rules.recoveryOrder.some((step) => step.documentId === removed.id)).toBe(false)
    expect(workflow.rules.sourcePriority.some((rule) => rule.targetId === removed.id || rule.orderedSources.some((source) => source.documentId === removed.id))).toBe(false)
    expect(workflow.rules.updateTriggers.some((trigger) => trigger.targetDocumentId === removed.id)).toBe(false)
    expect(workflow.rules.completionChecks.some((check) => check.relatedDocumentIds.includes(removed.id))).toBe(false)
    expect(workflow.documents.some((document) => document.readPolicy.dependsOnDocumentIds.includes(removed.id))).toBe(false)
    expect(workflow.documents.flatMap((document) => document.sections).flatMap((section) => section.fields).some((field) => fieldValueToText(field.value).includes(removed.filename))).toBe(false)
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

  it('reports source conflicts with selected source details', () => {
    const result = simulateRecovery(createCurrentStandardWorkflow(), 'goal-conflict')

    expect(result.status).toBe('risky')
    expect(result.conflicts[0]?.selectedSource?.label).toBe('最新明确用户指令')
    expect(result.conflicts[0]?.resolution).toBe('resolved')
  })

  it('generates static HTML and Markdown documents with visible guidance', () => {
    const workflow = createCurrentStandardWorkflow()
    const html = exportHtmlDocuments(workflow)
    const markdown = exportMarkdownDocuments(workflow)

    expect(html['SPEC.html']).toContain('data-guidance="true"')
    expect(html['SPEC.html']).not.toContain('<script')
    expect(html['SPEC.html']).not.toContain('https://')
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
    expect(pkg.files['documents/AGENTS.md']).toContain('AGENTS.md -> SPEC.html -> STATUS.html')
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
    expect(markdown['AGENTS.md']).toContain('AGENTS.md -> SPEC.md -> STATUS.md')
    expect(markdown['AGENTS.md']).not.toMatch(/(?:SPEC|STATUS|USER|MEMORY|CONTEXT)\.html/)
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

  it('blocks missing realtime status and missing next atomic step', async () => {
    const noStatus = createCurrentStandardWorkflow()
    noStatus.documents = noStatus.documents.filter((document) => document.id !== 'status')
    noStatus.rules.recoveryOrder = noStatus.rules.recoveryOrder.filter((step) => step.documentId !== 'status')
    expect(validateWorkflow(noStatus).some((issue) => issue.ruleId === 'recovery-realtime-status' && issue.severity === 'error')).toBe(true)
    await expect(createWorkflowZip(noStatus)).rejects.toThrow(/导出被阻止/)

    const noNextStep = createCurrentStandardWorkflow()
    const nextStepField = noNextStep.documents.flatMap((document) => document.sections).flatMap((section) => section.fields).find((field) => field.id === 'next-atomic-step')
    if (!nextStepField) throw new Error('missing test fixture')
    nextStepField.value = { kind: 'empty' }
    expect(validateWorkflow(noNextStep).some((issue) => issue.ruleId === 'recovery-next-atomic-step-value' && issue.severity === 'error')).toBe(true)
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

  it('blocks recovery simulation when the status entry is missing', () => {
    const workflow = createCurrentStandardWorkflow()
    workflow.documents = workflow.documents.filter((document) => document.id !== 'status')
    workflow.rules.recoveryOrder = workflow.rules.recoveryOrder.filter((step) => step.documentId !== 'status')

    const result = simulateRecovery(workflow, 'new-session')

    expect(result.status).toBe('blocked')
    expect(result.blockers.join('\n')).toMatch(/realtime|下一原子步骤/)
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
