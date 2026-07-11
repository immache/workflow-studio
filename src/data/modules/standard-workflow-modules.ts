import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SCORING_SETTINGS,
  SCHEMA_VERSION,
  createField,
  emptyValue,
  scalarValue,
  type CompletionCheck,
  type DocumentRole,
  type DisplayFormatId,
  type FieldType,
  type InformationLifecycle,
  type RecoveryStep,
  type SourceRef,
  type SourcePriorityRule,
  type UpdateTriggerRule,
  type WorkflowDocument,
  type WorkflowField,
  type WorkflowRules,
  type WorkflowSchema,
  type WorkflowSection,
} from '../../domain/schema'
import { createSystemProtocolState, normalizeWorkflowForRuntime } from '../../domain/protocol-state'

export type ContentDocumentId = 'spec' | 'status' | 'user' | 'memory' | 'context'

export type StandardDocumentCard = {
  id: ContentDocumentId
  filename: string
  title: string
  role: DocumentRole
  lifecycle: InformationLifecycle
  description: string
  whenToUse: string
  generatedResult: string
  recommended: boolean
  required: boolean
}

type FieldModuleDefinition = {
  id: string
  label: string
  guidance: string
  type: FieldType
  lifecycle: InformationLifecycle
  displayFormat: DisplayFormatId
  required?: boolean
  value?: string
}

export type SectionModuleDefinition = {
  id: string
  title: string
  purpose: string
  lifecycle: InformationLifecycle
  targetRoles: DocumentRole[]
  displayFormat: DisplayFormatId
  userBenefit: string
  futureModelUse: string
  fields: FieldModuleDefinition[]
}

export type FieldModuleCard = FieldModuleDefinition & {
  targetRoles: DocumentRole[]
  userBenefit: string
  futureModelUse: string
}

type ModularWorkflowInput = {
  name: string
  description: string
  selectedDocumentIds: Iterable<ContentDocumentId>
  firstAction: string
  recoveryRisk: string
}

const contentDocumentOrder: ContentDocumentId[] = ['spec', 'status', 'user', 'memory', 'context']
const defaultContentDocumentIds: ContentDocumentId[] = ['spec', 'status', 'memory']

export const standardDocumentCards: StandardDocumentCard[] = [
  {
    id: 'spec',
    filename: 'SPEC.html',
    title: '稳定计划',
    role: 'plan',
    lifecycle: 'stable',
    description: '记录长期目标、成功标准、范围边界、阶段计划和持久约束。',
    whenToUse: '项目有长期目标、阶段计划或范围边界时启用。',
    generatedResult: '生成计划章节、成功标准字段和持久约束字段。',
    recommended: true,
    required: false,
  },
  {
    id: 'status',
    filename: 'STATUS.html',
    title: '状态快照',
    role: 'status',
    lifecycle: 'realtime',
    description: '记录当前目标、下一原子步骤、已验证事实、阻塞和恢复指针。',
    whenToUse: '需要持续记录当前目标、下一步或阻塞时启用；推荐使用，但可以取消。',
    generatedResult: '生成当前目标、下一原子步骤、阻塞确认和恢复指针。',
    recommended: true,
    required: false,
  },
  {
    id: 'user',
    filename: 'USER.html',
    title: '用户偏好',
    role: 'preference',
    lifecycle: 'preference',
    description: '记录长期稳定、会影响多数任务的用户偏好。',
    whenToUse: '用户有长期协作、输出、执行或安全偏好时启用。',
    generatedResult: '生成协作偏好、输出偏好、执行偏好和边界字段。',
    recommended: false,
    required: false,
  },
  {
    id: 'memory',
    filename: 'MEMORY.html',
    title: '演变历史',
    role: 'history',
    lifecycle: 'historical',
    description: '记录项目演变、方向变化、废弃方案、替代关系和关键证据。',
    whenToUse: '项目会持续迭代，或者需要解释为什么做过某个选择时启用。',
    generatedResult: '生成记忆索引、演变时间线和失效归档规则。',
    recommended: true,
    required: false,
  },
  {
    id: 'context',
    filename: 'CONTEXT.html',
    title: '术语解释',
    role: 'context',
    lifecycle: 'reference',
    description: '解释术语含义、反例、归属和例子，不记录实时状态。',
    whenToUse: '项目有容易误解的抽象术语、专有名词或边界定义时启用。',
    generatedResult: '生成术语条目模板、基础术语和维护规则。',
    recommended: false,
    required: false,
  },
]

