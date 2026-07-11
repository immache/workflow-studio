import { describe, expect, it } from 'vitest'
import { createCurrentStandardWorkflow } from '../../data/presets/current-standard-workflow'
import {
  createFieldFromModule,
  createModularWorkflow,
  createProtocolDraftDocument,
  createSectionFromModule,
  findUnselectedContentDocumentReferences,
} from '../../data/modules/standard-workflow-modules'
import { createWorkflowZip } from '../../domain/export-zip'
import { exportReadme } from '../../domain/export-markdown'
import { fieldValueToText } from '../../domain/schema'
import { simulateRecovery } from '../../domain/simulation'
import { validateWorkflow } from '../../domain/validation'

describe('Workflow Studio modular builder', () => {
  it('creates selected content documents before the protocol draft is reviewed', () => {
    const workflow = createModularWorkflow({
      name: '模块化测试工作流',
      description: '用于测试优化3模块化搭建。',
      selectedDocumentIds: ['status', 'memory'],
      firstAction: '读取 STATUS.html 并执行下一原子步骤。',
      recoveryRisk: '当前目标和历史替代关系容易丢失。',
    })

    expect(workflow.documents.map((document) => document.filename)).toEqual(['AGENTS.md', 'STATUS.html', 'MEMORY.html'])
    expect(workflow.documents.some((document) => document.filename === 'USER.html')).toBe(false)
    expect(workflow.documents.some((document) => document.filename === 'CONTEXT.html')).toBe(false)
    expect(workflow.rules.recoveryOrder.map((step) => step.documentId)).toEqual(['agents', 'content-status', 'content-memory'])
    expect(validateWorkflow(workflow).filter((issue) => issue.severity === 'error')).toHaveLength(0)
  })

  it('generates an AGENTS draft from selected content documents', () => {
    const workflow = createModularWorkflow({
      name: '协议草案测试',
      description: '检查入口协议生成。',
      selectedDocumentIds: ['spec', 'status', 'user', 'memory', 'context'],
      firstAction: '先读取 STATUS.html。',
      recoveryRisk: '来源冲突和术语不清。',
    })
    const protocol = workflow.documents.find((document) => document.filename === 'AGENTS.md')

    expect(protocol?.sections.map((section) => section.title)).toEqual([
      '文档清单',
      '读取顺序',
      '来源优先级',
      '更新规则',
      '完成检查',
    ])
    const protocolText = protocol?.sections.flatMap((section) => section.fields).map((field) => JSON.stringify(field.value)).join('\n') ?? ''
    expect(protocolText).toContain('SPEC.html')
    expect(protocolText).toContain('STATUS.html')
    expect(protocolText).toContain('CONTEXT.html')
    expect(protocolText).toContain('必读：AGENTS.md -> STATUS.html -> SPEC.html')
    expect(protocolText).toContain('按需读取：USER.html')
    expect(workflow.rules.recoveryOrder.map((step) => step.documentId)).toEqual([
      'agents',
      'content-status',
      'content-spec',
      'content-user',
      'content-memory',
      'content-context',
    ])
    expect(workflow.rules.recoveryOrder.map((step) => step.required)).toEqual([true, true, true, false, false, false])
  })

  it('allows STATUS.html to be omitted for a static workflow', () => {
    const firstAction = '读取入口协议后核对稳定计划。'
    const workflow = createModularWorkflow({
      name: '静态工作流',
      description: '只保存稳定计划。',
      selectedDocumentIds: ['spec'],
      firstAction,
      recoveryRisk: '无实时状态。',
    })
    const fallbackField = workflow.documents
      .find((document) => document.role === 'protocol')
      ?.sections.flatMap((section) => section.fields)
      .find((field) => field.id === 'protocol-fallback-next-atomic-step')
    if (!fallbackField) throw new Error('missing protocol fallback fixture')
    const simulation = simulateRecovery(workflow, 'new-session')

    expect(workflow.documents.map((document) => document.filename)).toEqual(['AGENTS.md', 'SPEC.html'])
    expect(fieldValueToText(fallbackField.value)).toBe(firstAction)
    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'recovery-realtime-status', severity: 'warning' }),
    ]))
    expect(simulation).toMatchObject({
      status: 'risky',
      nextAtomicStep: firstAction,
      readDocuments: ['AGENTS.md', 'SPEC.html'],
    })
  })

  it('detects first-action references to content documents that will not be generated', () => {
    const missingReferences = findUnselectedContentDocumentReferences(
      '先读取 documents/STATUS.html，再对照 context.HTML。',
      ['spec', 'memory'],
    )

    expect(missingReferences.map((document) => document.filename)).toEqual(['STATUS.html', 'CONTEXT.html'])
    expect(findUnselectedContentDocumentReferences('读取 SPEC.html。', ['spec'])).toHaveLength(0)
  })

  it('copies section and field modules into ordinary schema objects', () => {
    const section = createSectionFromModule('status-blockers', 9)
    const field = createFieldFromModule('field-evidence')

    expect(section?.title).toBe('阻塞与确认')
    expect(section?.fields.map((item) => item.label)).toEqual(['阻塞', '需要确认'])
    expect(field?.label).toBe('证据或验证方式')
    expect(field?.guidance).toBe('记录命令、文件检查、截图、测试或来源证据。')
    expect(field?.displayFormat).toBe('checklist')
  })

  it('exports modular workflows with README module summaries', async () => {
    const workflow = createModularWorkflow({
      name: '导出模块摘要',
      description: '检查模块化导出。',
      selectedDocumentIds: ['spec', 'status', 'memory'],
      firstAction: '继续完善状态快照。',
      recoveryRisk: '范围和下一步容易混淆。',
    })
    const readme = exportReadme(workflow)
    const zip = await createWorkflowZip(workflow)

    expect(readme).toContain('## 模块摘要')
    expect(readme).toContain('### 标准模块')
    expect(readme).toContain('### 自定义模块')
    expect(readme).toContain('STATUS.html')
    expect(zip.files['documents/AGENTS.md']).toBeTruthy()
    expect(zip.files['documents/AGENTS.html']).toBeUndefined()
    expect(zip.files['documents/STATUS.html']).toContain('data-guidance="true"')
  })

  it('classifies the built-in current workflow sections as standard README modules', () => {
    const workflow = createCurrentStandardWorkflow()
    const status = workflow.documents.find((document) => document.role === 'status')
    if (!status) throw new Error('missing current status fixture')
    status.sections.push({
      id: 'custom-delivery-notes',
      title: '交付备注',
      purpose: '记录当前项目的交付补充信息。',
      lifecycle: 'realtime',
      order: status.sections.length + 1,
      repeatable: false,
      fields: [],
    })

    const readme = exportReadme(workflow)
    const standardModules = readme.match(/### 标准模块\s*([\s\S]*?)### 自定义模块/)?.[1] ?? ''
    const customModules = readme.match(/### 自定义模块\s*([\s\S]*)/)?.[1] ?? ''

    expect(standardModules).not.toContain('- 无。')
    expect(standardModules).toContain(status.sections[0].title)
    expect(customModules).toContain('交付备注')
  })

  it('separates custom modules from standard modules in README summaries', () => {
    const workflow = createModularWorkflow({
      name: '自定义模块摘要',
      description: '检查 README 分类。',
      selectedDocumentIds: ['status'],
      firstAction: '读取 STATUS.html。',
      recoveryRisk: '当前状态丢失。',
    })
    const status = workflow.documents.find((document) => document.role === 'status')
    if (!status) throw new Error('missing status fixture')
    status.sections.push({
      id: 'custom-delivery-notes',
      title: '交付备注',
      purpose: '记录本项目的交付补充信息。',
      lifecycle: 'realtime',
      order: status.sections.length + 1,
      repeatable: false,
      fields: [],
    })

    const readme = exportReadme(workflow)

    expect(readme).toMatch(/### 标准模块[\s\S]*当前目标与下一步/)
    expect(readme).toMatch(/### 自定义模块[\s\S]*交付备注/)
  })

  it('regenerates a protocol draft without referencing unselected documents', () => {
    const workflow = createModularWorkflow({
      name: '精简草案',
      description: '只选择状态和历史。',
      selectedDocumentIds: ['status', 'memory'],
      firstAction: '读取状态。',
      recoveryRisk: '当前状态丢失。',
    })
    const contentDocuments = workflow.documents.filter((document) => document.role !== 'protocol')
    const protocol = createProtocolDraftDocument(contentDocuments)
    const text = protocol.sections.flatMap((section) => section.fields).map((field) => JSON.stringify(field.value)).join('\n')

    expect(text).toContain('STATUS.html')
    expect(text).toContain('MEMORY.html')
    expect(text).not.toContain('USER.html')
    expect(text).not.toContain('CONTEXT.html')
  })

  it('blocks a modular protocol whose core module has no usable field content', () => {
    const workflow = createModularWorkflow({
      name: '协议完整性测试',
      description: '验证核心协议模块不能成为空壳。',
      selectedDocumentIds: ['status'],
      firstAction: '读取状态并继续。',
      recoveryRisk: '当前状态丢失。',
    })
    const protocol = workflow.documents.find((document) => document.role === 'protocol')
    const readOrder = protocol?.sections.find((section) => section.id === 'protocol-read-order')
    if (!readOrder) throw new Error('missing protocol read-order fixture')
    readOrder.fields = []

    expect(validateWorkflow(workflow)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'structure-protocol-core-content', severity: 'error' }),
    ]))
  })
})
