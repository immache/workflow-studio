import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
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
  Save,
  Trash2,
  X,
} from 'lucide-react'
import './App.css'
import { exportHtmlDocuments } from './domain/export-html'
import { exportMarkdownDocuments, exportReadme } from './domain/export-markdown'
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

type UiCopy = {
  label: string
  detail: string
  example?: string
  recommended?: boolean
  advanced?: boolean
}

type AppMode = 'home' | 'learn' | 'build' | 'advanced'
type BuildStep = 0 | 1 | 2 | 3 | 4 | 5 | 6

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
  },
  {
    title: '好工作流的标准',
    question: '怎样判断一套工作流是不是能交付？',
    answer: '它应该可恢复、少重复、职责清楚、状态不过期、历史可追溯，并且有能实际执行的验证方式。',
    example: '如果一个新会话只靠文档就能知道下一步做什么，这套工作流才算站得住。',
  },
  {
    title: '常见材料分工',
    question: '为什么不能只写一个总说明？',
    answer: '不同信息会以不同速度变化。入口规则、长期计划、当前状态、用户偏好、历史和术语应该分开维护。',
    example: '当前目标会变，放状态里；长期范围相对稳定，放计划里；已经替换的方案，放历史里。',
  },
  {
    title: '字段怎么判断',
    question: '看到一个字段时，我到底该写什么？',
    answer: '先问四件事：这条信息给谁看、多久会变、缺了还能不能恢复、未来模型会用它判断什么。',
    example: '“下一原子步骤”不是普通待办，而是恢复后可以立刻执行的唯一动作。',
  },
  {
    title: '冲突时信谁',
    question: '用户刚说的话和文档冲突时怎么办？',
    answer: '默认优先相信最新明确用户指令，其次是新鲜工作区事实，再看状态、计划、偏好和历史。',
    example: '用户刚要求改目标时，不要被旧状态文档覆盖；旧状态应更新或归档。',
  },
  {
    title: '怎么验收和导出',
    question: '完成后怎样知道它真的可用？',
    answer: '至少跑一次恢复演练，修掉阻塞项，确认导出的 ZIP 里有 workflow.json、README 和主维护文档。',
    example: '导出不是保存网页，而是生成能复制到项目里的工作流包。',
  },
]

const materialChoices = [
  { id: 'protocol', title: '入口规则', detail: '未来模型第一眼要读的恢复协议。', recommended: true, required: true },
  { id: 'status', title: '当前状态', detail: '当前目标、下一步、阻塞和恢复指针。', recommended: true, required: true },
  { id: 'memory', title: '历史演变', detail: '为什么走到现在、哪些方案已经替换。', recommended: true, required: true },
  { id: 'plan', title: '长期计划', detail: '使命、范围、阶段和稳定约束。', recommended: false, required: false },
  { id: 'preference', title: '用户偏好', detail: '长期稳定、会影响多数任务的偏好。', recommended: false, required: false },
  { id: 'context', title: '术语解释', detail: '避免未来模型误解抽象概念。', recommended: false, required: false },
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

function HomePage({ onLearn, onBuild, onAdvanced }: { onLearn: () => void; onBuild: () => void; onAdvanced: () => void }) {
  return (
    <main className="onboarding-main" id="main-workspace">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-copy">
          <span className="kicker">Workflow Studio</span>
          <h1 id="home-title">为未来接手项目的模型，留下一套清楚的工作流。</h1>
          <p>先理解好工作流的判断标准，再一步步生成可复制到项目里的恢复文档包。这里不会把你直接丢进字段表单。</p>
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
          <p>适合第一次使用、不确定字段含义，或还不知道好工作流应该长什么样的人。</p>
          <ul>
            <li>理解工作流是什么。</li>
            <li>看懂常见材料分工。</li>
            <li>弄清字段、冲突和验收标准。</li>
          </ul>
          <button type="button" className="button button-primary" onClick={onLearn}>
            进入工作流入门
          </button>
        </article>
        <article className="home-entry">
          <span className="kicker">开始产出</span>
          <h2>工作流搭建</h2>
          <p>适合已经有项目目标，想从预设、空白或已有文件开始生成工作流包的人。</p>
          <ul>
            <li>回答少量自然语言问题。</li>
            <li>生成恢复材料和规则。</li>
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

function LearnPage({ onBuild }: { onBuild: () => void }) {
  return (
    <main className="onboarding-main learn-main" id="main-workspace">
      <section className="editorial-hero" aria-labelledby="learn-title">
        <span className="kicker">Workflow Primer</span>
        <h1 id="learn-title">先弄懂工作流，再开始填内容。</h1>
        <p>这些章节解释的是搭建时最容易卡住的概念。你不需要记住底层字段名，只要知道每份材料在恢复时承担什么职责。</p>
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
            </div>
          </article>
        ))}
      </section>
      <section className="learn-cta">
        <div>
          <h2>读完这些概念后，就可以开始搭建。</h2>
          <p>搭建流程会继续用自然语言提问，并在需要时把你带回对应的入门章节。</p>
        </div>
        <button type="button" className="button button-primary" onClick={onBuild}>
          去工作流搭建
        </button>
      </section>
    </main>
  )
}