export const displayFormatLabels: Record<DisplayFormatId, string> = {
  paragraph: '段落说明',
  'bullet-list': '项目列表',
  checklist: '检查清单',
  steps: '步骤序列',
  'key-value': '键值表',
  'decision-table': '决策表',
  timeline: '时间线',
  code: '代码或命令',
  'path-list': '路径列表',
}

export const sectionModuleLibrary: SectionModuleDefinition[] = [
  {
    id: 'status-next-action',
    title: '当前目标与下一步',
    purpose: '让未来模型恢复后知道当前目标和唯一下一原子步骤。',
    lifecycle: 'realtime',
    targetRoles: ['status'],
    displayFormat: 'steps',
    userBenefit: '新手只需要回答“现在做什么”和“接下来做什么”。',
    futureModelUse: '恢复后从这里进入具体执行。',
    fields: [
      { id: 'current-goal', label: '当前目标', guidance: '只写当前仍有效目标，不写旧目标。', type: 'longText', lifecycle: 'realtime', displayFormat: 'paragraph' },
      { id: 'next-atomic-step', label: '下一原子步骤', guidance: '唯一、具体、可执行；恢复后直接从这里开始。', type: 'longText', lifecycle: 'realtime', displayFormat: 'steps', required: true },
    ],
  },
  {
    id: 'status-blockers',
    title: '阻塞与确认',
    purpose: '记录当前阻塞、解除条件和必须询问用户的问题。',
    lifecycle: 'realtime',
    targetRoles: ['status'],
    displayFormat: 'checklist',
    userBenefit: '把“卡在哪里”写清楚，避免未来模型误以为可以继续。',
    futureModelUse: '恢复时先判断是否能继续，或必须等待用户确认。',
    fields: [
      { id: 'blockers', label: '阻塞', guidance: '写清阻塞对象、影响和解除条件。', type: 'list', lifecycle: 'realtime', displayFormat: 'checklist' },
      { id: 'confirmation-needed', label: '需要确认', guidance: '只有必须问用户才能继续时填写。', type: 'list', lifecycle: 'realtime', displayFormat: 'checklist' },
    ],
  },
  {
    id: 'spec-success',
    title: '目标、范围与成功标准',
    purpose: '记录长期目标、边界和怎样才算完成。',
    lifecycle: 'stable',
    targetRoles: ['plan'],
    displayFormat: 'key-value',
    userBenefit: '先确定长期边界，后续状态变化不会污染计划。',
    futureModelUse: '判断当前任务是否仍在范围内，以及交付是否达标。',
    fields: [
      { id: 'mission', label: '项目使命', guidance: '用 1-3 句话说明项目长期目标。', type: 'longText', lifecycle: 'stable', displayFormat: 'paragraph' },
      { id: 'success-criteria', label: '成功标准', guidance: '写可验证标准，不写过程流水。', type: 'list', lifecycle: 'stable', displayFormat: 'checklist' },
      { id: 'scope-boundary', label: '范围边界', guidance: '明确目标和非目标。', type: 'table', lifecycle: 'stable', displayFormat: 'decision-table' },
    ],
  },
  {
    id: 'user-preferences',
    title: '长期偏好条目',
    purpose: '记录用户明确表达或反复确认的长期稳定偏好。',
    lifecycle: 'preference',
    targetRoles: ['preference'],
    displayFormat: 'key-value',
    userBenefit: '一次性要求不会误写成长期偏好。',
    futureModelUse: '跨任务恢复用户协作方式、输出方式和安全边界。',
    fields: [
      { id: 'preference-item', label: '偏好条目', guidance: '写清偏好内容、证据来源和适用边界。', type: 'table', lifecycle: 'preference', displayFormat: 'key-value' },
      { id: 'preference-update-rule', label: '更新规则', guidance: '说明什么情况下新增、替换或删除偏好。', type: 'longText', lifecycle: 'preference', displayFormat: 'paragraph' },
    ],
  },
  {
    id: 'memory-timeline',
    title: '记忆索引与时间线',
    purpose: '保存项目演变、方向变化、废弃方案和替代关系。',
    lifecycle: 'historical',
    targetRoles: ['history'],
    displayFormat: 'timeline',
    userBenefit: '历史只解释为什么，不覆盖当前状态。',
    futureModelUse: '当前材料不足时按关键词理解项目演变。',
    fields: [
      { id: 'memory-index', label: '记忆索引', guidance: '记录关键词、日期、状态和简短摘要；状态只能填写“仍有效参考”或“已失效归档”。', type: 'table', lifecycle: 'historical', displayFormat: 'key-value' },
      { id: 'timeline-entry', label: '演变时间线', guidance: '每条历史都要写状态、事件、原因、当前结果和证据；被替代后改为“已失效归档”，不要删除。', type: 'table', lifecycle: 'historical', displayFormat: 'timeline' },
    ],
  },
  {
    id: 'context-term',
    title: '术语条目',
    purpose: '解释术语含义、常见误解、归属和例子。',
    lifecycle: 'reference',
    targetRoles: ['context'],
    displayFormat: 'key-value',
    userBenefit: '避免未来模型把术语误认为实时状态或执行协议。',
    futureModelUse: '术语不清楚时按需读取，不覆盖其他文档事实。',
    fields: [
      { id: 'term-name', label: '术语名称', guidance: '写需要解释的术语。', type: 'shortText', lifecycle: 'reference', displayFormat: 'paragraph' },
      { id: 'term-meaning', label: '含义', guidance: '解释这个术语在本工作流中的意思。', type: 'longText', lifecycle: 'reference', displayFormat: 'paragraph' },
      { id: 'term-not-equal', label: '不等于', guidance: '写清容易混淆的相邻概念。', type: 'longText', lifecycle: 'reference', displayFormat: 'paragraph' },
    ],
  },
]

