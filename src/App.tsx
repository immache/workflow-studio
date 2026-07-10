import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Boxes,
  CheckCircle2,
  Copy,
  Download,
  FileArchive,
  FileJson,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Import,
  Layers3,
  ListChecks,
  PanelRightOpen,
  Play,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import './App.css'
import { exportReadme } from './domain/export-markdown'
import { exportDocumentsForFormat } from './domain/export-documents'
import { projectDocumentFilename } from './domain/export-naming'
import { createWorkflowZip, packageName } from './domain/export-zip'
import { dimensionLabels, scoreWorkflow } from './domain/scoring'
import {
  fieldValueToText,
  type FieldOption,
  type MaintenanceFormat,
  type SimulationScenario,
  type SourceRef,
  type ValidationRule,
  type ValidationIssue,
  type WorkflowDocument,
  type WorkflowField,
  type WorkflowSchema,
  type WorkflowSection,
} from './domain/schema'
import { scenarioLabels, simulateRecovery } from './domain/simulation'
import { hasBlockingErrors, validateWorkflow } from './domain/validation'
import {
  documentRoleOptions,
  fieldTypeOptions,
  lifecycleOptions,
  sourceTypeOptions,
  useWorkflowStore,
  type AppView,
} from './store/workflow-store'
import {
  displayFormatLabels,
  fieldModuleLibrary,
  sectionModuleLibrary,
  standardDocumentCards,
  type ContentDocumentId,
} from './data/modules/standard-workflow-modules'

type UiCopy = {
  label: string
  detail: string
  example?: string
  recommended?: boolean
  advanced?: boolean
}

type AppMode = 'home' | 'learn' | 'build' | 'advanced'
type BuildStep = 0 | 1 | 2 | 3 | 4 | 5
type AppRoute = { mode: AppMode; step: BuildStep; view?: AppView }

type BuilderDraft = {
  workflowId: string
  projectName: string
  recoveryRisk: string
  firstAction: string
  selectedContentDocs: ContentDocumentId[]
  selectedCanvasDocumentId: string
  reviewedDocumentIds: string[]
  protocolNeedsInitialGeneration: boolean
  hasBuilderProject: boolean
  protocolBaselineFingerprint: string
  rulesBaselineFingerprint: string
}

const BUILDER_DRAFT_KEY_PREFIX = 'workflow-studio.builder-draft.v2'

function protocolFingerprint(workflow: WorkflowSchema): string {
  return JSON.stringify(workflow.documents.find((document) => document.role === 'protocol') ?? null)
}

function rulesFingerprint(workflow: WorkflowSchema): string {
  return JSON.stringify(workflow.rules)
}

function readBuilderDraft(workflow: WorkflowSchema): BuilderDraft {
  const fallback: BuilderDraft = {
    workflowId: workflow.workflowId,
    projectName: workflow.name,
    recoveryRisk: '目标、下一步和当前阻塞最容易丢失。',
    firstAction: '读取 STATUS.html，确认下一原子步骤。',
    selectedContentDocs: standardDocumentCards.filter((item) => item.recommended || item.required).map((item) => item.id),
    selectedCanvasDocumentId: 'content-status',
    reviewedDocumentIds: [],
    protocolNeedsInitialGeneration: false,
    hasBuilderProject: false,
    protocolBaselineFingerprint: protocolFingerprint(workflow),
    rulesBaselineFingerprint: rulesFingerprint(workflow),
  }
  try {
    const value = window.localStorage.getItem(`${BUILDER_DRAFT_KEY_PREFIX}.${workflow.workflowId}`)
    if (!value) return fallback
    const parsed = JSON.parse(value) as Partial<BuilderDraft>
    if (parsed.workflowId !== workflow.workflowId) return fallback
    const allowedIds = new Set(standardDocumentCards.map((item) => item.id))
    const selectedContentDocs = Array.isArray(parsed.selectedContentDocs)
      ? parsed.selectedContentDocs.filter((id): id is ContentDocumentId => allowedIds.has(id as ContentDocumentId))
      : fallback.selectedContentDocs
    return {
      workflowId: workflow.workflowId,
      projectName: typeof parsed.projectName === 'string' ? parsed.projectName : fallback.projectName,
      recoveryRisk: typeof parsed.recoveryRisk === 'string' ? parsed.recoveryRisk : fallback.recoveryRisk,
      firstAction: typeof parsed.firstAction === 'string' ? parsed.firstAction : fallback.firstAction,
      selectedContentDocs,
      selectedCanvasDocumentId: typeof parsed.selectedCanvasDocumentId === 'string' ? parsed.selectedCanvasDocumentId : fallback.selectedCanvasDocumentId,
      reviewedDocumentIds: Array.isArray(parsed.reviewedDocumentIds)
        ? parsed.reviewedDocumentIds.filter((id): id is string => typeof id === 'string')
        : [],
      protocolNeedsInitialGeneration: parsed.protocolNeedsInitialGeneration === true,
      hasBuilderProject: parsed.hasBuilderProject === true,
      protocolBaselineFingerprint: typeof parsed.protocolBaselineFingerprint === 'string' ? parsed.protocolBaselineFingerprint : fallback.protocolBaselineFingerprint,
      rulesBaselineFingerprint: typeof parsed.rulesBaselineFingerprint === 'string' ? parsed.rulesBaselineFingerprint : fallback.rulesBaselineFingerprint,
    }
  } catch {
    return fallback
  }
}

function routeFromHash(): AppRoute {
  const hash = window.location.hash.replace(/^#/, '')
  const buildMatch = hash.match(/^build\/step-([1-6])$/)
  if (buildMatch) return { mode: 'build', step: (Number(buildMatch[1]) - 1) as BuildStep }
  const advancedMatch = hash.match(/^advanced\/(overview|documents|rules|simulation|export)$/)
  if (advancedMatch) return { mode: 'advanced', step: 0, view: advancedMatch[1] as AppView }
  if (hash === 'advanced') return { mode: 'advanced', step: 0, view: 'overview' }
  if (hash === 'learn' || hash === 'home') return { mode: hash, step: 0 }
  return { mode: 'home', step: 0 }
}

function routeHash(mode: AppMode, step: BuildStep, view: AppView = 'overview'): string {
  if (mode === 'build') return `#build/step-${step + 1}`
  if (mode === 'advanced') return `#advanced/${view}`
  return `#${mode}`
}

const viewItems: { id: AppView; label: string; shortLabel: string; detail: string; icon: typeof Layers3 }[] = [
  { id: 'overview', label: '当前工作流能不能交付', shortLabel: '能否交付', detail: '查看阻塞项、必填清单和下一步建议。', icon: Layers3 },
  { id: 'documents', label: '写给未来模型看的资料', shortLabel: '未来资料', detail: '维护文档、章节、字段和当前内容。', icon: FilePlus2 },
  { id: 'rules', label: '规定未来模型怎么读、怎么裁决', shortLabel: '读取裁决', detail: '设置读取顺序、来源信任顺序和冲突处理。', icon: GitBranch },
  { id: 'simulation', label: '演练断线后如何恢复', shortLabel: '恢复演练', detail: '模拟新会话、上下文压缩和目标冲突。', icon: Play },
  { id: 'export', label: '生成可复制的工作流包', shortLabel: '生成包', detail: '预览文件结构并下载工作流包。', icon: FileArchive },
]

const learnChapters = [
  {
    title: '工作流是什么',
    question: '如果模型断线重开，它第一眼应该看哪里？',
    answer: '工作流是一套接手说明。它告诉未来模型先读什么、如何确认当前目标、冲突时信谁，以及交付前怎样检查。',
    example: '好写法：先读 AGENTS，再读状态，最后按需看历史。坏写法：把所有背景都堆在一个文件里。',
    mistake: '常见误区：把工作流写成项目介绍，未来模型读完仍不知道下一步该做什么。',
    help: '先把它想成接班说明。它不追求完整讲完项目，而是让未来模型在最短时间内恢复目标、边界和下一步。',
    action: '从用途说明开始',
    buildStep: 0 as BuildStep,
  },
  {
    title: '好工作流的标准',
    question: '怎样判断一套工作流是不是能交付？',
    answer: '它应该可恢复、少重复、职责清楚、状态不过期、历史可追溯，并且有能实际执行的验证方式。',
    example: '如果一个新会话只靠文档就能知道下一步做什么，这套工作流才算站得住。',
    mistake: '常见误区：文档很多，但同一事实散落在多处，更新时不知道该改哪一个。',
    help: '好工作流不是文件越多越好。每份材料只负责一种生命周期，当前事实替换当前事实，历史原因归入历史。',
    action: '从用途说明开始',
    buildStep: 0 as BuildStep,
  },
  {
    title: '常见材料分工',
    question: '为什么不能只写一个总说明？',
    answer: '不同信息会以不同速度变化。入口规则、长期计划、当前状态、用户偏好、历史和术语应该分开维护。',
    example: '当前目标会变，放状态里；长期范围相对稳定，放计划里；已经替换的方案，放历史里。',
    mistake: '常见误区：把当前下一步写进长期计划，几天后计划看起来正式但已经过期。',
    help: '判断材料时先看变化速度。会很快变的是状态，长期有效的是计划，只解释词义的是术语。',
    action: '去选择内容文档',
    buildStep: 1 as BuildStep,
  },
  {
    title: '字段怎么判断',
    question: '看到一个字段时，我到底该写什么？',
    answer: '先问四件事：这条信息给谁看、多久会变、缺了还能不能恢复、未来模型会用它判断什么。',
    example: '“下一原子步骤”不是普通待办，而是恢复后可以立刻执行的唯一动作。',
    mistake: '常见误区：把字段当成填空题，能写多少写多少，最后反而让恢复路径变慢。',
    help: '字段只保留会影响恢复或判断的信息。写入前问一句：未来模型会不会靠它决定下一步？',
    action: '先定义恢复动作',
    buildStep: 0 as BuildStep,
  },
  {
    title: '冲突时信谁',
    question: '用户刚说的话和文档冲突时怎么办？',
    answer: '默认优先相信最新明确用户指令，其次是新鲜工作区事实，再看状态、计划、偏好和历史。',
    example: '用户刚要求改目标时，不要被旧状态文档覆盖；旧状态应更新或归档。',
    mistake: '常见误区：把旧历史当成当前命令，导致模型沿着已经废弃的方案继续做。',
    help: '冲突裁决要看来源和新鲜度。历史解释为什么变成现在，但不能覆盖最新目标。',
    action: '先选择恢复材料',
    buildStep: 1 as BuildStep,
  },
  {
    title: '怎么验收和导出',
    question: '完成后怎样知道它真的可用？',
    answer: '至少跑一次恢复演练，修掉阻塞项，确认导出的 ZIP 里有 workflow.json、README 和主维护文档。',
    example: '导出不是保存网页，而是生成能复制到项目里的工作流包。',
    mistake: '常见误区：只看页面没有红色错误，就直接导出；但未来模型可能仍不知道如何恢复。',
    help: '验收要模拟真实恢复：假设新模型只拿到导出包，它能不能按入口规则找到状态、历史和下一步。',
    action: '从完整搭建流程开始',
    buildStep: 0 as BuildStep,
  },
]

const scenarioOptions = Object.keys(scenarioLabels) as SimulationScenario[]
let didInitialize = false

const documentRoleCopy: Record<WorkflowDocument['role'], UiCopy> = {
  protocol: { label: '恢复入口与总规则', detail: '规定未来模型如何恢复、按什么优先级行动。', example: 'AGENTS.md', recommended: true },
  plan: { label: '长期计划', detail: '记录目标、范围、阶段、稳定约束。', example: 'SPEC.html' },
  status: { label: '当前状态', detail: '记录当前目标、下一步、阻塞和恢复指针。', example: 'STATUS.html', recommended: true },
  preference: { label: '长期用户偏好', detail: '记录跨任务稳定偏好，不记录一次性要求。', example: 'USER.html' },
  history: { label: '历史演变', detail: '保存决策、废弃方案、替代关系。', example: 'MEMORY.html' },
  context: { label: '术语解释', detail: '解释项目术语，不记录实时状态。', example: 'CONTEXT.html' },
  validation: { label: '验收/检查规则', detail: '单独维护测试、质量门禁或审查规则。', example: 'CHECKS.html', advanced: true },
  custom: { label: '自定义文档', detail: '上述类型都不贴合时使用，并写清职责边界。', example: 'RESEARCH.html', advanced: true },
}

const lifecycleCopy: Record<WorkflowDocument['lifecycle'], UiCopy> = {
  realtime: { label: '会过期的当前信息', detail: '适合当前目标、下一步、实时阻塞。' },
  stable: { label: '长期稳定计划', detail: '适合使命、范围、成功标准、阶段计划。', recommended: true },
  historical: { label: '历史归档', detail: '适合已发生且用于理解演变的信息。' },
  preference: { label: '长期偏好', detail: '适合用户反复确认、影响多数任务的偏好。' },
  reference: { label: '参考解释', detail: '适合术语、定义、背景知识。' },
  validation: { label: '检查规则', detail: '适合测试、验收、门禁、审查项。' },
  mixed: { label: '复合信息，需写清边界', detail: '确实横跨多种生命周期时使用。', advanced: true },
}

const fieldTypeCopy: Record<WorkflowField['type'], UiCopy> = {
  shortText: { label: '短文本', detail: '一句话、名称、短标签。', example: '当前目标' },
  longText: { label: '长文本', detail: '说明、规则、段落内容。', example: '职责说明', recommended: true },
  richText: { label: '带格式文本', detail: '需要列表、强调或结构化段落。', example: '完成协议' },
  select: { label: '单选', detail: '只能从一个固定选项中选择。', example: '导出格式' },
  multiSelect: { label: '多选', detail: '可以同时选择多个固定选项。', example: '适用场景' },
  boolean: { label: '是/否', detail: '二元开关。', example: '是否必填' },
  date: { label: '日期', detail: '明确日期或时间点。', example: '审查日期' },
  path: { label: '路径', detail: '本地目录、文件或仓库路径。', example: 'D:\\codex\\...' },
  url: { label: '链接', detail: '网页、仓库、文档地址。', example: 'GitHub 仓库' },
  email: { label: '邮箱', detail: '需要邮箱格式校验。', example: '作者邮箱' },
  code: { label: '代码/命令', detail: '命令、配置、代码片段。', example: 'npm run test' },
  list: { label: '列表', detail: '多条同类文本。', example: '恢复读取顺序' },
  table: { label: '表格', detail: '多列结构化条目。', example: '来源优先级', advanced: true },
  reference: { label: '引用其他对象', detail: '字段值指向文档、章节或规则。', example: '关联文档', advanced: true },
}

const sourceTypeCopy: Record<SourceRef['sourceType'], UiCopy> = {
  'latest-user-instruction': { label: '最新明确用户指令', detail: '用户刚刚说的目标、纠正或限制。', recommended: true },
  'workspace-fact': { label: '新鲜工作区事实', detail: '文件、命令、测试、截图等当前可验证事实。', recommended: true },
  'current-status': { label: '当前状态文档', detail: '状态快照里的当前目标、下一步和阻塞。' },
  'stable-plan': { label: '稳定计划文档', detail: '使命、范围、阶段、长期约束。' },
  'user-preference': { label: '长期用户偏好', detail: '跨任务稳定偏好。' },
  'session-history': { label: '当前会话历史', detail: '恢复文档不足时的补充。', advanced: true },
  'memory-history': { label: '项目历史档案', detail: '理解演变，不判断当前状态。', advanced: true },
  'context-reference': { label: '术语参考', detail: '只解释术语，不覆盖事实。', advanced: true },
  'older-history': { label: '更早历史', detail: '极少数溯源场景。', advanced: true },
}

const recencyPolicyCopy: Record<SourceRef['recencyPolicy'], UiCopy> = {
  'prefer-newer': { label: '优先相信更新的信息', detail: '适合用户指令和工作区事实。', recommended: true },
  'ignore-recency': { label: '不按新旧判断', detail: '适合稳定计划和术语解释。' },
  manual: { label: '需要人工判断', detail: '适合复杂冲突。', advanced: true },
}

const conflictActionCopy: Record<WorkflowSchema['rules']['conflictPolicy']['defaultAction'], UiCopy> = {
  'apply-source-priority': { label: '按来源排序自动裁决', detail: '默认按信任顺序选择信息。', recommended: true },
  'ask-user': { label: '不确定时询问用户', detail: '适合敏感或无法自动裁决的决策。' },
  'block-until-resolved': { label: '冲突未解决就停止', detail: '适合高风险工作流。', advanced: true },
}

const obsoleteHandlingCopy: Record<WorkflowSchema['rules']['historyPolicy']['obsoleteHandling'], UiCopy> = {
  'mark-obsolete': { label: '标记为失效', detail: '保留历史，但明确不可作为当前依据。', recommended: true },
  'archive-with-replacement': { label: '归档并写明替代关系', detail: '适合重要决策或方案替换。' },
  delete: { label: '删除旧记录', detail: '仅用于非历史垃圾内容。', advanced: true },
}

const maintenanceFormatCopy: Record<MaintenanceFormat, UiCopy> = {
  html: { label: 'HTML 文档（推荐主格式）', detail: '适合浏览器阅读和模型定位字段。', recommended: true },
  markdown: { label: 'Markdown 文档（推荐次级格式）', detail: '适合纯文本仓库和 diff。' },
}

function statusLabel(status: string): string {
  if (status === 'saved') return '已保存'
  if (status === 'saving') return '保存中'
  if (status === 'failed') return '保存失败'
  if (status === 'memory') return '内存模式'
  return '加载中'
}

function severityLabel(severity: ValidationIssue['severity']): string {
  if (severity === 'error') return 'Error'
  if (severity === 'warning') return 'Warning'
  if (severity === 'suggestion') return 'Suggestion'
  return 'Pass'
}

function formatProjectDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function confirmDelete(label: string): boolean {
  return window.confirm(`确认删除${label}？此操作会立即改变当前工作流。`)
}

function optionsToText(options: FieldOption[] | undefined): string {
  return options?.map((option) => [option.value, option.label, option.description ?? ''].join(' | ').replace(/\s+\|\s+$/, '')).join('\n') ?? ''
}

function parseOptionsText(text: string): FieldOption[] | undefined {
  const options = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, label, description] = line.split('|').map((part) => part.trim())
      return { value, label: label || value, description: description || undefined }
    })
    .filter((option) => option.value.length > 0)
  return options.length > 0 ? options : undefined
}

