import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bot,
  ChevronRight,
  CircleHelp,
  Download,
  Eye,
  FilePlus2,
  FileText,
  FolderOpen,
  List,
  ListOrdered,
  Package,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import './App.css'
import {
  displayFormatLabels,
  fieldModuleLibrary,
  sectionModuleLibrary,
  standardDocumentCards,
} from './data/modules/standard-workflow-modules'
import { exportDocumentsForFormat } from './domain/export-documents'
import { projectDocumentFilename } from './domain/export-naming'
import { createWorkflowZip, packageName, serializeWorkflowJson } from './domain/export-zip'
import {
  LATEST_USER_SOURCE_KEY,
  SYSTEM_PROTOCOL_READ_ITEM_ID,
  WORKSPACE_FACT_SOURCE_KEY,
  buildProtocolProjection,
} from './domain/protocol-state'
import {
  REVIEW_MATERIAL_WARNING_CHARACTERS,
  buildReviewMaterial,
  reviewLocationLabel,
  reviewProtocolKey,
  reviewReportIsStale,
  reviewReportSummaryLabel,
  reviewSnapshotFromRequest,
  type ReviewEditTarget,
  type ReviewFinding,
  type ReviewMaterial,
  type ReviewMaterialSnapshot,
  type ReviewReport,
  type ReviewedRequest,
} from './domain/agent-review'
import { validateReviewEndpoint } from './domain/agent-review-client'
import { simulateRecovery } from './domain/simulation'
import { validateWorkflow } from './domain/validation'
import {
  fieldValueToText,
  type DisplayFormatId,
  type ProtocolReadOrderPreference,
  type ProtocolSourcePriorityPreference,
  type SimulationScenario,
  type WorkflowDocument,
  type WorkflowField,
  type WorkflowSchema,
} from './domain/schema'
import { useWorkflowStore } from './store/workflow-store'
import { useAgentReviewStore } from './store/agent-review-store'

type Route = { page: 'home' | 'learn' | 'build' | 'review'; step: number }
type CreationKind = 'standard' | 'blank' | null
type PreviewFormat = 'html' | 'markdown'

const steps = [
  ['确定用途', '给这套模板取名并说明它解决什么问题。'],
  ['选择文档', '挑选需要长期维护的资料。'],
  ['搭建文档', '像搭积木一样安排章节和信息项。'],
  ['审查协议', '核对系统整理出的入口协议。'],
  ['查看结果', '确认最终会生成哪些资料。'],
  ['演练与导出', '模拟恢复并下载可继续编辑的工作流包。'],
] as const

const formatCards: Array<{ id: Extract<DisplayFormatId, 'paragraph' | 'bullet-list' | 'steps'>; title: string; description: string }> = [
  { id: 'paragraph', title: '一段说明', description: '适合解释目标、边界、规则或背景。' },
  { id: 'bullet-list', title: '项目清单', description: '适合没有先后顺序的事实、材料或检查项。' },
  { id: 'steps', title: '按步骤写', description: '适合必须按顺序执行或读取的动作。' },
]

function isBeginnerDisplayFormat(format: DisplayFormatId | undefined): format is Extract<DisplayFormatId, 'paragraph' | 'bullet-list' | 'steps'> {
  return format === 'paragraph' || format === 'bullet-list' || format === 'steps'
}

function reviewEditTargetStep(target: ReviewEditTarget): number {
  if (target.scope === 'workflow-meta') return 1
  if (target.scope === 'protocol-read-order' || target.scope === 'protocol-source-priority') return 4
  return 3
}

function reviewEditTargetElementId(target: ReviewEditTarget): string {
  if (target.scope === 'workflow-meta') return `review-workflow-${target.property}`
  if (target.scope === 'document') return `review-document-${target.documentId}-${target.property}`
  if (target.scope === 'section') return `review-section-${target.documentId}-${target.sectionId}-${target.property}`
  if (target.scope === 'field') return `review-field-${target.documentId}-${target.sectionId}-${target.fieldId}-${target.property}`
  return target.scope === 'protocol-read-order' ? 'review-protocol-read-order' : 'review-protocol-source-priority'
}