export const fieldModuleLibrary: FieldModuleCard[] = [
  {
    id: 'field-guidance',
    label: '常驻填写说明',
    guidance: '写清为什么要填、应该填什么、什么时候更新和未来模型怎么用。',
    type: 'longText',
    lifecycle: 'stable',
    displayFormat: 'paragraph',
    targetRoles: ['plan', 'status', 'preference', 'history', 'context', 'custom'],
    userBenefit: '具体内容写入后，填写指导仍然可见。',
    futureModelUse: '模型能区分说明和值，不会覆盖指导文本。',
  },
  {
    id: 'field-evidence',
    label: '证据或验证方式',
    guidance: '记录命令、文件检查、截图、测试或来源证据。',
    type: 'list',
    lifecycle: 'validation',
    displayFormat: 'checklist',
    targetRoles: ['plan', 'status', 'history', 'validation', 'custom'],
    userBenefit: '交付前知道凭什么判断已经完成。',
    futureModelUse: '恢复时能复用验证入口，而不是猜测。',
  },
  {
    id: 'field-decision',
    label: '冲突裁决',
    guidance: '写清冲突场景、优先相信谁、例外和需要询问用户的条件。',
    type: 'table',
    lifecycle: 'validation',
    displayFormat: 'decision-table',
    targetRoles: ['protocol', 'status', 'plan', 'custom'],
    userBenefit: '不用理解底层来源优先级，也能写清裁决规则。',
    futureModelUse: '信息冲突时按表格判断下一步。',
  },
  {
    id: 'field-paths',
    label: '文件或工作入口',
    guidance: '记录项目根、worktree、子目录、远端或容器路径；不要默认一定是根目录。',
    type: 'path',
    lifecycle: 'realtime',
    displayFormat: 'path-list',
    targetRoles: ['status', 'context', 'custom'],
    userBenefit: '避免把工作目录误填为根目录。',
    futureModelUse: '恢复后知道应该从哪个实际入口检查工作区。',
  },
]