function customRulesToText(rules: ValidationRule[]): string {
  return rules.map((rule) => [rule.severity, rule.predicate, rule.description].join(' | ')).join('\n')
}

function parseCustomRulesText(text: string): ValidationRule[] {
  return text.split(/\r?\n/)
    .map((line, index) => {
      const [severityInput, predicateInput, descriptionInput] = line.split('|').map((part) => part.trim())
      const severity = ['error', 'warning', 'suggestion'].includes(severityInput) ? severityInput as ValidationRule['severity'] : 'warning'
      const predicate = ['non-empty', 'valid-path', 'valid-url', 'valid-email', 'matches-pattern', 'custom'].includes(predicateInput)
        ? predicateInput as ValidationRule['predicate']
        : 'custom'
      const description = descriptionInput || predicateInput || severityInput
      if (!description) return undefined
      return { id: `custom-${index + 1}`, severity, predicate, description }
    })
    .filter((rule): rule is ValidationRule => Boolean(rule))
}

function fieldInstances(field: WorkflowField) {
  if (field.value.kind === 'list') return field.value.value
  const text = fieldValueToText(field.value)
  return text.trim().length === 0 ? [] : [field.value]
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function downloadText(content: string, filename: string, type = 'application/json'): void {
  downloadBlob(new Blob([content], { type }), filename)
}

function selectedDocument(workflow: WorkflowSchema, selectedDocumentId: string): WorkflowDocument | undefined {
  return workflow.documents.find((document) => document.id === selectedDocumentId) ?? workflow.documents[0]
}

function selectedField(workflow: WorkflowSchema, documentId: string, sectionId?: string, fieldId?: string): WorkflowField | undefined {
  return workflow.documents
    .find((document) => document.id === documentId)
    ?.sections.find((section) => section.id === sectionId)
    ?.fields.find((field) => field.id === fieldId)
}

function ModuleFieldEditor({
  document,
  section,
  field,
  index,
  total,
  onDirty,
}: {
  document: WorkflowDocument
  section: WorkflowSection
  field: WorkflowField
  index: number
  total: number
  onDirty: (location: string) => void
}) {
  const updateField = useWorkflowStore((state) => state.updateField)
  const updateFieldText = useWorkflowStore((state) => state.updateFieldText)
  const duplicateField = useWorkflowStore((state) => state.duplicateField)
  const moveField = useWorkflowStore((state) => state.moveField)
  const removeField = useWorkflowStore((state) => state.removeField)
  const location = `${document.filename} > ${section.title} > ${field.label}`

  function markAndRun(action: () => void, nextLocation = location) {
    action()
    onDirty(nextLocation)
  }

  return (
    <article className="module-field-editor">
      <div className="module-editor-heading">
        <span className="kicker">字段 {index + 1}</span>
        <div className="module-icon-actions" aria-label={`${field.label} 字段操作`}>
          <button type="button" className="icon-button compact-icon" title="上移字段" aria-label={`上移字段 ${field.label}`} disabled={index === 0} onClick={() => markAndRun(() => moveField(document.id, section.id, field.id, -1))}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button compact-icon" title="下移字段" aria-label={`下移字段 ${field.label}`} disabled={index === total - 1} onClick={() => markAndRun(() => moveField(document.id, section.id, field.id, 1))}>
            <ArrowDown size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button compact-icon" title="复制字段" aria-label={`复制字段 ${field.label}`} onClick={() => markAndRun(() => duplicateField(document.id, section.id, field.id))}>
            <Copy size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button compact-icon danger" title="删除字段" aria-label={`删除字段 ${field.label}`} onClick={() => {
            if (confirmDelete(`字段 ${field.label}`)) markAndRun(() => removeField(document.id, section.id, field.id))
          }}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="module-field-form">
        <label>
          字段名称
          <input
            name={`${field.id}-label`}
            autoComplete="off"
            value={field.label}
            onChange={(event) => {
              const nextLabel = event.currentTarget.value
              markAndRun(
                () => updateField(document.id, section.id, field.id, { label: nextLabel }),
                `${document.filename} > ${section.title} > ${nextLabel || '未命名字段'}`,
              )
            }}
          />
          <small>用未来模型一眼能判断用途的名称，例如“下一原子步骤”。</small>
        </label>
        <label>
          常驻说明
          <textarea
            name={`${field.id}-guidance`}
            autoComplete="off"
            rows={3}
            value={field.guidance}
            onChange={(event) => markAndRun(() => updateField(document.id, section.id, field.id, { guidance: event.currentTarget.value }))}
          />
          <small>说明应该写什么、何时更新和未来模型如何使用；填写内容后仍会保留。</small>
        </label>
        <label className="field-value-editor">
          当前内容
          <textarea
            name={`${field.id}-value`}
            autoComplete="off"
            rows={Math.min(8, Math.max(3, fieldValueToText(field.value).split('\n').length + 1))}
            value={fieldValueToText(field.value)}
            placeholder="例如：运行测试并记录结果…"
            onChange={(event) => markAndRun(() => updateFieldText(document.id, section.id, field.id, event.currentTarget.value))}
          />
        </label>
        <div className="field-setting-row">
          <label>
            展示方式
            <select
              name={`${field.id}-display-format`}
              value={field.displayFormat ?? 'paragraph'}
              onChange={(event) => markAndRun(() => updateField(document.id, section.id, field.id, { displayFormat: event.currentTarget.value as WorkflowField['displayFormat'] }))}
            >
              {Object.entries(displayFormatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <small>只改变导出后的阅读形式，不改变字段含义。</small>
          </label>
          <label className="check-row module-required-check">
            <input
              name={`${field.id}-required`}
              type="checkbox"
              checked={field.required && !field.allowEmpty}
              onChange={(event) => markAndRun(() => updateField(document.id, section.id, field.id, { required: event.currentTarget.checked, allowEmpty: !event.currentTarget.checked }))}
            />
            <span>导出前必须填写</span>
          </label>
        </div>
      </div>
    </article>
  )
}

function ModuleSectionEditor({
  document,
  section,
  index,
  total,
  onDirty,
}: {
  document: WorkflowDocument
  section: WorkflowSection
  index: number
  total: number
  onDirty: (location: string) => void
}) {
  const updateSection = useWorkflowStore((state) => state.updateSection)
  const duplicateSection = useWorkflowStore((state) => state.duplicateSection)
  const moveSection = useWorkflowStore((state) => state.moveSection)
  const removeSection = useWorkflowStore((state) => state.removeSection)
  const addField = useWorkflowStore((state) => state.addField)
  const addFieldFromModule = useWorkflowStore((state) => state.addFieldFromModule)
  const availableFields = fieldModuleLibrary.filter((module) => module.targetRoles.includes(document.role))
  const sectionLocation = `${document.filename} > ${section.title}`

  function markAndRun(action: () => void, location = sectionLocation) {
    action()
    onDirty(location)
  }

  return (
    <article className="canvas-section-card module-section-editor">
      <div className="module-editor-heading section-editor-heading">
        <span className="kicker">章节 {index + 1}</span>
        <div className="module-icon-actions" aria-label={`${section.title} 章节操作`}>
          <button type="button" className="icon-button compact-icon" title="上移章节" aria-label={`上移章节 ${section.title}`} disabled={index === 0} onClick={() => markAndRun(() => moveSection(document.id, section.id, -1))}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button compact-icon" title="下移章节" aria-label={`下移章节 ${section.title}`} disabled={index === total - 1} onClick={() => markAndRun(() => moveSection(document.id, section.id, 1))}>
            <ArrowDown size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button compact-icon" title="复制章节" aria-label={`复制章节 ${section.title}`} onClick={() => markAndRun(() => duplicateSection(document.id, section.id))}>
            <Copy size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button compact-icon danger" title="删除章节" aria-label={`删除章节 ${section.title}`} onClick={() => {
            const confirmed = document.role === 'protocol'
              ? window.confirm(`确认删除入口协议模块“${section.title}”？删除核心模块会让协议无法进入预览，直到你补回相应内容。`)
              : confirmDelete(`章节 ${section.title}`)
            if (confirmed) markAndRun(() => removeSection(document.id, section.id))
          }}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="section-meta-form">
        <label>
          章节名称
          <input name={`${section.id}-title`} autoComplete="off" value={section.title} onChange={(event) => {
            const nextTitle = event.currentTarget.value
            markAndRun(
              () => updateSection(document.id, section.id, { title: nextTitle }),
              `${document.filename} > ${nextTitle || '未命名章节'}`,
            )
          }} />
        </label>
        <label>
          这一章负责什么
          <textarea name={`${section.id}-purpose`} autoComplete="off" rows={2} value={section.purpose} onChange={(event) => markAndRun(() => updateSection(document.id, section.id, { purpose: event.currentTarget.value }))} />
          <small>只写职责边界，不把当前项目事实塞进这里。</small>
        </label>
      </div>
      <div className="canvas-field-list">
        {section.fields.map((field, fieldIndex) => (
          <ModuleFieldEditor
            key={field.id}
            document={document}
            section={section}
            field={field}
            index={fieldIndex}
            total={section.fields.length}
            onDirty={onDirty}
          />
        ))}
        {section.fields.length === 0 ? <p className="inline-empty">这个章节还没有字段。先添加一个自定义字段，才能写入内容。</p> : null}
      </div>
      <div className="field-library-band">
        <div>
          <strong>向本章加入字段</strong>
          <p>预设字段只可加入一次；需要相似字段时，先复制现有字段再改名。</p>
        </div>
        <div className="module-button-row">
          {availableFields.map((module) => {
            const alreadyPresent = section.fields.some((field) => field.label === module.label && field.guidance === module.guidance)
            return (
              <button
                key={module.id}
                type="button"
                className="button button-ghost"
                disabled={alreadyPresent}
                title={alreadyPresent ? '本章已经有这个预设字段' : displayFormatLabels[module.displayFormat]}
                onClick={() => markAndRun(() => addFieldFromModule(document.id, section.id, module.id), `${document.filename} > ${section.title} > ${module.label}`)}
              >
                <Plus size={15} aria-hidden="true" />
                {alreadyPresent ? `${module.label}（已加入）` : module.label}
              </button>
            )
          })}
          <button type="button" className="button button-secondary" onClick={() => markAndRun(() => addField(document.id, section.id), `${document.filename} > ${section.title} > 新字段`)}>
            <Plus size={15} aria-hidden="true" />
            自定义字段
          </button>
        </div>
      </div>
    </article>
  )
}

function DocumentPreview({ filename, content }: { filename?: string; content?: string }) {
  if (!filename || !content) return <p className="inline-empty">没有可预览的导出内容。</p>
  if (/\.html?$/i.test(filename)) {
    return <iframe className="document-preview-frame" title={`${filename} 渲染预览`} sandbox="" srcDoc={content} />
  }
  return <pre className="code-preview markdown-preview">{content}</pre>
}

function HomePage({ onLearn, onBuild, onAdvanced }: { onLearn: () => void; onBuild: () => void; onAdvanced: () => void }) {
  return (
    <main className="onboarding-main" id="main-workspace">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-copy">
          <span className="kicker">Workflow Studio</span>
          <h1 id="home-title">为未来<span className="semantic-unit">接手项目</span>的模型，留下一套清楚的<span className="semantic-unit">工作流</span>。</h1>
          <p>工作流的目的，是让模型知道始终该读什么、信什么、接着做什么。你会先选内容文档，再像搭积木一样设计每份文档。</p>
        </div>
        <div className="home-proof" aria-label="本地工作方式">
          <span>本地保存</span>
          <span>可导出 ZIP</span>
          <span>无后端上传</span>
        </div>
      </section>

      <section className="home-entry-grid" aria-label="开始方式">
        <article className="home-entry primary-entry">
          <span className="kicker">先理解</span>
          <h2>工作流入门</h2>
          <p>适合第一次使用、不确定文档职责，或还不知道为什么要先选内容文档的人。</p>
          <ul>
            <li>理解工作流是什么。</li>
            <li>看懂标准内容文档分工。</li>
            <li>弄清模块、字段说明和入口协议草案。</li>
          </ul>
          <button type="button" className="button button-primary" onClick={onLearn}>
            进入工作流入门
          </button>
        </article>
        <article className="home-entry">
          <span className="kicker">开始产出</span>
          <h2>工作流搭建</h2>
          <p>适合已经有项目目标，想通过文档选择、模块画布和协议草案审查生成工作流包的人。</p>
          <ul>
            <li>选择需要的内容文档。</li>
            <li>逐文档添加章节和字段模块。</li>
            <li>演练后导出工作流包。</li>
          </ul>
          <button type="button" className="button button-secondary" onClick={onBuild}>
            开始搭建工作流
          </button>
        </article>
      </section>

      <section className="home-afterword">
        <div>
          <h2>已经熟悉这套结构？</h2>
          <p>高级编辑仍然保留，用来手动调整文档、字段、规则、恢复演练和导出格式。</p>
        </div>
        <button type="button" className="button button-ghost" onClick={onAdvanced}>
          打开高级编辑
        </button>
      </section>
    </main>
  )
}

