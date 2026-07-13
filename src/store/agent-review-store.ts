import { create } from 'zustand'
import {
  DEFAULT_REVIEW_PROMPT,
  REVIEW_CONTRACT_VERSION,
  buildReviewMaterial,
  compareReviewRequests,
  parseReviewReport,
  reviewProtocolKey,
  type LatestReviewRequest,
  type PersistedReviewConnection,
  type PersistedReviewReport,
  type ReviewEditTarget,
  type ReviewMaterial,
} from '../domain/agent-review'
import {
  requestOpenAiCompatibleCompletion,
  reviewTransportMessage,
  testReviewConnection,
  type RequestStage,
  type ReviewTransportError,
} from '../domain/agent-review-client'
import {
  cleanupOrphanReviewData,
  loadPersistedReviewReport,
  loadReviewConnection,
  loadReviewPrompt,
  markLatestReviewRequest,
  saveReviewConnection,
  saveReviewPrompt,
  saveReviewReportIfCurrent,
} from '../storage/agent-review-storage'
import type { WorkflowSchema } from '../domain/schema'
import { validateWorkflow } from '../domain/validation'

type ReviewRequestKind = 'test' | 'review'

export type EditIntent = {
  workflowId: string
  target: ReviewEditTarget
  nonce: string
}

export type InFlightReview = {
  kind: ReviewRequestKind
  requestId: string
  requestedAt: number
  workflowId: string | null
  contextToken: string
  controller: AbortController
  stage: RequestStage
  material?: ReviewMaterial
}

export type ReviewOperationStatus =
  | { kind: 'idle' }
  | { kind: 'running'; requestKind: ReviewRequestKind; stage: RequestStage }
  | { kind: 'success'; message: string }
  | { kind: 'error'; code: ReviewTransportError | 'invalid-report' | 'request-superseded' | 'insecure-confirmation-required'; message: string }

type AgentReviewState = {
  storageAvailable: boolean
  storageMessage: string
  connection: PersistedReviewConnection
  endpointUrl: string
  apiKey: string
  activeWorkflowId: string | null
  contextToken: string
  prompt: string
  report: PersistedReviewReport | undefined
  protocolConfirmation: { workflowId: string; protocolKey: string } | undefined
  inFlight: InFlightReview | undefined
  testStatus: ReviewOperationStatus
  reviewStatus: ReviewOperationStatus
  editIntent: EditIntent | undefined
  hydrateBrowserSettings: () => Promise<void>
  activateWorkflow: (workflowId: string | null) => void
  invalidateForProjectTransition: () => void
  updateConnection: (patch: Partial<PersistedReviewConnection>) => void
  setEndpointUrl: (value: string) => void
  setApiKey: (value: string) => void
  clearApiKey: () => void
  setPrompt: (workflowId: string, prompt: string) => void
  resetPrompt: (workflowId: string) => void
  confirmProtocol: (workflowId: string, protocolKey: string) => void
  isProtocolConfirmed: (workflowId: string, protocolKey: string | null) => boolean
  startConnectionTest: (input: { allowInsecure: boolean }) => Promise<void>
  startReview: (input: {
    workflow: WorkflowSchema
    allowInsecure: boolean
    currentFingerprint: () => string | null
  }) => Promise<void>
  cancelInFlight: () => void
  setEditIntent: (workflowId: string, target: ReviewEditTarget) => void
  consumeEditIntent: (workflowId: string) => EditIntent | undefined
}

let memoryConnection: PersistedReviewConnection = { version: 1, name: '', model: '' }
const memoryPrompts = new Map<string, string>()
const memoryReports = new Map<string, PersistedReviewReport>()
const memoryMarkers = new Map<string, LatestReviewRequest>()

function newNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  if (typeof crypto === 'undefined') return `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const values = new Uint32Array(4)
  crypto.getRandomValues(values)
  return `${values[0].toString(16)}-${values[1].toString(16)}-4${values[2].toString(16).slice(1)}-a${values[3].toString(16).slice(1)}`
}

function currentPageProtocol(): string {
  return typeof window === 'undefined' ? 'http:' : window.location.protocol
}

function isCurrentRun(state: AgentReviewState, run: InFlightReview): boolean {
  return state.inFlight?.requestId === run.requestId
    && state.contextToken === run.contextToken
    && state.activeWorkflowId === run.workflowId
}

function isHttpEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === 'http:'
  } catch {
    return false
  }
}

function fallbackMarker(workflowId: string, marker: LatestReviewRequest): { accepted: boolean; latest: LatestReviewRequest } {
  const current = memoryMarkers.get(workflowId)
  if (current && compareReviewRequests(marker, current) < 0) return { accepted: false, latest: current }
  memoryMarkers.set(workflowId, marker)
  return { accepted: true, latest: marker }
}

function materialProtocolStatus(state: AgentReviewState, workflow: WorkflowSchema): 'confirmed' | 'draft' {
  const key = reviewProtocolKey(workflow)
  return key && state.protocolConfirmation?.workflowId === workflow.workflowId && state.protocolConfirmation.protocolKey === key ? 'confirmed' : 'draft'
}

export const useAgentReviewStore = create<AgentReviewState>((set, get) => {
  const storageFailure = (message: string) => set({ storageAvailable: false, storageMessage: message })
  const activateWorkflow = (workflowId: string | null) => {
    const before = get()
    before.inFlight?.controller.abort()
    const contextToken = newNonce()
    const isSameWorkflow = before.activeWorkflowId === workflowId
    const prompt = workflowId ? memoryPrompts.get(workflowId) ?? DEFAULT_REVIEW_PROMPT : DEFAULT_REVIEW_PROMPT
    const report = workflowId ? memoryReports.get(workflowId) : undefined
    set({
      activeWorkflowId: workflowId,
      contextToken,
      prompt,
      report,
      inFlight: undefined,
      protocolConfirmation: isSameWorkflow ? before.protocolConfirmation : undefined,
      testStatus: { kind: 'idle' },
      reviewStatus: { kind: 'idle' },
      editIntent: undefined,
    })
    if (!workflowId || !before.storageAvailable) return
    void Promise.all([loadReviewPrompt(workflowId), loadPersistedReviewReport(workflowId)])
      .then(([storedPrompt, storedReport]) => {
        const current = get()
        if (current.activeWorkflowId !== workflowId || current.contextToken !== contextToken) return
        memoryPrompts.set(workflowId, storedPrompt)
        if (storedReport) memoryReports.set(workflowId, storedReport)
        set({ prompt: storedPrompt, report: storedReport ?? memoryReports.get(workflowId) })
      })
      .catch(() => storageFailure('审查设置只能保留在当前页面会话中。'))
  }

  return {
    storageAvailable: true,
    storageMessage: '',
    connection: memoryConnection,
    endpointUrl: '',
    apiKey: '',
    activeWorkflowId: null,
    contextToken: newNonce(),
    prompt: DEFAULT_REVIEW_PROMPT,
    report: undefined,
    protocolConfirmation: undefined,
    inFlight: undefined,
    testStatus: { kind: 'idle' },
    reviewStatus: { kind: 'idle' },
    editIntent: undefined,
    hydrateBrowserSettings: async () => {
      try {
        const connection = await loadReviewConnection()
        if (connection) memoryConnection = connection
        set({ connection: memoryConnection, storageAvailable: true, storageMessage: '' })
        await cleanupOrphanReviewData()
      } catch {
        storageFailure('审查设置只能保留在当前页面会话中。')
      }
    },
    activateWorkflow,
    invalidateForProjectTransition: () => {
      get().inFlight?.controller.abort()
      set({
        activeWorkflowId: null,
        contextToken: newNonce(),
        prompt: DEFAULT_REVIEW_PROMPT,
        report: undefined,
        protocolConfirmation: undefined,
        inFlight: undefined,
        testStatus: { kind: 'idle' },
        reviewStatus: { kind: 'idle' },
        editIntent: undefined,
      })
    },
    updateConnection: (patch) => {
      const next = { ...get().connection, ...patch, version: 1 as const }
      memoryConnection = next
      set({ connection: next, testStatus: { kind: 'idle' } })
      if (!get().storageAvailable) return
      void saveReviewConnection(next).catch(() => storageFailure('审查连接名称和模型只能保留在当前页面会话中。'))
    },
    setEndpointUrl: (endpointUrl) => set({ endpointUrl, testStatus: { kind: 'idle' } }),
    setApiKey: (apiKey) => set({ apiKey, testStatus: { kind: 'idle' } }),
    clearApiKey: () => set({ apiKey: '', testStatus: { kind: 'idle' } }),
    setPrompt: (workflowId, prompt) => {
      memoryPrompts.set(workflowId, prompt)
      if (get().activeWorkflowId === workflowId) set({ prompt })
      if (!get().storageAvailable) return
      void saveReviewPrompt(workflowId, prompt).catch(() => storageFailure('审查提示词只能保留在当前页面会话中。'))
    },
    resetPrompt: (workflowId) => {
      memoryPrompts.set(workflowId, DEFAULT_REVIEW_PROMPT)
      if (get().activeWorkflowId === workflowId) set({ prompt: DEFAULT_REVIEW_PROMPT })
      if (!get().storageAvailable) return
      void saveReviewPrompt(workflowId, DEFAULT_REVIEW_PROMPT).catch(() => storageFailure('审查提示词只能保留在当前页面会话中。'))
    },
    confirmProtocol: (workflowId, protocolKey) => set({ protocolConfirmation: { workflowId, protocolKey } }),
    isProtocolConfirmed: (workflowId, protocolKey) => Boolean(protocolKey
      && get().protocolConfirmation?.workflowId === workflowId
      && get().protocolConfirmation?.protocolKey === protocolKey),
    startConnectionTest: async ({ allowInsecure }) => {
      const state = get()
      if (state.inFlight) return
      if (isHttpEndpoint(state.endpointUrl) && !allowInsecure) {
        set({ testStatus: { kind: 'error', code: 'insecure-confirmation-required', message: '请先确认 HTTP 地址的未加密传输风险。' } })
        return
      }
      const controller = new AbortController()
      const run: InFlightReview = {
        kind: 'test',
        requestId: newNonce(),
        requestedAt: Date.now(),
        workflowId: state.activeWorkflowId,
        contextToken: state.contextToken,
        controller,
        stage: 'connecting',
      }
      set({ inFlight: run, testStatus: { kind: 'running', requestKind: 'test', stage: run.stage } })
      const result = await testReviewConnection({
        endpoint: state.endpointUrl,
        apiKey: state.apiKey,
        model: state.connection.model,
        pageProtocol: currentPageProtocol(),
        signal: controller.signal,
        onStage: (stage) => {
          if (!isCurrentRun(get(), run)) return
          set({ inFlight: { ...run, stage }, testStatus: { kind: 'running', requestKind: 'test', stage } })
        },
      })
      if (!isCurrentRun(get(), run)) return
      set({
        inFlight: undefined,
        testStatus: result.ok
          ? { kind: 'success', message: '连接测试成功。此结果只代表当前会话中的地址、模型和 Key。' }
          : { kind: 'error', code: result.code, message: reviewTransportMessage(result.code) },
      })
    },
    startReview: async ({ workflow, allowInsecure, currentFingerprint }) => {
      const state = get()
      if (state.inFlight) return
      if (state.activeWorkflowId !== workflow.workflowId) {
        set({ reviewStatus: { kind: 'error', code: 'request-superseded', message: '当前项目已变化，请重新打开审查页面。' } })
        return
      }
      if (validateWorkflow(workflow).some((issue) => issue.severity === 'error')) {
        set({ reviewStatus: { kind: 'error', code: 'invalid-report', message: '请先处理当前工作流的结构问题，再发起审查。' } })
        return
      }
      if (isHttpEndpoint(state.endpointUrl) && !allowInsecure) {
        set({ reviewStatus: { kind: 'error', code: 'insecure-confirmation-required', message: '请先确认 HTTP 地址的未加密传输风险。' } })
        return
      }
      let material: ReviewMaterial
      try {
        material = buildReviewMaterial({
          workflow,
          userPrompt: state.prompt,
          protocolStatus: materialProtocolStatus(state, workflow),
        })
      } catch (error) {
        set({ reviewStatus: { kind: 'error', code: 'invalid-report', message: error instanceof Error ? error.message : '当前工作流还不能发起审查。' } })
        return
      }
      const marker: LatestReviewRequest = { version: 1, requestId: newNonce(), requestedAt: Date.now() }
      let markerResult: { accepted: boolean; latest: LatestReviewRequest }
      if (state.storageAvailable) {
        try {
          markerResult = await markLatestReviewRequest(workflow.workflowId, marker)
        } catch {
          storageFailure('审查标记只能保留在当前页面会话中。')
          markerResult = fallbackMarker(workflow.workflowId, marker)
        }
      } else {
        markerResult = fallbackMarker(workflow.workflowId, marker)
      }
      if (!markerResult.accepted) {
        set({ reviewStatus: { kind: 'error', code: 'request-superseded', message: '已有较晚发起的审查，请查看或等待该审查结果。' } })
        return
      }

      const controller = new AbortController()
      const run: InFlightReview = {
        kind: 'review',
        requestId: marker.requestId,
        requestedAt: marker.requestedAt,
        workflowId: workflow.workflowId,
        contextToken: state.contextToken,
        controller,
        stage: 'connecting',
        material,
      }
      set({ inFlight: run, reviewStatus: { kind: 'running', requestKind: 'review', stage: run.stage } })
      const response = await requestOpenAiCompatibleCompletion({
        endpoint: state.endpointUrl,
        apiKey: state.apiKey,
        model: state.connection.model,
        messages: material.messages,
        timeoutMs: 600_000,
        pageProtocol: currentPageProtocol(),
        signal: controller.signal,
        onStage: (stage) => {
          if (!isCurrentRun(get(), run)) return
          set({ inFlight: { ...run, stage }, reviewStatus: { kind: 'running', requestKind: 'review', stage } })
        },
      })
      if (!isCurrentRun(get(), run)) return
      if (!response.ok) {
        set({ inFlight: undefined, reviewStatus: { kind: 'error', code: response.code, message: reviewTransportMessage(response.code) } })
        return
      }
      let parsed
      try {
        parsed = parseReviewReport(response.content, material.snapshot)
      } catch {
        set({ inFlight: undefined, reviewStatus: { kind: 'error', code: 'invalid-report', message: '审查结果无法按固定格式读取，请调整提示词或重试。' } })
        return
      }
      const report: PersistedReviewReport = {
        version: 1,
        report: parsed,
        reviewedAt: Date.now(),
        model: state.connection.model,
        inputFingerprint: material.inputFingerprint,
        reviewContractVersion: REVIEW_CONTRACT_VERSION,
        reviewedRequest: material.reviewedRequest,
      }
      let saveResult: 'saved' | 'protected-current' | 'discarded'
      const fingerprint = currentFingerprint()
      if (get().storageAvailable) {
        try {
          saveResult = await saveReviewReportIfCurrent({ workflowId: workflow.workflowId, marker, report, currentFingerprint: fingerprint })
        } catch {
          storageFailure('审查报告只能保留在当前页面会话中。')
          const currentReport = memoryReports.get(workflow.workflowId)
          if (fingerprint && report.inputFingerprint !== fingerprint && currentReport?.inputFingerprint === fingerprint) saveResult = 'protected-current'
          else {
            memoryReports.set(workflow.workflowId, report)
            saveResult = 'saved'
          }
        }
      } else {
        const currentReport = memoryReports.get(workflow.workflowId)
        if (fingerprint && report.inputFingerprint !== fingerprint && currentReport?.inputFingerprint === fingerprint) saveResult = 'protected-current'
        else {
          memoryReports.set(workflow.workflowId, report)
          saveResult = 'saved'
        }
      }
      if (!isCurrentRun(get(), run)) return
      if (saveResult === 'saved') {
        memoryReports.set(workflow.workflowId, report)
        set({ inFlight: undefined, report, reviewStatus: { kind: 'success', message: '审查完成 · 查看报告' } })
        return
      }
      if (saveResult === 'protected-current') {
        set({ inFlight: undefined, reviewStatus: { kind: 'success', message: '审查完成 · 当前版本已有报告' } })
        return
      }
      set({ inFlight: undefined, reviewStatus: { kind: 'error', code: 'request-superseded', message: '审查结果已过期，未写入当前项目。' } })
    },
    cancelInFlight: () => {
      const run = get().inFlight
      if (!run) return
      run.controller.abort()
      const status: ReviewOperationStatus = { kind: 'error', code: 'canceled', message: reviewTransportMessage('canceled') }
      set({ inFlight: undefined, [run.kind === 'test' ? 'testStatus' : 'reviewStatus']: status })
    },
    setEditIntent: (workflowId, target) => set({ editIntent: { workflowId, target, nonce: newNonce() } }),
    consumeEditIntent: (workflowId) => {
      const intent = get().editIntent
      if (!intent || intent.workflowId !== workflowId) return undefined
      set({ editIntent: undefined })
      return intent
    },
  }
})

export const agentReviewCoordinator = {
  activateWorkflow(workflowId: string | null): void {
    useAgentReviewStore.getState().activateWorkflow(workflowId)
  },
  invalidateForProjectTransition(): void {
    useAgentReviewStore.getState().invalidateForProjectTransition()
  },
}