function now() {
  return new Date().toISOString()
}

function uniqueSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function section(
  id: string,
  title: string,
  purpose: string,
  lifecycle: InformationLifecycle,
  order: number,
  fields: WorkflowField[],
): WorkflowSection {
  return { id, title, purpose, lifecycle, order, repeatable: false, fields }
}

function field(input: FieldModuleDefinition): WorkflowField {
  return createField({
    id: input.id,
    label: input.label,
    type: input.type,
    guidance: input.guidance,
    lifecycle: input.lifecycle,
    required: input.required,
    value: input.value ? scalarValue(input.value) : undefined,
    displayFormat: input.displayFormat,
  })
}

const updateTriggerByRole: Record<DocumentRole, string> = {
  protocol: '恢复路径、来源优先级、文档职责、更新规则或完成检查变化时',
  plan: '长期目标、成功标准、范围边界、阶段计划或持久约束变化时',
  status: '当前目标、已验证事实、阻塞、下一原子步骤或恢复指针变化时',
  preference: '用户明确表达或反复确认会影响多数未来任务的长期偏好时',
  history: '出现方向变化、废弃方案、替代关系、重要原因或关键证据时',
  context: '新增、改名或重新定义术语时',
  validation: '校验标准、验证方式或完成条件变化时',
  custom: '这份文档职责范围内的有效事实变化时',
}

function document(input: {
  id: string
  filename: string
  title: string
  role: DocumentRole
  lifecycle: InformationLifecycle
  description: string
  order: number
  sections: WorkflowSection[]
}): WorkflowDocument {
  const whenToReadByRole: Partial<Record<DocumentRole, string[]>> = {
    preference: ['长期用户偏好会影响当前任务时读取'],
    history: ['实时文档不足或需要理解项目演变时按关键词读取'],
    context: ['术语含义、边界或归属不清楚时读取'],
  }
  return {
    ...input,
    required: input.role === 'protocol',
    readPolicy: {
      whenToRead: whenToReadByRole[input.role] ?? ['恢复时按规则读取'],
      dependsOnDocumentIds: [],
      readOrderHint: input.order,
    },
    updatePolicy: {
      updateTriggers: [updateTriggerByRole[input.role]],
      replacementMode: input.lifecycle === 'historical' ? 'append-history' : 'replace-current',
      staleInfoHandling: input.lifecycle === 'historical' ? 'archive' : 'remove',
    },
  }
}

export function normalizeContentDocumentIds(ids?: Iterable<string>): ContentDocumentId[] {
  const allowed = new Set(contentDocumentOrder)
  const selected = new Set<ContentDocumentId>(defaultContentDocumentIds)
  if (ids) {
    selected.clear()
    for (const id of ids) {
      if (allowed.has(id as ContentDocumentId)) selected.add(id as ContentDocumentId)
    }
  }
  return contentDocumentOrder.filter((id) => selected.has(id))
}

export function findUnselectedContentDocumentReferences(
  text: string,
  selectedDocumentIds: Iterable<ContentDocumentId>,
): StandardDocumentCard[] {
  const selected = new Set(selectedDocumentIds)
  const normalizedText = text.toLocaleLowerCase('en-US')
  return standardDocumentCards.filter((card) => (
    !selected.has(card.id) && normalizedText.includes(card.filename.toLocaleLowerCase('en-US'))
  ))
}