function LearnPage({ onBuild }: { onBuild: (step: BuildStep) => void }) {
  return (
    <main className="onboarding-main learn-main" id="main-workspace">
      <section className="editorial-hero" aria-labelledby="learn-title">
        <span className="kicker">Workflow Primer</span>
        <h1 id="learn-title">先弄懂工作流，再开始填内容。</h1>
        <p>工作流的目的，是让模型知道始终该读什么、信什么、接着做什么。</p>
        <p>下面这些章节解释搭建时最容易卡住的概念，你不需要记住底层字段名。</p>
      </section>
      <section className="primer-map" aria-label="模块化搭建方法">
        <article>
          <span className="kicker">01</span>
          <h2>先选内容文档</h2>
          <p>从稳定计划、状态快照、用户偏好、历史演变和术语解释中选择需要的文档。入口协议不要求你第一步手写。</p>
        </article>
        <article>
          <span className="kicker">02</span>
          <h2>再搭文档模块</h2>
          <p>每份文档像一块画布，你可以加入章节、字段、展示格式和常驻说明。模块加入后仍可继续编辑。</p>
        </article>
        <article>
          <span className="kicker">03</span>
          <h2>最后审查协议草案</h2>
          <p>系统根据内容文档自动生成 AGENTS.md 草案，你只需要检查它是否正确串联了读取顺序和更新规则。</p>
        </article>
      </section>
      <section className="lesson-list" aria-label="工作流入门章节">
        {learnChapters.map((chapter, index) => (
          <article className="lesson-card" key={chapter.title}>
            <span className="lesson-number">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <h2>{chapter.title}</h2>
              <p className="lesson-question">{chapter.question}</p>
              <p>{chapter.answer}</p>
              <p className="lesson-example">{chapter.example}</p>
              <p className="lesson-mistake">{chapter.mistake}</p>
              <details className="lesson-help">
                <summary>看不懂这里</summary>
                <p>{chapter.help}</p>
              </details>
              <button type="button" className="button button-secondary lesson-action" onClick={() => onBuild(chapter.buildStep)}>
                {chapter.action}
              </button>
            </div>
          </article>
        ))}
      </section>
      <section className="learn-cta">
        <div>
          <h2>读完这些概念后，就可以开始搭建。</h2>
          <p>搭建流程会继续用自然语言提问，并在需要时把你带回对应的入门章节。</p>
        </div>
        <button type="button" className="button button-primary" onClick={() => onBuild(0)}>
          去工作流搭建
        </button>
      </section>
    </main>
  )
}

