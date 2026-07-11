import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createCurrentStandardWorkflow } from '../../data/presets/current-standard-workflow'
import { createModularWorkflow } from '../../data/modules/standard-workflow-modules'
import { buildProtocolProjection, normalizeWorkflowForRuntime, sha256Hex, toPersistedWorkflow, withRegeneratedSystemProtocol } from '../../domain/protocol-state'
import { exportHtmlDocuments } from '../../domain/export-html'
import { exportMarkdownDocuments } from '../../domain/export-markdown'
import { createWorkflowZip, serializeWorkflowJson } from '../../domain/export-zip'
import { parseImportedWorkflow, parseWorkflowJson } from '../../domain/import-export'
import { validateWorkflow } from '../../domain/validation'
import { simulateRecovery } from '../../domain/simulation'
import { useWorkflowStore } from '../../store/workflow-store'

function legacyV10() {
  const runtime = createCurrentStandardWorkflow()
  const persisted = toPersistedWorkflow(runtime)
  const { mode: _mode, protocolState: _protocolState, ...legacy } = persisted
  return {
    ...legacy,
    schemaVersion: '1.0.0',
    documents: structuredClone(runtime.documents),
    rules: structuredClone(runtime.rules),
  }
}

function copyProtocolWithNewIds(protocol: ReturnType<typeof createCurrentStandardWorkflow>['documents'][number]) {
  return {
    ...structuredClone(protocol),
    id: 'legacy-protocol-copy',
    filename: 'AGENTS-OLD.md',
    sections: protocol.sections.map((section, sectionIndex) => ({
      ...structuredClone(section),
      id: `legacy-protocol-copy-section-${sectionIndex + 1}`,
      fields: section.fields.map((field, fieldIndex) => ({
        ...structuredClone(field),
        id: `legacy-protocol-copy-field-${sectionIndex + 1}-${fieldIndex + 1}`,
      })),
    })),
  }
}