export function createFieldFromModule(moduleId: string): WorkflowField | undefined {
  const module = fieldModuleLibrary.find((item) => item.id === moduleId)
  if (!module) return undefined
  return field({ ...module, id: `${module.id}-${uniqueSuffix()}` })
}

export function createSectionFromModule(moduleId: string, order: number): WorkflowSection | undefined {
  const module = sectionModuleLibrary.find((item) => item.id === moduleId)
  if (!module) return undefined
  const suffix = uniqueSuffix()
  return section(
    `${module.id}-${suffix}`,
    module.title,
    `${module.purpose} ${module.futureModelUse}`,
    module.lifecycle,
    order,
    module.fields.map((item) => field({ ...item, id: `${module.id}-${item.id}-${suffix}` })),
  )
}

function sectionsForCard(card: StandardDocumentCard): WorkflowSection[] {
  const modules = sectionModuleLibrary.filter((module) => module.targetRoles.includes(card.role))
  if (modules.length === 0) {
    return [
      section('custom-core', '核心内容', '说明这份文档需要保存的信息。', card.lifecycle, 1, [
        createField({
          id: 'custom-key-fact',
          label: '关键事实',
          guidance: '写清事实来源、适用边界、什么时候更新和未来模型怎么用。',
          lifecycle: card.lifecycle,
        }),
      ]),
    ]
  }
  return modules.map((module, index) => {
    const created = createSectionFromModule(module.id, index + 1)
    if (!created) throw new Error(`无法创建章节模块 ${module.id}`)
    created.id = module.id
    created.fields = created.fields.map((fieldItem, fieldIndex) => ({
      ...fieldItem,
      id: `${module.id}-${module.fields[fieldIndex]?.id ?? fieldIndex + 1}`,
    }))
    return created
  })
}

export function createContentDocument(cardId: ContentDocumentId, order: number): WorkflowDocument {
  const card = standardDocumentCards.find((item) => item.id === cardId)
  if (!card) throw new Error(`未知内容文档：${cardId}`)
  return document({
    id: `content-${card.id}`,
    filename: card.filename,
    title: card.title,
    role: card.role,
    lifecycle: card.lifecycle,
    description: card.description,
    order,
    sections: sectionsForCard(card),
  })
}

function sourceRefsForDocuments(documents: WorkflowDocument[]): SourceRef[] {
  const refs: SourceRef[] = [
    { sourceType: 'latest-user-instruction', label: '最新明确用户指令', priority: 1, recencyPolicy: 'prefer-newer' },
    { sourceType: 'workspace-fact', label: '新鲜工作区事实和工具输出', priority: 2, recencyPolicy: 'prefer-newer' },
  ]
  const status = documents.find((documentItem) => documentItem.role === 'status')
  const plan = documents.find((documentItem) => documentItem.role === 'plan')
  const preference = documents.find((documentItem) => documentItem.role === 'preference')
  const history = documents.find((documentItem) => documentItem.role === 'history')
  const context = documents.find((documentItem) => documentItem.role === 'context')
  if (status) refs.push({ sourceType: 'current-status', label: status.filename, documentId: status.id, priority: refs.length + 1, recencyPolicy: 'prefer-newer' })
  if (plan) refs.push({ sourceType: 'stable-plan', label: plan.filename, documentId: plan.id, priority: refs.length + 1, recencyPolicy: 'ignore-recency' })
  if (preference) refs.push({ sourceType: 'user-preference', label: preference.filename, documentId: preference.id, priority: refs.length + 1, recencyPolicy: 'ignore-recency' })
  refs.push({ sourceType: 'session-history', label: '当前会话历史', priority: refs.length + 1, recencyPolicy: 'prefer-newer' })
  if (history) refs.push({ sourceType: 'memory-history', label: history.filename, documentId: history.id, priority: refs.length + 1, recencyPolicy: 'manual' })
  refs.push({ sourceType: 'older-history', label: '更早历史', priority: refs.length + 1, recencyPolicy: 'manual' })
  if (context) refs.push({ sourceType: 'context-reference', label: context.filename, documentId: context.id, priority: refs.length + 1, recencyPolicy: 'ignore-recency' })
  return refs.map((ref, index) => ({ ...ref, priority: index + 1 }))
}