function BuildWizard({
  step,
  onStepChange,
  onLearn,
  onAdvanced,
}: {
  step: BuildStep
  onStepChange: (step: BuildStep) => void
  onLearn: () => void
  onAdvanced: (view: AppView) => void
}) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const createModularProject = useWorkflowStore((state) => state.createModularProject)
  const importProject = useWorkflowStore((state) => state.importProject)
  const addSectionFromModule = useWorkflowStore((state) => state.addSectionFromModule)
  const updateDocument = useWorkflowStore((state) => state.updateDocument)
  const addSection = useWorkflowStore((state) => state.addSection)
  const refreshProtocolDraft = useWorkflowStore((state) => state.refreshProtocolDraft)
  const [initialDraft] = useState(() => readBuilderDraft(workflow))
  const [projectName, setProjectName] = useState(initialDraft.projectName)
  const [recoveryRisk, setRecoveryRisk] = useState(initialDraft.recoveryRisk)
  const [firstAction, setFirstAction] = useState(initialDraft.firstAction)
  const [selectedContentDocs, setSelectedContentDocs] = useState<Set<ContentDocumentId>>(
    () => new Set(initialDraft.selectedContentDocs),
  )
  const [selectedCanvasDocumentId, setSelectedCanvasDocumentId] = useState(initialDraft.selectedCanvasDocumentId)
  const [reviewedDocumentIds, setReviewedDocumentIds] = useState<Set<string>>(() => new Set(initialDraft.reviewedDocumentIds))
  const [protocolNeedsInitialGeneration, setProtocolNeedsInitialGeneration] = useState(initialDraft.protocolNeedsInitialGeneration)
  const [hasBuilderProject, setHasBuilderProject] = useState(initialDraft.hasBuilderProject)
  const [protocolBaseline, setProtocolBaseline] = useState(initialDraft.protocolBaselineFingerprint)
  const [rulesBaseline, setRulesBaseline] = useState(initialDraft.rulesBaselineFingerprint)
  const [latestWriteTarget, setLatestWriteTarget] = useState('先选择一份文档。')
  const [isGenerating, setIsGenerating] = useState(false)
  const [generatedMessage, setGeneratedMessage] = useState('')
  const importInputRef = useRef<HTMLInputElement>(null)
  const stepperRef = useRef<HTMLOListElement>(null)
  const draftWorkflowIdRef = useRef(initialDraft.workflowId)
  const skipDraftSaveRef = useRef(false)
  const contentDocuments = workflow.documents.filter((document) => document.role !== 'protocol')
  const canvasDocument = contentDocuments.find((document) => document.id === selectedCanvasDocumentId) ?? contentDocuments[0]
  const protocolDocument = workflow.documents.find((document) => document.role === 'protocol')
  const validationIssues = useMemo(() => validateWorkflow(workflow), [workflow])
  const primaryDocs = useMemo(() => exportDocumentsForFormat(workflow, 'html'), [workflow])
  const firstPreview = Object.entries(primaryDocs).find(([filename]) => filename.endsWith('.html')) ?? Object.entries(primaryDocs)[0]
  const rehearsal = useMemo(() => simulateRecovery(workflow, 'new-session'), [workflow])
  const currentDocumentErrors = canvasDocument
    ? validationIssues.filter((issue) => issue.severity === 'error' && issue.target.documentId === canvasDocument.id)
    : []
  const protocolErrors = protocolDocument
    ? validationIssues.filter((issue) => issue.severity === 'error' && issue.target.documentId === protocolDocument.id)
    : validationIssues.filter((issue) => issue.severity === 'error' && issue.ruleId.includes('protocol'))
  const blockingErrors = validationIssues.filter((issue) => issue.severity === 'error')
  const contentStageErrors = validationIssues.filter((issue) => issue.severity === 'error' && (
    (issue.target.documentId && contentDocuments.some((document) => document.id === issue.target.documentId)) ||
    (!issue.target.documentId && (
      issue.ruleId.startsWith('structure-') ||
      issue.ruleId.startsWith('export-') ||
      issue.ruleId.startsWith('recovery-next-atomic-step') ||
      issue.ruleId === 'recovery-realtime-status'
    ))
  ))
  const reviewedDocumentCount = contentDocuments.filter((document) => reviewedDocumentIds.has(document.id)).length
  const allContentDocumentsReviewed = contentDocuments.length > 0 && contentDocuments.every((document) => reviewedDocumentIds.has(document.id))
  const contentStageReady = allContentDocumentsReviewed && contentStageErrors.length === 0

  function initialWriteTargetFor(document: WorkflowDocument): string {
    const section = document.sections[0]
    const field = section?.fields[0]
    if (section && field) return `${document.filename} > ${section.title} > ${field.label}`
    if (section) return `${document.filename} > ${section.title}`
    return `${document.filename} > 文档职责`
  }

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 })
    const timer = window.setTimeout(() => {
      const heading = document.querySelector<HTMLElement>('.builder-step h2')
      heading?.focus({ preventScroll: true })
      const stepper = stepperRef.current
      const activeStep = stepper?.querySelector<HTMLElement>('li.active')
      if (stepper && activeStep) {
        const centeredLeft = activeStep.offsetLeft - (stepper.clientWidth - activeStep.clientWidth) / 2
        stepper.scrollTo({ left: Math.max(0, centeredLeft), behavior: 'auto' })
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [step])

  useEffect(() => {
    if (draftWorkflowIdRef.current === workflow.workflowId) return
    const nextDraft = readBuilderDraft(workflow)
    draftWorkflowIdRef.current = workflow.workflowId
    skipDraftSaveRef.current = true
    setProjectName(nextDraft.projectName)
    setRecoveryRisk(nextDraft.recoveryRisk)
    setFirstAction(nextDraft.firstAction)
    setSelectedContentDocs(new Set(nextDraft.selectedContentDocs))
    setSelectedCanvasDocumentId(nextDraft.selectedCanvasDocumentId)
    setReviewedDocumentIds(new Set(nextDraft.reviewedDocumentIds))
    setProtocolNeedsInitialGeneration(nextDraft.protocolNeedsInitialGeneration)
    setHasBuilderProject(nextDraft.hasBuilderProject)
    setProtocolBaseline(nextDraft.protocolBaselineFingerprint)
    setRulesBaseline(nextDraft.rulesBaselineFingerprint)
  }, [workflow])

  useEffect(() => {
    if (skipDraftSaveRef.current) {
      skipDraftSaveRef.current = false
      return
    }
    const draft: BuilderDraft = {
      workflowId: workflow.workflowId,
      projectName,
      recoveryRisk,
      firstAction,
      selectedContentDocs: [...selectedContentDocs],
      selectedCanvasDocumentId,
      reviewedDocumentIds: [...reviewedDocumentIds],
      protocolNeedsInitialGeneration,
      hasBuilderProject,
      protocolBaselineFingerprint: protocolBaseline,
      rulesBaselineFingerprint: rulesBaseline,
    }
    try {
      window.localStorage.setItem(`${BUILDER_DRAFT_KEY_PREFIX}.${workflow.workflowId}`, JSON.stringify(draft))
    } catch {
      // IndexedDB still stores the generated workflow when localStorage is unavailable.
    }
  }, [firstAction, hasBuilderProject, projectName, protocolBaseline, protocolNeedsInitialGeneration, recoveryRisk, reviewedDocumentIds, rulesBaseline, selectedCanvasDocumentId, selectedContentDocs, workflow.workflowId])

  useEffect(() => {
    if (step !== 2 || !canvasDocument) return
    setLatestWriteTarget((current) => {
      if (current !== '先选择一份文档。' && current.startsWith(`${canvasDocument.filename} >`)) return current
      return initialWriteTargetFor(canvasDocument)
    })
  }, [canvasDocument, step])

  useEffect(() => {
    if (contentDocuments[0] && !contentDocuments.some((document) => document.id === selectedCanvasDocumentId)) {
      setSelectedCanvasDocumentId(contentDocuments[0].id)
    }
  }, [contentDocuments, selectedCanvasDocumentId])

  function goToStep(nextStep: BuildStep) {
    onStepChange(nextStep)
  }

  function markDocumentDirty(documentId: string, location: string) {
    setReviewedDocumentIds((current) => {
      if (!current.has(documentId)) return current
      const next = new Set(current)
      next.delete(documentId)
      return next
    })
    setLatestWriteTarget(location)
    setGeneratedMessage('改动已保存为本地草稿；请完成后重新标记这份文档为已检查。')
  }

  async function createFromDocumentSelection(nextStep: BuildStep = 2) {
    if (selectedContentDocs.size === 0) {
      setGeneratedMessage('请至少选择 1 份内容文档；AGENTS.md 会在这些文档设计完成后自动生成。')
      return
    }
    if (hasBuilderProject && !window.confirm('重新生成文档会替换当前模块画布和入口协议草案。确认放弃现有搭建内容并继续？')) return
    setIsGenerating(true)
    try {
      await createModularProject({
        name: projectName,
        description: `恢复风险：${recoveryRisk.trim() || '目标、下一步和当前阻塞最容易丢失。'} 恢复后第一动作：${firstAction.trim() || '读取状态并确认下一步。'}`,
        selectedDocumentIds: selectedContentDocs,
        firstAction,
        recoveryRisk,
      })
      const createdWorkflow = useWorkflowStore.getState().workflow
      draftWorkflowIdRef.current = createdWorkflow.workflowId
      setSelectedCanvasDocumentId(createdWorkflow.documents.find((document) => document.role !== 'protocol')?.id ?? '')
      setReviewedDocumentIds(new Set())
      setProtocolNeedsInitialGeneration(true)
      setHasBuilderProject(true)
      setProtocolBaseline(protocolFingerprint(createdWorkflow))
      setRulesBaseline(rulesFingerprint(createdWorkflow))
      setGeneratedMessage('已根据所选内容文档生成工作流；入口协议草案已经后置生成，稍后可审查。')
      goToStep(nextStep)
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleImportStart(file: File | undefined) {
    if (!file) return
    setIsGenerating(true)
    try {
      await importProject(file)
      const importedWorkflow = useWorkflowStore.getState().workflow
      draftWorkflowIdRef.current = importedWorkflow.workflowId
      const importedContentDocuments = importedWorkflow.documents.filter((document) => document.role !== 'protocol')
      const importedIds = importedContentDocuments
        .map((document) => document.id.replace(/^content-/, ''))
        .filter((id): id is ContentDocumentId => standardDocumentCards.some((card) => card.id === id))
      setSelectedContentDocs(new Set(importedIds))
      setSelectedCanvasDocumentId(importedContentDocuments[0]?.id ?? '')
      setReviewedDocumentIds(new Set())
      setProtocolNeedsInitialGeneration(false)
      setHasBuilderProject(true)
      setProtocolBaseline(protocolFingerprint(importedWorkflow))
      setRulesBaseline(rulesFingerprint(importedWorkflow))
      setGeneratedMessage(`已导入 ${file.name}。你可以在模块画布中检查文档职责，再审查入口协议。`)
      goToStep(2)
    } catch (error) {
      setGeneratedMessage(error instanceof Error ? error.message : '导入失败，请检查文件格式。')
    } finally {
      setIsGenerating(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  function toggleContentDocument(id: ContentDocumentId) {
    setSelectedContentDocs((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function addSectionModule(moduleId: string) {
    if (!canvasDocument) return
    const module = sectionModuleLibrary.find((item) => item.id === moduleId)
    addSectionFromModule(canvasDocument.id, moduleId)
    markDocumentDirty(canvasDocument.id, `${canvasDocument.filename} > ${module?.title ?? '新章节'}`)
    setGeneratedMessage('已添加章节模块。你可以继续改标题、字段和值槽。')
  }

  function addCustomSection() {
    if (!canvasDocument) return
    addSection(canvasDocument.id)
    markDocumentDirty(canvasDocument.id, `${canvasDocument.filename} > 新章节`)
    setGeneratedMessage('已添加自定义章节。请先改清章节名称和职责，再设计字段。')
  }

  function reviewProtocolDraft() {
    if (!contentStageReady) {
      setGeneratedMessage(contentStageErrors.length > 0 ? '仍有内容文档或文件名错误，请按页面提示修复后再生成协议。' : '请逐份打开内容文档，并点击“标记这份文档已检查”。')
      return
    }
    if (protocolNeedsInitialGeneration) {
      const currentWorkflow = useWorkflowStore.getState().workflow
      const protocolWasEdited = protocolFingerprint(currentWorkflow) !== protocolBaseline
      const rulesWereEdited = rulesFingerprint(currentWorkflow) !== rulesBaseline
      const replaceProtocol = !protocolWasEdited || window.confirm('检测到 AGENTS.md 已被手工修改。是否仅用最终内容文档重新生成并覆盖入口协议？选择“取消”会保留手工协议。')
      const replaceRules = !rulesWereEdited || window.confirm('检测到恢复顺序、来源优先级或维护规则已被手工修改。是否重新生成并覆盖这些规则？选择“取消”会保留手工规则。')
      if (replaceProtocol || replaceRules) refreshProtocolDraft({ replaceProtocol, replaceRules })
      const reviewedWorkflow = useWorkflowStore.getState().workflow
      setProtocolBaseline(protocolFingerprint(reviewedWorkflow))
      setRulesBaseline(rulesFingerprint(reviewedWorkflow))
      setProtocolNeedsInitialGeneration(false)
      setGeneratedMessage(replaceProtocol && replaceRules
        ? '入口协议草案已根据最终内容文档生成。请审查文档清单、读取顺序、来源优先级、更新规则和完成检查。'
        : '已保留你选择不覆盖的手工协议或规则；请检查它们是否仍与最终内容文档一致。')
    } else {
      setGeneratedMessage('已保留当前入口协议草案，没有覆盖导入或手工修改。请继续审查各模块。')
    }
    goToStep(3)
  }

  function addProtocolModule() {
    if (!protocolDocument) return
    addSection(protocolDocument.id)
    setGeneratedMessage('已新增协议模块。请补充模块标题、用途和草案内容。')
  }

  function regenerateProtocolDraft() {
    const replaceProtocol = window.confirm('重新生成会覆盖当前 AGENTS.md 的全部模块和字段内容。确认覆盖入口协议吗？')
    const replaceRules = window.confirm('重新生成也可以覆盖恢复顺序、来源优先级、更新规则和完成检查。确认覆盖恢复规则吗？')
    if (!replaceProtocol && !replaceRules) return
    refreshProtocolDraft({ replaceProtocol, replaceRules })
    const refreshedWorkflow = useWorkflowStore.getState().workflow
    setProtocolBaseline(protocolFingerprint(refreshedWorkflow))
    setRulesBaseline(rulesFingerprint(refreshedWorkflow))
    setProtocolNeedsInitialGeneration(false)
    setGeneratedMessage(replaceProtocol && replaceRules
      ? '入口协议和恢复规则已重新生成；之前的手工修改已被替换。'
      : '已重新生成你确认覆盖的部分，另一部分继续保留手工内容。')
  }

  function openAdvanced(view: AppView) {
    onAdvanced(view)
  }

  const steps = ['确定用途', '选择文档', '模块画布', '协议草案', '结果预览', '演练导出']
  const purposeReady = projectName.trim().length > 0 && recoveryRisk.trim().length > 0 && firstAction.trim().length > 0

  function continueFromPurpose() {
    if (purposeReady) {
      goToStep(1)
      return
    }
    const firstInvalidId = !projectName.trim()
      ? 'builder-project-name'
      : !recoveryRisk.trim()
        ? 'builder-recovery-risk'
        : 'builder-first-action'
    document.getElementById(firstInvalidId)?.focus()
  }

  return (
    <main className="onboarding-main build-main" id="main-workspace">
      <section className="build-shell" aria-labelledby="build-title">
        <div className={step === 0 ? 'build-head' : 'build-head build-head-compact'}>
          <span className="kicker">Workflow Builder</span>
          {step === 0 ? (
            <>
              <h1 id="build-title" aria-label="像搭积木一样设计工作流。"><span className="line-lock">像搭积木一样</span><span className="line-lock">设计工作流。</span></h1>
              <p>先确定需要哪些内容文档，再逐份文档添加章节、字段、展示格式和常驻说明。入口协议草案由系统后置生成，你最后审查。</p>
            </>
          ) : (
            <>
              <h1 id="build-title">{projectName.trim() || '未命名工作流'}</h1>
              <p>当前步骤：{steps[step]}。草稿和当前位置会保存在本机。</p>
            </>
          )}
        </div>
        <ol ref={stepperRef} className="stepper" aria-label="搭建步骤">
          {steps.map((label, index) => (
            <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>
              <button
                type="button"
                aria-current={index === step ? 'step' : undefined}
                disabled={index > step}
                onClick={() => goToStep(index as BuildStep)}
              >
                <span>{index + 1}</span>
                <strong>{label}</strong>
              </button>
            </li>
          ))}
        </ol>

        <div className="builder-panel">
          {step === 0 ? (
            <section className="builder-step" aria-labelledby="start-title">
              <span className="kicker">Step 1</span>
              <h2 id="start-title" tabIndex={-1}>先说清这套工作流要帮谁接手什么。</h2>
              <p>工作流的目的，是让模型知道始终该读什么、信什么、接着做什么。这里先收集最少信息，下一步再选择内容文档。</p>
              {generatedMessage ? <p className="notice" aria-live="polite">{generatedMessage}</p> : null}
              <div className="question-form">
                <label>
                  这个工作流服务哪个项目或任务？
                  <input id="builder-project-name" name="builder-project-name" aria-label="这个工作流服务哪个项目或任务？" aria-invalid={!projectName.trim()} aria-describedby={!projectName.trim() ? 'builder-project-name-error' : undefined} autoComplete="off" value={projectName} onChange={(event) => setProjectName(event.currentTarget.value)} />
                  {!projectName.trim() ? <small id="builder-project-name-error" className="field-error" role="alert">请写一个能识别的项目或任务名称。</small> : null}
                </label>
                <label>
                  未来模型恢复时最容易丢失什么信息？
                  <textarea id="builder-recovery-risk" name="builder-recovery-risk" aria-label="未来模型恢复时最容易丢失什么信息？" aria-invalid={!recoveryRisk.trim()} aria-describedby={!recoveryRisk.trim() ? 'builder-recovery-risk-error' : undefined} autoComplete="off" rows={3} value={recoveryRisk} onChange={(event) => setRecoveryRisk(event.currentTarget.value)} />
                  {!recoveryRisk.trim() ? <small id="builder-recovery-risk-error" className="field-error" role="alert">请说明至少一种恢复时容易丢失的信息。</small> : null}
                </label>
                <label>
                  恢复后希望模型立刻做什么？
                  <textarea id="builder-first-action" name="builder-first-action" aria-label="恢复后希望模型立刻做什么？" aria-invalid={!firstAction.trim()} aria-describedby={!firstAction.trim() ? 'builder-first-action-error' : undefined} autoComplete="off" rows={3} value={firstAction} onChange={(event) => setFirstAction(event.currentTarget.value)} />
                  {!firstAction.trim() ? <small id="builder-first-action-error" className="field-error" role="alert">请写一个恢复后可以立刻执行的动作。</small> : null}
                </label>
              </div>
              <div className="builder-actions">
                <button type="button" className="button button-primary" onClick={continueFromPurpose}>
                  继续选择内容文档
                </button>
                <button type="button" className="button button-secondary" aria-controls="builder-import-input" onClick={() => importInputRef.current?.click()} disabled={isGenerating}>
                  导入已有包
                </button>
                <button type="button" className="button button-ghost" onClick={onLearn}>
                  我还不确定，先去入门页
                </button>
              </div>
              <input
                ref={importInputRef}
                id="builder-import-input"
                className="visually-hidden"
                type="file"
                tabIndex={-1}
                aria-label="导入已有工作流包"
                accept=".json,.zip,application/json,application/zip"
                onChange={(event) => void handleImportStart(event.currentTarget.files?.[0])}
              />
            </section>
          ) : null}

          {step === 1 ? (
            <section className="builder-step" aria-labelledby="materials-title">
              <span className="kicker">Step 2</span>
              <h2 id="materials-title" tabIndex={-1}>先选择需要的内容文档。</h2>
              <p><code>AGENTS.md</code> 不需要你第一步手写。你先选择内容文档，系统会在后面根据这些文档自动生成入口协议草案。</p>
              {generatedMessage ? <p className="notice" aria-live="polite">{generatedMessage}</p> : null}
              <div className="material-grid">
                {standardDocumentCards.map((item) => (
                  <label key={item.id} className={selectedContentDocs.has(item.id) ? 'material-card document-card selected' : 'material-card document-card'}>
                    <input name={`document-${item.id}`} type="checkbox" checked={selectedContentDocs.has(item.id)} onChange={() => toggleContentDocument(item.id)} />
                    <strong>{item.filename}{item.recommended ? <em>推荐</em> : null}</strong>
                    <span>{item.description}</span>
                    <small>{item.whenToUse}</small>
                  </label>
                ))}
              </div>
              <section className="write-map" aria-label="写入地图">
                <strong>写入地图</strong>
                <p>下一步会生成你选中的内容文档；入口协议草案稍后写入 <code>AGENTS.md</code>，并引用这些文档。</p>
              </section>
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => goToStep(0)}><ArrowLeft size={16} aria-hidden="true" />返回用途说明</button>
                <button type="button" className="button button-primary" onClick={() => void createFromDocumentSelection()} disabled={isGenerating || selectedContentDocs.size === 0}>
                  生成文档并进入模块画布
                </button>
              </div>
            </section>
          ) : null}

          {step === 2 ? (
            <section className="builder-step module-builder-step" aria-labelledby="content-title">
              <span className="kicker">Step 3</span>
              <h2 id="content-title" tabIndex={-1}>逐份文档搭建模块。</h2>
              <p>先确认文档名称和职责，再编辑章节与字段。每份文档完成后都要标记为已检查，系统才会生成入口协议草案。</p>
              {generatedMessage ? <p className="notice" aria-live="polite">{generatedMessage}</p> : null}
              <div className="review-progress" aria-label="内容文档检查进度">
                <strong>{reviewedDocumentCount}/{contentDocuments.length} 份文档已检查</strong>
                <span>{contentStageReady ? '可以进入入口协议审查。' : '请逐份确认名称、职责、章节、字段说明和当前内容。'}</span>
              </div>
              {contentStageErrors.some((issue) => !issue.target.documentId) ? (
                <section className="inline-issues" aria-live="polite">
                  <strong>文档集合还有结构或文件名问题</strong>
                  {contentStageErrors.filter((issue) => !issue.target.documentId).slice(0, 4).map((issue) => <p key={issue.id}>{issue.title}：{issue.message}</p>)}
                </section>
              ) : null}
              <div className="module-workbench">
                <div className="module-canvas">
                  <nav className="document-module-list" aria-label="内容文档">
                    <span className="kicker">Content Documents</span>
                    <div className="document-tab-row">
                      {contentDocuments.map((document) => (
                        <button
                          key={document.id}
                          type="button"
                          className={canvasDocument?.id === document.id ? 'module-doc-card active' : 'module-doc-card'}
                          onClick={() => {
                            setSelectedCanvasDocumentId(document.id)
                            setLatestWriteTarget(`${document.filename} > 文档职责`)
                          }}
                        >
                          <strong>{document.filename}</strong>
                          <span>{document.description}</span>
                          <small className={reviewedDocumentIds.has(document.id) ? 'document-review-state reviewed' : 'document-review-state'}>
                            {reviewedDocumentIds.has(document.id) ? '已检查' : '待检查'}
                          </small>
                        </button>
                      ))}
                    </div>
                  </nav>
                  {canvasDocument ? (
                    <>
                      <section className="canvas-document-head">
                        <span className="kicker">正在设计</span>
                        <div className="document-meta-form">
                          <label>
                            文档标题
                            <input name={`${canvasDocument.id}-title`} autoComplete="off" value={canvasDocument.title} onChange={(event) => {
                              updateDocument(canvasDocument.id, { title: event.currentTarget.value })
                              markDocumentDirty(canvasDocument.id, `${canvasDocument.filename} > 文档标题`)
                            }} />
                            <small>显示给人和模型看的名称，例如“当前状态”。</small>
                          </label>
                          <label>
                            导出文件名
                            <input name={`${canvasDocument.id}-filename`} autoComplete="off" spellCheck={false} value={canvasDocument.filename} onChange={(event) => {
                              updateDocument(canvasDocument.id, { filename: event.currentTarget.value })
                              markDocumentDirty(canvasDocument.id, `${event.currentTarget.value || '未命名文件'} > 文件名`)
                            }} />
                            <small>真正写入工作流包的文件名；HTML 内容文档建议使用 .html。</small>
                          </label>
                          <label className="document-purpose-field">
                            这份文档只负责什么
                            <textarea name={`${canvasDocument.id}-description`} autoComplete="off" rows={3} value={canvasDocument.description} onChange={(event) => {
                              updateDocument(canvasDocument.id, { description: event.currentTarget.value })
                              markDocumentDirty(canvasDocument.id, `${canvasDocument.filename} > 文档职责`)
                            }} />
                            <small>写清边界，避免同一事实在多份文档重复维护。</small>
                          </label>
                        </div>
                      </section>
                      <section className="module-library-strip" aria-label="推荐章节模块">
                        <div>
                          <strong>可加入的章节模块</strong>
                          <p>模块加入后会展开成普通章节和字段，可直接改名、复制、排序或删除。</p>
                        </div>
                        <div className="module-button-row">
                          {sectionModuleLibrary
                            .filter((module) => module.targetRoles.includes(canvasDocument.role))
                            .map((module) => {
                              const alreadyPresent = canvasDocument.sections.some((section) => section.id === module.id || section.title === module.title)
                              return (
                                <button key={module.id} type="button" className="button button-secondary" disabled={alreadyPresent} title={alreadyPresent ? '这份文档已经有这个预设章节' : displayFormatLabels[module.displayFormat]} onClick={() => addSectionModule(module.id)}>
                                  <Plus size={15} aria-hidden="true" />
                                  {alreadyPresent ? `${module.title}（已加入）` : module.title}
                                </button>
                              )
                            })}
                          <button type="button" className="button button-secondary" onClick={addCustomSection}>
                            <Plus size={15} aria-hidden="true" />
                            自定义章节
                          </button>
                        </div>
                      </section>
                      <div className="canvas-section-list">
                        {canvasDocument.sections.map((section, sectionIndex) => (
                          <ModuleSectionEditor
                            key={section.id}
                            document={canvasDocument}
                            section={section}
                            index={sectionIndex}
                            total={canvasDocument.sections.length}
                            onDirty={(location) => markDocumentDirty(canvasDocument.id, location)}
                          />
                        ))}
                        {canvasDocument.sections.length === 0 ? <p className="inline-empty">这份文档还没有章节。请添加一个预设章节或自定义章节。</p> : null}
                      </div>
                      {currentDocumentErrors.length > 0 ? (
                        <section className="inline-issues" aria-live="polite">
                          <strong>这份文档还有 {currentDocumentErrors.length} 个必须修复的问题</strong>
                          {currentDocumentErrors.slice(0, 4).map((issue) => <p key={issue.id}>{issue.title}：{issue.message}</p>)}
                        </section>
                      ) : null}
                      <button
                        type="button"
                        className={reviewedDocumentIds.has(canvasDocument.id) ? 'button button-secondary document-reviewed-button' : 'button button-primary document-reviewed-button'}
                        disabled={currentDocumentErrors.length > 0}
                        onClick={() => {
                          setReviewedDocumentIds((current) => new Set(current).add(canvasDocument.id))
                          setGeneratedMessage(`${canvasDocument.filename} 已标记为检查完成。后续改动会自动撤销此标记。`)
                        }}
                      >
                        <CheckCircle2 size={16} aria-hidden="true" />
                        {reviewedDocumentIds.has(canvasDocument.id) ? '这份文档已检查' : '标记这份文档已检查'}
                      </button>
                    </>
                  ) : (
                    <EmptyState title="还没有内容文档" detail="请先选择并生成至少一份内容文档。" actionLabel="返回选择文档" onAction={() => goToStep(1)} />
                  )}
                </div>
                <aside className="write-map sticky-map" aria-label="写入地图">
                  <strong>写入地图</strong>
                  <p>{latestWriteTarget}</p>
                  <p>{canvasDocument ? `当前操作位于 ${canvasDocument.filename}。章节模块会成为文档章节，字段模块会成为常驻说明和值槽。` : '先选择一份文档。'}</p>
                  <p>未来模型会按入口协议先找到这份文档，再根据章节和字段说明恢复判断。</p>
                </aside>
              </div>
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => goToStep(1)}><ArrowLeft size={16} aria-hidden="true" />返回文档选择</button>
                <button type="button" className="button button-secondary" onClick={() => openAdvanced('documents')}>打开高级文档编辑</button>
                <button type="button" className="button button-primary" disabled={!contentStageReady} onClick={reviewProtocolDraft}>
                  {protocolNeedsInitialGeneration ? '生成并审查入口协议草案' : '进入入口协议审查'}
                </button>
              </div>
            </section>
          ) : null}

          {step === 3 ? (
            <section className="builder-step protocol-builder-step" aria-labelledby="protocol-title">
              <span className="kicker">Step 4</span>
              <h2 id="protocol-title" tabIndex={-1}>审查系统生成的入口协议草案。</h2>
              <p><code>AGENTS.md</code> 会串联所有内容文档。导入的协议和你的手工修改不会自动被覆盖；只有点击“重新生成草案”并确认后才会替换。</p>
              {generatedMessage ? <p className="notice" aria-live="polite">{generatedMessage}</p> : null}
              <div className="protocol-toolbar">
                <div>
                  <strong>协议完整性</strong>
                  <span>{protocolErrors.length > 0 ? `${protocolErrors.length} 个问题必须修复` : '文档清单、读取顺序、来源优先级、更新规则和完成检查均存在。'}</span>
                </div>
                <button type="button" className="button button-secondary" onClick={regenerateProtocolDraft}>
                  <RotateCcw size={16} aria-hidden="true" />
                  重新生成草案
                </button>
              </div>
              {protocolDocument ? (
                <section className="canvas-document-head protocol-document-head">
                  <span className="kicker">AGENTS.md</span>
                  <div className="document-meta-form">
                    <label>
                      协议标题
                      <input name="protocol-title" autoComplete="off" value={protocolDocument.title} onChange={(event) => updateDocument(protocolDocument.id, { title: event.currentTarget.value })} />
                    </label>
                    <label className="document-purpose-field">
                      协议用途
                      <textarea name="protocol-description" autoComplete="off" rows={2} value={protocolDocument.description} onChange={(event) => updateDocument(protocolDocument.id, { description: event.currentTarget.value })} />
                    </label>
                  </div>
                </section>
              ) : null}
              <div className="protocol-review-grid">
                {protocolDocument?.sections.map((section, index) => (
                  <ModuleSectionEditor
                    key={section.id}
                    document={protocolDocument}
                    section={section}
                    index={index}
                    total={protocolDocument.sections.length}
                    onDirty={(location) => {
                      setLatestWriteTarget(location)
                      setGeneratedMessage('协议修改已保存。系统不会自动重生成并覆盖这些内容。')
                    }}
                  />
                ))}
                {!protocolDocument || protocolDocument.sections.length === 0 ? <p className="inline-empty">入口协议没有可用模块。请新增模块，或确认后重新生成草案。</p> : null}
              </div>
              <button type="button" className="button button-secondary protocol-add-module" onClick={addProtocolModule}>
                <Plus size={15} aria-hidden="true" />
                新增协议模块
              </button>
              <section className="write-map" aria-label="写入地图">
                <strong>写入地图</strong>
                <p>{latestWriteTarget.startsWith('AGENTS.md') ? latestWriteTarget : 'AGENTS.md > 入口协议模块'}</p>
                <p>这些模块写入 <code>AGENTS.md</code>，未来模型会先读这里，再根据读取顺序进入其他文档。</p>
              </section>
              {protocolErrors.length > 0 ? (
                <section className="inline-issues" aria-live="polite">
                  <strong>协议还不能进入结果预览</strong>
                  {protocolErrors.slice(0, 5).map((issue) => <p key={issue.id}>{issue.title}：{issue.message}</p>)}
                </section>
              ) : null}
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => goToStep(2)}><ArrowLeft size={16} aria-hidden="true" />返回内容文档</button>
                <button type="button" className="button button-secondary" onClick={() => openAdvanced('documents')}>打开高级编辑</button>
                <button type="button" className="button button-primary" disabled={protocolErrors.length > 0} onClick={() => goToStep(4)}>查看结果预览</button>
              </div>
            </section>
          ) : null}

          {step === 4 ? (
            <section className="builder-step" aria-labelledby="preview-title">
              <span className="kicker">Step 5</span>
              <h2 id="preview-title" tabIndex={-1}>结果预览：文件树、模块分布和恢复路径。</h2>
              <p>这里不做复杂关系画布。初版只展示导出前必须看懂的结果：有哪些文件、入口协议怎么引用它们、恢复演练会怎么读。</p>
              <div className="result-preview-grid">
                <section className="plain-panel">
                  <h3>文件树</h3>
                  <ul className="file-list">
                    <li><code>workflow.json</code><span>结构化事实源，可重新导入。</span></li>
                    <li><code>README.md</code><span>说明如何使用导出包。</span></li>
                    {Object.keys(primaryDocs).map((filename) => {
                      const source = workflow.documents.find((document) => document.filename === filename || (document.role !== 'protocol' && filename.replace(/\.html$/i, '') === document.filename.replace(/\.(html|md)$/i, '')))
                      return <li key={filename}><code>documents/{filename}</code><span>{source?.sections.length ?? 0} 个模块章节。</span></li>
                    })}
                  </ul>
                </section>
                <section className="plain-panel">
                  <h3>恢复读取路径</h3>
                  <ol className="read-order-list">
                    {workflow.rules.recoveryOrder.map((stepItem, index) => {
                      const document = workflow.documents.find((item) => item.id === stepItem.documentId)
                      return <li key={stepItem.id}><span>{index + 1}</span><strong>{document ? projectDocumentFilename(document, 'html') : '未知文档'}</strong><small>{stepItem.condition}</small></li>
                    })}
                  </ol>
                </section>
                <section className="plain-panel">
                  <h3>渲染预览：{firstPreview?.[0] ?? '无文档'}</h3>
                  <DocumentPreview filename={firstPreview?.[0]} content={firstPreview?.[1]} />
                </section>
              </div>
              {blockingErrors.length > 0 ? (
                <section className="inline-issues" aria-live="polite">
                  <strong>进入最终演练前还要修复 {blockingErrors.length} 个问题</strong>
                  {blockingErrors.slice(0, 5).map((issue) => <p key={issue.id}>{issue.title}：{issue.message}</p>)}
                </section>
              ) : null}
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => goToStep(3)}><ArrowLeft size={16} aria-hidden="true" />返回协议审查</button>
                <button type="button" className="button button-secondary" onClick={() => openAdvanced('export')}>打开完整导出页</button>
                <button type="button" className="button button-primary" disabled={blockingErrors.length > 0} onClick={() => goToStep(5)}>进入演练与导出</button>
              </div>
            </section>
          ) : null}

          {step === 5 ? (
            <section className="builder-step" aria-labelledby="export-ready-title">
              <span className="kicker">Step 6</span>
              <h2 id="export-ready-title" tabIndex={-1}>最后做一次演练，然后导出。</h2>
              <p>{rehearsal.status === 'blocked' ? '演练仍有阻塞项，建议先查看恢复演练。' : '恢复演练已经可以推出下一步；导出前再检查一次校验结果。'}</p>
              <div className="finish-grid">
                <button type="button" className="finish-card" onClick={() => openAdvanced('simulation')}>
                  <strong>运行恢复演练</strong>
                  <span>模拟新会话、上下文压缩和目标冲突。</span>
                </button>
                <button type="button" className="finish-card" onClick={() => openAdvanced('export')}>
                  <strong>生成工作流包</strong>
                  <span>预览 README、workflow.json 和导出文档。</span>
                </button>
              </div>
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => goToStep(4)}><ArrowLeft size={16} aria-hidden="true" />返回结果预览</button>
              </div>
            </section>
          ) : null}
        </div>
      </section>
    </main>
  )
}

function TopBar({ issueCount, onOpenInspector, mode, onModeChange }: { issueCount: number; onOpenInspector: () => void; mode: AppMode; onModeChange: (mode: AppMode) => void }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const saveStatus = useWorkflowStore((state) => state.saveStatus)
  const storageMessage = useWorkflowStore((state) => state.storageMessage)
  const importProject = useWorkflowStore((state) => state.importProject)
  const importInProgress = useWorkflowStore((state) => state.importInProgress)
  const cancelImport = useWorkflowStore((state) => state.cancelImport)
  const saveCurrent = useWorkflowStore((state) => state.saveCurrent)
  const [importMessage, setImportMessage] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const readOnly = Boolean(workflow.readOnlyReason)

  async function handleImport(file: File | undefined) {
    if (!file) return
    try {
      await importProject(file)
      onModeChange('advanced')
      setImportMessage(`已导入 ${file.name}`)
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : '导入失败。')
    }
  }

  const modeItems: { id: AppMode; label: string }[] = [
    { id: 'home', label: '首页' },
    { id: 'learn', label: '工作流入门' },
    { id: 'build', label: '工作流搭建' },
    { id: 'advanced', label: '高级编辑' },
  ]

  return (
    <header className="topbar">
      <a className="skip-link" href="#main-workspace">跳到主工作区</a>
      <div className="brand-block">
        <span className="kicker">Workflow Studio</span>
        <strong>{workflow.name}</strong>
      </div>
      <nav className="mode-nav" aria-label="页面入口">
        {modeItems.map((item) => (
          <a
            key={item.id}
            href={routeHash(item.id, 0)}
            className={mode === item.id ? 'mode-tab active' : 'mode-tab'}
            aria-current={mode === item.id ? 'page' : undefined}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              onModeChange(item.id)
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <div className="topbar-actions">
        {mode === 'advanced' ? (
          <button type="button" className="button button-secondary" onClick={onOpenInspector}>
            <PanelRightOpen size={16} aria-hidden="true" />
            检查
          </button>
        ) : null}
        <button type="button" className="button button-secondary" aria-controls="topbar-import-input" onClick={() => fileInputRef.current?.click()}>
          <Import size={16} aria-hidden="true" />
          导入
        </button>
        <input
          ref={fileInputRef}
          id="topbar-import-input"
          className="visually-hidden"
          type="file"
          tabIndex={-1}
          aria-label="导入工作流 JSON 或 ZIP"
          accept=".json,.zip,application/json,application/zip"
          onChange={(event) => void handleImport(event.currentTarget.files?.[0])}
        />
        <button type="button" className="button button-secondary" onClick={() => void saveCurrent()} disabled={readOnly}>
          <Save size={16} aria-hidden="true" />
          保存
        </button>
        {importInProgress ? (
          <button type="button" className="button button-ghost" onClick={cancelImport}>
            取消导入
          </button>
        ) : null}
      </div>
      <div className="topbar-status" aria-live="polite">
        <span className={`save-dot save-dot-${mode === 'build' ? 'saved' : saveStatus}`}></span>
        <span>{mode === 'build' ? '本地草稿已保存' : statusLabel(saveStatus)}</span>
        {mode !== 'build' ? <span className="muted">{storageMessage}</span> : null}
        {mode === 'build'
          ? <span className="status-pill">搭建中</span>
          : issueCount > 0
            ? <span className="status-pill">{issueCount} 个 Error</span>
            : <span className="status-pill status-pill-ok">可导出</span>}
      </div>
      {workflow.readOnlyReason ? <p className="topbar-message" role="status" aria-live="polite">{workflow.readOnlyReason}</p> : importMessage ? <p className="topbar-message" role="status" aria-live="polite">{importMessage}</p> : null}
    </header>
  )
}

function LeftRail() {
  const projects = useWorkflowStore((state) => state.projects)
  const workflow = useWorkflowStore((state) => state.workflow)
  const activeView = useWorkflowStore((state) => state.activeView)
  const selectedDocumentId = useWorkflowStore((state) => state.selectedDocumentId)
  const setActiveView = useWorkflowStore((state) => state.setActiveView)
  const selectDocument = useWorkflowStore((state) => state.selectDocument)
  const openProject = useWorkflowStore((state) => state.openProject)
  const deleteProject = useWorkflowStore((state) => state.deleteProject)
  const createPresetProject = useWorkflowStore((state) => state.createPresetProject)
  const createBlankProject = useWorkflowStore((state) => state.createBlankProject)
  const duplicateCurrentProject = useWorkflowStore((state) => state.duplicateCurrentProject)

  return (
    <aside className="left-rail" aria-label="项目与文档">
      <section className="rail-section">
        <div className="rail-heading">
          <span>项目</span>
          <FolderOpen size={16} aria-hidden="true" />
        </div>
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={project.id === workflow.workflowId ? 'project-item active' : 'project-item'}
              onClick={() => void openProject(project.id)}
            >
              <span>{project.name}</span>
              <small>{formatProjectDate(project.updatedAt)}</small>
            </button>
          ))}
        </div>
        <div className="rail-actions">
          <button type="button" className="button button-secondary" onClick={() => void createPresetProject()}>
            <Plus size={15} aria-hidden="true" />
            标准恢复文档
          </button>
          <button type="button" className="button button-ghost" onClick={() => void createBlankProject()}>
            最小工作流
          </button>
          <button type="button" className="button button-ghost" onClick={() => void duplicateCurrentProject()}>
            复制
          </button>
          {projects.length > 1 ? (
            <button type="button" className="icon-button" aria-label="删除当前项目" onClick={() => {
              if (confirmDelete('当前项目')) void deleteProject(workflow.workflowId)
            }}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </section>

      <nav className="rail-section" aria-label="工作台任务">
        <div className="rail-heading">任务路径</div>
        <div className="view-list">
          {viewItems.map((view) => {
            const Icon = view.icon
            return (
              <button
                key={view.id}
                type="button"
                className={activeView === view.id ? 'view-item active' : 'view-item'}
                aria-label={view.label}
                title={`${view.label}：${view.detail}`}
                onClick={() => setActiveView(view.id)}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="view-label-full">{view.label}</span>
                <span className="view-label-short" aria-hidden="true">{view.shortLabel}</span>
                <small>{view.detail}</small>
              </button>
            )
          })}
        </div>
      </nav>

      <section className="rail-section">
        <div className="rail-heading">当前资料</div>
        <p className="rail-note">{workflow.documents.length} 份文档，当前选中 {selectedDocumentId ? workflow.documents.find((document) => document.id === selectedDocumentId)?.filename : '无'}。</p>
        <button
          type="button"
          className="button button-ghost rail-wide-action"
          onClick={() => {
            if (selectedDocumentId) selectDocument(selectedDocumentId)
            setActiveView('documents')
          }}
        >
          查看文档索引
        </button>
      </section>
    </aside>
  )
}

function Overview({ issues }: { issues: ValidationIssue[] }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const updateWorkflowMeta = useWorkflowStore((state) => state.updateWorkflowMeta)
  const createPresetProject = useWorkflowStore((state) => state.createPresetProject)
  const createBlankProject = useWorkflowStore((state) => state.createBlankProject)
  const importProject = useWorkflowStore((state) => state.importProject)
  const setActiveView = useWorkflowStore((state) => state.setActiveView)
  const score = useMemo(() => scoreWorkflow(workflow, issues), [workflow, issues])
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning' && !issue.accepted).length
  const fieldCount = workflow.documents.reduce((sum, document) => sum + document.sections.reduce((inner, section) => inner + section.fields.length, 0), 0)
  const blockingIssues = issues.filter((issue) => issue.severity === 'error')
  const firstBlockingIssue = blockingIssues[0]
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleImport(file: File | undefined) {
    if (!file) return
    await importProject(file)
  }

  return (
    <section className="workspace-section" aria-labelledby="overview-title">
      <div className="delivery-hero">
        <div>
          <span className="kicker">Delivery Readiness</span>
          <h1 id="overview-title">当前工作流{errorCount > 0 ? '还不能交付。' : '可以交付。'}</h1>
          <p>{errorCount > 0 ? `还有 ${errorCount} 个必须修复的问题。先处理第一个阻塞项，再运行恢复演练。` : '没有阻塞性错误。建议运行一次恢复演练，再生成工作流包。'}</p>
        </div>
        <div className={errorCount > 0 ? 'delivery-status blocked' : 'delivery-status'}>
          {errorCount > 0 ? <AlertTriangle size={22} aria-hidden="true" /> : <CheckCircle2 size={22} aria-hidden="true" />}
          <strong>{errorCount > 0 ? '导出被阻止' : '可生成工作流包'}</strong>
          <span>{firstBlockingIssue ? firstBlockingIssue.title : `${workflow.documents.length} 份文档，${fieldCount} 个字段已纳入校验。`}</span>
          <button type="button" className="button button-secondary" onClick={() => setActiveView(errorCount > 0 ? 'documents' : 'simulation')}>
            {errorCount > 0 ? '查看要修的项' : '演练新会话恢复'}
          </button>
        </div>
      </div>

      <div className="entry-grid" aria-label="首次使用入口">
        <article className="entry-card recommended">
          <span className="kicker">推荐起点</span>
          <h2>使用标准恢复文档</h2>
          <p>从当前标准工作流开始，保留恢复入口、状态入口、历史和术语文档。</p>
          <button type="button" className="button button-primary" onClick={() => void createPresetProject()}>
            使用标准恢复文档
          </button>
        </article>
        <article className="entry-card">
          <span className="kicker">最小起点</span>
          <h2>创建最小工作流</h2>
          <p>只生成基础文档和必填字段，适合从零设计新的协作协议。</p>
          <button type="button" className="button button-secondary" onClick={() => void createBlankProject()}>
            创建最小工作流
          </button>
        </article>
        <article className="entry-card">
          <span className="kicker">已有文件</span>
          <h2>导入 ZIP 或 JSON</h2>
          <p>读取已有工作流包。高版本 schema 会进入只读模式，避免误写。</p>
          <button type="button" className="button button-secondary" onClick={() => fileInputRef.current?.click()}>
            导入已有 ZIP/JSON
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            tabIndex={-1}
            accept=".json,.zip,application/json,application/zip"
            onChange={(event) => void handleImport(event.currentTarget.files?.[0])}
          />
        </article>
      </div>

      <div className="setup-grid">
        <section className="setup-panel">
          <div className="section-heading compact">
            <div>
              <h2>三个必答问题</h2>
              <p>这些内容会写入导出的 README 和工作流描述。</p>
            </div>
          </div>
          <label>
            项目名称
            <input value={workflow.name} onChange={(event) => updateWorkflowMeta({ name: event.currentTarget.value, description: workflow.description })} />
          </label>
          <label>
            一句话说明
            <textarea value={workflow.description} rows={3} onChange={(event) => updateWorkflowMeta({ name: workflow.name, description: event.currentTarget.value })} />
          </label>
          <p className="format-note">当前主维护格式：{maintenanceFormatCopy[workflow.maintenanceFormat].label}</p>
        </section>
        <section className="setup-panel">
          <div className="section-heading compact">
            <div>
              <h2>最后会得到什么</h2>
              <p>导出不是保存网页，而是生成可复制到项目里的工作流包。</p>
            </div>
          </div>
          <ul className="artifact-list">
            <li><code>workflow.json</code><span>保留完整结构，供再次导入和继续编辑。</span></li>
            <li><code>README.md</code><span>说明如何使用这套工作流包。</span></li>
            <li>HTML / Markdown 文档<span>给未来模型和人类直接阅读。</span></li>
            <li>ZIP 工作流包<span>一次性下载并复制到新项目。</span></li>
          </ul>
        </section>
      </div>

      <div className="metric-grid" aria-label="工作流摘要">
        <Metric label="总分" value={`${score.total}`} detail={score.status === 'good' ? '结构健康' : score.status === 'caution' ? '需要关注' : '风险较高'} />
        <Metric label="文档" value={`${workflow.documents.length}`} detail={`${fieldCount} 个字段`} />
        <Metric label="校验" value={`${errorCount} / ${warningCount}`} detail="Error / Warning" />
        <Metric label="导出" value={workflow.maintenanceFormat.toUpperCase()} detail={workflow.secondaryFormat ? `次级 ${workflow.secondaryFormat}` : '无次级格式'} />
      </div>

      <div className="split-panel secondary-flow">
        <RelationshipGraph workflow={workflow} issues={issues} />
        <section className="plain-panel">
          <div className="section-heading">
            <h2>评分原因</h2>
            <span className="muted">最多显示每个维度的前三条原因</span>
          </div>
          <div className="score-list">
            {Object.entries(score.dimensions).map(([dimension, result]) => (
              <article key={dimension} className="score-row">
                <div>
                  <strong>{dimensionLabels[dimension as keyof typeof dimensionLabels]}</strong>
                  <small>{result.reasons[0] ?? '未发现主要扣分项。'}</small>
                </div>
                <span>{result.score}</span>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function DocumentEditor() {
  const workflow = useWorkflowStore((state) => state.workflow)
  const selectedDocumentId = useWorkflowStore((state) => state.selectedDocumentId)
  const selectDocument = useWorkflowStore((state) => state.selectDocument)
  const selectFieldAction = useWorkflowStore((state) => state.selectField)
  const updateDocument = useWorkflowStore((state) => state.updateDocument)
  const addDocument = useWorkflowStore((state) => state.addDocument)
  const moveDocument = useWorkflowStore((state) => state.moveDocument)
  const removeDocument = useWorkflowStore((state) => state.removeDocument)
  const addSection = useWorkflowStore((state) => state.addSection)
  const updateSection = useWorkflowStore((state) => state.updateSection)
  const removeSection = useWorkflowStore((state) => state.removeSection)
  const addField = useWorkflowStore((state) => state.addField)
  const updateField = useWorkflowStore((state) => state.updateField)
  const updateFieldText = useWorkflowStore((state) => state.updateFieldText)
  const addFieldInstance = useWorkflowStore((state) => state.addFieldInstance)
  const updateFieldInstance = useWorkflowStore((state) => state.updateFieldInstance)
  const copyFieldInstance = useWorkflowStore((state) => state.copyFieldInstance)
  const moveFieldInstance = useWorkflowStore((state) => state.moveFieldInstance)
  const removeFieldInstance = useWorkflowStore((state) => state.removeFieldInstance)
  const removeField = useWorkflowStore((state) => state.removeField)
  const document = selectedDocument(workflow, selectedDocumentId)
  const documentIndex = document ? workflow.documents.findIndex((item) => item.id === document.id) : -1
  const handleFieldFocus = (documentId: string, sectionId: string, fieldId: string) => {
    selectFieldAction(documentId, sectionId, fieldId)
  }

  if (!document) {
    return (
      <section className="workspace-section">
        <EmptyState title="还没有文档" detail="请先创建一个恢复入口文档。" actionLabel="新增文档" onAction={addDocument} />
      </section>
    )
  }

  return (
    <section className="workspace-section" aria-labelledby="documents-title">
      <div className="section-heading">
        <div>
          <span className="kicker">Documents</span>
          <h1 id="documents-title">写给未来模型看的资料</h1>
          <p>先写清每份文档的职责，再维护字段说明和当前内容。结构和高级校验默认收起。</p>
        </div>
        <button type="button" className="button button-primary" onClick={addDocument}>
          <FilePlus2 size={16} aria-hidden="true" />
          新增文档
        </button>
      </div>

      <div className="document-selector" aria-label="文档索引">
        {workflow.documents.map((item) => (
          <button key={item.id} type="button" className={item.id === document.id ? 'chip active' : 'chip'} onClick={() => selectDocument(item.id)}>
            <span>{item.filename}</span>
            <small>{documentRoleCopy[item.role].label}</small>
          </button>
        ))}
      </div>

      <section className="form-band" aria-label="文档属性">
        <label>
          标题
          <input value={document.title} onChange={(event) => updateDocument(document.id, { title: event.currentTarget.value })} />
        </label>
        <label>
          文件名
          <input value={document.filename} onChange={(event) => updateDocument(document.id, { filename: event.currentTarget.value })} />
        </label>
        <label>
          这份文档承担什么职责
          <select value={document.role} onChange={(event) => updateDocument(document.id, { role: event.currentTarget.value as WorkflowDocument['role'] })}>
            {documentRoleOptions.map((role) => <option key={role} value={role}>{documentRoleCopy[role].label}</option>)}
          </select>
          <small>{documentRoleCopy[document.role].detail}</small>
        </label>
        <label>
          里面的信息多久会变化
          <select value={document.lifecycle} onChange={(event) => updateDocument(document.id, { lifecycle: event.currentTarget.value as WorkflowDocument['lifecycle'] })}>
            {lifecycleOptions.map((lifecycle) => <option key={lifecycle} value={lifecycle}>{lifecycleCopy[lifecycle].label}</option>)}
          </select>
          <small>{lifecycleCopy[document.lifecycle].detail}</small>
        </label>
        <label className="wide-field">
          职责说明
          <textarea rows={3} value={document.description} onChange={(event) => updateDocument(document.id, { description: event.currentTarget.value })} />
        </label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" disabled={documentIndex <= 0} onClick={() => moveDocument(document.id, -1)}>
            上移
          </button>
          <button type="button" className="button button-secondary" disabled={documentIndex < 0 || documentIndex >= workflow.documents.length - 1} onClick={() => moveDocument(document.id, 1)}>
            下移
          </button>
          <button type="button" className="button button-ghost danger" disabled={workflow.documents.length <= 1} onClick={() => {
            if (confirmDelete(`文档 ${document.title}`)) removeDocument(document.id)
          }}>
            <Trash2 size={15} aria-hidden="true" />
            删除文档
          </button>
        </div>
      </section>

      <div className="section-stack">
        {document.sections.map((section) => (
          <article key={section.id} className="section-editor">
            <div className="section-heading compact">
              <div>
                <h2>{section.title}</h2>
                <p>{section.purpose}</p>
              </div>
              <div className="inline-actions">
                <button type="button" className="button button-secondary" onClick={() => addField(document.id, section.id)}>
                  <Plus size={15} aria-hidden="true" />
                  字段
                </button>
                <button type="button" className="icon-button" aria-label={`删除章节 ${section.title}`} onClick={() => {
                  if (confirmDelete(`章节 ${section.title}`)) removeSection(document.id, section.id)
                }}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="form-band form-band-compact">
              <label>
                章节标题
                <input value={section.title} onChange={(event) => updateSection(document.id, section.id, { title: event.currentTarget.value })} />
              </label>
              <label>
                信息变化频率
                <select value={section.lifecycle} onChange={(event) => updateSection(document.id, section.id, { lifecycle: event.currentTarget.value as WorkflowDocument['lifecycle'] })}>
                  {lifecycleOptions.map((lifecycle) => <option key={lifecycle} value={lifecycle}>{lifecycleCopy[lifecycle].label}</option>)}
                </select>
              </label>
              <label className="wide-field">
                章节目的
                <textarea rows={2} value={section.purpose} onChange={(event) => updateSection(document.id, section.id, { purpose: event.currentTarget.value })} />
              </label>
            </div>
            <div className="field-list">
              {section.fields.map((field) => (
                <article key={field.id} className="field-editor" data-field={field.id}>
                  <div className="field-default">
                    <label>
                      字段名称
                      <input value={field.label} onFocus={() => handleFieldFocus(document.id, section.id, field.id)} onChange={(event) => updateField(document.id, section.id, field.id, { label: event.currentTarget.value })} />
                    </label>
                    <label>
                      给未来模型看的填写规则
                      <textarea rows={2} value={field.guidance} onFocus={() => handleFieldFocus(document.id, section.id, field.id)} onChange={(event) => updateField(document.id, section.id, field.id, { guidance: event.currentTarget.value })} />
                    </label>
                    {field.repeatable ? (
                      <div className="repeatable-editor" aria-label={`${field.label} 内容条目列表`}>
                        <div className="repeatable-heading">
                          <span>多条当前内容</span>
                          <button type="button" className="button button-secondary" onClick={() => addFieldInstance(document.id, section.id, field.id)}>
                            <Plus size={15} aria-hidden="true" />
                            添加内容
                          </button>
                        </div>
                        {fieldInstances(field).map((item, index) => (
                          <div key={`${field.id}-${index}`} className="repeatable-row">
                            <label>
                              内容条目 {index + 1}
                              <input value={fieldValueToText(item)} onFocus={() => handleFieldFocus(document.id, section.id, field.id)} onInput={(event) => updateFieldInstance(document.id, section.id, field.id, index, event.currentTarget.value)} />
                            </label>
                            <div className="inline-actions">
                              <button type="button" className="icon-button" title="内容上移" aria-label="内容上移" disabled={index === 0} onClick={() => moveFieldInstance(document.id, section.id, field.id, index, -1)}><ArrowUp size={16} aria-hidden="true" /></button>
                              <button type="button" className="icon-button" title="内容下移" aria-label="内容下移" disabled={index === fieldInstances(field).length - 1} onClick={() => moveFieldInstance(document.id, section.id, field.id, index, 1)}><ArrowDown size={16} aria-hidden="true" /></button>
                              <button type="button" className="icon-button" aria-label="复制内容" onClick={(event) => {
                                const input = event.currentTarget.closest('.repeatable-row')?.querySelector('input')
                                copyFieldInstance(document.id, section.id, field.id, index, input?.value)
                              }}>
                                <Copy size={15} aria-hidden="true" />
                              </button>
                              <button type="button" className="icon-button" aria-label="删除内容" onClick={() => removeFieldInstance(document.id, section.id, field.id, index)}>
                                <Trash2 size={15} aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        ))}
                        {fieldInstances(field).length === 0 ? <p className="muted">还没有内容，添加后会写入列表值。</p> : null}
                      </div>
                    ) : (
                      <label>
                        当前内容
                        <textarea rows={4} value={fieldValueToText(field.value)} onFocus={() => handleFieldFocus(document.id, section.id, field.id)} onChange={(event) => updateFieldText(document.id, section.id, field.id, event.currentTarget.value)} />
                      </label>
                    )}
                  </div>
                  <div className="field-flags">
                    <label className="checkbox-label">
                      <input type="checkbox" checked={field.required} onChange={(event) => updateField(document.id, section.id, field.id, { required: event.currentTarget.checked })} />
                      必须填写
                    </label>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={field.allowEmpty} onChange={(event) => updateField(document.id, section.id, field.id, { allowEmpty: event.currentTarget.checked })} />
                      允许暂时为空
                    </label>
                    <button type="button" className="button button-ghost danger" onClick={() => {
                      if (confirmDelete(`字段 ${field.label}`)) removeField(document.id, section.id, field.id)
                    }}>
                      删除字段
                    </button>
                  </div>
                  <details className="field-details">
                    <summary>结构设置</summary>
                    <div className="field-grid">
                      <label>
                        字段类型
                        <select value={field.type} onChange={(event) => updateField(document.id, section.id, field.id, { type: event.currentTarget.value as WorkflowField['type'] })}>
                          {fieldTypeOptions.map((type) => <option key={type} value={type}>{fieldTypeCopy[type].label}</option>)}
                        </select>
                        <small>{fieldTypeCopy[field.type].detail}</small>
                      </label>
                      <label>
                        信息变化频率
                        <select value={field.lifecycle} onChange={(event) => updateField(document.id, section.id, field.id, { lifecycle: event.currentTarget.value as WorkflowDocument['lifecycle'] })}>
                          {lifecycleOptions.map((lifecycle) => <option key={lifecycle} value={lifecycle}>{lifecycleCopy[lifecycle].label}</option>)}
                        </select>
                      </label>
                      <label>
                        默认内容
                        <input value={typeof field.defaultValue === 'string' ? field.defaultValue : ''} onFocus={() => handleFieldFocus(document.id, section.id, field.id)} onChange={(event) => updateField(document.id, section.id, field.id, { defaultValue: event.currentTarget.value.trim().length === 0 ? undefined : event.currentTarget.value })} />
                      </label>
                      <label className="checkbox-label">
                        <input type="checkbox" checked={field.repeatable} onChange={(event) => updateField(document.id, section.id, field.id, { repeatable: event.currentTarget.checked })} />
                        允许多条内容
                      </label>
                      <label className="wide-field">
                        可选项
                        <textarea
                          rows={3}
                          value={optionsToText(field.options)}
                          placeholder="value | label | description…"
                          onFocus={() => handleFieldFocus(document.id, section.id, field.id)}
                          onChange={(event) => {
                            const options = parseOptionsText(event.currentTarget.value)
                            updateField(document.id, section.id, field.id, {
                              options,
                              validation: {
                                ...field.validation,
                                allowedValues: options?.map((option) => option.value),
                              },
                            })
                          }}
                        />
                      </label>
                    </div>
                  </details>
                  <details className="field-details">
                    <summary>高级校验与底层值</summary>
                    <div className="field-advanced">
                    <label>
                      最小长度
                      <input
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={field.validation.minLength ?? ''}
                        onFocus={() => handleFieldFocus(document.id, section.id, field.id)}
                        onChange={(event) => updateField(document.id, section.id, field.id, {
                          validation: {
                            ...field.validation,
                            minLength: event.currentTarget.value === '' ? undefined : Number.parseInt(event.currentTarget.value, 10),
                          },
                        })}
                      />
                    </label>
                    <label>
                      最大长度
                      <input
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={field.validation.maxLength ?? ''}
                        onFocus={() => handleFieldFocus(document.id, section.id, field.id)}
                        onChange={(event) => updateField(document.id, section.id, field.id, {
                          validation: {
                            ...field.validation,
                            maxLength: event.currentTarget.value === '' ? undefined : Number.parseInt(event.currentTarget.value, 10),
                          },
                        })}
                      />
                    </label>
                    <label>
                      格式限制
                      <input value={field.validation.pattern ?? ''} onFocus={() => handleFieldFocus(document.id, section.id, field.id)} onChange={(event) => updateField(document.id, section.id, field.id, { validation: { ...field.validation, pattern: event.currentTarget.value || undefined } })} />
                    </label>
                    <label className="wide-field">
                      高级校验
                      <textarea
                        rows={3}
                        value={customRulesToText(field.validation.customRules)}
                        placeholder="warning | non-empty | 说明…"
                        onFocus={() => handleFieldFocus(document.id, section.id, field.id)}
                        onChange={(event) => updateField(document.id, section.id, field.id, { validation: { ...field.validation, customRules: parseCustomRulesText(event.currentTarget.value) } })}
                      />
                    </label>
                    <p className="raw-meta">底层值：{field.type} · {field.lifecycle} · {field.repeatable ? 'repeatable' : 'single'}</p>
                    </div>
                  </details>
                </article>
              ))}
              {section.fields.length === 0 ? <p className="muted">这个章节还没有字段。</p> : null}
            </div>
          </article>
        ))}
      </div>

      <button type="button" className="button button-secondary" onClick={() => addSection(document.id)}>
        <Plus size={16} aria-hidden="true" />
        新增章节
      </button>
    </section>
  )
}

function RulesEditor() {
  const workflow = useWorkflowStore((state) => state.workflow)
  const updateRecoveryStep = useWorkflowStore((state) => state.updateRecoveryStep)
  const addRecoveryStep = useWorkflowStore((state) => state.addRecoveryStep)
  const removeRecoveryStep = useWorkflowStore((state) => state.removeRecoveryStep)
  const updateSourcePriorityReason = useWorkflowStore((state) => state.updateSourcePriorityReason)
  const updateSourceRef = useWorkflowStore((state) => state.updateSourceRef)
  const addSourceRef = useWorkflowStore((state) => state.addSourceRef)
  const moveSourceRef = useWorkflowStore((state) => state.moveSourceRef)
  const removeSourceRef = useWorkflowStore((state) => state.removeSourceRef)
  const updateTrigger = useWorkflowStore((state) => state.updateTrigger)
  const addUpdateTrigger = useWorkflowStore((state) => state.addUpdateTrigger)
  const removeUpdateTrigger = useWorkflowStore((state) => state.removeUpdateTrigger)
  const updateCompletionCheck = useWorkflowStore((state) => state.updateCompletionCheck)
  const addCompletionCheck = useWorkflowStore((state) => state.addCompletionCheck)
  const removeCompletionCheck = useWorkflowStore((state) => state.removeCompletionCheck)
  const updateConflictPolicy = useWorkflowStore((state) => state.updateConflictPolicy)
  const updateHistoryPolicy = useWorkflowStore((state) => state.updateHistoryPolicy)
  const sourceRule = workflow.rules.sourcePriority[0]

  return (
    <section className="workspace-section" aria-labelledby="rules-title">
      <div className="section-heading">
        <div>
          <span className="kicker">Rules</span>
          <h1 id="rules-title">规定未来模型怎么读、怎么裁决</h1>
          <p>把恢复顺序、信息来源和冲突策略写成未来模型能执行的判断规则。</p>
        </div>
        <button type="button" className="button button-primary" onClick={() => addRecoveryStep(workflow.documents[0]?.id ?? '')} disabled={workflow.documents.length === 0}>
          <Plus size={16} aria-hidden="true" />
          添加读取步骤
        </button>
      </div>

      <section className="plain-panel">
        <h2>未来模型先读什么</h2>
        <div className="rule-list">
          {workflow.rules.recoveryOrder.map((step, index) => (
            <article key={step.id} className="rule-row">
              <span className="rule-index">{index + 1}</span>
              <label>
                要读取的文档
                <select value={step.documentId} onChange={(event) => updateRecoveryStep(step.id, { documentId: event.currentTarget.value })}>
                  {workflow.documents.map((document) => <option key={document.id} value={document.id}>{document.filename} · {documentRoleCopy[document.role].label}</option>)}
                </select>
              </label>
              <label>
                什么时候读取
                <input value={step.condition} onChange={(event) => updateRecoveryStep(step.id, { condition: event.currentTarget.value })} />
              </label>
              <label className="checkbox-label inline-checkbox">
                <input type="checkbox" checked={step.required} onChange={(event) => updateRecoveryStep(step.id, { required: event.currentTarget.checked })} />
                恢复时必须读
              </label>
              <button type="button" className="icon-button" aria-label="删除恢复步骤" onClick={() => {
                if (confirmDelete('恢复步骤')) removeRecoveryStep(step.id)
              }}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="plain-panel">
        <div className="section-heading compact">
          <h2>信息冲突时信谁</h2>
          <button type="button" className="button button-secondary" onClick={addSourceRef}>
            <Plus size={15} aria-hidden="true" />
            添加来源
          </button>
        </div>
        <label>
          为什么这样排序
          <textarea rows={3} value={sourceRule?.reason ?? ''} onChange={(event) => updateSourcePriorityReason(event.currentTarget.value)} />
        </label>
        <div className="source-list">
          {(sourceRule?.orderedSources ?? []).map((source, index) => (
            <article key={`source-${index}`} className="source-row editable-source">
              <span>{source.priority}</span>
              <label>
                显示名称
                <input value={source.label} onChange={(event) => updateSourceRef(index, { label: event.currentTarget.value })} />
              </label>
              <label>
                来源类型
                <select value={source.sourceType} onChange={(event) => updateSourceRef(index, { sourceType: event.currentTarget.value as typeof source.sourceType })}>
                  {sourceTypeOptions.map((type) => <option key={type} value={type}>{sourceTypeCopy[type].label}</option>)}
                </select>
                <small>{sourceTypeCopy[source.sourceType].detail}</small>
              </label>
              <label>
                信息新旧怎么处理
                <select value={source.recencyPolicy} onChange={(event) => updateSourceRef(index, { recencyPolicy: event.currentTarget.value as typeof source.recencyPolicy })}>
                  <option value="prefer-newer">{recencyPolicyCopy['prefer-newer'].label}</option>
                  <option value="ignore-recency">{recencyPolicyCopy['ignore-recency'].label}</option>
                  <option value="manual">{recencyPolicyCopy.manual.label}</option>
                </select>
              </label>
              <div className="inline-actions">
                <button type="button" className="icon-button" title="来源上移" aria-label="来源上移" disabled={index === 0} onClick={() => moveSourceRef(index, -1)}><ArrowUp size={16} aria-hidden="true" /></button>
                <button type="button" className="icon-button" title="来源下移" aria-label="来源下移" disabled={index === (sourceRule?.orderedSources.length ?? 0) - 1} onClick={() => moveSourceRef(index, 1)}><ArrowDown size={16} aria-hidden="true" /></button>
                <button type="button" className="icon-button" aria-label="删除来源" onClick={() => {
                  if (confirmDelete('来源')) removeSourceRef(index)
                }}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="plain-panel">
        <div className="section-heading compact">
          <h2>什么时候必须更新文档</h2>
          <button type="button" className="button button-secondary" onClick={addUpdateTrigger}>
            <Plus size={15} aria-hidden="true" />
            添加触发条件
          </button>
        </div>
        <div className="rule-list">
          {workflow.rules.updateTriggers.map((trigger) => (
            <article key={trigger.id} className="trigger-row">
              <label>
                需要更新的文档
                <select value={trigger.targetDocumentId} onChange={(event) => updateTrigger(trigger.id, { targetDocumentId: event.currentTarget.value })}>
                  {workflow.documents.map((document) => <option key={document.id} value={document.id}>{document.filename} · {documentRoleCopy[document.role].label}</option>)}
                </select>
              </label>
              <label>
                触发条件
                <input value={trigger.trigger} onChange={(event) => updateTrigger(trigger.id, { trigger: event.currentTarget.value })} />
              </label>
              <label>
                必要动作
                <input value={trigger.requiredAction} onChange={(event) => updateTrigger(trigger.id, { requiredAction: event.currentTarget.value })} />
              </label>
              <button type="button" className="icon-button" aria-label="删除更新触发器" onClick={() => {
                if (confirmDelete('更新触发器')) removeUpdateTrigger(trigger.id)
              }}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="plain-panel">
        <div className="section-heading compact">
          <h2>交付前必须确认什么</h2>
          <button type="button" className="button button-secondary" onClick={addCompletionCheck}>
            <Plus size={15} aria-hidden="true" />
            添加检查
          </button>
        </div>
        <div className="rule-list">
          {workflow.rules.completionChecks.map((check) => (
            <article key={check.id} className="trigger-row">
              <label>
                名称
                <input value={check.label} onChange={(event) => updateCompletionCheck(check.id, { label: event.currentTarget.value })} />
              </label>
              <label>
                说明
                <input value={check.description} onChange={(event) => updateCompletionCheck(check.id, { description: event.currentTarget.value })} />
              </label>
              <label>
                缺失时的影响
                <select value={check.severityWhenMissing} onChange={(event) => updateCompletionCheck(check.id, { severityWhenMissing: event.currentTarget.value as typeof check.severityWhenMissing })}>
                  <option value="error">必须修复，否则不能导出</option>
                  <option value="warning">有风险，可接受但会记录</option>
                </select>
              </label>
              <button type="button" className="icon-button" aria-label="删除完成检查" onClick={() => {
                if (confirmDelete('完成检查')) removeCompletionCheck(check.id)
              }}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="form-band">
        <label>
          信息冲突时默认怎么做
          <select value={workflow.rules.conflictPolicy.defaultAction} onChange={(event) => updateConflictPolicy({ defaultAction: event.currentTarget.value as typeof workflow.rules.conflictPolicy.defaultAction })}>
            <option value="apply-source-priority">{conflictActionCopy['apply-source-priority'].label}</option>
            <option value="ask-user">{conflictActionCopy['ask-user'].label}</option>
            <option value="block-until-resolved">{conflictActionCopy['block-until-resolved'].label}</option>
          </select>
        </label>
        <label>
          未解决冲突的影响
          <select value={workflow.rules.conflictPolicy.unresolvedConflictSeverity} onChange={(event) => updateConflictPolicy({ unresolvedConflictSeverity: event.currentTarget.value as typeof workflow.rules.conflictPolicy.unresolvedConflictSeverity })}>
            <option value="error">必须修复，否则不能导出</option>
            <option value="warning">有风险，可接受但会记录</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={workflow.rules.conflictPolicy.requireExplicitNoteForManualOverride} onChange={(event) => updateConflictPolicy({ requireExplicitNoteForManualOverride: event.currentTarget.checked })} />
          人工覆盖需要说明
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={workflow.rules.historyPolicy.appendOnly} onChange={(event) => updateHistoryPolicy({ appendOnly: event.currentTarget.checked })} />
          历史只追加
        </label>
        <label>
          旧历史怎么处理
          <select value={workflow.rules.historyPolicy.obsoleteHandling} onChange={(event) => updateHistoryPolicy({ obsoleteHandling: event.currentTarget.value as typeof workflow.rules.historyPolicy.obsoleteHandling })}>
            <option value="mark-obsolete">{obsoleteHandlingCopy['mark-obsolete'].label}</option>
            <option value="archive-with-replacement">{obsoleteHandlingCopy['archive-with-replacement'].label}</option>
            <option value="delete">{obsoleteHandlingCopy.delete.label}</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={workflow.rules.historyPolicy.requireIndexUpdate} onChange={(event) => updateHistoryPolicy({ requireIndexUpdate: event.currentTarget.checked })} />
          历史索引必须更新
        </label>
      </section>
    </section>
  )
}

function SimulationView({ issues }: { issues: ValidationIssue[] }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const scenario = useWorkflowStore((state) => state.simulationScenario)
  const setScenario = useWorkflowStore((state) => state.setSimulationScenario)
  const [resultScenario, setResultScenario] = useState<SimulationScenario>(scenario)
  const result = useMemo(() => simulateRecovery(workflow, resultScenario), [workflow, resultScenario])

  return (
    <section className="workspace-section" aria-labelledby="simulation-title">
      <div className="section-heading">
        <div>
          <span className="kicker">Simulation</span>
          <h1 id="simulation-title">演练断线后如何恢复</h1>
          <p>查看未来模型会先读什么、为什么读、冲突时信谁，以及下一处应该改哪里。</p>
        </div>
        <div className="inline-actions">
          <select value={scenario} onChange={(event) => setScenario(event.currentTarget.value as SimulationScenario)} aria-label="选择模拟情境">
            {scenarioOptions.map((item) => <option key={item} value={item}>{scenarioLabels[item]}</option>)}
          </select>
          <button type="button" className="button button-primary" onClick={() => setResultScenario(scenario)}>
            <Play size={16} aria-hidden="true" />
            演练新会话恢复
          </button>
        </div>
      </div>

      <div className="split-panel">
        <RelationshipGraph workflow={workflow} issues={issues} activeDocumentIds={result.readDocuments} />
        <section className={`plain-panel simulation-status simulation-${result.status}`}>
          <h2>{scenarioLabels[result.scenario]}</h2>
          <p>{result.nextAtomicStep ? `下一步建议：${result.nextAtomicStep}` : '本次演练没有发现新的下一步。'}</p>
          {result.blockers.length > 0 ? (
            <ul className="blocker-list">
              {result.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          ) : null}
          {result.conflicts.length > 0 ? (
            <div className="conflict-list">
              {result.conflicts.map((conflict) => (
                <article key={conflict.id}>
                  <strong>{conflict.description}</strong>
                  <p>冲突时信谁：{conflict.selectedSource?.label ?? '需要人工确认'}。{conflict.reason}</p>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      <ol className="timeline" aria-label="模拟步骤">
        {result.steps.map((step) => (
          <li key={`${step.order}-${step.action}`} className={`timeline-step timeline-${step.outcome}`}>
            <span>{step.order}</span>
            <div>
              <strong>{step.action}</strong>
              <p>{step.reason}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ExportCenter({ issues }: { issues: ValidationIssue[] }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const updateMaintenanceFormat = useWorkflowStore((state) => state.updateMaintenanceFormat)
  const blocking = hasBlockingErrors(issues)
  const blockingIssues = issues.filter((issue) => issue.severity === 'error')
  const [message, setMessage] = useState('')
  const [isExporting, setIsExporting] = useState(false)
  const primaryDocs = useMemo(() => exportDocumentsForFormat(workflow, workflow.maintenanceFormat), [workflow])
  const firstPreview = workflow.maintenanceFormat === 'html'
    ? Object.entries(primaryDocs).find(([filename]) => filename.endsWith('.html')) ?? Object.entries(primaryDocs)[0]
    : Object.entries(primaryDocs)[0]

  async function downloadZip() {
    if (blocking) {
      setMessage('存在未解决 Error，导出已阻止。')
      return
    }
    setIsExporting(true)
    try {
      const pkg = await createWorkflowZip(workflow)
      downloadBlob(pkg.blob, packageName(workflow))
      setMessage(`已生成 ZIP，包含 ${Object.keys(pkg.files).length} 个文件。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ZIP 生成失败。')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <section className="workspace-section" aria-labelledby="export-title">
      <div className="section-heading">
        <div>
          <span className="kicker">Export</span>
          <h1 id="export-title">生成可复制的<span className="semantic-unit">工作流包</span></h1>
          <p>确认 ZIP 内每个文件的用途；有 Error 时必须先修复，不能绕过导出。</p>
        </div>
        <div className="inline-actions">
          <button type="button" className="button button-secondary" onClick={() => downloadText(JSON.stringify(workflow, null, 2), 'workflow.json')}>
            <FileJson size={16} aria-hidden="true" />
            workflow.json
          </button>
          <button type="button" className="button button-primary" disabled={blocking || isExporting} onClick={() => void downloadZip()}>
            <Download size={16} aria-hidden="true" />
            下载工作流包
          </button>
        </div>
      </div>

      <section className="form-band">
        <label>
          主维护格式
          <select value={workflow.maintenanceFormat} onChange={(event) => updateMaintenanceFormat(event.currentTarget.value as MaintenanceFormat, workflow.secondaryFormat)}>
            <option value="html">{maintenanceFormatCopy.html.label}</option>
            <option value="markdown">{maintenanceFormatCopy.markdown.label}</option>
          </select>
          <small>{maintenanceFormatCopy[workflow.maintenanceFormat].detail}</small>
        </label>
        <label>
          次级格式
          <select value={workflow.secondaryFormat ?? ''} onChange={(event) => updateMaintenanceFormat(workflow.maintenanceFormat, event.currentTarget.value ? event.currentTarget.value as MaintenanceFormat : undefined)}>
            <option value="">不生成</option>
            <option value="html">{maintenanceFormatCopy.html.label}</option>
            <option value="markdown">{maintenanceFormatCopy.markdown.label}</option>
          </select>
        </label>
        <div className={blocking ? 'export-gate blocked' : 'export-gate'}>
          {blocking ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
          <span>{blocking ? 'Error 未解决，ZIP 导出禁用。' : '没有阻塞性错误，可以导出。'}</span>
        </div>
      </section>

      {message ? <p className="notice" aria-live="polite">{message}</p> : null}

      {blockingIssues.length > 0 ? (
        <section className="plain-panel blocked-summary" aria-live="polite">
          <div className="section-heading compact">
            <div>
              <h2>需要先修复的阻塞项</h2>
              <p>这些问题会阻止工作流包导出。请回到对应文档或字段处理后再下载。</p>
            </div>
          </div>
          <div className="issue-list">
            {blockingIssues.slice(0, 4).map((issue) => (
              <article key={issue.id} className="issue issue-error">
                <span>必须修复</span>
                <strong>{issue.title}</strong>
                <p>{issue.message}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <div className="split-panel">
        <section className="plain-panel">
          <h2>ZIP 文件结构</h2>
          <ul className="file-list">
            <li><code>workflow.json</code><span>完整结构，用于再次导入和继续编辑。</span></li>
            <li><code>README.md</code><span>告诉接手者如何使用这套工作流。</span></li>
            {Object.keys(primaryDocs).map((filename) => <li key={filename}><code>documents/{filename}</code><span>主维护格式文档，给未来模型直接阅读。</span></li>)}
            {workflow.secondaryFormat ? <li><code>documents-{workflow.secondaryFormat === 'html' ? 'html' : 'md'}/...</code><span>次级格式备份。</span></li> : null}
          </ul>
        </section>
        <section className="plain-panel">
          <h2>README 预览</h2>
          <pre className="code-preview">{exportReadme(workflow)}</pre>
        </section>
      </div>

      <section className="plain-panel">
        <h2>文档预览：{firstPreview?.[0] ?? '无文档'}</h2>
        <DocumentPreview filename={firstPreview?.[0]} content={firstPreview?.[1]} />
      </section>
    </section>
  )
}

function InspectorPanel({ issues, onClose }: { issues: ValidationIssue[]; onClose: () => void }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const selectedDocumentId = useWorkflowStore((state) => state.selectedDocumentId)
  const selectedSectionId = useWorkflowStore((state) => state.selectedSectionId)
  const selectedFieldId = useWorkflowStore((state) => state.selectedFieldId)
  const setActiveView = useWorkflowStore((state) => state.setActiveView)
  const selectDocument = useWorkflowStore((state) => state.selectDocument)
  const selectFieldAction = useWorkflowStore((state) => state.selectField)
  const acceptWarning = useWorkflowStore((state) => state.acceptWarning)
  const [showSuggestions, setShowSuggestions] = useState(true)
  const field = selectedField(workflow, selectedDocumentId, selectedSectionId, selectedFieldId)
  const suggestionCount = issues.filter((issue) => issue.severity === 'suggestion').length
  const visibleIssues = issues
    .filter((issue) => showSuggestions || issue.severity !== 'suggestion')
    .filter((issue) => issue.severity !== 'pass' || issues.length <= 8)
    .slice(0, 10)
  const errors = issues.filter((issue) => issue.severity === 'error').length

  function goToIssue(issue: ValidationIssue) {
    if (issue.target.documentId && issue.target.sectionId && issue.target.fieldId) {
      selectFieldAction(issue.target.documentId, issue.target.sectionId, issue.target.fieldId)
      return
    }
    if (issue.target.documentId) {
      selectDocument(issue.target.documentId)
      setActiveView('documents')
      return
    }
    setActiveView(issue.target.ruleId ? 'rules' : 'overview')
  }

  return (
    <aside className="right-panel" aria-label="属性、校验与预览">
      <div className="inspector-top">
        <div>
          <span className="kicker">Inspector</span>
          <strong>检查与修复</strong>
        </div>
        <button type="button" className="icon-button" aria-label="关闭检查器" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <section className="inspector">
        <div className="rail-heading">
          <span>当前字段</span>
          <Boxes size={16} aria-hidden="true" />
        </div>
        {field ? (
          <div className="inspector-field">
            <strong>{field.label}</strong>
            <p>{field.guidance}</p>
            <small>{lifecycleCopy[field.lifecycle].label} · {fieldTypeCopy[field.type].label}</small>
          </div>
        ) : (
          <p className="muted">选中文档字段后，这里显示填写规则和当前内容状态。没有选中字段时，检查器只显示校验修复路径。</p>
        )}
      </section>
      <section className="inspector" aria-live="polite">
        <div className="rail-heading">
          <span>校验结果</span>
          <ListChecks size={16} aria-hidden="true" />
        </div>
        <p className="validation-summary">{errors > 0 ? `${errors} 个 Error 阻止导出` : '没有阻塞性 Error'}</p>
        {suggestionCount > 0 ? (
          <button type="button" className="button button-ghost suggestion-toggle" onClick={() => setShowSuggestions((value) => !value)}>
            {showSuggestions ? '隐藏 Suggestion' : '显示 Suggestion'}
          </button>
        ) : null}
        <div className="issue-list">
          {visibleIssues.map((issue) => (
            <article key={issue.id} className={`issue issue-${issue.severity}${issue.accepted ? ' accepted' : ''}`}>
              <span>{severityLabel(issue.severity)}</span>
              <strong>{issue.title}</strong>
              <p>{issue.message}</p>
              {issue.severity === 'error' || issue.severity === 'warning' ? (
                <p className="issue-help">
                  {issue.severity === 'error' ? '这个问题会阻止工作流包导出。' : '这个问题可以接受风险，但会保留记录。'}
                </p>
              ) : null}
              <button type="button" className="button button-secondary" onClick={() => goToIssue(issue)}>
                去修复
              </button>
              {issue.severity === 'warning' && issue.canAccept && !issue.accepted ? (
                <button type="button" className="button button-ghost" onClick={() => acceptWarning(issue)}>
                  接受风险并记录
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </aside>
  )
}

function RelationshipGraph({ workflow, issues, activeDocumentIds = [] }: { workflow: WorkflowSchema; issues: ValidationIssue[]; activeDocumentIds?: string[] }) {
  const documents = workflow.documents
  const errorDocumentIds = new Set(issues.filter((issue) => issue.severity === 'error' && issue.target.documentId).map((issue) => issue.target.documentId))
  const activeSet = new Set(activeDocumentIds)
  const nodePositions = documents.map((document, index) => ({
    document,
    x: 110 + (index % 3) * 280,
    y: 70 + Math.floor(index / 3) * 105,
  }))
  const nodeById = new Map(nodePositions.map((node) => [node.document.id, node]))
  const edges = workflow.rules.recoveryOrder
    .map((step, index, steps) => {
      const from = nodeById.get(step.documentId)
      const next = steps[index + 1] ? nodeById.get(steps[index + 1].documentId) : undefined
      return from && next ? { from, next, required: step.required } : undefined
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
  const height = Math.max(300, 155 + Math.ceil(documents.length / 3) * 105)

  return (
    <section className="graph-panel" aria-labelledby="graph-title">
      <div className="section-heading compact">
        <div>
          <h2 id="graph-title">关系图与恢复路径</h2>
          <p>{documents.length} 个节点，{edges.length} 条路径边；橙色实线表示必读恢复路径，虚线表示按需读取。</p>
        </div>
      </div>
      <div className="graph-scroll" role="img" aria-label={`关系图：${documents.length} 个节点，${edges.length} 条边，当前恢复顺序为 ${workflow.rules.recoveryOrder.length} 步。`}>
        <svg viewBox={`0 0 920 ${height}`} className="relationship-svg" aria-hidden="true">
          {edges.map((edge) => (
            <line
              key={`${edge.from.document.id}-${edge.next.document.id}`}
              x1={edge.from.x + 90}
              y1={edge.from.y}
              x2={edge.next.x - 90}
              y2={edge.next.y}
              className={edge.required ? 'graph-edge required' : 'graph-edge optional'}
            />
          ))}
          {nodePositions.map((node) => {
            const hasError = errorDocumentIds.has(node.document.id)
            const active = activeSet.has(node.document.filename) || activeSet.has(node.document.id)
            return (
              <g key={node.document.id} transform={`translate(${node.x - 92} ${node.y - 36})`} className={hasError ? 'graph-node error' : active ? 'graph-node active' : 'graph-node'}>
                <rect width="184" height="72" rx="12" />
                <text x="16" y="27">{node.document.filename}</text>
                <text x="16" y="50" className="graph-node-meta">{documentRoleCopy[node.document.role].label} · {lifecycleCopy[node.document.lifecycle].label}</text>
              </g>
            )
          })}
        </svg>
      </div>
      <p className="graph-summary">
        文本摘要：恢复顺序包含 {workflow.rules.recoveryOrder.length} 步；错误节点 {errorDocumentIds.size} 个；阻塞节点由校验结果决定。
      </p>
    </section>
  )
}

function EmptyState({ title, detail, actionLabel, onAction }: { title: string; detail: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{detail}</p>
      <button type="button" className="button button-primary" onClick={onAction}>{actionLabel}</button>
    </div>
  )
}

function MainWorkspace({ issues }: { issues: ValidationIssue[] }) {
  const activeView = useWorkflowStore((state) => state.activeView)
  if (activeView === 'documents') return <DocumentEditor />
  if (activeView === 'rules') return <RulesEditor />
  if (activeView === 'simulation') return <SimulationView issues={issues} />
  if (activeView === 'export') return <ExportCenter issues={issues} />
  return <Overview issues={issues} />
}

function App() {
  const initialize = useWorkflowStore((state) => state.initialize)
  const workflow = useWorkflowStore((state) => state.workflow)
  const activeView = useWorkflowStore((state) => state.activeView)
  const setActiveView = useWorkflowStore((state) => state.setActiveView)
  const [route, setRoute] = useState(routeFromHash)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const syncingAdvancedViewRef = useRef(false)
  const mode = route.mode
  const issues = useMemo(() => validateWorkflow(workflow), [workflow])
  const errorCount = issues.filter((issue) => issue.severity === 'error').length

  useEffect(() => {
    if (didInitialize) return
    didInitialize = true
    void initialize()
  }, [initialize])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 })
    const timer = window.setTimeout(() => {
      const heading = document.querySelector<HTMLElement>('#main-workspace h1')
      if (!heading) return
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeView, mode])

  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', routeHash('home', 0))
    const syncRoute = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', syncRoute)
    window.addEventListener('popstate', syncRoute)
    return () => {
      window.removeEventListener('hashchange', syncRoute)
      window.removeEventListener('popstate', syncRoute)
    }
  }, [])

  useEffect(() => {
    if (route.mode !== 'advanced' || !route.view) return
    const currentView = useWorkflowStore.getState().activeView
    if (currentView === route.view) return
    syncingAdvancedViewRef.current = true
    setActiveView(route.view)
  }, [route.mode, route.view, setActiveView])

  useEffect(() => {
    if (syncingAdvancedViewRef.current) {
      syncingAdvancedViewRef.current = false
      return
    }
    if (mode !== 'advanced' || activeView === route.view) return
    const nextHash = routeHash('advanced', 0, activeView)
    window.history.pushState(null, '', nextHash)
    setRoute({ mode: 'advanced', step: 0, view: activeView })
  }, [activeView, mode, route.view])

  function changeMode(nextMode: AppMode, requestedStep?: BuildStep, requestedView?: AppView) {
    const nextStep = nextMode === 'build' ? requestedStep ?? route.step : route.step
    const nextView = nextMode === 'advanced' ? requestedView ?? activeView : route.view
    const nextRoute: AppRoute = { mode: nextMode, step: nextStep, view: nextView }
    const nextHash = routeHash(nextMode, nextStep, nextView)
    if (window.location.hash !== nextHash) window.history.pushState(null, '', nextHash)
    setRoute(nextRoute)
    if (nextMode !== 'advanced') setInspectorOpen(false)
  }

  return (
    <div className={`${workflow.readOnlyReason ? 'app-shell read-only-shell' : 'app-shell'} mode-${mode}${mode === 'advanced' && inspectorOpen ? ' inspector-open' : ''}`}>
      <TopBar issueCount={errorCount} onOpenInspector={() => setInspectorOpen(true)} mode={mode} onModeChange={changeMode} />
      {workflow.readOnlyReason ? <div className="read-only-banner" role="status">{workflow.readOnlyReason}</div> : null}
      {mode === 'home' ? <HomePage onLearn={() => changeMode('learn')} onBuild={() => changeMode('build', 0)} onAdvanced={() => changeMode('advanced')} /> : null}
      {mode === 'learn' ? <LearnPage onBuild={(step) => changeMode('build', step)} /> : null}
      {mode === 'build' ? <BuildWizard step={route.step} onStepChange={(step) => changeMode('build', step)} onLearn={() => changeMode('learn')} onAdvanced={(view) => changeMode('advanced', undefined, view)} /> : null}
      {mode === 'advanced' ? (
        <div className="studio-layout">
          <LeftRail />
          <main id="main-workspace" className="main-workspace">
            <MainWorkspace issues={issues} />
          </main>
          {inspectorOpen ? <InspectorPanel issues={issues} onClose={() => setInspectorOpen(false)} /> : null}
        </div>
      ) : null}
    </div>
  )
}

export default App