function parseRoute(hash = window.location.hash): Route {
  const value = hash.replace(/^#/, '')
  if (value === 'learn') return { page: 'learn', step: 0 }
  if (value === 'review') return { page: 'review', step: 0 }
  const build = value.match(/^build\/step-(\d)$/)
  if (build) return { page: 'build', step: Math.min(6, Math.max(1, Number(build[1]))) }
  if (value.startsWith('advanced') || ['documents', 'rules'].includes(value)) return { page: 'build', step: value.includes('documents') ? 3 : value.includes('rules') ? 4 : 1 }
  if (['simulation', 'export'].includes(value)) return { page: 'build', step: 6 }
  return { page: 'home', step: 0 }
}

function routeHash(route: Route): string {
  if (route.page === 'home') return '#home'
  if (route.page === 'learn') return '#learn'
  if (route.page === 'review') return '#review'
  return `#build/step-${route.step}`
}

function useRoute(): [Route, (route: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState(() => parseRoute())
  useEffect(() => {
    const listener = () => setRoute(parseRoute())
    window.addEventListener('hashchange', listener)
    return () => window.removeEventListener('hashchange', listener)
  }, [])
  const navigate = (next: Route, replace = false) => {
    const hash = routeHash(next)
    if (replace) window.history.replaceState(null, '', hash)
    else window.location.hash = hash
    setRoute(next)
  }
  return [route, navigate]
}

function contentDocuments(workflow: WorkflowSchema): WorkflowDocument[] {
  return workflow.documents.filter((document) => document.role !== 'protocol')
}

function reviewEditTargetIsAvailable(workflow: WorkflowSchema, target: ReviewEditTarget): boolean {
  if (target.scope === 'workflow-meta') return !workflow.readOnlyReason
  if (target.scope === 'protocol-read-order' || target.scope === 'protocol-source-priority') {
    return !workflow.readOnlyReason && !workflow.protocolState.legacyManualOverride
  }
  const document = contentDocuments(workflow).find((candidate) => candidate.id === target.documentId)
  if (!document || workflow.readOnlyReason) return false
  if (target.scope === 'document') return true
  const section = document.sections.find((candidate) => candidate.id === target.sectionId)
  if (!section) return false
  if (target.scope === 'section') return true
  return section.fields.some((candidate) => candidate.id === target.fieldId)
}

function legacyContentCount(workflow: WorkflowSchema): number {
  if (workflow.mode !== 'legacy-content') return 0
  return contentDocuments(workflow)
    .flatMap((document) => document.sections)
    .flatMap((section) => section.fields)
    .filter((field) => fieldValueToText(field.value).trim().length > 0)
    .length
}

function legacyContentReferences(workflow: WorkflowSchema): Array<{ id: string; document: string; section: string; field: string }> {
  if (workflow.mode !== 'legacy-content') return []
  return contentDocuments(workflow).flatMap((document) => document.sections.flatMap((section) => section.fields
    .filter((field) => fieldValueToText(field.value).trim().length > 0)
    .map((field) => ({ id: `${document.id}/${section.id}/${field.id}`, document: document.filename, section: section.title, field: field.label }))))
}

function download(filename: string, content: BlobPart, mime = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function FormatSample({ format }: { format: Extract<DisplayFormatId, 'paragraph' | 'bullet-list' | 'steps'> }) {
  if (format === 'bullet-list') return <ul className="format-sample"><li>阅读入口协议</li><li>阅读当前状态</li><li>执行下一步</li></ul>
  if (format === 'steps') return <ol className="format-sample"><li>阅读入口协议</li><li>阅读当前状态</li><li>执行下一步</li></ol>
  return <p className="format-sample">先阅读入口协议，再阅读当前状态，最后执行下一步。</p>
}

function App() {
  const [route, navigate] = useRoute()
  const workflow = useWorkflowStore((state) => state.workflow)
  const projects = useWorkflowStore((state) => state.projects)
  const initialize = useWorkflowStore((state) => state.initialize)
  const importProject = useWorkflowStore((state) => state.importProject)
  const importInProgress = useWorkflowStore((state) => state.importInProgress)
  const storageMessage = useWorkflowStore((state) => state.storageMessage)
  const saveStatus = useWorkflowStore((state) => state.saveStatus)
  const createStandardProject = useWorkflowStore((state) => state.createStandardProject)
  const createEmptyProject = useWorkflowStore((state) => state.createEmptyProject)
  const duplicateCurrentProject = useWorkflowStore((state) => state.duplicateCurrentProject)
  const deleteProject = useWorkflowStore((state) => state.deleteProject)
  const openProject = useWorkflowStore((state) => state.openProject)
  const hydrateAgentReview = useAgentReviewStore((state) => state.hydrateBrowserSettings)
  const reviewInFlight = useAgentReviewStore((state) => state.inFlight)
  const reviewReport = useAgentReviewStore((state) => state.report)
  const reviewStatus = useAgentReviewStore((state) => state.reviewStatus)
  const reviewTestStatus = useAgentReviewStore((state) => state.testStatus)
  const reviewPrompt = useAgentReviewStore((state) => state.prompt)
  const isReviewProtocolConfirmed = useAgentReviewStore((state) => state.isProtocolConfirmed)
  const cancelReview = useAgentReviewStore((state) => state.cancelInFlight)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mainHeadingRef = useRef<HTMLHeadingElement>(null)
  const hasMountedRouteRef = useRef(false)
  const currentLegacyContentCount = workflow ? legacyContentCount(workflow) : 0
  const statusNeedsAttention = importInProgress || saveStatus === 'failed' || saveStatus === 'memory' || /失败|不可用|无法/.test(storageMessage)
  const headerReviewFingerprint = useMemo(() => {
    if (!workflow || !reviewReport) return null
    const protocolKey = reviewProtocolKey(workflow)
    const protocolStatus: 'confirmed' | 'draft' = protocolKey && isReviewProtocolConfirmed(workflow.workflowId, protocolKey) ? 'confirmed' : 'draft'
    try {
      return buildReviewMaterial({ workflow, userPrompt: reviewPrompt, protocolStatus }).inputFingerprint
    } catch {
      return null
    }
  }, [isReviewProtocolConfirmed, reviewPrompt, reviewReport, workflow])
  const headerReportStale = reviewReportIsStale(reviewReport, headerReviewFingerprint)
  const reviewHeaderLabel = reviewInFlight?.kind === 'review'
    ? ''
    : reviewReport
      ? reviewStatus.kind === 'error'
        ? headerReportStale ? '审查未完成 · 查看上次报告（基于较早版本）' : '审查未完成 · 查看上次报告'
        : headerReportStale ? '审查完成 · 查看报告（基于较早版本）' : '审查完成 · 查看报告'
      : reviewStatus.kind === 'error' ? '审查未完成 · 返回审查/重试' : ''
  const reviewLiveMessage = reviewInFlight
    ? `${reviewInFlight.kind === 'review' ? '智能体审查' : '连接测试'}：${reviewStageLabel(reviewInFlight.stage)}`
    : reviewStatus.kind === 'success' || reviewStatus.kind === 'error' ? reviewStatus.message
      : reviewTestStatus.kind === 'success' || reviewTestStatus.kind === 'error' ? reviewTestStatus.message
        : ''

  useEffect(() => {
    void initialize()
    void hydrateAgentReview()
  }, [hydrateAgentReview, initialize])
  useEffect(() => {
    if (!window.location.hash || window.location.hash.startsWith('#advanced') || ['#documents', '#rules', '#simulation', '#export'].includes(window.location.hash)) {
      window.history.replaceState(null, '', routeHash(parseRoute()))
    }
  }, [])
  useEffect(() => {
    if (!hasMountedRouteRef.current) {
      hasMountedRouteRef.current = true
      return
    }
    const timer = window.setTimeout(() => mainHeadingRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [route.page, route.step])

  const openImporter = () => fileInputRef.current?.click()
  const deleteCurrent = async () => {
    if (!workflow || !window.confirm(`删除“${workflow.name}”吗？这只会删除当前浏览器中的本地项目。`)) return
    await deleteProject(workflow.workflowId)
    navigate({ page: 'home', step: 0 })
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>跳到主要内容</a>
    <header className="site-header">
      <button className="brand" type="button" onClick={() => navigate({ page: 'home', step: 0 })}>Workflow Studio</button>
      <nav aria-label="主导航" className="site-nav">
        <button type="button" className={route.page === 'learn' ? 'nav-link active' : 'nav-link'} onClick={() => navigate({ page: 'learn', step: 0 })}><BookOpen size={16} aria-hidden="true" />工作流入门</button>
        <button type="button" className={route.page === 'build' ? 'nav-link active' : 'nav-link'} onClick={() => navigate({ page: 'build', step: workflow ? Math.max(2, route.step || 2) : 1 })}><FilePlus2 size={16} aria-hidden="true" />工作流搭建</button>
        <button type="button" className={route.page === 'review' ? 'nav-link active' : 'nav-link'} onClick={() => navigate({ page: 'review', step: 0 })}><Bot size={16} aria-hidden="true" />智能体审查</button>
      </nav>
      <div className="header-actions">
        {reviewInFlight?.kind === 'review' ? <div className="review-header-status"><span>智能体审查中</span><button type="button" className="text-action" onClick={cancelReview}>取消</button></div> : null}
        {!reviewInFlight && reviewHeaderLabel ? <button type="button" className="review-header-result text-action" onClick={() => navigate({ page: 'review', step: 0 })}>{reviewHeaderLabel}</button> : null}
        {workflow ? <details className="project-menu"><summary>项目 <ChevronRight size={15} aria-hidden="true" /></summary><div className="project-menu-panel">
          <p className="menu-label">本地项目</p>
          {projects.map((project) => <button key={project.id} type="button" className={project.id === workflow.workflowId ? 'project-choice active' : 'project-choice'} onClick={() => void openProject(project.id)}><span>{project.name}</span><small>{project.id === workflow.workflowId && currentLegacyContentCount > 0 ? `含 ${currentLegacyContentCount} 项旧版内容` : new Date(project.updatedAt).toLocaleDateString('zh-CN')}</small></button>)}
          <div className="menu-rule" />
          <button type="button" onClick={() => void duplicateCurrentProject()}>复制当前项目</button>
          <button type="button" onClick={deleteCurrent}>删除当前项目</button>
        </div></details> : null}
        <button className="icon-button" type="button" title="导入 workflow.json 或 ZIP" aria-label="导入 workflow.json 或 ZIP" onClick={openImporter} disabled={importInProgress}><Upload size={17} aria-hidden="true" /></button>
        <span className={`save-state ${saveStatus}`}>{saveStatus === 'saving' ? '保存中' : saveStatus === 'saved' ? '已保存' : saveStatus === 'memory' ? '仅内存' : '…'}</span>
      </div>
      <input ref={fileInputRef} className="visually-hidden" aria-label="选择要导入的文件" type="file" accept=".json,.zip" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importProject(file); event.currentTarget.value = '' }} />
    </header>
    <main id="main-content" className="site-main" tabIndex={-1}>
      {route.page === 'home' ? <HomePage headingRef={mainHeadingRef} onLearn={() => navigate({ page: 'learn', step: 0 })} onBuild={() => navigate({ page: 'build', step: 1 })} /> : null}
      {route.page === 'learn' ? <LearnPage headingRef={mainHeadingRef} onBuild={() => navigate({ page: 'build', step: 1 })} /> : null}
      {route.page === 'build' ? <BuildPage headingRef={mainHeadingRef} workflow={workflow} step={route.step} onNavigate={navigate} createStandard={createStandardProject} createBlank={createEmptyProject} openImporter={openImporter} /> : null}
      {route.page === 'review' ? <ReviewPage headingRef={mainHeadingRef} workflow={workflow} onNavigate={navigate} /> : null}
    </main>
    <p className="review-live-region" role="status" aria-live="polite">{reviewLiveMessage}</p>
    <div className={statusNeedsAttention ? 'status-line' : 'status-line quiet'} role={statusNeedsAttention ? 'status' : undefined} aria-live={statusNeedsAttention ? 'polite' : 'off'}>{storageMessage}</div>
  </div>
}

function HomePage({ headingRef, onLearn, onBuild }: { headingRef: React.RefObject<HTMLHeadingElement | null>; onLearn: () => void; onBuild: () => void }) {
  return <>
    <section className="home-hero" aria-labelledby="home-title">
      <p className="eyebrow">Local-first workflow design</p>
      <h1 id="home-title" ref={headingRef} tabIndex={-1}>让模型始终知道<br /><span className="underline-emphasis">该读什么、信什么、接着做什么。</span></h1>
      <p className="hero-copy">把一套工作方法拆成清楚的资料、长期说明和可恢复的入口协议。这里先帮你理解，再带你一步步搭建。</p>
      <div className="hero-actions">
        <button type="button" className="button primary" onClick={onLearn}><BookOpen size={18} aria-hidden="true" />工作流入门</button>
        <button type="button" className="button secondary" onClick={onBuild}><FilePlus2 size={18} aria-hidden="true" />开始搭建</button>
      </div>
    </section>
    <section className="home-notes" aria-label="工作流特点">
      <article><span>01</span><h2>资料各司其职</h2><p>每份文档只保存一种生命周期的内容，减少冲突和重复。</p></article>
      <article><span>02</span><h2>结构先于内容</h2><p>先设计模型未来该如何记录，再让它在实际工作中填写事实。</p></article>
      <article><span>03</span><h2>恢复无需猜测</h2><p>入口协议从你选择的资料和结构生成，后续可以重新审查。</p></article>
    </section>
  </>
}

function LearnPage({ headingRef, onBuild }: { headingRef: React.RefObject<HTMLHeadingElement | null>; onBuild: () => void }) {
  return <article className="learn-page">
    <p className="eyebrow">Workflow primer</p>
    <h1 ref={headingRef} tabIndex={-1}>先把<strong>要保存的判断</strong>想清楚。</h1>
    <p className="lead">工作流不是一堆表单。它是给下一次协作留下可信入口：哪些资料必须先读，哪些内容只在需要时查，哪些事实会变化，哪些历史不能覆盖当前判断。</p>
    <div className="learning-sections">
      <section><span>01</span><div><h2>先确定资料，不要先填内容</h2><p>先选长期计划、当前状态、历史或术语解释等资料。它们的职责明确后，模型才知道应该把信息写到哪里。</p></div></section>
      <section><span>02</span><div><h2>章节决定主题，信息项决定记录什么</h2><p>章节是一组相关主题；信息项是模型未来会填写的一块内容。每项只需名称、说明和导出后的排版。</p></div></section>
      <section><span>03</span><div><h2>模板不是项目运行记录</h2><p>搭建时不填写项目事实。你是在留下空槽和长期说明，之后的模型才能按照说明安全填写。</p></div></section>
      <section><span>04</span><div><h2>入口协议由结构生成</h2><p>当至少有一份资料和一个信息项后，系统会整理职责和完成检查。你可以调整读取顺序与来源优先级，也可以补充通用提醒，不需要手填底层规则。</p></div></section>
    </div>
    <button type="button" className="button primary" onClick={onBuild}>开始搭建 <ChevronRight size={18} aria-hidden="true" /></button>
  </article>
}

type BuildPageProps = {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  workflow: WorkflowSchema | null
  step: number
  onNavigate: (route: Route, replace?: boolean) => void
  createStandard: (input: { name: string; description: string }) => Promise<void>
  createBlank: (input: { name: string; description: string }) => Promise<void>
  openImporter: () => void
}

function BuildPage({ headingRef, workflow, step, onNavigate, createStandard, createBlank, openImporter }: BuildPageProps) {
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null)
  const [pendingReviewFocus, setPendingReviewFocus] = useState<string | null>(null)
  const saveStatus = useWorkflowStore((state) => state.saveStatus)
  const isProtocolConfirmed = useAgentReviewStore((state) => state.isProtocolConfirmed)
  const confirmProtocol = useAgentReviewStore((state) => state.confirmProtocol)
  const editIntent = useAgentReviewStore((state) => state.editIntent)
  const consumeEditIntent = useAgentReviewStore((state) => state.consumeEditIntent)
  const content = useMemo(() => workflow ? contentDocuments(workflow) : [], [workflow])
  const protocolKey = workflow ? reviewProtocolKey(workflow) : null
  const protocolConfirmed = Boolean(workflow && isProtocolConfirmed(workflow.workflowId, protocolKey))

  useEffect(() => {
    if (!workflow && saveStatus !== 'loading' && step !== 1) onNavigate({ page: 'build', step: 1 }, true)
  }, [onNavigate, saveStatus, step, workflow])

  useEffect(() => {
    if (workflow?.readOnlyReason && step !== 6) onNavigate({ page: 'build', step: 6 }, true)
  }, [onNavigate, step, workflow?.readOnlyReason])

  useEffect(() => {
    if (!content.some((document) => document.id === activeDocumentId)) {
      setActiveDocumentId(content[0]?.id ?? null)
      setActiveSectionId(content[0]?.sections[0]?.id ?? null)
      setActiveFieldId(content[0]?.sections[0]?.fields[0]?.id ?? null)
    }
  }, [activeDocumentId, content])

  useEffect(() => {
    if (!workflow || !editIntent || editIntent.workflowId !== workflow.workflowId) return
    const targetStep = reviewEditTargetStep(editIntent.target)
    if (step !== targetStep) {
      onNavigate({ page: 'build', step: targetStep }, true)
      return
    }
    if (editIntent.target.scope === 'document' || editIntent.target.scope === 'section' || editIntent.target.scope === 'field') {
      setActiveDocumentId(editIntent.target.documentId)
      if (editIntent.target.scope === 'section' || editIntent.target.scope === 'field') setActiveSectionId(editIntent.target.sectionId)
      if (editIntent.target.scope === 'field') setActiveFieldId(editIntent.target.fieldId)
    }
    const consumed = consumeEditIntent(workflow.workflowId)
    if (!consumed) return
    setPendingReviewFocus(reviewEditTargetElementId(consumed.target))
  }, [consumeEditIntent, editIntent, onNavigate, step, workflow])

  useEffect(() => {
    if (!pendingReviewFocus) return
    const timer = window.setTimeout(() => {
      const target = document.getElementById(pendingReviewFocus)
      if (target instanceof HTMLElement) target.focus()
      else headingRef.current?.focus()
      setPendingReviewFocus(null)
    }, 40)
    return () => window.clearTimeout(timer)
  }, [activeDocumentId, activeFieldId, activeSectionId, headingRef, pendingReviewFocus])

  const displayedStep = workflow ? step : 1
  const go = (nextStep: number) => onNavigate({ page: 'build', step: nextStep })

  return <section className="builder-page" aria-labelledby="builder-title">
    <header className="builder-heading">
      <p className="eyebrow">Build a workflow</p>
      <h1 id="builder-title" ref={headingRef} tabIndex={-1}>{workflow ? workflow.name : '从一套清楚的资料开始。'}</h1>
      <p>{workflow ? '先安排资料，再定义每一项需要记录什么。模板设计不填写项目运行内容。' : '选择一个起点。标准模板适合第一次使用；空白模板适合已经有明确结构的人。'}</p>
    </header>

    <ol className="build-progress" aria-label="工作流搭建步骤">
      {steps.map(([title, description], index) => {
        const number = index + 1
        const active = displayedStep === number
        return <li key={title} className={active ? 'active' : ''}>
          <button type="button" aria-current={active ? 'step' : undefined} onClick={() => go(number)}>
            <span>{number}</span><strong>{title}</strong><small>{description}</small>
          </button>
        </li>
      })}
    </ol>

    {workflow && legacyContentCount(workflow) > 0 ? <LegacyContentNotice workflow={workflow} showDetails={displayedStep >= 5} /> : null}
    {displayedStep === 1 ? <ProjectStartStep workflow={workflow} onCreateStandard={createStandard} onCreateBlank={createBlank} onNext={() => go(2)} openImporter={openImporter} /> : null}
    {displayedStep === 2 && workflow ? <DocumentSelectionStep workflow={workflow} onNext={() => go(3)} /> : null}
    {displayedStep >= 3 && workflow ? <BuildPagePlaceholder step={displayedStep} workflow={workflow} activeDocumentId={activeDocumentId} activeSectionId={activeSectionId} activeFieldId={activeFieldId} setActiveDocumentId={setActiveDocumentId} setActiveSectionId={setActiveSectionId} setActiveFieldId={setActiveFieldId} protocolConfirmed={protocolConfirmed} onProtocolConfirmed={() => { if (protocolKey) confirmProtocol(workflow.workflowId, protocolKey) }} onNavigate={go} /> : null}
  </section>
}

function LegacyContentNotice({ workflow, showDetails }: { workflow: WorkflowSchema; showDetails: boolean }) {
  const convertLegacyToTemplate = useWorkflowStore((state) => state.convertLegacyToTemplate)
  const references = legacyContentReferences(workflow)
  return <section className="legacy-content-notice" aria-label="旧版内容提示">
    <AlertCircle size={20} aria-hidden="true" />
    <div><strong>这份导入工作流保留了 {references.length} 项旧版项目内容。</strong><p>新手编辑器不会显示它们；在转换前，完整 ZIP 仍会保留并导出这些内容。转换会清空旧内容和旧限制，保留资料、章节、常驻填写说明与排版。建议先在项目菜单复制一份。</p>{showDetails ? <details className="legacy-content-details"><summary>查看会随完整 ZIP 保留的内容位置</summary><ul>{references.map((reference) => <li key={reference.id}><code>{reference.document}</code><span>{reference.section} / {reference.field}</span></li>)}</ul></details> : null}</div>
    <button type="button" className="button secondary" onClick={() => { if (window.confirm('将当前项目转换为新的空模板吗？旧版项目内容和旧限制会被清空，且无法在当前项目中撤销。')) convertLegacyToTemplate() }}>转换为新的空模板</button>
  </section>
}

function ProjectStartStep({ workflow, onCreateStandard, onCreateBlank, onNext, openImporter }: {
  workflow: WorkflowSchema | null
  onCreateStandard: (input: { name: string; description: string }) => Promise<void>
  onCreateBlank: (input: { name: string; description: string }) => Promise<void>
  onNext: () => void
  openImporter: () => void
}) {
  const [kind, setKind] = useState<CreationKind>('standard')
  const [name, setName] = useState('我的工作流')
  const [description, setDescription] = useState('帮助模型在每次协作中找到正确资料和下一步。')
  const [error, setError] = useState('')
  const updateWorkflowMeta = useWorkflowStore((state) => state.updateWorkflowMeta)

  if (workflow) {
    return <section className="step-panel project-summary" aria-labelledby="project-summary-title">
      <p className="step-marker">第 1 步</p>
      <h2 id="project-summary-title">这套工作流要解决什么？</h2>
      <p className="step-intro">名称和说明会出现在导出包的说明中。它们描述模板用途，不是当前项目进度。</p>
      <div className="form-grid">
        <label>工作流名称<input id="review-workflow-name" value={workflow.name} onChange={(event) => updateWorkflowMeta({ name: event.target.value, description: workflow.description })} /></label>
        <label className="wide">一句话说明<textarea id="review-workflow-description" rows={3} value={workflow.description} onChange={(event) => updateWorkflowMeta({ name: workflow.name, description: event.target.value })} /></label>
      </div>
      <div className="step-actions"><button type="button" className="button primary" onClick={onNext}>继续选择资料 <ChevronRight size={17} aria-hidden="true" /></button></div>
    </section>
  }

  const create = async () => {
    if (!name.trim()) {
      setError('先给这套工作流取一个名字。')
      return
    }
    if (!description.trim()) {
      setError('用一句话说明它要帮助模型完成什么。')
      return
    }
    setError('')
    const input = { name: name.trim(), description: description.trim() }
    if (kind === 'blank') await onCreateBlank(input)
    else await onCreateStandard(input)
    onNext()
  }

  return <section className="step-panel" aria-labelledby="start-title">
    <p className="step-marker">第 1 步</p>
    <h2 id="start-title">先选一个容易开始的方式。</h2>
    <p className="step-intro">两种方式都会生成可继续编辑的本地模板。入口协议 AGENTS.md 不需要现在手写，系统会在资料结构完成后生成。</p>
    <div className="start-options" role="radiogroup" aria-label="模板起点">
      <button type="button" role="radio" aria-checked={kind === 'standard'} className={kind === 'standard' ? 'start-option selected' : 'start-option'} onClick={() => setKind('standard')}>
        <span className="option-tag">推荐</span><strong>使用标准模板</strong><p>先放入计划、状态、历史等常见资料，再按需要删减。</p><small>适合第一次搭建。</small>
      </button>
      <button type="button" role="radio" aria-checked={kind === 'blank'} className={kind === 'blank' ? 'start-option selected' : 'start-option'} onClick={() => setKind('blank')}>
        <span className="option-tag">自定义</span><strong>从空白开始</strong><p>自己添加资料、章节和信息项，系统只在结构完整后生成入口协议。</p><small>适合已有明确结构。</small>
      </button>
    </div>
    <div className="form-grid">
      <label>工作流名称<input value={name} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(error && !name.trim())} /></label>
      <label className="wide">一句话说明<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} aria-invalid={Boolean(error && !description.trim())} /></label>
    </div>
    {error ? <p className="form-error" role="alert"><AlertCircle size={16} aria-hidden="true" />{error}</p> : null}
    <div className="step-actions">
      <button type="button" className="button primary" onClick={() => void create()}>{kind === 'blank' ? '创建空白模板' : '创建标准模板'} <ChevronRight size={17} aria-hidden="true" /></button>
      <button type="button" className="button text" onClick={openImporter}><FolderOpen size={17} aria-hidden="true" />导入已有 workflow.json 或 ZIP</button>
    </div>
  </section>
}

function DocumentSelectionStep({ workflow, onNext }: { workflow: WorkflowSchema; onNext: () => void }) {
  const addStandardDocument = useWorkflowStore((state) => state.addStandardDocument)
  const addContentDocument = useWorkflowStore((state) => state.addContentDocument)
  const removeDocument = useWorkflowStore((state) => state.removeDocument)
  const documents = contentDocuments(workflow)

  const toggleStandard = (card: typeof standardDocumentCards[number]) => {
    const present = documents.find((document) => document.filename === card.filename)
    if (present) removeDocument(present.id)
    else addStandardDocument(card.id)
  }

  return <section className="step-panel" aria-labelledby="documents-title">
    <p className="step-marker">第 2 步</p>
    <h2 id="documents-title">选择需要长期维护的资料。</h2>
    <p className="step-intro">一份资料只负责一种信息生命周期。这里选的是模板中的文档，不是在填写项目事实。系统会根据你的选择生成 AGENTS.md。</p>
    <div className="protocol-note"><FileText size={20} aria-hidden="true" /><p><strong>AGENTS.md 会自动生成。</strong>它负责告诉模型先读哪些资料、冲突时信什么，以及交付前做哪些检查。等资料结构完整后再审查它。</p></div>
    <div className="document-options">
      {standardDocumentCards.map((card) => {
        const selected = documents.some((document) => document.filename === card.filename)
        return <label className={selected ? 'document-option selected' : 'document-option'} key={card.id}>
          <input type="checkbox" checked={selected} onChange={() => toggleStandard(card)} />
          <span><strong>{card.filename}</strong><b>{card.title}</b><p>{card.description}</p><small>{card.whenToUse}</small></span>
        </label>
      })}
    </div>
    <div className="custom-document-row">
      <div><strong>还需要一份自己的资料？</strong><p>先新增一张空白文档卡，再在下一步给它命名、说明职责和添加章节。</p></div>
      <button type="button" className="button secondary" onClick={addContentDocument}><Plus size={17} aria-hidden="true" />新增自定义文档</button>
    </div>
    {documents.some((document) => !standardDocumentCards.some((card) => card.filename === document.filename)) ? <div className="custom-documents" aria-label="自定义文档">
      {documents.filter((document) => !standardDocumentCards.some((card) => card.filename === document.filename)).map((document) => <div key={document.id}><span><strong>{document.filename}</strong><small>{document.description}</small></span><button type="button" className="text-action" onClick={() => removeDocument(document.id)}>删除</button></div>)}
    </div> : null}
    <div className="step-actions">
      <button type="button" className="button primary" disabled={documents.length === 0} onClick={onNext}>开始搭建资料内容 <ChevronRight size={17} aria-hidden="true" /></button>
      {documents.length === 0 ? <p className="inline-help"><CircleHelp size={16} aria-hidden="true" />至少选一份资料，系统才能生成可读的入口协议。</p> : null}
    </div>
  </section>
}

function BuildPagePlaceholder({ step, workflow, activeDocumentId, activeSectionId, activeFieldId, setActiveDocumentId, setActiveSectionId, setActiveFieldId, protocolConfirmed, onProtocolConfirmed, onNavigate }: {
  step: number
  workflow: WorkflowSchema
  activeDocumentId: string | null
  activeSectionId: string | null
  activeFieldId: string | null
  setActiveDocumentId: (id: string | null) => void
  setActiveSectionId: (id: string | null) => void
  setActiveFieldId: (id: string | null) => void
  protocolConfirmed: boolean
  onProtocolConfirmed: () => void
  onNavigate: (step: number) => void
}) {
  if (step === 3) return <DocumentCanvasStep workflow={workflow} activeDocumentId={activeDocumentId} activeSectionId={activeSectionId} activeFieldId={activeFieldId} setActiveDocumentId={setActiveDocumentId} setActiveSectionId={setActiveSectionId} setActiveFieldId={setActiveFieldId} onNext={() => onNavigate(4)} />
  if (step === 4) return <ProtocolReviewStep workflow={workflow} onEditDocument={(documentId) => { setActiveDocumentId(documentId); onNavigate(3) }} confirmed={protocolConfirmed} onConfirmed={onProtocolConfirmed} onNext={() => onNavigate(5)} />
  if (step === 5) return <ResultPreviewStep workflow={workflow} protocolConfirmed={protocolConfirmed} onReviewProtocol={() => onNavigate(4)} onNext={() => onNavigate(6)} />
  if (step === 6) return <RehearseExportStep workflow={workflow} protocolConfirmed={protocolConfirmed} onReviewProtocol={() => onNavigate(4)} />
  return <section className="step-panel pending-step">
    <p className="step-marker">第 {step} 步</p>
    <h2>这一部分将在下一小段接入。</h2>
    <p>当前项目包含 {contentDocuments(workflow).length} 份内容文档。</p>
    <button type="button" className="button secondary" onClick={() => onNavigate(3)}>返回搭建资料</button>
  </section>
}

function DocumentCanvasStep({ workflow, activeDocumentId, activeSectionId, activeFieldId, setActiveDocumentId, setActiveSectionId, setActiveFieldId, onNext }: {
  workflow: WorkflowSchema
  activeDocumentId: string | null
  activeSectionId: string | null
  activeFieldId: string | null
  setActiveDocumentId: (id: string | null) => void
  setActiveSectionId: (id: string | null) => void
  setActiveFieldId: (id: string | null) => void
  onNext: () => void
}) {
  const updateDocument = useWorkflowStore((state) => state.updateDocument)
  const addSection = useWorkflowStore((state) => state.addSection)
  const addSectionFromModule = useWorkflowStore((state) => state.addSectionFromModule)
  const updateSection = useWorkflowStore((state) => state.updateSection)
  const removeSection = useWorkflowStore((state) => state.removeSection)
  const addField = useWorkflowStore((state) => state.addField)
  const addFieldFromModule = useWorkflowStore((state) => state.addFieldFromModule)
  const updateField = useWorkflowStore((state) => state.updateField)
  const moveField = useWorkflowStore((state) => state.moveField)
  const removeField = useWorkflowStore((state) => state.removeField)
  const documents = contentDocuments(workflow)
  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? documents[0]
  const activeSection = activeDocument?.sections.find((section) => section.id === activeSectionId) ?? activeDocument?.sections[0]
  const activeField = activeSection?.fields.find((field) => field.id === activeFieldId) ?? activeSection?.fields[0]
  const fieldNameInputRef = useRef<HTMLInputElement>(null)
  const [pendingFieldFocus, setPendingFieldFocus] = useState<string | null>(null)

  useEffect(() => {
    if (!pendingFieldFocus || activeField?.id !== pendingFieldFocus) return
    const timer = window.setTimeout(() => {
      fieldNameInputRef.current?.focus()
      setPendingFieldFocus(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeField?.id, pendingFieldFocus])

  const chooseDocument = (document: WorkflowDocument) => {
    setActiveDocumentId(document.id)
    setActiveSectionId(document.sections[0]?.id ?? null)
    setActiveFieldId(document.sections[0]?.fields[0]?.id ?? null)
  }
  const chooseSection = (sectionId: string) => {
    const section = activeDocument?.sections.find((item) => item.id === sectionId)
    setActiveSectionId(sectionId)
    setActiveFieldId(section?.fields[0]?.id ?? null)
  }
  const addManualField = () => {
    if (!activeDocument || !activeSection) return
    const fieldId = addField(activeDocument.id, activeSection.id)
    if (fieldId) {
      setActiveFieldId(fieldId)
      setPendingFieldFocus(fieldId)
    }
  }
  const addLibraryField = (moduleId: string) => {
    if (!activeDocument || !activeSection) return
    const fieldId = addFieldFromModule(activeDocument.id, activeSection.id, moduleId)
    if (fieldId) {
      setActiveFieldId(fieldId)
      setPendingFieldFocus(fieldId)
    }
  }

  if (!activeDocument) {
    return <section className="step-panel empty-builder">
      <p className="step-marker">第 3 步</p>
      <h2>先选择至少一份资料。</h2>
      <p>没有资料时，无法安排章节或告诉系统该生成怎样的入口协议。</p>
    </section>
  }

  const availableSectionModules = sectionModuleLibrary.filter((module) => module.targetRoles.includes(activeDocument.role))
  const availableFieldModules = fieldModuleLibrary.filter((module) => module.targetRoles.includes(activeDocument.role))

  return <section className="step-panel canvas-step" aria-labelledby="canvas-title">
    <p className="step-marker">第 3 步</p>
    <h2 id="canvas-title">给每份资料搭好章节和信息项。</h2>
    <p className="step-intro">每次只编辑一个信息项。你要留下的是名称、常驻填写说明和导出后的呈现方式；项目事实留给以后实际使用时填写。</p>

    <div className="document-switcher" aria-label="选择正在编辑的资料">
      {documents.map((document) => <button key={document.id} type="button" className={document.id === activeDocument.id ? 'document-tab active' : 'document-tab'} onClick={() => chooseDocument(document)}>
        <strong>{document.title}</strong><small>{document.filename}</small><span>{document.sections.reduce((count, section) => count + section.fields.length, 0)} 项</span>
      </button>)}
    </div>

    <section className="document-details" aria-labelledby="document-details-title">
      <div className="document-details-heading"><div><p className="micro-label">正在设计的资料</p><h3 id="document-details-title">{activeDocument.filename}</h3><p>{activeDocument.description}</p></div><FileText size={28} aria-hidden="true" /></div>
      <div className="form-grid document-form">
        <label>资料标题（页面上看到的名字）<input id={`review-document-${activeDocument.id}-title`} value={activeDocument.title} onChange={(event) => updateDocument(activeDocument.id, { title: event.target.value, description: activeDocument.description, filename: activeDocument.filename })} /></label>
        <label>导出文件名（保存到文件夹中的名字）<input id={`review-document-${activeDocument.id}-filename`} value={activeDocument.filename} onChange={(event) => updateDocument(activeDocument.id, { title: activeDocument.title, description: activeDocument.description, filename: event.target.value })} /></label>
        <label className="wide">这份资料只负责什么<textarea id={`review-document-${activeDocument.id}-description`} rows={3} value={activeDocument.description} onChange={(event) => updateDocument(activeDocument.id, { title: activeDocument.title, description: event.target.value, filename: activeDocument.filename })} /></label>
      </div>
    </section>

    <div className="canvas-layout">
      <aside className="chapter-list" aria-label="章节目录">
        <div><p className="micro-label">章节目录</p><h3>先选一个主题</h3><p>章节把同一主题的信息放在一起。</p></div>
        {activeDocument.sections.map((section) => <button type="button" key={section.id} className={section.id === activeSection?.id ? 'chapter-choice active' : 'chapter-choice'} onClick={() => chooseSection(section.id)}><strong>{section.title}</strong><small>{section.fields.length} 个信息项</small></button>)}
        <div className="chapter-add">
          <p>常用章节</p>
          {availableSectionModules.map((module) => <button type="button" key={module.id} className="text-action" onClick={() => { addSectionFromModule(activeDocument.id, module.id); window.setTimeout(() => { const next = contentDocuments(useWorkflowStore.getState().workflow!).find((document) => document.id === activeDocument.id)?.sections.at(-1); if (next) chooseSection(next.id) }, 0) }}>+ {module.title}</button>)}
          <button type="button" className="text-action" onClick={() => { addSection(activeDocument.id); window.setTimeout(() => { const next = contentDocuments(useWorkflowStore.getState().workflow!).find((document) => document.id === activeDocument.id)?.sections.at(-1); if (next) chooseSection(next.id) }, 0) }}>+ 自己新建章节</button>
        </div>
      </aside>

      {activeSection ? <section className="section-workspace" aria-labelledby="section-title">
        <div className="section-heading-block"><p className="micro-label">正在设计的章节</p><h3 id="section-title">{activeSection.title}</h3><p>先写清这一章要收集什么，再添加信息项。</p></div>
        <div className="form-grid section-form">
          <label>章节名称<input id={`review-section-${activeDocument.id}-${activeSection.id}-title`} value={activeSection.title} onChange={(event) => updateSection(activeDocument.id, activeSection.id, { title: event.target.value, purpose: activeSection.purpose })} /></label>
          <label className="wide">这一章负责什么<textarea id={`review-section-${activeDocument.id}-${activeSection.id}-purpose`} rows={2} value={activeSection.purpose} onChange={(event) => updateSection(activeDocument.id, activeSection.id, { title: activeSection.title, purpose: event.target.value })} /></label>
        </div>
        <div className="information-list" aria-label="章节中的信息项">
          <div className="information-list-heading"><div><p className="micro-label">信息项</p><h4>告诉未来模型要记录什么</h4></div><button type="button" className="button secondary" onClick={addManualField}><Plus size={17} aria-hidden="true" />新增信息项</button></div>
          {activeSection.fields.length === 0 ? <div className="empty-information"><p>这一章还没有信息项。可以先新增一个简单的信息项，或从下方挑一个常用项。</p></div> : activeSection.fields.map((field, index) => <div className={field.id === activeField?.id ? 'information-row active' : 'information-row'} key={field.id}>
            <button type="button" className="information-select" onClick={() => setActiveFieldId(field.id)}><span>{index + 1}</span><strong>{field.label}</strong><small>{field.guidance}</small></button>
            <div className="information-actions"><button type="button" className="icon-button" title="上移信息项" aria-label={`上移 ${field.label}`} disabled={index === 0} onClick={() => moveField(activeDocument.id, activeSection.id, field.id, -1)}><ArrowUp size={16} aria-hidden="true" /></button><button type="button" className="icon-button" title="下移信息项" aria-label={`下移 ${field.label}`} disabled={index === activeSection.fields.length - 1} onClick={() => moveField(activeDocument.id, activeSection.id, field.id, 1)}><ArrowDown size={16} aria-hidden="true" /></button><button type="button" className="icon-button danger" title="删除信息项" aria-label={`删除 ${field.label}`} onClick={() => { if (window.confirm(`删除“${field.label}”吗？这不会删除其他资料。`)) removeField(activeDocument.id, activeSection.id, field.id) }}><Trash2 size={16} aria-hidden="true" /></button></div>
          </div>)}
        </div>
        <div className="field-library"><p className="micro-label">常用信息项</p><p>这些只是可修改的起点。选中后仍可以改名字、填写说明和呈现方式。</p><div>{availableFieldModules.map((module) => <button type="button" key={module.id} className="library-choice" onClick={() => addLibraryField(module.id)}><strong>{module.label}</strong><small>{module.userBenefit}</small></button>)}</div></div>
        {activeField ? <FieldDesignCard document={activeDocument} section={activeSection} field={activeField} nameInputRef={fieldNameInputRef} onChange={(patch) => updateField(activeDocument.id, activeSection.id, activeField.id, patch)} /> : null}
        <div className="section-footer"><button type="button" className="text-action danger-text" onClick={() => { if (window.confirm(`删除章节“${activeSection.title}”及其中的信息项吗？`)) { removeSection(activeDocument.id, activeSection.id); const next = activeDocument.sections.find((section) => section.id !== activeSection.id); setActiveSectionId(next?.id ?? null); setActiveFieldId(next?.fields[0]?.id ?? null) } }}>删除这一章</button></div>
      </section> : <section className="section-workspace"><p>先新建一个章节。</p></section>}
    </div>
    <div className="step-actions"><button type="button" className="button primary" onClick={onNext}>审查入口协议 <ChevronRight size={17} aria-hidden="true" /></button></div>
  </section>
}

function FieldDesignCard({ document, section, field, nameInputRef, onChange }: {
  document: WorkflowDocument
  section: WorkflowDocument['sections'][number]
  field: WorkflowField
  nameInputRef: React.RefObject<HTMLInputElement | null>
  onChange: (patch: Pick<WorkflowField, 'label' | 'guidance'> & Partial<Pick<WorkflowField, 'displayFormat'>>) => void
}) {
  const selectedFormat = isBeginnerDisplayFormat(field.displayFormat) ? field.displayFormat : undefined
  const legacyFormat = field.displayFormat && !isBeginnerDisplayFormat(field.displayFormat) ? field.displayFormat : undefined
  return <section className="field-design-card" aria-labelledby="field-design-title">
    <div className="field-design-heading"><div><p className="micro-label">正在编辑的信息项</p><h4 id="field-design-title">{field.label}</h4><p>模板阶段不填写项目事实。现在只定义未来模型应当怎么记录这项信息。</p></div><span className="field-location">{document.filename} / {section.title}</span></div>
    <div className="form-grid field-form">
      <label>信息项名称<input id={`review-field-${document.id}-${section.id}-${field.id}-label`} ref={nameInputRef} value={field.label} onChange={(event) => onChange({ label: event.target.value, guidance: field.guidance })} /></label>
      <label className="wide">常驻填写说明<textarea id={`review-field-${document.id}-${section.id}-${field.id}-guidance`} rows={3} value={field.guidance} onChange={(event) => onChange({ label: field.label, guidance: event.target.value })} /></label>
    </div>
    <div className="format-area" id={`review-field-${document.id}-${section.id}-${field.id}-display-format`} tabIndex={-1}><div><p className="micro-label">导出后怎么呈现</p><h4>选一种最容易读懂的排版</h4><p>下面的内容只是实时示例，不会写入你的模板。</p></div>{legacyFormat ? <div className="legacy-format-note" role="status"><strong>旧版排版：{displayFormatLabels[legacyFormat]}</strong><p>这是导入包原有的呈现方式，目前会保持原样。只有主动选择下面的新排版，才会替换它。</p></div> : null}<div className="format-options" role="radiogroup" aria-label="导出后的呈现方式">
      {formatCards.map((format) => <label className={selectedFormat === format.id ? 'format-option selected' : 'format-option'} key={format.id}>
        <input type="radio" name={`format-${field.id}`} checked={selectedFormat === format.id} onChange={() => onChange({ label: field.label, guidance: field.guidance, displayFormat: format.id })} />
        <span><strong>{format.title}</strong><small>{format.description}</small><FormatSample format={format.id} /></span>
      </label>)}
    </div></div>
    {selectedFormat ? <p className="format-explanation" role="status" aria-live="polite"><Eye size={16} aria-hidden="true" />已选择<strong>{formatCards.find((format) => format.id === selectedFormat)?.title}</strong>。{formatCards.find((format) => format.id === selectedFormat)?.description}</p> : null}
  </section>
}

export default App

function ProtocolReviewStep({ workflow, onEditDocument, confirmed, onConfirmed, onNext }: {
  workflow: WorkflowSchema
  onEditDocument: (documentId: string) => void
  confirmed: boolean
  onConfirmed: () => void
  onNext: () => void
}) {
  const regenerateProtocol = useWorkflowStore((state) => state.regenerateProtocol)
  const addProtocolSupplement = useWorkflowStore((state) => state.addProtocolSupplement)
  const removeProtocolSupplement = useWorkflowStore((state) => state.removeProtocolSupplement)
  const selectLegacyProtocol = useWorkflowStore((state) => state.selectLegacyProtocol)
  const moveProtocolReadItem = useWorkflowStore((state) => state.moveProtocolReadItem)
  const updateProtocolReadItem = useWorkflowStore((state) => state.updateProtocolReadItem)
  const moveProtocolSourceItem = useWorkflowStore((state) => state.moveProtocolSourceItem)
  const updateProtocolSourceItem = useWorkflowStore((state) => state.updateProtocolSourceItem)
  const resetProtocolOrdering = useWorkflowStore((state) => state.resetProtocolOrdering)
  const projection = useMemo(() => buildProtocolProjection(workflow), [workflow])
  const [acknowledged, setAcknowledged] = useState(false)
  const [addingSupplement, setAddingSupplement] = useState(false)
  const [supplementTitle, setSupplementTitle] = useState('')
  const [supplementInstruction, setSupplementInstruction] = useState('')
  const [supplementFormat, setSupplementFormat] = useState<Extract<DisplayFormatId, 'paragraph' | 'bullet-list' | 'steps'>>('paragraph')
  const blockingDiagnostics = projection.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  const warningDiagnostics = projection.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')
  const validationErrors = validateWorkflow(workflow).filter((issue) => issue.severity === 'error')
  const effective = projection.effective
  const content = contentDocuments(workflow)
  const legacy = workflow.protocolState.legacyManualOverride
  const orderingEditable = !legacy

  useEffect(() => {
    setAcknowledged(false)
  }, [workflow.protocolState.orderingPreferences, workflow.protocolState.system])

  const saveSupplement = () => {
    if (!supplementTitle.trim() || !supplementInstruction.trim()) return
    addProtocolSupplement({ title: supplementTitle.trim(), instruction: supplementInstruction.trim(), displayFormat: supplementFormat })
    setSupplementTitle('')
    setSupplementInstruction('')
    setSupplementFormat('paragraph')
    setAddingSupplement(false)
    setAcknowledged(false)
  }

  return <section className="step-panel protocol-step" aria-labelledby="protocol-title">
    <p className="step-marker">第 4 步</p>
    <h2 id="protocol-title">审查系统整理出的入口协议。</h2>
    <p className="step-intro">这是模型每次开始工作时先读的说明。它来自你刚才选择的资料、章节和填写说明，不需要手工维护底层规则。</p>

    <div className={projection.freshness === 'current' && effective ? 'protocol-state ready' : 'protocol-state'}>
      <div><strong>{projection.owner.document === 'legacy-manual' ? '正在使用兼容的旧版协议' : projection.freshness === 'current' ? '入口协议已根据当前结构生成' : '入口协议需要生成或刷新'}</strong><p>{projection.freshness === 'current' ? '改动资料结构后，请回到这里重新生成并审查。' : '先确保每份资料至少有一个信息项，再生成新的入口协议。'}</p></div>
      <button type="button" className="button secondary" onClick={regenerateProtocol}><RefreshCw size={17} aria-hidden="true" />{projection.freshness === 'current' ? '重新生成' : '生成入口协议'}</button>
    </div>

    {legacy && legacy.documents.length > 1 ? <section className="compatibility-choice" aria-labelledby="legacy-choice-title">
      <h3 id="legacy-choice-title">导入内容里有多份旧入口协议</h3><p>系统不会替你猜测哪一份有效。请先选择仍要保留的版本；其他旧资料不会被删除。</p>
      <div role="radiogroup" aria-label="选择旧入口协议">
        {legacy.documents.map((document) => <label key={document.id}><input type="radio" checked={legacy.selectedDocumentId === document.id} onChange={() => selectLegacyProtocol(document.id)} /><span><strong>{document.filename}</strong><small>{document.description}</small></span></label>)}
      </div>
    </section> : null}

    {blockingDiagnostics.length > 0 ? <div className="issue-stack" role="alert">{blockingDiagnostics.map((diagnostic) => <article key={diagnostic.id}><AlertCircle size={18} aria-hidden="true" /><div><strong>{diagnostic.title}</strong><p>{diagnostic.message}</p></div></article>)}</div> : null}
    {warningDiagnostics.length > 0 ? <div className="issue-stack warning-stack" role="status">{warningDiagnostics.map((diagnostic) => <article key={diagnostic.id}><AlertCircle size={18} aria-hidden="true" /><div><strong>{diagnostic.title}</strong><p>{diagnostic.message}</p></div></article>)}</div> : null}

    {effective ? <>
      <div className="protocol-review-grid protocol-review-summary">
        <ProtocolReviewPanel title="要读哪些资料" description="每份资料只负责自己的信息。" icon={<FileText size={19} aria-hidden="true" />}>
          <ul className="protocol-document-list">{content.map((document) => <li key={document.id}><div><strong>{document.filename}</strong><span>{document.description}</span></div><button type="button" className="text-action" onClick={() => onEditDocument(document.id)}>回到资料修改</button></li>)}</ul>
        </ProtocolReviewPanel>
        <ProtocolReviewPanel title="完成前检查什么" description="它会提醒模型验证结果并维护仍有效的资料。" icon={<List size={19} aria-hidden="true" />}>
          <ProtocolSectionValue document={effective.document} sectionId="protocol-completion" fallbackIndex={4} />
        </ProtocolReviewPanel>
      </div>
      {orderingEditable ? <section className="protocol-ordering-section" aria-labelledby="protocol-ordering-title">
        <div className="protocol-ordering-heading"><div><p className="micro-label">模型的读取规则</p><h3 id="protocol-ordering-title">按你的需要安排顺序</h3><p>上面的资料内容不变；这里只决定模型先读什么，以及发生冲突时先相信什么。</p></div><button type="button" className="button text" onClick={resetProtocolOrdering}><RefreshCw size={16} aria-hidden="true" />恢复自动安排</button></div>
        <div className="protocol-ordering-grid">
          <ProtocolReadOrderEditor items={workflow.protocolState.orderingPreferences.readOrder} documents={content} onMove={moveProtocolReadItem} onUpdate={updateProtocolReadItem} />
          <ProtocolSourceOrderEditor items={workflow.protocolState.orderingPreferences.sourcePriority} documents={content} onMove={moveProtocolSourceItem} onUpdate={updateProtocolSourceItem} />
        </div>
      </section> : <div className="protocol-review-grid legacy-protocol-rules"><ProtocolReviewPanel title="按什么顺序读" description="旧版协议保留原有读取安排。" icon={<ListOrdered size={19} aria-hidden="true" />}><ProtocolSectionValue document={effective.document} sectionId="protocol-read-order" fallbackIndex={1} /></ProtocolReviewPanel><ProtocolReviewPanel title="来源优先级" description="旧版协议保留原有冲突裁决顺序。" icon={<List size={19} aria-hidden="true" />}><ProtocolSectionValue document={effective.document} sectionId="protocol-source-priority" fallbackIndex={2} /></ProtocolReviewPanel></div>}
      <details className="protocol-details"><summary>查看自动生成的维护规则</summary><div className="protocol-details-grid single"><ProtocolSectionValue document={effective.document} sectionId="protocol-update-rules" fallbackIndex={3} /></div></details>
    </> : <div className="empty-protocol"><p>入口协议还不能生成。回到资料页面，至少保留一份资料，并在每份资料中添加一个信息项。</p><button type="button" className="button secondary" onClick={() => content[0] && onEditDocument(content[0].id)}>回到资料搭建</button></div>}

    {workflow.protocolState.supplements.length > 0 ? <section className="supplement-list" aria-labelledby="supplement-title"><div><p className="micro-label">已添加的额外说明</p><h3 id="supplement-title">只保留无法归入某份资料的通用提醒</h3></div>{workflow.protocolState.supplements.map((supplement) => <article key={supplement.id}><div><strong>{supplement.title}</strong><p>{supplement.instruction}</p></div><button type="button" className="text-action danger-text" onClick={() => removeProtocolSupplement(supplement.id)}>删除</button></article>)}</section> : null}
    {addingSupplement ? <section className="supplement-form" aria-labelledby="supplement-form-title"><h3 id="supplement-form-title">添加一条额外说明</h3><p>仅用于不能归入某份资料的通用提醒；属于某份资料的内容应回到原资料修改。</p><div className="form-grid"><label>说明标题<input value={supplementTitle} onChange={(event) => setSupplementTitle(event.target.value)} /></label><label className="wide">说明正文<textarea rows={3} value={supplementInstruction} onChange={(event) => setSupplementInstruction(event.target.value)} /></label></div><div className="compact-format-options" role="radiogroup" aria-label="补充说明的呈现方式">{formatCards.map((format) => <label key={format.id}><input type="radio" name="supplement-format" checked={supplementFormat === format.id} onChange={() => setSupplementFormat(format.id)} /><span><strong>{format.title}</strong><small>{format.description}</small></span></label>)}</div><div className="step-actions"><button type="button" className="button primary" disabled={!supplementTitle.trim() || !supplementInstruction.trim()} onClick={saveSupplement}>保存说明</button><button type="button" className="button text" onClick={() => setAddingSupplement(false)}>取消</button></div></section> : <button type="button" className="button text add-supplement" onClick={() => setAddingSupplement(true)}><Plus size={17} aria-hidden="true" />添加一条额外说明</button>}

    {validationErrors.length > 0 ? <div className="validation-hint"><AlertCircle size={18} aria-hidden="true" /><div><strong>还不能确认入口协议</strong><p>{validationErrors[0].message}</p></div></div> : null}
    <label className="confirmation-check"><input type="checkbox" name="protocol-reviewed" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={!effective || blockingDiagnostics.length > 0 || validationErrors.length > 0} /><span>我已核对资料、读取顺序和完成检查。</span></label>
    <div className="step-actions"><button type="button" className="button primary" disabled={!effective || blockingDiagnostics.length > 0 || validationErrors.length > 0 || !acknowledged} onClick={() => { onConfirmed(); onNext() }}>确认入口协议并查看结果 <ChevronRight size={17} aria-hidden="true" /></button>{confirmed ? <span className="confirmation-state">已在当前结构下确认</span> : null}</div>
  </section>
}

function ProtocolReviewPanel({ title, description, icon, children }: { title: string; description: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <section className="protocol-review-panel"><div className="protocol-panel-heading">{icon}<div><h3>{title}</h3><p>{description}</p></div></div>{children}</section>
}

function ProtocolReadOrderEditor({ items, documents, onMove, onUpdate }: {
  items: ProtocolReadOrderPreference[]
  documents: WorkflowDocument[]
  onMove: (itemId: string, direction: -1 | 1) => void
  onUpdate: (itemId: string, patch: Partial<Pick<ProtocolReadOrderPreference, 'enabled' | 'required'>>) => void
}) {
  const orderedItems = [...items].sort((left, right) => left.order - right.order)
  const activeItems = orderedItems.filter((item) => item.enabled)
  const removedItems = orderedItems.filter((item) => !item.enabled)
  const describe = (itemId: string) => {
    if (itemId === SYSTEM_PROTOCOL_READ_ITEM_ID) return { label: 'AGENTS.md', description: '整套工作流的入口规则。' }
    const document = documents.find((candidate) => itemId === `document:${candidate.id}`)
    return { label: document?.filename ?? itemId, description: document?.description ?? '当前工作流中的资料。' }
  }

  return <section className="protocol-ordering-editor" id="review-protocol-read-order" tabIndex={-1} aria-labelledby="read-order-editor-title">
    <header><span className="ordering-editor-number">01</span><div><h4 id="read-order-editor-title">开始时按什么顺序读</h4><p>“必读”会在开始工作时读取；“按需”只在用到相关信息时读取。</p></div></header>
    {activeItems.length > 0 ? <ol className="protocol-ordering-list">
      {activeItems.map((item, index) => {
        const copy = describe(item.itemId)
        return <li key={item.itemId} className="protocol-ordering-item">
          <span className="ordering-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <div className="ordering-copy"><strong>{copy.label}</strong><small>{copy.description}</small></div>
          <div className="ordering-controls">
            <button type="button" className="ordering-icon-button" title={`上移 ${copy.label}`} aria-label={`上移 ${copy.label}`} disabled={index === 0} onClick={() => onMove(item.itemId, -1)}><ArrowUp size={16} aria-hidden="true" /></button>
            <button type="button" className="ordering-icon-button" title={`下移 ${copy.label}`} aria-label={`下移 ${copy.label}`} disabled={index === activeItems.length - 1} onClick={() => onMove(item.itemId, 1)}><ArrowDown size={16} aria-hidden="true" /></button>
            <label className="required-toggle"><input type="checkbox" name={`required-${item.itemId}`} checked={item.required} onChange={(event) => onUpdate(item.itemId, { required: event.target.checked })} /><span>{item.required ? '必读' : '按需'}</span></label>
            <button type="button" className="ordering-remove" onClick={() => onUpdate(item.itemId, { enabled: false })}>移出</button>
          </div>
        </li>
      })}
    </ol> : <p className="ordering-empty">当前没有读取项。重新加入至少一项后才能确认和导出。</p>}
    {removedItems.length > 0 ? <details className="ordering-removed"><summary>已移出 {removedItems.length} 项</summary><ul>{removedItems.map((item) => { const copy = describe(item.itemId); return <li key={item.itemId}><div><strong>{copy.label}</strong><small>{copy.description}</small></div><button type="button" className="text-action" onClick={() => onUpdate(item.itemId, { enabled: true })}><Plus size={15} aria-hidden="true" />重新加入</button></li> })}</ul></details> : null}
  </section>
}

function ProtocolSourceOrderEditor({ items, documents, onMove, onUpdate }: {
  items: ProtocolSourcePriorityPreference[]
  documents: WorkflowDocument[]
  onMove: (sourceKey: string, direction: -1 | 1) => void
  onUpdate: (sourceKey: string, patch: Partial<Pick<ProtocolSourcePriorityPreference, 'enabled'>>) => void
}) {
  const orderedItems = [...items].sort((left, right) => left.order - right.order)
  const activeItems = orderedItems.filter((item) => item.enabled)
  const removedItems = orderedItems.filter((item) => !item.enabled)
  const describe = (sourceKey: string) => {
    if (sourceKey === LATEST_USER_SOURCE_KEY) return { label: '最新明确用户指令', description: '用户刚刚明确提出的要求。' }
    if (sourceKey === WORKSPACE_FACT_SOURCE_KEY) return { label: '新鲜工作区事实', description: '文件、测试和工具输出反映的最新事实。' }
    const document = documents.find((candidate) => sourceKey === `document:${candidate.id}`)
    return { label: document?.filename ?? sourceKey, description: document?.description ?? '当前工作流中的资料。' }
  }

  return <section className="protocol-ordering-editor" id="review-protocol-source-priority" tabIndex={-1} aria-labelledby="source-order-editor-title">
    <header><span className="ordering-editor-number">02</span><div><h4 id="source-order-editor-title">冲突时先相信什么</h4><p>同一件事说法不同时，排在前面的来源先用于判断。</p></div></header>
    {activeItems.length > 0 ? <ol className="protocol-ordering-list">
      {activeItems.map((item, index) => {
        const copy = describe(item.sourceKey)
        return <li key={item.sourceKey} className="protocol-ordering-item">
          <span className="ordering-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <div className="ordering-copy"><strong>{copy.label}</strong><small>{copy.description}</small></div>
          <div className="ordering-controls">
            <button type="button" className="ordering-icon-button" title={`上移 ${copy.label}`} aria-label={`上移 ${copy.label}`} disabled={index === 0} onClick={() => onMove(item.sourceKey, -1)}><ArrowUp size={16} aria-hidden="true" /></button>
            <button type="button" className="ordering-icon-button" title={`下移 ${copy.label}`} aria-label={`下移 ${copy.label}`} disabled={index === activeItems.length - 1} onClick={() => onMove(item.sourceKey, 1)}><ArrowDown size={16} aria-hidden="true" /></button>
            <button type="button" className="ordering-remove" onClick={() => onUpdate(item.sourceKey, { enabled: false })}>移出</button>
          </div>
        </li>
      })}
    </ol> : <p className="ordering-empty">当前没有来源。重新加入至少一个来源后才能确认和导出。</p>}
    {removedItems.length > 0 ? <details className="ordering-removed"><summary>已移出 {removedItems.length} 项</summary><ul>{removedItems.map((item) => { const copy = describe(item.sourceKey); return <li key={item.sourceKey}><div><strong>{copy.label}</strong><small>{copy.description}</small></div><button type="button" className="text-action" onClick={() => onUpdate(item.sourceKey, { enabled: true })}><Plus size={15} aria-hidden="true" />重新加入</button></li> })}</ul></details> : null}
  </section>
}

function ProtocolSectionValue({ document, sectionId, fallbackIndex }: { document: WorkflowDocument; sectionId: string; fallbackIndex: number }) {
  const section = document.sections.find((item) => item.id === sectionId) ?? document.sections[fallbackIndex]
  if (!section) return <p className="muted-copy">这一部分会在生成入口协议后出现。</p>
  return <div className="protocol-value"><h4>{section.title}</h4>{section.fields.map((field) => <div key={field.id}><strong>{field.label}</strong><DisplayValue field={field} /></div>)}</div>
}

function DisplayValue({ field }: { field: WorkflowField }) {
  const text = fieldValueToText(field.value)
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^[-*]\s*|^\d+[.)、]\s*/, '').trim()).filter(Boolean)
  if (field.displayFormat === 'steps') return <ol>{lines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ol>
  if (field.displayFormat === 'bullet-list' || field.displayFormat === 'checklist') return <ul>{lines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>
  return <p>{text || '这部分会在实际使用时填写。'}</p>
}

function ResultPreviewStep({ workflow, protocolConfirmed, onReviewProtocol, onNext }: {
  workflow: WorkflowSchema
  protocolConfirmed: boolean
  onReviewProtocol: () => void
  onNext: () => void
}) {
  const [format, setFormat] = useState<PreviewFormat>('html')
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const projection = useMemo(() => buildProtocolProjection(workflow), [workflow])
  const documents = workflow.documents
  const selectedDocument = documents.find((document) => document.id === selectedDocumentId) ?? documents[0]
  const exportedDocuments = useMemo(() => exportDocumentsForFormat(workflow, format), [format, workflow])
  const selectedFilename = selectedDocument ? projectDocumentFilename(selectedDocument, format) : ''
  const visibleOutput = selectedFilename ? exportedDocuments[selectedFilename] : ''

  useEffect(() => {
    if (!documents.some((document) => document.id === selectedDocumentId)) setSelectedDocumentId(documents[0]?.id ?? null)
  }, [documents, selectedDocumentId])

  return <section className="step-panel result-step" aria-labelledby="result-title">
    <p className="step-marker">第 5 步</p>
    <h2 id="result-title">查看模型以后会读到的资料。</h2>
    <p className="step-intro">这里展示的是模板样子：说明会常驻，内容位置保持为空，等待未来实际使用时填写。JSON 或 ZIP 才是可重新导入编辑的事实源。</p>
    {!protocolConfirmed ? <div className="confirmation-required"><AlertCircle size={19} aria-hidden="true" /><div><strong>还没有确认入口协议</strong><p>先核对资料、顺序和完成检查，再继续演练与导出。</p></div><button type="button" className="button secondary" onClick={onReviewProtocol}>回到协议审查</button></div> : null}
    {projection.effective ? <>
      <div className="preview-toolbar"><div role="radiogroup" aria-label="预览格式"><label><input type="radio" checked={format === 'html'} onChange={() => setFormat('html')} />HTML 阅读版</label><label><input type="radio" checked={format === 'markdown'} onChange={() => setFormat('markdown')} />Markdown 阅读版</label></div><span>已生成 {documents.length} 份资料</span></div>
      <div className="result-layout">
        <aside className="result-documents" aria-label="生成的资料">
          <p className="micro-label">生成的文件</p>
          {documents.map((document) => <button type="button" key={document.id} className={document.id === selectedDocument?.id ? 'result-document active' : 'result-document'} onClick={() => setSelectedDocumentId(document.id)}><strong>{projectDocumentFilename(document, format)}</strong><small>{document.role === 'protocol' ? '系统生成的入口协议' : document.description}</small></button>)}
        </aside>
        {selectedDocument ? <section className="document-reading-preview" aria-labelledby="reading-preview-title">
          <div className="reading-preview-heading"><div><p className="micro-label">阅读版预览</p><h3 id="reading-preview-title">{selectedDocument.title}</h3><p>{selectedDocument.description}</p></div><code>{selectedFilename}</code></div>
          {format === 'html' ? <TemplateDocumentPreview document={selectedDocument} /> : <pre className="markdown-preview" tabIndex={0} aria-label={`${selectedFilename} Markdown 内容`}>{visibleOutput}</pre>}
        </section> : null}
      </div>
    </> : <div className="empty-protocol"><p>入口协议尚不可用，因此无法生成完整的结果预览。</p><button type="button" className="button secondary" onClick={onReviewProtocol}>回到协议审查</button></div>}
    <div className="step-actions"><button type="button" className="button primary" disabled={!protocolConfirmed || !projection.effective} onClick={onNext}>演练并导出 <ChevronRight size={17} aria-hidden="true" /></button></div>
  </section>
}

function TemplateDocumentPreview({ document }: { document: WorkflowDocument }) {
  const protocol = document.id === 'protocol-system'
  return <div className={protocol ? 'template-document-preview protocol-document-preview' : 'template-document-preview'}>
    {document.sections.map((section) => <section key={section.id}>
      <h4>{section.title}</h4>
      {!protocol ? <p className="preview-purpose">{section.purpose}</p> : null}
      {section.fields.map((field) => protocol
        ? <TemplatePreviewValue key={field.id} field={field} />
        : <div className="template-preview-field" key={field.id}><h5>{field.label}</h5><p>{field.guidance}</p><TemplatePreviewValue field={field} /></div>)}
    </section>)}
  </div>
}

function TemplatePreviewValue({ field }: { field: WorkflowField }) {
  return fieldValueToText(field.value).trim()
    ? <div className="template-preview-value"><DisplayValue field={field} /></div>
    : <TemplateEmptySlot format={field.displayFormat} />
}

function TemplateEmptySlot({ format }: { format: DisplayFormatId | undefined }) {
  if (format === 'steps') return <ol className="empty-slot-list"><li /><li /><li /></ol>
  if (format === 'bullet-list' || format === 'checklist') return <ul className="empty-slot-list"><li /><li /><li /></ul>
  return <div className="empty-slot" aria-label="未来填写的空槽" />
}

function RehearseExportStep({ workflow, protocolConfirmed, onReviewProtocol }: { workflow: WorkflowSchema; protocolConfirmed: boolean; onReviewProtocol: () => void }) {
  const [scenario, setScenario] = useState<SimulationScenario>('new-session')
  const [exportFormat, setExportFormat] = useState<PreviewFormat>('html')
  const [message, setMessage] = useState('')
  const projection = useMemo(() => buildProtocolProjection(workflow), [workflow])
  const simulation = useMemo(() => simulateRecovery(workflow, scenario), [scenario, workflow])
  const validationErrors = useMemo(() => validateWorkflow(workflow).filter((issue) => issue.severity === 'error'), [workflow])
  const canExport = protocolConfirmed && Boolean(projection.effective) && validationErrors.length === 0 && !workflow.readOnlyReason
  const exportedDocuments = useMemo(() => exportDocumentsForFormat(workflow, exportFormat), [exportFormat, workflow])

  const exportJson = () => {
    try {
      download('workflow.json', serializeWorkflowJson(workflow), 'application/json;charset=utf-8')
      setMessage('已下载 workflow.json。它可以重新导入并继续编辑。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法导出 JSON。')
    }
  }
  const exportZip = async () => {
    try {
      const pack = await createWorkflowZip(workflow)
      download(packageName(workflow), pack.blob, 'application/zip')
      setMessage(`已下载 ${packageName(workflow)}，其中包含 JSON、入口协议和阅读文件。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法导出 ZIP。')
    }
  }
  const exportReadingFile = (filename: string, content: string) => {
    download(filename, content, filename.endsWith('.html') ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8')
    setMessage(`已下载 ${filename}。阅读文件不能重新导入编辑，请保留 workflow.json 或完整 ZIP。`)
  }

  return <section className="step-panel export-step" aria-labelledby="export-title">
    <p className="step-marker">第 6 步</p>
    <h2 id="export-title">先演练一次，再带走工作流包。</h2>
    <p className="step-intro">演练不会写入模板。它只是用当前入口协议检查：模型是否能知道先读什么、遇到不确定时怎么处理，以及怎样继续下一步。</p>
    {!protocolConfirmed ? <div className="confirmation-required"><AlertCircle size={19} aria-hidden="true" /><div><strong>导出前需要确认入口协议</strong><p>确认后才能下载可交付的工作流包。</p></div><button type="button" className="button secondary" onClick={onReviewProtocol}>回到协议审查</button></div> : null}
    <div className="rehearsal-panel">
      <div className="rehearsal-heading"><div><p className="micro-label">恢复演练</p><h3>换一个常见场景试试看</h3></div><span className={`simulation-badge ${simulation.status}`}>{simulation.status === 'pass' ? '可以继续' : simulation.status === 'risky' ? '需要留意' : '暂时阻塞'}</span></div>
      <label>模拟哪种情况<select value={scenario} onChange={(event) => setScenario(event.target.value as SimulationScenario)}><option value="new-session">新会话开始</option><option value="context-compaction">上下文被压缩后恢复</option><option value="goal-conflict">目标或资料发生冲突</option><option value="missing-preference">需要确认用户长期偏好</option><option value="unclear-term">遇到术语不清楚</option><option value="stale-status">状态可能已经过期</option><option value="insufficient-history">需要理解过去决策</option><option value="unclear-work-entry">工作入口不明确</option><option value="handoff-after-failure">失败后交接</option></select></label>
      <ol className="simulation-steps">{simulation.steps.map((item) => <li key={`${item.order}-${item.action}`} className={item.outcome}><span>{item.order}</span><div><strong>{item.action}</strong><p>{item.reason}</p></div></li>)}</ol>
      {simulation.blockers.length > 0 ? <div className="simulation-blockers"><strong>需要先处理</strong><ul>{simulation.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div> : null}
    </div>
    <div className="export-layout">
      <section className="export-panel"><p className="micro-label">可继续编辑的版本</p><h3>保留 JSON 或完整 ZIP</h3><p>它们保存资料、章节和信息项结构；生成的 HTML/Markdown 只用于阅读。</p><div className="export-actions"><button type="button" className="button secondary" disabled={!canExport} onClick={exportJson}><Download size={17} aria-hidden="true" />下载 workflow.json</button><button type="button" className="button primary" disabled={!canExport} onClick={() => void exportZip()}><Package size={17} aria-hidden="true" />下载完整 ZIP</button></div></section>
      <section className="export-panel"><p className="micro-label">阅读文件</p><h3>按需要单独下载</h3><div className="format-toggle" role="radiogroup" aria-label="阅读文件格式"><label><input type="radio" checked={exportFormat === 'html'} onChange={() => setExportFormat('html')} />HTML</label><label><input type="radio" checked={exportFormat === 'markdown'} onChange={() => setExportFormat('markdown')} />Markdown</label></div><div className="reading-file-list">{Object.entries(exportedDocuments).map(([filename, content]) => <button type="button" key={filename} disabled={!canExport} onClick={() => exportReadingFile(filename, content)}><FileText size={16} aria-hidden="true" /><span>{filename}</span><Download size={15} aria-hidden="true" /></button>)}</div></section>
    </div>
    {workflow.readOnlyReason ? <div className="validation-hint"><AlertCircle size={18} aria-hidden="true" /><div><strong>该导入包只能查看</strong><p>{workflow.readOnlyReason}</p></div></div> : null}
    {validationErrors.length > 0 ? <div className="validation-hint"><AlertCircle size={18} aria-hidden="true" /><div><strong>导出前还需要处理 {validationErrors.length} 个问题</strong><p>{validationErrors[0].message}</p></div></div> : null}
    {message ? <p className="export-message" role="status">{message}</p> : null}
  </section>
}

function reviewStageLabel(stage: 'connecting' | 'sending' | 'waiting' | 'validating'): string {
  if (stage === 'connecting') return '正在连接…'
  if (stage === 'sending') return '正在发送…'
  if (stage === 'waiting') return '正在等待审查意见…'
  return '正在检查报告格式…'
}

function ReviewPage({ headingRef, workflow, onNavigate }: {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  workflow: WorkflowSchema | null
  onNavigate: (route: Route, replace?: boolean) => void
}) {
  const connection = useAgentReviewStore((state) => state.connection)
  const endpointUrl = useAgentReviewStore((state) => state.endpointUrl)
  const apiKey = useAgentReviewStore((state) => state.apiKey)
  const prompt = useAgentReviewStore((state) => state.prompt)
  const report = useAgentReviewStore((state) => state.report)
  const inFlight = useAgentReviewStore((state) => state.inFlight)
  const testStatus = useAgentReviewStore((state) => state.testStatus)
  const reviewStatus = useAgentReviewStore((state) => state.reviewStatus)
  const isProtocolConfirmed = useAgentReviewStore((state) => state.isProtocolConfirmed)
  const updateConnection = useAgentReviewStore((state) => state.updateConnection)
  const setEndpointUrl = useAgentReviewStore((state) => state.setEndpointUrl)
  const setApiKey = useAgentReviewStore((state) => state.setApiKey)
  const clearApiKey = useAgentReviewStore((state) => state.clearApiKey)
  const setPrompt = useAgentReviewStore((state) => state.setPrompt)
  const resetPrompt = useAgentReviewStore((state) => state.resetPrompt)
  const startConnectionTest = useAgentReviewStore((state) => state.startConnectionTest)
  const startReview = useAgentReviewStore((state) => state.startReview)
  const cancelInFlight = useAgentReviewStore((state) => state.cancelInFlight)
  const setEditIntent = useAgentReviewStore((state) => state.setEditIntent)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [promptOpen, setPromptOpen] = useState(true)
  const [showKey, setShowKey] = useState(false)
  const [allowInsecure, setAllowInsecure] = useState(false)

  const protocolKey = workflow ? reviewProtocolKey(workflow) : null
  const protocolStatus: 'confirmed' | 'draft' = workflow && protocolKey && isProtocolConfirmed(workflow.workflowId, protocolKey) ? 'confirmed' : 'draft'
  const validationErrors = useMemo(() => workflow ? validateWorkflow(workflow).filter((issue) => issue.severity === 'error') : [], [workflow])
  const materialState = useMemo(() => {
    if (!workflow) return { material: undefined as ReviewMaterial | undefined, error: '先创建或打开一套工作流，才能准备审查材料。' }
    try {
      return { material: buildReviewMaterial({ workflow, userPrompt: prompt, protocolStatus }), error: undefined }
    } catch (error) {
      return { material: undefined as ReviewMaterial | undefined, error: error instanceof Error ? error.message : '当前工作流还不能发起审查。' }
    }
  }, [prompt, protocolStatus, workflow])
  const endpoint = validateReviewEndpoint(endpointUrl)
  const isHttpEndpoint = endpoint.ok && endpoint.endpoint.protocol === 'http:'
  const connectionComplete = endpoint.ok && Boolean(connection.model.trim()) && Boolean(apiKey)
  const transportAllowed = !isHttpEndpoint || allowInsecure
  const reviewReady = Boolean(workflow && materialState.material && validationErrors.length === 0 && connectionComplete && transportAllowed && !inFlight)
  const reviewInputsLocked = Boolean(inFlight)
  const reportSnapshot = useMemo(() => report ? reviewSnapshotFromRequest(report.reviewedRequest) : undefined, [report])
  const reportStale = reviewReportIsStale(report, materialState.material?.inputFingerprint ?? null)
  const reviewInProgress = inFlight?.kind === 'review'
  const testInProgress = inFlight?.kind === 'test'

  useEffect(() => {
    setAllowInsecure(false)
  }, [endpointUrl])

  const currentFingerprint = () => {
    const currentWorkflow = useWorkflowStore.getState().workflow
    if (!currentWorkflow || currentWorkflow.workflowId !== workflow?.workflowId) return null
    const reviewState = useAgentReviewStore.getState()
    const key = reviewProtocolKey(currentWorkflow)
    const currentProtocolStatus: 'confirmed' | 'draft' = key && reviewState.isProtocolConfirmed(currentWorkflow.workflowId, key) ? 'confirmed' : 'draft'
    try {
      return buildReviewMaterial({ workflow: currentWorkflow, userPrompt: reviewState.prompt, protocolStatus: currentProtocolStatus }).inputFingerprint
    } catch {
      return null
    }
  }

  const goToBuild = (step = 1) => onNavigate({ page: 'build', step })
  const goToEdit = (target: ReviewEditTarget) => {
    if (!workflow || !reviewEditTargetIsAvailable(workflow, target)) return
    setEditIntent(workflow.workflowId, target)
    onNavigate({ page: 'build', step: reviewEditTargetStep(target) })
  }
  const startFullReview = () => {
    if (!workflow || !reviewReady) return
    void startReview({ workflow, allowInsecure, currentFingerprint })
  }

  const blockers: Array<{ title: string; detail: string; action?: { label: string; step: number } }> = []
  if (!workflow) {
    blockers.push({ title: '还没有工作流', detail: '先创建或打开一套工作流，才能审查它的长期协作能力。', action: { label: '去搭建工作流', step: 1 } })
  } else {
    if (materialState.error) {
      const action = materialState.error.includes('至少需要一份内容文档')
        ? { label: '去选择资料', step: 2 }
        : materialState.error.includes('保留旧运行内容') || materialState.error.includes('只读兼容')
          ? { label: '去处理兼容内容', step: 6 }
          : { label: '去审查入口协议', step: 4 }
      blockers.push({ title: '工作流还没有准备好', detail: materialState.error, action })
    }
    if (validationErrors.length > 0) {
      const firstIssue = validationErrors[0]
      const protocolRule = /^(recovery|protocol|maintenance-valid|completion-valid|export-)/.test(firstIssue.ruleId)
      blockers.push({ title: `还有 ${validationErrors.length} 个结构问题`, detail: firstIssue.message, action: protocolRule ? { label: '去审查入口协议', step: 4 } : { label: '去搭建资料', step: 3 } })
    }
  }
  if (!endpoint.ok && endpointUrl.trim()) blockers.push({ title: '请求地址还不能使用', detail: '请填写完整的 HTTP 或 HTTPS 请求地址；地址不能包含用户名、密码或 # 片段。' })
  if (!connection.model.trim()) blockers.push({ title: '还没有填写模型名', detail: '输入服务商要求的模型名称后，才能开始审查。' })
  if (!apiKey) blockers.push({ title: '还没有填写 API Key', detail: 'Key 只保留在当前浏览器标签页；刷新或关闭后会自动清除。' })
  if (isHttpEndpoint && !allowInsecure) blockers.push({ title: '需要确认 HTTP 风险', detail: '认证 Key 和审查材料会以未加密方式直接发送到该地址。' })

  return <article className="review-page" aria-labelledby="review-title">
    <header className="review-heading">
      <p className="eyebrow">Independent workflow review</p>
      <h1 id="review-title" ref={headingRef} tabIndex={-1}>让另一位审查员检查工作流能否<span className="underline-emphasis">长期不偏移。</span></h1>
      <p>它只给建议，不会改写你的资料。审查重点是：模型能否持续知道该读什么、信什么、接着做什么，同时不过度增加维护成本。</p>
    </header>

    <section className="review-section review-connection" aria-labelledby="review-connection-title">
      <details open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
        <summary><span><span className="micro-label">01 · 审查连接</span><strong id="review-connection-title">连接到你的兼容服务</strong><small>{connection.name || '尚未命名'} · {connection.model || '尚未填写模型名'}</small></span><span className="details-hint">{settingsOpen ? '收起' : '编辑'}</span></summary>
        <div className="review-details-body">
          <p className="review-intro">填写服务商提供的完整 Chat Completions 请求地址和模型名，不要只填服务根地址。程序不会替你补路径，也不会保存完整地址或 API Key。</p>
          <div className="review-form-grid">
            <label>连接名称（只保存在本机）<input disabled={reviewInputsLocked} value={connection.name} placeholder="例如：我的审查服务" onChange={(event) => updateConnection({ name: event.target.value })} /></label>
            <label>模型名（只保存在本机）<input disabled={reviewInputsLocked} value={connection.model} placeholder="例如：deepseek-chat" onChange={(event) => updateConnection({ model: event.target.value })} /></label>
            <label className="wide">最终请求地址（仅当前会话）<input disabled={reviewInputsLocked} inputMode="url" autoComplete="off" spellCheck={false} value={endpointUrl} placeholder="https://example.com/v1/chat/completions" onChange={(event) => setEndpointUrl(event.target.value)} aria-invalid={Boolean(endpointUrl.trim() && !endpoint.ok)} /></label>
            <label className="wide">API Key（仅当前会话）<span className="key-input-row"><input disabled={reviewInputsLocked} type={showKey ? 'text' : 'password'} autoComplete="off" value={apiKey} placeholder="粘贴后只用于本次浏览器会话" onChange={(event) => setApiKey(event.target.value)} /><button disabled={reviewInputsLocked} type="button" className="text-action" onClick={() => setShowKey((visible) => !visible)}>{showKey ? '隐藏' : '显示'}</button>{apiKey ? <button disabled={reviewInputsLocked} type="button" className="text-action" onClick={clearApiKey}>清除</button> : null}</span></label>
          </div>
          {endpointUrl.trim() && !endpoint.ok ? <p className="form-error" role="alert"><AlertCircle size={16} aria-hidden="true" />请求地址不可用。</p> : null}
          {isHttpEndpoint ? <label className="insecure-confirmation"><input disabled={reviewInputsLocked} type="checkbox" checked={allowInsecure} onChange={(event) => setAllowInsecure(event.target.checked)} /><span>我了解：HTTP 不会加密传输，API Key 和审查材料会直接发送到这个地址。</span></label> : null}
          <div className="review-inline-actions"><button type="button" className="button secondary" disabled={!connectionComplete || Boolean(inFlight) || (isHttpEndpoint && !allowInsecure)} onClick={() => void startConnectionTest({ allowInsecure })}>{testInProgress ? reviewStageLabel(inFlight.stage) : '测试连接'}</button>{(testStatus.kind === 'success' || testStatus.kind === 'error') && !testInProgress ? <p className={testStatus.kind === 'success' ? 'review-status success' : 'review-status error'}>{testStatus.message}</p> : null}</div>
        </div>
      </details>
    </section>

    {workflow ? <section className="review-section review-prompt" aria-labelledby="review-prompt-title">
      <details open={promptOpen} onToggle={(event) => setPromptOpen(event.currentTarget.open)}>
        <summary><span><span className="micro-label">02 · 审查重点</span><strong id="review-prompt-title">告诉审查员你特别在意什么</strong><small>默认提示词会关注长期稳定与维护效率。</small></span><span className="details-hint">{promptOpen ? '收起' : '编辑'}</span></summary>
        <div className="review-details-body">
          <p className="review-intro">默认提示词已经覆盖核心问题。只有在你有额外关注点时再改；它不会改变固定报告格式或让程序自动修改资料。</p>
          <label className="review-textarea-label">给审查员的补充说明<textarea disabled={reviewInputsLocked} rows={7} value={prompt} onChange={(event) => setPrompt(workflow.workflowId, event.target.value)} /></label>
          <div className="review-inline-actions"><button disabled={reviewInputsLocked} type="button" className="button text" onClick={() => resetPrompt(workflow.workflowId)}>恢复默认</button><span className="review-meta">这份说明只保存在当前工作流的本机数据中。</span></div>
        </div>
      </details>
    </section> : <section className="review-section review-unavailable"><p className="micro-label">02 · 审查重点</p><h2>先搭建一套工作流。</h2><p>没有当前工作流时，仍可测试连接；审查提示词、材料预览和全面审查会在创建项目后出现。</p><button type="button" className="button secondary" onClick={() => goToBuild(1)}>去搭建工作流</button></section>}

    <section className="review-section review-material" aria-labelledby="review-material-title">
      <div className="review-section-heading"><div><p className="micro-label">03 · 发送材料</p><h2 id="review-material-title">本次会发送哪些内容？</h2><p>只发送工作流的结构、系统生成的 AGENTS.md 草案和审查提示词。不会发送 API Key、完整请求地址、项目运行内容或其他工作流。</p></div><span className={materialState.material ? 'review-readiness ready' : 'review-readiness'}>{materialState.material ? `已准备 ${materialState.material.reviewedRequest.materialCharacterCount.toLocaleString('zh-CN')} 字符` : '暂不能发送'}</span></div>
      {materialState.material ? <ReviewMaterialPreview material={materialState.material} current /> : <div className="review-blocked-copy"><AlertCircle size={18} aria-hidden="true" /><p>{materialState.error}</p></div>}
      {materialState.material && materialState.material.reviewedRequest.materialCharacterCount > REVIEW_MATERIAL_WARNING_CHARACTERS ? <p className="review-material-warning"><AlertCircle size={16} aria-hidden="true" />材料较长，服务商可能需要更多时间和额度完成审查。</p> : null}
    </section>

    <section className="review-section review-action" aria-labelledby="review-action-title">
      <div><p className="micro-label">04 · 开始审查</p><h2 id="review-action-title">让审查员给出必要的修改意见。</h2><p>一次审查最多等待 10 分钟。你可以留在这里，也可以继续浏览当前项目；程序不会自动重试或改写任何资料。</p></div>
      {blockers.length > 0 ? <div className="review-blocker-list">{blockers.map((blocker) => <article key={blocker.title}><AlertCircle size={18} aria-hidden="true" /><div><strong>{blocker.title}</strong><p>{blocker.detail}</p>{blocker.action ? <button type="button" className="text-action" onClick={() => goToBuild(blocker.action!.step)}>{blocker.action.label}</button> : null}</div></article>)}</div> : null}
      <div className="review-primary-action"><button type="button" className="button primary" disabled={!reviewReady} onClick={startFullReview}>{reviewInProgress ? reviewStageLabel(inFlight.stage) : report ? '重新审查' : '开始全面审查'}</button>{reviewInProgress ? <button type="button" className="button text" onClick={cancelInFlight}>取消</button> : null}</div>
      {(reviewStatus.kind === 'error' || (reviewStatus.kind === 'success' && !report)) && !reviewInProgress ? <p className={reviewStatus.kind === 'success' ? 'review-status success' : 'review-status error'}>{reviewStatus.message}</p> : null}
    </section>

    {report && reportSnapshot ? <ReviewReportPanel report={report.report} snapshot={reportSnapshot} reviewedRequest={report.reviewedRequest} reviewedAt={report.reviewedAt} model={report.model} stale={reportStale} onGoToEdit={goToEdit} workflow={workflow} /> : null}
  </article>
}

function ReviewMaterialPreview({ material, current = false }: { material: ReviewMaterial; current?: boolean }) {
  return <ReviewRequestPreview request={material.reviewedRequest} current={current} />
}

function ReviewRequestPreview({ request, current }: { request: ReviewedRequest; current: boolean }) {
  const [copyStatus, setCopyStatus] = useState('')
  const copyRequest = async () => {
    const text = [
      '固定审查约束',
      request.systemContract,
      '审查提示词',
      request.userPrompt,
      '审查材料',
      request.materialMessage,
    ].join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus('已复制。')
    } catch {
      setCopyStatus('当前浏览器无法复制，请手动选择文本。')
    }
  }

  return <details className="review-request-preview">
    <summary>{current ? '查看将要发送的材料' : '查看本次发送材料'} <small>材料部分共 {request.materialCharacterCount.toLocaleString('zh-CN')} 字符</small></summary>
    <div className="review-request-body">
      <div className="review-request-actions"><p>{current ? '这是下一次全面审查会发送的精确内容。' : '这是当时实际发送的冻结内容，不会被后续修改替换。'}</p><button type="button" className="text-action" onClick={() => void copyRequest()}>复制材料</button></div>
      {copyStatus ? <p className="review-status success">{copyStatus}</p> : null}
      <section><h3>固定审查约束</h3><pre>{request.systemContract}</pre></section>
      <section><h3>审查提示词</h3><pre>{request.userPrompt}</pre></section>
      <section><h3>工作流材料</h3><pre>{request.materialMessage}</pre></section>
    </div>
  </details>
}

function ReviewReportPanel({ report, snapshot, reviewedRequest, reviewedAt, model, stale, onGoToEdit, workflow }: {
  report: ReviewReport
  snapshot: ReviewMaterialSnapshot
  reviewedRequest: ReviewedRequest
  reviewedAt: number
  model: string
  stale: boolean
  onGoToEdit: (target: ReviewEditTarget) => void
  workflow: WorkflowSchema | null
}) {
  const verdictClass = report.overall.verdict === 'pass' ? 'pass' : report.overall.verdict === 'needs_revision' ? 'needs-revision' : 'unassessable'
  const reviewedAtLabel = new Date(reviewedAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
  const categoryLabel = (value: string) => {
    if (value === 'stable') return '长期稳定：可靠'
    if (value === 'at_risk') return '长期稳定：有风险'
    if (value === 'efficient') return '维护效率：轻量'
    if (value === 'adequate') return '维护效率：可接受'
    if (value === 'burdensome') return '维护效率：偏重'
    return '暂时无法判断'
  }

  return <section className="review-report" aria-labelledby="review-report-title">
    <div className="review-report-heading"><div><p className="micro-label">审查报告</p><h2 id="review-report-title">{reviewReportSummaryLabel(report)}</h2><p>由 {model || '当前模型'} 于 {reviewedAtLabel} 返回。</p></div><span className={`review-verdict ${verdictClass}`}><ShieldCheck size={17} aria-hidden="true" />{reviewReportSummaryLabel(report)}</span></div>
    {stale ? <div className="review-stale-notice"><AlertCircle size={18} aria-hidden="true" /><div><strong>这份报告基于较早版本。</strong><p>工作流结构、入口协议或审查提示词已经变化。它仍可阅读，但重新审查后才代表当前设计。</p></div></div> : null}
    <p className="review-report-summary">{report.overall.summary}</p>
    <div className="review-category-list" aria-label="审查分类">
      <span>{categoryLabel(report.overall.longTermStability)}</span><span>{categoryLabel(report.overall.maintenanceEfficiency)}</span>
    </div>

    {report.findings.length > 0 ? <div className="review-findings"><h3>建议优先处理</h3>{report.findings.map((finding) => <ReviewFindingRow key={finding.id} finding={finding} snapshot={snapshot} workflow={workflow} onGoToEdit={onGoToEdit} />)}</div> : null}
    {report.limits.length > 0 ? <div className="review-limits"><h3>这次判断的边界</h3><ul>{report.limits.map((limit) => <li key={limit}>{limit}</li>)}</ul></div> : null}
    <ReviewRequestPreview request={reviewedRequest} current={false} />
  </section>
}

function ReviewFindingRow({ finding, snapshot, workflow, onGoToEdit }: {
  finding: ReviewFinding
  snapshot: ReviewMaterialSnapshot
  workflow: WorkflowSchema | null
  onGoToEdit: (target: ReviewEditTarget) => void
}) {
  const canEdit = Boolean(workflow && finding.editTarget && reviewEditTargetIsAvailable(workflow, finding.editTarget))
  return <article className={`review-finding ${finding.severity}`}>
    <div className="review-finding-meta"><span>{finding.severity === 'must_fix' ? '建议优先处理' : '建议检查'}</span><small>{finding.id}</small></div>
    <h4>{finding.title}</h4>
    <p className="review-finding-location">出现位置：{reviewLocationLabel(snapshot, finding.observedLocation)}</p>
    <p>{finding.analysis}</p>
    <div className="review-recommendation"><strong>建议</strong><p>{finding.recommendation}</p></div>
    <div className="review-finding-actions"><details><summary>查看依据</summary><p>{finding.evidence}</p></details>{canEdit && finding.editTarget ? <button type="button" className="button secondary" onClick={() => onGoToEdit(finding.editTarget!)}>去修改</button> : null}</div>
  </article>
}