function orderedRecoveryDocuments(documents: WorkflowDocument[]): WorkflowDocument[] {
  const rolePriority: Partial<Record<DocumentRole, number>> = {
    status: 1,
    plan: 2,
    preference: 3,
    history: 4,
    context: 5,
  }
  return [...documents].sort((left, right) => (
    (rolePriority[left.role] ?? 99) - (rolePriority[right.role] ?? 99) || left.order - right.order
  ))
}

function recoveryOrderForDocuments(documents: WorkflowDocument[]): RecoveryStep[] {
  const protocolStep: RecoveryStep = {
    id: 'recovery-agents',
    documentId: 'agents',
    condition: '恢复时第一步读取入口协议草案。',
    required: true,
    fallbackStepIds: [],
  }
  return [
    protocolStep,
    ...orderedRecoveryDocuments(documents).map((documentItem) => ({
      id: `recovery-${documentItem.id}`,
      documentId: documentItem.id,
      condition: documentItem.role === 'history' || documentItem.role === 'context' || documentItem.role === 'preference'
        ? '按需读取'
        : '恢复时必读',
      required: documentItem.role === 'status' || documentItem.role === 'plan',
      fallbackStepIds: [],
    })),
  ]
}

function updateTriggersForDocuments(documents: WorkflowDocument[]): UpdateTriggerRule[] {
  return documents.map((documentItem) => ({
    id: `trigger-${documentItem.id}`,
    targetDocumentId: documentItem.id,
    trigger: documentItem.updatePolicy.updateTriggers.join('；'),
    requiredAction: documentItem.lifecycle === 'historical'
      ? `追加或归档 ${documentItem.filename}，不要覆盖当前状态`
      : `更新 ${documentItem.filename}，替换已经失效的信息`,
  }))
}

function completionChecksForDocuments(documents: WorkflowDocument[]): CompletionCheck[] {
  const checks: CompletionCheck[] = [
    {
      id: 'check-run-verification',
      label: '验证交付结果',
      description: '用命令、测试、截图或清单验证交付结果。',
      severityWhenMissing: 'error',
      relatedDocumentIds: ['agents', ...documents.filter((item) => item.role === 'status').map((item) => item.id)],
    },
    {
      id: 'check-docs-current',
      label: '恢复文档最新',
      description: '确认实时文档没有失效信息，历史演变写入历史文档。',
      severityWhenMissing: 'warning',
      relatedDocumentIds: documents.map((item) => item.id),
    },
  ]
  if (documents.some((item) => item.role === 'history')) {
    checks.push({
      id: 'check-memory-index',
      label: '历史索引已更新',
      description: '新增或归档历史条目后，必须同步更新记忆索引。',
      severityWhenMissing: 'warning',
      relatedDocumentIds: documents.filter((item) => item.role === 'history').map((item) => item.id),
    })
  }
  return checks
}