describe('Workflow Studio 1.1 data semantics', () => {
  it('uses SHA-256 for stable protocol source fingerprints', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('creates a template with empty runtime slots and a generated protocol state', () => {
    const workflow = createCurrentStandardWorkflow()
    const persisted = toPersistedWorkflow(workflow)

    expect(workflow.schemaVersion).toBe('1.1.0')
    expect(workflow.mode).toBe('template')
    expect(workflow.documents[0]).toMatchObject({ filename: 'AGENTS.md', role: 'protocol' })
    expect(workflow.documents.filter((document) => document.role !== 'protocol')
      .flatMap((document) => document.sections)
      .flatMap((section) => section.fields)
      .every((field) => field.value.kind === 'empty')).toBe(true)
    expect(workflow.protocolState.system.status).toBe('ready')
    expect(validateWorkflow(workflow).filter((issue) => issue.severity === 'error')).toHaveLength(0)
    expect('rules' in persisted).toBe(false)
    expect(persisted.documents.map((document) => document.filename)).not.toContain('AGENTS.md')
  })

  it('migrates 1.0 packages into legacy-content without losing protocol documents or rules', async () => {
    const imported = await parseWorkflowJson(JSON.stringify(legacyV10()))
    const legacy = imported.protocolState.legacyManualOverride

    expect(imported.schemaVersion).toBe('1.1.0')
    expect(imported.mode).toBe('legacy-content')
    expect(legacy?.documents).toHaveLength(1)
    expect(legacy?.documents[0].role).toBe('protocol')
    expect(legacy?.rules.recoveryOrder.length).toBeGreaterThan(0)
    expect(imported.documents.some((document) => document.role === 'protocol')).toBe(true)
  })

  it('requires an explicit choice when a legacy package contains multiple protocols', async () => {
    const legacy = legacyV10()
    const original = legacy.documents.find((document) => document.role === 'protocol')
    if (!original) throw new Error('legacy fixture has no protocol')
    legacy.documents.push(copyProtocolWithNewIds(original))

    const imported = await parseWorkflowJson(JSON.stringify(legacy))
    expect(imported.protocolProjection?.effective).toBeNull()
    expect(imported.protocolProjection?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy-protocol-selection-required', severity: 'error' }),
    ]))
    await expect(createWorkflowZip(imported)).rejects.toThrow(/需要选择当前入口协议/)
  })

  it('hard-rejects malformed 1.1 shapes instead of silently repairing them', async () => {
    const raw = JSON.parse(serializeWorkflowJson(createCurrentStandardWorkflow()))
    raw.rules = {}
    await expect(parseWorkflowJson(JSON.stringify(raw))).rejects.toThrow(/不接受顶层 rules/)

    const noSystem = JSON.parse(serializeWorkflowJson(createCurrentStandardWorkflow()))
    delete noSystem.protocolState.system
    await expect(parseWorkflowJson(JSON.stringify(noSystem))).rejects.toThrow(/protocolState\.system/)

    const protocolInDocuments = JSON.parse(serializeWorkflowJson(createCurrentStandardWorkflow()))
    protocolInDocuments.documents.push(protocolInDocuments.protocolState.system.bundle.document)
    await expect(parseWorkflowJson(JSON.stringify(protocolInDocuments))).rejects.toThrow(/document\.role/)
  })

  it('opens a higher-version package as a read-only compatibility view', async () => {
    const imported = await parseWorkflowJson(JSON.stringify({
      schemaVersion: '9.0.0',
      name: '未来版本工作流',
      description: '当前版本不应尝试降级写回。',
    }))

    expect(imported.readOnlyReason).toMatch(/高于当前应用/)
    expect(imported.sourceSchemaVersion).toBe('9.0.0')
    expect(imported.documents.find((document) => document.role === 'validation')?.title).toBe('只读导入说明')
    await expect(createWorkflowZip(imported)).rejects.toThrow(/只能查看/)
  })

  it('marks generated protocols stale when template structure changes and refreshes them explicitly', () => {
    const workflow = createModularWorkflow({
      name: '过期检查',
      description: '验证入口协议不会静默滞后。',
      selectedDocumentIds: ['status'],
      firstAction: '继续设计模板。',
      recoveryRisk: '文档结构改变后协议仍引用旧结构。',
    })
    const status = workflow.documents.find((document) => document.role === 'status')
    if (!status) throw new Error('missing status fixture')
    status.description = '已修改的职责说明。'

    expect(buildProtocolProjection(workflow)).toMatchObject({ freshness: 'stale', effective: null })
    const refreshed = withRegeneratedSystemProtocol(workflow)
    expect(buildProtocolProjection(refreshed)).toMatchObject({ freshness: 'current' })
  })

  it('keeps source priority normalization runtime-only during JSON serialization', async () => {
    const raw = JSON.parse(serializeWorkflowJson(createCurrentStandardWorkflow()))
    raw.protocolState.system.bundle.rules.sourcePriority[0].orderedSources[0].priority = 77
    raw.protocolState.system.bundle.rules.sourcePriority[0].orderedSources[1].priority = 12

    const imported = await parseWorkflowJson(JSON.stringify(raw))
    expect(imported.rules.sourcePriority[0].orderedSources.map((source) => source.priority)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const exported = JSON.parse(serializeWorkflowJson(imported))
    expect(exported.protocolState.system.bundle.rules.sourcePriority[0].orderedSources.slice(0, 2).map((source: { priority: number }) => source.priority)).toEqual([77, 12])
  })

  it('exports template slots without fake current content while preserving machine-readable empties', async () => {
    const workflow = createModularWorkflow({
      name: '空模板导出',
      description: '验证模板不伪造运行事实。',
      selectedDocumentIds: ['status'],
      firstAction: '不用填写运行内容。',
      recoveryRisk: '空值被错误当作实例内容。',
    })
    const html = exportHtmlDocuments(workflow)
    const markdown = exportMarkdownDocuments(workflow)
    const zip = await createWorkflowZip(workflow)

    expect(html['STATUS.html']).toContain('data-empty="true"')
    expect(html['STATUS.html']).not.toContain('未填写')
    expect(markdown['STATUS.md']).toContain('<!-- workflow-value: empty -->')
    expect(JSON.parse(zip.files['workflow.json']).rules).toBeUndefined()
    expect(zip.files['documents/STATUS.html']).not.toContain('未填写')
  })

  it('exports the generated AGENTS.md as five compact rule sections', async () => {
    const workflow = createModularWorkflow({
      name: '精简协议测试',
      description: '验证系统入口协议只保留工作时需要的规则。',
      selectedDocumentIds: ['status'],
      firstAction: '继续检查结果预览。',
      recoveryRisk: '入口协议混入搭建阶段说明。',
    })
    const htmlAgents = exportHtmlDocuments(workflow)['AGENTS.md']
    const markdownAgents = exportMarkdownDocuments(workflow)['AGENTS.md']
    const zip = await createWorkflowZip(workflow)

    expect(htmlAgents.match(/^## .+$/gm)).toEqual([
      '## 文档职责',
      '## 读取顺序',
      '## 来源优先级',
      '## 更新规则',
      '## 交付前检查',
    ])
    expect(htmlAgents).toContain('STATUS.html')
    expect(markdownAgents).toContain('STATUS.md')
    expect(htmlAgents).not.toMatch(/文件名：|职责：`|说明：|### /)
    expect(htmlAgents).not.toContain('由已确认文档生成的工作入口协议')
    expect(zip.files['documents/AGENTS.md']).toBe(htmlAgents)
  })

  it('appends only user-authored protocol supplements after the five core sections', () => {
    const workflow = createCurrentStandardWorkflow()
    const persisted = toPersistedWorkflow(workflow)
    persisted.protocolState.supplements.push({
      id: 'supplement-review',
      title: '自定义审查要求',
      instruction: '交付前由读者核对自定义约束。',
      displayFormat: 'paragraph',
    })
    const supplemented = normalizeWorkflowForRuntime(persisted)
    const agents = exportHtmlDocuments(supplemented)['AGENTS.md']

    expect(agents).toContain('## 自定义审查要求')
    expect(agents).toContain('交付前由读者核对自定义约束。')
    expect(agents).not.toContain('## 自定义项')
    expect(agents.match(/^## .+$/gm)).toHaveLength(6)
  })

  it('renders the three beginner display formats as distinct HTML and Markdown structures', () => {
    const workflow = createCurrentStandardWorkflow()
    const status = workflow.documents.find((document) => document.role === 'status')
    if (!status) throw new Error('missing status fixture')
    const fields = status.sections.flatMap((section) => section.fields)
    fields[0]!.displayFormat = 'paragraph'
    fields[0]!.value = { kind: 'scalar', value: '用一段完整说明保留当前判断。' }
    fields[1]!.displayFormat = 'bullet-list'
    fields[1]!.value = { kind: 'scalar', value: '第一项\n第二项' }
    fields[2]!.displayFormat = 'steps'
    fields[2]!.value = { kind: 'scalar', value: '先读取资料\n再执行下一步' }

    const html = exportHtmlDocuments(workflow)['STATUS.html']
    const markdown = exportMarkdownDocuments(workflow)['STATUS.md']

    expect(html).toContain('<div class="value paragraph"')
    expect(html).toContain('<ul class="value bullet-list"')
    expect(html).toContain('<ol class="value steps"')
    expect(markdown).toContain('- 第一项')
    expect(markdown).toContain('1. 先读取资料')
  })

  it('treats an empty next-step field as a template slot during recovery rehearsal', () => {
    const workflow = createCurrentStandardWorkflow()
    const result = simulateRecovery(workflow, 'new-session')

    expect(result.status).toBe('pass')
    expect(result.blockers).not.toContain('本次实际读取的文档中没有可执行的下一原子步骤。')
    expect(result.steps.at(-1)).toMatchObject({ action: '确认模板保留下一原子步骤空槽', outcome: 'complete' })
  })

  it('uses workflow.json as the only editable ZIP source and leaves HTML imports unchanged', async () => {
    const workflow = createCurrentStandardWorkflow()
    const zip = new JSZip()
    zip.file('workflow.json', serializeWorkflowJson(workflow))
    zip.file('documents/STATUS.html', '<main>not an editable source</main>')
    const blob = await zip.generateAsync({ type: 'blob' })
    const imported = await parseImportedWorkflow(new File([blob], 'workflow.zip', { type: 'application/zip' }))

    expect(imported.name).toBe(workflow.name)
    await expect(parseImportedWorkflow(new File(['<html></html>'], 'STATUS.html', { type: 'text/html' }))).rejects.toThrow(/生成的阅读文件/)
  })

  it('keeps the current project intact when a store import fails', async () => {
    const current = createCurrentStandardWorkflow()
    useWorkflowStore.setState({ workflow: current, storageAvailable: false, storageMessage: 'test baseline' })

    await useWorkflowStore.getState().importProject(new File(['{"schemaVersion":"1.1.0"}'], 'broken.json', { type: 'application/json' }))

    expect(useWorkflowStore.getState().workflow?.workflowId).toBe(current.workflowId)
    expect(useWorkflowStore.getState().storageMessage).toMatch(/导入失败/)
  })

  it('only clears imported legacy values through the explicit template conversion action', async () => {
    const imported = await parseWorkflowJson(JSON.stringify(legacyV10()))
    const legacyValues = imported.documents
      .filter((document) => document.role !== 'protocol')
      .flatMap((document) => document.sections)
      .flatMap((section) => section.fields)
    legacyValues[0]!.value = { kind: 'scalar', value: '保留直到用户明确转换的旧内容。' }
    useWorkflowStore.setState({ workflow: imported, storageAvailable: false, storageMessage: 'legacy baseline' })

    useWorkflowStore.getState().convertLegacyToTemplate()
    const converted = useWorkflowStore.getState().workflow

    expect(converted?.mode).toBe('template')
    expect(converted?.protocolState.legacyManualOverride).toBeUndefined()
    expect(converted?.documents.filter((document) => document.role !== 'protocol')
      .flatMap((document) => document.sections)
      .flatMap((section) => section.fields)
      .every((field) => field.value.kind === 'empty' && field.required === false && field.validation.customRules.length === 0)).toBe(true)
    expect(validateWorkflow(converted!).filter((issue) => issue.severity === 'error')).toHaveLength(0)
  })

  it('preserves an old display format until the user deliberately chooses a new beginner format', async () => {
    const legacy = legacyV10()
    const content = legacy.documents.find((document) => document.role !== 'protocol')
    const field = content?.sections[0]?.fields[0]
    if (!content || !field) throw new Error('legacy fixture has no editable field')
    field.displayFormat = 'checklist'
    const imported = await parseWorkflowJson(JSON.stringify(legacy))
    const importedDocument = imported.documents.find((document) => document.role !== 'protocol')
    const importedField = importedDocument?.sections[0]?.fields[0]
    if (!importedDocument || !importedField) throw new Error('migrated fixture has no editable field')

    useWorkflowStore.setState({ workflow: imported, storageAvailable: false, storageMessage: 'legacy display baseline' })
    useWorkflowStore.getState().updateField(importedDocument.id, importedDocument.sections[0]!.id, importedField.id, {
      label: '更新后的说明项',
      guidance: '只更新名称和说明时，旧排版必须保持原样。',
    })
    expect(useWorkflowStore.getState().workflow?.documents.find((document) => document.id === importedDocument.id)?.sections[0]?.fields[0]?.displayFormat).toBe('checklist')

    useWorkflowStore.getState().updateField(importedDocument.id, importedDocument.sections[0]!.id, importedField.id, {
      label: '更新后的说明项',
      guidance: '主动选择新排版时才替换旧排版。',
      displayFormat: 'bullet-list',
    })
    expect(useWorkflowStore.getState().workflow?.documents.find((document) => document.id === importedDocument.id)?.sections[0]?.fields[0]?.displayFormat).toBe('bullet-list')
  })
})
