import {
  DEFAULT_REVIEW_PROMPT,
  REVIEW_CONTRACT_VERSION,
  compareReviewRequests,
  parseReviewReport,
  reviewSnapshotFromRequest,
  type LatestReviewRequest,
  type PersistedReviewConnection,
  type PersistedReviewReport,
} from '../domain/agent-review'

const DATABASE_NAME = 'workflow-studio'
const STORE_NAME = 'workflows'
const WORKFLOW_PREFIX = 'workflow:'
const CONNECTION_KEY = 'review:connection'
const PROMPT_PREFIX = 'review:prompt:'
const LATEST_REQUEST_PREFIX = 'review:latest-request:'
const REPORT_PREFIX = 'review:report:'

export type ReviewReportSaveResult = 'saved' | 'protected-current' | 'discarded'

export function reviewConnectionKey(): string {
  return CONNECTION_KEY
}

export function reviewPromptKey(workflowId: string): string {
  return `${PROMPT_PREFIX}${workflowId}`
}

export function reviewLatestRequestKey(workflowId: string): string {
  return `${LATEST_REQUEST_PREFIX}${workflowId}`
}

export function reviewReportKey(workflowId: string): string {
  return `${REPORT_PREFIX}${workflowId}`
}

function workflowKey(workflowId: string): string {
  return `${WORKFLOW_PREFIX}${workflowId}`
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB 不可用。'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地存储。'))
    request.onblocked = () => reject(new Error('本地存储被其他页面占用。'))
  })
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地存储请求失败。'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('本地存储事务已中止。'))
    transaction.onerror = () => reject(transaction.error ?? new Error('本地存储事务失败。'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const database = await openDatabase()
  const transaction = database.transaction(STORE_NAME, mode)
  const completed = transactionComplete(transaction)
  try {
    const result = await action(transaction.objectStore(STORE_NAME))
    await completed
    return result
  } catch (error) {
    try {
      transaction.abort()
    } catch {
      // The transaction may already be complete after an IDB request failure.
    }
    await completed.catch(() => undefined)
    throw error
  } finally {
    database.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConnection(value: unknown): value is PersistedReviewConnection {
  return isRecord(value)
    && value.version === 1
    && typeof value.name === 'string'
    && typeof value.model === 'string'
}

function isLatestRequest(value: unknown): value is LatestReviewRequest {
  return isRecord(value)
    && value.version === 1
    && typeof value.requestId === 'string'
    && typeof value.requestedAt === 'number'
    && Number.isFinite(value.requestedAt)
}

function isReviewedRequest(value: unknown): boolean {
  return isRecord(value)
    && typeof value.systemContract === 'string'
    && typeof value.userPrompt === 'string'
    && typeof value.materialMessage === 'string'
    && typeof value.materialCharacterCount === 'number'
}

function isReport(value: unknown): value is PersistedReviewReport {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.reviewedAt !== 'number'
    || typeof value.model !== 'string'
    || typeof value.inputFingerprint !== 'string'
    || value.reviewContractVersion !== REVIEW_CONTRACT_VERSION
    || !isReviewedRequest(value.reviewedRequest)
    || !isRecord(value.report)) return false
  const request = value.reviewedRequest as PersistedReviewReport['reviewedRequest']
  const snapshot = reviewSnapshotFromRequest(request)
  if (!snapshot) return false
  try {
    parseReviewReport(JSON.stringify(value.report), snapshot)
    return true
  } catch {
    return false
  }
}

export async function loadReviewConnection(): Promise<PersistedReviewConnection | undefined> {
  const raw = await withStore('readonly', (store) => requestValue(store.get(CONNECTION_KEY)))
  return isConnection(raw) ? raw : undefined
}

export async function saveReviewConnection(connection: PersistedReviewConnection): Promise<void> {
  await withStore('readwrite', async (store) => {
    await requestValue(store.put({ version: 1, name: connection.name, model: connection.model }, CONNECTION_KEY))
  })
}

export async function loadReviewPrompt(workflowId: string): Promise<string> {
  const raw = await withStore('readonly', (store) => requestValue(store.get(reviewPromptKey(workflowId))))
  return typeof raw === 'string' ? raw : DEFAULT_REVIEW_PROMPT
}

export async function saveReviewPrompt(workflowId: string, prompt: string): Promise<void> {
  await withStore('readwrite', async (store) => {
    await requestValue(store.put(prompt, reviewPromptKey(workflowId)))
  })
}

export async function deleteReviewPrompt(workflowId: string): Promise<void> {
  await withStore('readwrite', async (store) => {
    await requestValue(store.delete(reviewPromptKey(workflowId)))
  })
}

export async function loadLatestReviewRequest(workflowId: string): Promise<LatestReviewRequest | undefined> {
  const raw = await withStore('readonly', (store) => requestValue(store.get(reviewLatestRequestKey(workflowId))))
  return isLatestRequest(raw) ? raw : undefined
}

export async function loadPersistedReviewReport(workflowId: string): Promise<PersistedReviewReport | undefined> {
  const raw = await withStore('readonly', (store) => requestValue(store.get(reviewReportKey(workflowId))))
  return isReport(raw) ? raw : undefined
}

export async function markLatestReviewRequest(workflowId: string, marker: LatestReviewRequest): Promise<{ accepted: boolean; latest: LatestReviewRequest }> {
  return withStore('readwrite', async (store) => {
    const raw = await requestValue(store.get(reviewLatestRequestKey(workflowId)))
    const current = isLatestRequest(raw) ? raw : undefined
    if (current && compareReviewRequests(marker, current) < 0) return { accepted: false, latest: current }
    await requestValue(store.put({ version: 1, requestId: marker.requestId, requestedAt: marker.requestedAt }, reviewLatestRequestKey(workflowId)))
    return { accepted: true, latest: marker }
  })
}

export async function saveReviewReportIfCurrent(input: {
  workflowId: string
  marker: LatestReviewRequest
  report: PersistedReviewReport
  currentFingerprint: string | null
}): Promise<ReviewReportSaveResult> {
  return withStore('readwrite', async (store) => {
    const root = await requestValue(store.get(workflowKey(input.workflowId)))
    if (!root) return 'discarded'
    const currentMarkerRaw = await requestValue(store.get(reviewLatestRequestKey(input.workflowId)))
    if (!isLatestRequest(currentMarkerRaw)
      || currentMarkerRaw.requestId !== input.marker.requestId
      || currentMarkerRaw.requestedAt !== input.marker.requestedAt) return 'discarded'

    const existingRaw = await requestValue(store.get(reviewReportKey(input.workflowId)))
    const existing = isReport(existingRaw) ? existingRaw : undefined
    const incomingIsCurrent = Boolean(input.currentFingerprint && input.report.inputFingerprint === input.currentFingerprint)
    const existingIsCurrent = Boolean(input.currentFingerprint && existing && existing.inputFingerprint === input.currentFingerprint)
    if (!incomingIsCurrent && existingIsCurrent) return 'protected-current'

    await requestValue(store.put(input.report, reviewReportKey(input.workflowId)))
    return 'saved'
  })
}

export async function deleteWorkflowAndReviewData(workflowId: string): Promise<void> {
  await withStore('readwrite', async (store) => {
    await Promise.all([
      requestValue(store.delete(workflowKey(workflowId))),
      requestValue(store.delete(reviewPromptKey(workflowId))),
      requestValue(store.delete(reviewLatestRequestKey(workflowId))),
      requestValue(store.delete(reviewReportKey(workflowId))),
    ])
  })
}

function reviewWorkflowIdFromKey(key: string): string | undefined {
  for (const prefix of [PROMPT_PREFIX, LATEST_REQUEST_PREFIX, REPORT_PREFIX]) {
    if (key.startsWith(prefix)) return key.slice(prefix.length)
  }
  return undefined
}

export async function cleanupOrphanReviewData(): Promise<void> {
  await withStore('readwrite', async (store) => {
    const allKeys = await requestValue(store.getAllKeys())
    const workflowIds = [...new Set(allKeys
      .filter((key): key is string => typeof key === 'string')
      .map(reviewWorkflowIdFromKey)
      .filter((id): id is string => Boolean(id)))]
    for (const workflowId of workflowIds) {
      const root = await requestValue(store.get(workflowKey(workflowId)))
      if (root) continue
      await Promise.all([
        requestValue(store.delete(reviewPromptKey(workflowId))),
        requestValue(store.delete(reviewLatestRequestKey(workflowId))),
        requestValue(store.delete(reviewReportKey(workflowId))),
      ])
    }
  })
}