export function createRulesForDocuments(documents: WorkflowDocument[]): WorkflowRules {
  const sourcePriority: SourcePriorityRule = {
    id: 'global-source-priority',
    scope: 'global',
    orderedSources: sourceRefsForDocuments(documents),
    tieBreaker: 'explicit-user-confirmation',
    reason: '按最新明确用户指令、新鲜工作区事实和恢复文档职责裁决冲突。',
  }
  return {
    recoveryOrder: recoveryOrderForDocuments(documents),
    sourcePriority: [sourcePriority],
    updateTriggers: [
      {
        id: 'trigger-agents',
        targetDocumentId: 'agents',
        trigger: '内容文档集合、读取顺序、来源优先级、维护规则或完成检查变化时',
        requiredAction: '更新 AGENTS.md 对应协议模块并重新审查入口协议',
      },
      ...updateTriggersForDocuments(documents),
    ],
    completionChecks: completionChecksForDocuments(documents),
    conflictPolicy: {
      defaultAction: 'apply-source-priority',
      requireExplicitNoteForManualOverride: true,
      unresolvedConflictSeverity: 'error',
    },
    historyPolicy: {
      appendOnly: true,
      allowedStatuses: ['仍有效参考', '已失效归档'],
      requireIndexUpdate: documents.some((item) => item.role === 'history'),
      obsoleteHandling: 'archive-with-replacement',
    },
  }
}

export function createProtocolDraftDocument(documents: WorkflowDocument[], order = 1, fallbackNextAction = ''): WorkflowDocument {
  const readableDocs = protocolDocumentListContent(documents)
  const orderedDocuments = orderedRecoveryDocuments(documents)
  const requiredDocuments = orderedDocuments.filter((documentItem) => documentItem.role === 'status' || documentItem.role === 'plan')
  const onDemandDocuments = orderedDocuments.filter((documentItem) => !requiredDocuments.includes(documentItem))
  const recoveryOrder = [
    `必读：${['AGENTS.md', ...requiredDocuments.map((documentItem) => documentItem.filename)].join(' -> ')}`,
    onDemandDocuments.length > 0
      ? `按需读取：${onDemandDocuments.map((documentItem) => `${documentItem.filename}（${documentItem.readPolicy.whenToRead.join('；') || '职责相关时读取'}）`).join('；')}`
      : '',
  ].filter(Boolean).join('\n')
  const sourcePriority = sourceRefsForDocuments(documents)
    .map((source, index) => `${index + 1}. ${source.label}`)
    .join('\n')
  const updateRules = [
    'AGENTS.md：内容文档集合、读取顺序、来源优先级、维护规则或完成检查变化时；更新对应协议模块并重新审查。',
    ...documents.map((documentItem) => `${documentItem.filename}：${documentItem.updatePolicy.updateTriggers.join('；')}；${documentItem.updatePolicy.replacementMode === 'append-history' ? '追加历史条目并标明替代关系' : '替换失效信息，只保留当前有效内容'}。`),
  ].join('\n')
  const completionChecks = completionChecksForDocuments(documents).map((check) => `- ${check.label}：${check.description}`).join('\n')
  const recoveryFields = [
    createField({
      id: 'protocol-recovery-order',
      label: '恢复读取顺序',
      guidance: '入口协议必须第一步读取；其他文档按职责和需要读取。',
      lifecycle: 'validation',
      required: true,
      value: scalarValue(recoveryOrder),
    }),
  ]
  if (!documents.some((documentItem) => documentItem.role === 'status')) {
    recoveryFields.push(createField({
      id: 'protocol-fallback-next-atomic-step',
      label: '无状态文档时的接续动作',
      guidance: '未启用状态文档时，在这里保留恢复后可以立刻执行的唯一动作；修改用途答案后重新生成协议草案。',
      lifecycle: 'validation',
      required: true,
      value: scalarValue(fallbackNextAction.trim() || '先核对当前工作区事实，再执行计划中的第一项未完成工作。'),
    }))
  }

  const documentListField = createField({
    id: 'protocol-documents',
    label: '文档清单',
    guidance: '由已选内容文档生成；审查时可修改显示名和职责摘要。',
    lifecycle: 'validation',
    required: true,
    value: scalarValue(readableDocs),
  })
  documentListField.defaultValue = readableDocs

  return document({
    id: 'agents',
    filename: 'AGENTS.md',
    title: '入口协议草案',
    role: 'protocol',
    lifecycle: 'mixed',
    description: '系统根据已选内容文档自动生成的恢复入口草案，可在交付前继续模块化审查和编辑。',
    order,
    sections: [
      section('protocol-doc-list', '文档清单', '串联本工作流包含的内容文档和职责。', 'validation', 1, [
        documentListField,
      ]),
      section('protocol-read-order', '读取顺序', '说明未来模型恢复时先读什么、再读什么。', 'validation', 2, recoveryFields),
      section('protocol-source-priority', '来源优先级', '说明冲突时优先相信谁。', 'validation', 3, [
        createField({
          id: 'protocol-source-priority-field',
          label: '冲突时先信谁',
          guidance: '默认先信最新明确用户指令，再信新鲜工作区事实，然后按恢复文档职责裁决。',
          lifecycle: 'validation',
          required: true,
          value: scalarValue(sourcePriority),
        }),
      ]),
      section('protocol-update-rules', '更新规则', '说明什么变化写入哪份文档。', 'validation', 4, [
        createField({
          id: 'protocol-update-rules-field',
          label: '写入和维护规则',
          guidance: '同一实时事实只写入负责文档；历史演变写入历史文档。',
          lifecycle: 'validation',
          required: true,
          value: scalarValue(updateRules),
        }),
      ]),
      section('protocol-completion', '完成检查', '交付前确认验证和文档维护已经完成。', 'validation', 5, [
        createField({
          id: 'protocol-completion-checks',
          label: '完成前检查',
          guidance: '声明完成前必须验证交付结果，并维护恢复文档到最新。',
          lifecycle: 'validation',
          required: true,
          value: scalarValue(completionChecks),
        }),
      ]),
    ],
  })
}

