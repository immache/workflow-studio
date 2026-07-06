import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createCurrentStandardWorkflow, createBlankWorkflow } from '../../data/presets/current-standard-workflow'
import { exportHtmlDocuments } from '../../domain/export-html'
import { exportMarkdownDocuments, exportReadme } from '../../domain/export-markdown'
import { createWorkflowZip } from '../../domain/export-zip'
import { parseImportedWorkflow, parseWorkflowJson } from '../../domain/import-export'
import { scoreWorkflow } from '../../domain/scoring'
import { scalarValue, SCHEMA_VERSION } from '../../domain/schema'
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

    expect(issues.some((issue) => issue.severity === 'error')).toBe(true)
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
        'documents/AGENTS.html': expect.any(String),
        'documents/STATUS.html': expect.any(String),
      }),
    })
  })

  it('keeps empty repeatable fields as list values in the editable store', async () => {
    await useWorkflowStore.getState().createBlankProject()
    const workflow = useWorkflowStore.getState().workflow
    const field = workflow.documents[0].sections[0].fields[0]

    useWorkflowStore.getState().updateField(workflow.documents[0].id, workflow.documents[0].sections[0].id, field.id, { repeatable: true })

    const updatedField = useWorkflowStore.getState().workflow.documents[0].sections[0].fields[0]
    expect(updatedField.repeatable).toBe(true)
    expect(updatedField.value.kind).toBe('list')
    if (updatedField.value.kind === 'list') {
      expect(updatedField.value.value).toHaveLength(0)
    }
  })

  it('simulates a new session recovery path', () => {
    const workflow = createCurrentStandardWorkflow()
    const result = simulateRecovery(workflow, 'new-session')

    expect(result.status).toBe('pass')
    expect(result.readDocuments).toContain('AGENTS.md')
    expect(result.nextAtomicStep).toMatch(/下一原子步骤/)
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
    expect(markdown['SPEC.md']).toContain('字段 ID')
    expect(markdown['SPEC.md']).toContain('说明：')
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

  it('blocks unsafe document filenames before ZIP export', async () => {
    const workflow = createCurrentStandardWorkflow()
    workflow.documents[1].filename = '../SPEC.html'

    expect(validateWorkflow(workflow).some((issue) => issue.ruleId === 'export-safe-filename' && issue.severity === 'error')).toBe(true)
    await expect(createWorkflowZip(workflow)).rejects.toThrow(/导出被阻止/)
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