function BuildWizard({ onLearn, onAdvanced }: { onLearn: () => void; onAdvanced: () => void }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const createPresetProject = useWorkflowStore((state) => state.createPresetProject)
  const createBlankProject = useWorkflowStore((state) => state.createBlankProject)
  const importProject = useWorkflowStore((state) => state.importProject)
  const updateWorkflowMeta = useWorkflowStore((state) => state.updateWorkflowMeta)
  const updateFieldText = useWorkflowStore((state) => state.updateFieldText)
  const setActiveView = useWorkflowStore((state) => state.setActiveView)
  const [step, setStep] = useState<BuildStep>(0)
  const [startMode, setStartMode] = useState<'preset' | 'blank' | 'import' | undefined>()
  const [projectName, setProjectName] = useState(workflow.name)
  const [recoveryRisk, setRecoveryRisk] = useState('目标、下一步和当前阻塞最容易丢失。')
  const [firstAction, setFirstAction] = useState('读取 STATUS.html，确认下一原子步骤。')
  const [selectedMaterials, setSelectedMaterials] = useState(() => new Set(materialChoices.filter((item) => item.recommended).map((item) => item.id)))
  const [isGenerating, setIsGenerating] = useState(false)
  const [generatedMessage, setGeneratedMessage] = useState('')
  const importInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 })
  }, [step])

  async function handlePresetStart() {
    setIsGenerating(true)
    await createPresetProject()
    setStartMode('preset')
    setSelectedMaterials(new Set(materialChoices.map((item) => item.id)))
    setGeneratedMessage('已使用标准恢复文档作为起点。你可以继续确认材料组合。')
    setStep(2)
    setIsGenerating(false)
  }

  function selectedMaterialIds() {
    return materialChoices.filter((item) => selectedMaterials.has(item.id)).map((item) => item.id)
  }

  function fillBlankScaffoldFields() {
    updateWorkflowMeta({
      name: projectName.trim() || '新手工作流',
      description: `恢复场景：${recoveryRisk.trim() || '需要未来模型接手当前项目。'} 恢复后第一动作：${firstAction.trim() || '确认下一步。'}`,
    })
    updateFieldText('blank-status', 'blank-anchor', 'blank-current-goal', projectName.trim() || '继续完善当前项目。')
    updateFieldText('blank-status', 'blank-next-step-section', 'blank-next-atomic-step', firstAction.trim() || '读取当前状态并确认下一步。')
  }

  async function generateBlankScaffold(nextStep: BuildStep = 2) {
    setIsGenerating(true)
    await createBlankProject(selectedMaterialIds())
    fillBlankScaffoldFields()
    setStartMode('blank')
    setGeneratedMessage('已生成最小可恢复工作流：入口规则、当前状态和历史演变已经有了起点。')
    setStep(nextStep)
    setIsGenerating(false)
  }

  async function handleImportStart(file: File | undefined) {
    if (!file) return
    setIsGenerating(true)
    try {
      await importProject(file)
      setStartMode('import')
      setSelectedMaterials(new Set(materialChoices.filter((item) => item.required).map((item) => item.id)))
      setGeneratedMessage(`已导入 ${file.name}。你可以先查看材料摘要，再进入高级编辑调整。`)
      setStep(3)
    } catch (error) {
      setGeneratedMessage(error instanceof Error ? error.message : '导入失败，请检查文件格式。')
    } finally {
      setIsGenerating(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  function toggleMaterial(id: string) {
    if (materialChoices.find((item) => item.id === id)?.required) return
    setSelectedMaterials((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function continueAfterMaterials() {
    if (startMode === 'blank') {
      await generateBlankScaffold(3)
      return
    }
    setStep(3)
  }

  function openAdvanced(view: AppView) {
    setActiveView(view)
    onAdvanced()
  }

  const steps = ['选择起点', '说明场景', '选择材料', '填写内容', '恢复顺序', '冲突处理', '演练导出']

  return (
    <main className="onboarding-main build-main" id="main-workspace">
      <section className="build-shell" aria-labelledby="build-title">
        <div className="build-head">
          <span className="kicker">Workflow Builder</span>
          <h1 id="build-title">一步步搭建工作流。</h1>
          <p>每一步只处理一个问题。你看到的是项目判断，底层文档、字段和规则会在后台映射。</p>
        </div>
        <ol className="stepper" aria-label="搭建步骤">
          {steps.map((label, index) => (
            <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>
              <span>{index + 1}</span>
              <strong>{label}</strong>
            </li>
          ))}
        </ol>

        <div className="builder-panel">
          {step === 0 ? (
            <section className="builder-step" aria-labelledby="start-title">
              <span className="kicker">Step 1</span>
              <h2 id="start-title">你想从哪里开始？</h2>
              <p>不确定时建议先用标准工作流；如果你要从零设计，选择空白起点，系统会先帮你生成最小结构。</p>
              <div className="start-grid">
                <button type="button" className="start-card" onClick={() => void handlePresetStart()} disabled={isGenerating}>
                  <strong>使用标准工作流</strong>
                  <span>保留入口规则、状态、历史和术语等常见材料。</span>
                </button>
                <button type="button" className="start-card" onClick={() => setStep(1)} disabled={isGenerating}>
                  <strong>从空白开始</strong>
                  <span>先回答三个问题，再生成最小可恢复工作流。</span>
                </button>
                <button type="button" className="start-card" onClick={() => importInputRef.current?.click()} disabled={isGenerating}>
                  <strong>导入已有包</strong>
                  <span>从 workflow.json 或 ZIP 继续调整已有工作流。</span>
                </button>
              </div>
              <input
                ref={importInputRef}
                className="visually-hidden"
                type="file"
                tabIndex={-1}
                accept=".json,.zip,application/json,application/zip"
                onChange={(event) => void handleImportStart(event.currentTarget.files?.[0])}
              />
              <button type="button" className="button button-ghost" onClick={onLearn}>
                我还不确定，先去入门页
              </button>
            </section>
          ) : null}

          {step === 1 ? (
            <section className="builder-step" aria-labelledby="scenario-title">
              <span className="kicker">Step 2</span>
              <h2 id="scenario-title">先说明你的项目和恢复场景。</h2>
              <p>这三项会写入工作流描述和状态材料，帮助未来模型知道自己接手的是什么。</p>
              <div className="question-form">
                <label>
                  这个工作流服务哪个项目或任务？
                  <input value={projectName} onChange={(event) => setProjectName(event.currentTarget.value)} />
                </label>
                <label>
                  未来模型恢复时最容易丢失什么信息？
                  <textarea rows={3} value={recoveryRisk} onChange={(event) => setRecoveryRisk(event.currentTarget.value)} />
                </label>
                <label>
                  恢复后希望模型立刻做什么？
                  <textarea rows={3} value={firstAction} onChange={(event) => setFirstAction(event.currentTarget.value)} />
                </label>
              </div>
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => setStep(0)}>返回起点</button>
                <button type="button" className="button button-primary" onClick={() => void generateBlankScaffold()} disabled={isGenerating}>
                  生成最小工作流
                </button>
              </div>
            </section>
          ) : null}

          {step === 2 ? (
            <section className="builder-step" aria-labelledby="materials-title">
              <span className="kicker">Step 3</span>
              <h2 id="materials-title">需要留下哪些恢复材料？</h2>
              <p>推荐材料已经选中。你可以先保持默认，之后再进入高级编辑补细节。</p>
              {generatedMessage ? <p className="notice">{generatedMessage}</p> : null}
              <div className="material-grid">
                {materialChoices.map((item) => (
                  <label key={item.id} className={selectedMaterials.has(item.id) ? 'material-card selected' : 'material-card'}>
                    <input type="checkbox" checked={selectedMaterials.has(item.id)} disabled={item.required} onChange={() => toggleMaterial(item.id)} />
                    <strong>{item.title}{item.required ? <em>必要</em> : null}</strong>
                    <span>{item.detail}</span>
                  </label>
                ))}
              </div>
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => setStep(0)}>重新选择起点</button>
                <button type="button" className="button button-primary" onClick={() => void continueAfterMaterials()} disabled={isGenerating}>继续填写核心内容</button>
              </div>
            </section>
          ) : null}

          {step === 3 ? (
            <section className="builder-step" aria-labelledby="content-title">
              <span className="kicker">Step 4</span>
              <h2 id="content-title">每份材料先填最关键的内容。</h2>
              <p>这里不要求你理解字段类型。先确认未来模型必须知道的内容，细节可以稍后在高级编辑中调整。</p>
              <div className="generated-summary">
                {workflow.documents.map((document) => (
                  <article key={document.id}>
                    <strong>{document.title}</strong>
                    <p>{document.description}</p>
                  </article>
                ))}
              </div>
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => openAdvanced('documents')}>打开材料细节</button>
                <button type="button" className="button button-primary" onClick={() => setStep(4)}>继续规定恢复顺序</button>
              </div>
            </section>
          ) : null}

          {step === 4 ? (
            <section className="builder-step" aria-labelledby="order-title">
              <span className="kicker">Step 5</span>
              <h2 id="order-title">未来模型先读什么，再读什么？</h2>
              <p>默认顺序已经按恢复逻辑生成。只要能回答“断线重开后第一眼看哪里”，就可以继续。</p>
              <ol className="read-order-list">
                {workflow.rules.recoveryOrder.map((stepItem, index) => {
                  const document = workflow.documents.find((item) => item.id === stepItem.documentId)
                  return <li key={stepItem.id}><span>{index + 1}</span><strong>{document?.filename ?? '未知材料'}</strong><small>{stepItem.condition}</small></li>
                })}
              </ol>
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => openAdvanced('rules')}>调整恢复顺序</button>
                <button type="button" className="button button-primary" onClick={() => setStep(5)}>继续处理冲突</button>
              </div>
            </section>
          ) : null}

          {step === 5 ? (
            <section className="builder-step" aria-labelledby="conflict-title">
              <span className="kicker">Step 6</span>
              <h2 id="conflict-title">信息冲突时，未来模型应该信谁？</h2>
              <p>默认规则是先信最新明确用户指令，再信新鲜工作区事实。旧文档不是没用，但不能覆盖更高优先级的信息。</p>
              <div className="conflict-example">
                <strong>例子</strong>
                <p>如果用户刚说“这次只改首页”，而旧状态文档写着“继续优化三栏”，未来模型应该听用户刚说的话，并更新状态文档。</p>
              </div>
              <div className="builder-actions">
                <button type="button" className="button button-secondary" onClick={() => openAdvanced('rules')}>查看冲突规则</button>
                <button type="button" className="button button-primary" onClick={() => setStep(6)}>进入演练与导出</button>
              </div>
            </section>
          ) : null}

          {step === 6 ? (
            <section className="builder-step" aria-labelledby="export-ready-title">
              <span className="kicker">Step 7</span>
              <h2 id="export-ready-title">最后做一次演练，然后导出。</h2>
              <p>如果恢复演练能推出下一步，并且导出页没有阻塞项，这套工作流就可以交给项目使用。</p>
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
          <button
            key={item.id}
            type="button"
            className={mode === item.id ? 'mode-tab active' : 'mode-tab'}
            aria-current={mode === item.id ? 'page' : undefined}
            onClick={() => onModeChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="topbar-actions">
        {mode === 'advanced' ? (
          <button type="button" className="button button-secondary" onClick={onOpenInspector}>
            <PanelRightOpen size={16} aria-hidden="true" />
            检查
          </button>
        ) : null}
        <button type="button" className="button button-secondary" onClick={() => fileInputRef.current?.click()}>
          <Import size={16} aria-hidden="true" />
          导入
        </button>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          tabIndex={-1}
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
        <span className={`save-dot save-dot-${saveStatus}`}></span>
        <span>{statusLabel(saveStatus)}</span>
        <span className="muted">{storageMessage}</span>
        {issueCount > 0 ? <span className="status-pill">{issueCount} 个 Error</span> : <span className="status-pill status-pill-ok">可导出</span>}
      </div>
      {workflow.readOnlyReason ? <p className="topbar-message">{workflow.readOnlyReason}</p> : importMessage ? <p className="topbar-message">{importMessage}</p> : null}
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
                              <button type="button" className="icon-button" aria-label="内容上移" disabled={index === 0} onClick={() => moveFieldInstance(document.id, section.id, field.id, index, -1)}>↑</button>
                              <button type="button" className="icon-button" aria-label="内容下移" disabled={index === fieldInstances(field).length - 1} onClick={() => moveFieldInstance(document.id, section.id, field.id, index, 1)}>↓</button>
                              <button type="button" className="icon-button" aria-label="复制内容" onClick={(event) => {
                                const input = event.currentTarget.closest('.repeatable-row')?.querySelector('input')
                                copyFieldInstance(document.id, section.id, field.id, index, input?.value)
                              }}>
                                <Plus size={15} aria-hidden="true" />
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
                <button type="button" className="icon-button" aria-label="来源上移" disabled={index === 0} onClick={() => moveSourceRef(index, -1)}>↑</button>
                <button type="button" className="icon-button" aria-label="来源下移" disabled={index === (sourceRule?.orderedSources.length ?? 0) - 1} onClick={() => moveSourceRef(index, 1)}>↓</button>
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
  const htmlDocs = useMemo(() => exportHtmlDocuments(workflow), [workflow])
  const markdownDocs = useMemo(() => exportMarkdownDocuments(workflow), [workflow])
  const [message, setMessage] = useState('')
  const [isExporting, setIsExporting] = useState(false)
  const primaryDocs = workflow.maintenanceFormat === 'html' ? htmlDocs : markdownDocs
  const firstPreview = Object.entries(primaryDocs)[0]

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
          <h1 id="export-title">生成可复制的工作流包</h1>
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
        <pre className="code-preview">{firstPreview?.[1] ?? '没有可预览的导出内容。'}</pre>
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
  const [mode, setMode] = useState<AppMode>('home')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const issues = useMemo(() => validateWorkflow(workflow), [workflow])
  const errorCount = issues.filter((issue) => issue.severity === 'error').length

  useEffect(() => {
    if (didInitialize) return
    didInitialize = true
    void initialize()
  }, [initialize])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 })
  }, [mode])

  function changeMode(nextMode: AppMode) {
    setMode(nextMode)
    if (nextMode !== 'advanced') setInspectorOpen(false)
  }

  return (
    <div className={`${workflow.readOnlyReason ? 'app-shell read-only-shell' : 'app-shell'}${mode === 'advanced' && inspectorOpen ? ' inspector-open' : ''}`}>
      <TopBar issueCount={errorCount} onOpenInspector={() => setInspectorOpen(true)} mode={mode} onModeChange={changeMode} />
      {workflow.readOnlyReason ? <div className="read-only-banner" role="status">{workflow.readOnlyReason}</div> : null}
      {mode === 'home' ? <HomePage onLearn={() => changeMode('learn')} onBuild={() => changeMode('build')} onAdvanced={() => changeMode('advanced')} /> : null}
      {mode === 'learn' ? <LearnPage onBuild={() => changeMode('build')} /> : null}
      {mode === 'build' ? <BuildWizard onLearn={() => changeMode('learn')} onAdvanced={() => changeMode('advanced')} /> : null}
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