export function protocolDocumentListContent(documents: readonly Pick<WorkflowDocument, 'filename' | 'description'>[]): string {
  return documents
    .map((documentItem, index) => `${index + 1}. ${documentItem.filename}：${documentItem.description}`)
    .join('\n')
}

export function createModularWorkflow(input: ModularWorkflowInput): WorkflowSchema {
  const createdAt = now()
  const contentIds = normalizeContentDocumentIds(input.selectedDocumentIds)
  const contentDocuments = contentIds.map((id, index) => createContentDocument(id, index + 2))
  const documents = contentDocuments.map((documentItem, documentIndex) => ({
    ...documentItem,
    order: documentIndex + 1,
    readPolicy: { ...documentItem.readPolicy, readOrderHint: documentIndex + 1 },
    sections: documentItem.sections.map((sectionItem) => ({
      ...sectionItem,
      fields: sectionItem.fields.map((field) => ({
        ...field,
        value: emptyValue(),
        required: false,
        allowEmpty: true,
        defaultValue: undefined,
        displayFormat: field.displayFormat === 'steps' ? 'steps' as const : field.displayFormat === 'bullet-list' ? 'bullet-list' as const : 'paragraph' as const,
      })),
    })),
  }))
  const name = input.name.trim() || '模块化工作流'
  const description = input.description.trim() || `用于在模型协作中持续记录${input.recoveryRisk.trim() || '目标、下一步和当前阻塞'}。`
  const draft = {
    schemaVersion: SCHEMA_VERSION,
    workflowId: `workflow-${Date.now()}`,
    name,
    description,
    createdAt,
    updatedAt: createdAt,
    maintenanceFormat: 'html' as const,
    secondaryFormat: 'markdown' as const,
    documents,
    mode: 'template' as const,
    protocolState: createSystemProtocolState({ name, description, documents }),
    rules: createRulesForDocuments(contentDocuments),
    exportSettings: DEFAULT_EXPORT_SETTINGS,
    scoringSettings: DEFAULT_SCORING_SETTINGS,
    acceptedWarnings: [],
  }
  return normalizeWorkflowForRuntime(draft)
}
