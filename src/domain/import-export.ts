import JSZip from 'jszip'
import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SCORING_SETTINGS,
  SCHEMA_VERSION,
  createField,
  type WorkflowSchema,
} from './schema'
import { createSystemProtocolState, normalizeWorkflowForRuntime, remapWorkflowRootIdentity } from './protocol-state'
import { assertWorkflowShape, compareSchemaVersion } from './strict-workflow-shape'
import { normalizeZipPath, unsafePathReason } from './file-safety'
import { migrateWorkflowSchema } from '../data/migrations/workflow-migrations'

const MAX_ZIP_BYTES = 10 * 1024 * 1024
const MAX_JSON_BYTES = 5 * 1024 * 1024
const MAX_UNZIPPED_TEXT_BYTES = 25 * 1024 * 1024
const MAX_ENTRIES = 200
const DEFAULT_PARSE_TIMEOUT_MS = 12_000

export type ImportOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function byteLength(text: string): number {
  return new Blob([text]).size
}

function readText(value: Record<string, unknown>, key: string, fallback: string): string {
  return typeof value[key] === 'string' && value[key].trim() ? value[key] : fallback
}

function createReadOnlyUnsupportedWorkflow(input: Record<string, unknown>): WorkflowSchema {
  const createdAt = new Date().toISOString()
  const name = readText(input, 'name', '不兼容工作流')
  const description = readText(input, 'description', '该文件来自更高版本 Workflow Studio，只读打开可解析元数据。')
  const documents = [{
    id: 'readonly-status',
    filename: 'STATUS.html',
    title: '只读导入说明',
    role: 'validation' as const,
    lifecycle: 'validation' as const,
    description: '当前应用无法安全编辑这个更高版本的工作流。',
    readPolicy: { whenToRead: ['只读查看导入诊断时读取。'], dependsOnDocumentIds: [], readOrderHint: 1 },
    updatePolicy: { updateTriggers: [], replacementMode: 'manual' as const, staleInfoHandling: 'keep-with-warning' as const },
    order: 1,
    required: true,
    sections: [{
      id: 'readonly-reason-section',
      title: '如何继续',
      purpose: '保留可解析的元数据，避免降级覆盖原始文件。',
      lifecycle: 'validation' as const,
      order: 1,
      repeatable: false,
      fields: [createField({
        id: 'readonly-reason',
        label: '只读原因',
        guidance: '请使用支持原始 schemaVersion 的 Workflow Studio 打开原文件。',
        lifecycle: 'validation',
      })],
    }],
  }]
  return normalizeWorkflowForRuntime({
    schemaVersion: SCHEMA_VERSION,
    sourceSchemaVersion: readText(input, 'schemaVersion', 'unknown'),
    readOnlyReason: `原始 schemaVersion ${readText(input, 'schemaVersion', 'unknown')} 高于当前应用 ${SCHEMA_VERSION}，当前仅只读打开可解析元数据。`,
    workflowId: `workflow-readonly-${Date.now()}`,
    name,
    description,
    createdAt,
    updatedAt: createdAt,
    maintenanceFormat: 'html',
    secondaryFormat: 'markdown',
    mode: 'legacy-content',
    documents,
    protocolState: createSystemProtocolState({ name, description, documents }),
    exportSettings: DEFAULT_EXPORT_SETTINGS,
    scoringSettings: DEFAULT_SCORING_SETTINGS,
    acceptedWarnings: [],
  })
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('导入已取消。')
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  ensureNotAborted(signal)
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('导入解析超时，请先导出较小文件或重试。')), timeoutMs)
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function declaredUncompressedSize(entry: JSZip.JSZipObject): number {
  const data = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data
  if (!data || typeof data.uncompressedSize !== 'number' || !Number.isFinite(data.uncompressedSize) || data.uncompressedSize < 0) {
    throw new Error(`ZIP 条目 ${entry.name} 缺少可靠的解压大小。`)
  }
  return data.uncompressedSize
}

export async function parseWorkflowJson(text: string): Promise<WorkflowSchema> {
  if (byteLength(text) > MAX_JSON_BYTES) throw new Error('workflow.json 超过 5MB 限制。')
  const raw: unknown = JSON.parse(text)
  if (isRecord(raw) && typeof raw.schemaVersion === 'string' && compareSchemaVersion(raw.schemaVersion, SCHEMA_VERSION) > 0) {
    return createReadOnlyUnsupportedWorkflow(raw)
  }
  const migrated = migrateWorkflowSchema(raw)
  assertWorkflowShape(migrated)
  return remapWorkflowRootIdentity(normalizeWorkflowForRuntime(migrated))
}

export async function parseImportedWorkflow(file: File, options: ImportOptions = {}): Promise<WorkflowSchema> {
  ensureNotAborted(options.signal)
  const filename = file.name.toLocaleLowerCase()
  if (filename.endsWith('.html') || filename.endsWith('.htm') || filename.endsWith('.md') || filename.endsWith('.markdown')) {
    throw new Error('这是生成的阅读文件，请导入 workflow.json 或完整 ZIP；HTML 和 Markdown 的修改不会合并。')
  }
  if (filename.endsWith('.json')) {
    if (file.size > MAX_JSON_BYTES) throw new Error('workflow.json 超过 5MB 限制。')
    const text = await withTimeout(file.text(), options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS, options.signal)
    ensureNotAborted(options.signal)
    return parseWorkflowJson(text)
  }
  if (!filename.endsWith('.zip')) throw new Error('只支持 workflow.json 或本应用导出的 ZIP。')
  if (file.size > MAX_ZIP_BYTES) throw new Error('ZIP 超过 10MB 限制。')

  const zip = await withTimeout(JSZip.loadAsync(file), options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS, options.signal)
  const entries = Object.values(zip.files)
  if (entries.length > MAX_ENTRIES) throw new Error('ZIP 条目数超过 200。')
  let declaredTotalBytes = 0
  for (const entry of entries) {
    const normalized = normalizeZipPath(entry.name)
    const checkedName = entry.dir ? normalized.replace(/\/+$/, '') : normalized
    const reason = unsafePathReason(checkedName)
    if (reason || !checkedName.trim()) throw new Error(`ZIP 包含非法路径：${entry.name}${reason ? `，${reason}` : ''}`)
    if (entry.dir) continue
    const size = declaredUncompressedSize(entry)
    if (size > MAX_UNZIPPED_TEXT_BYTES) throw new Error('ZIP 单个条目解压后文本内容超过 25MB 限制。')
    declaredTotalBytes += size
    if (declaredTotalBytes > MAX_UNZIPPED_TEXT_BYTES) throw new Error('ZIP 解压后文本内容超过 25MB 限制。')
  }
  const workflowEntries = entries.filter((entry) => !entry.dir && normalizeZipPath(entry.name).endsWith('workflow.json'))
  if (workflowEntries.length !== 1) throw new Error('ZIP 中必须且只能包含一个 workflow.json。')
  ensureNotAborted(options.signal)
  const workflowText = await withTimeout(workflowEntries[0].async('string'), options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS, options.signal)
  ensureNotAborted(options.signal)
  return parseWorkflowJson(workflowText)
}
