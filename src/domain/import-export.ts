import JSZip from 'jszip'
import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SCORING_SETTINGS,
  SCHEMA_VERSION,
  createField,
  scalarValue,
  type FieldValue,
  type WorkflowSchema,
} from './schema'
import { validateWorkflow } from './validation'
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

const maintenanceFormats = ['html', 'markdown'] as const
const lifecycles = ['realtime', 'stable', 'historical', 'preference', 'reference', 'validation', 'mixed'] as const
const documentRoles = ['protocol', 'plan', 'status', 'preference', 'history', 'context', 'validation', 'custom'] as const
const fieldTypes = ['shortText', 'longText', 'richText', 'select', 'multiSelect', 'boolean', 'date', 'path', 'url', 'email', 'code', 'list', 'table', 'reference'] as const
const sourceTypes = ['latest-user-instruction', 'workspace-fact', 'current-status', 'stable-plan', 'user-preference', 'session-history', 'memory-history', 'context-reference', 'older-history'] as const
const recencyPolicies = ['prefer-newer', 'ignore-recency', 'manual'] as const

function schemaVersionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0)
}

function compareSchemaVersion(left: string, right: string): number {
  const leftParts = schemaVersionParts(left)
  const rightParts = schemaVersionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function byteLength(text: string): number {
  return new Blob([text]).size
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串。`)
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值。`)
}

function assertNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是数字。`)
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!isStringArray(value)) throw new Error(`${label} 必须是字符串数组。`)
}

function assertOneOf<T extends readonly string[]>(value: unknown, allowed: T, label: string): asserts value is T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${label} 无效。`)
  }
}

function assertRecordArray(value: unknown, label: string): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`${label} 必须是对象数组。`)
}

function declaredUncompressedSize(entry: JSZip.JSZipObject): number {
  const data = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data
  if (!data || typeof data.uncompressedSize !== 'number' || !Number.isFinite(data.uncompressedSize) || data.uncompressedSize < 0) {
    throw new Error(`ZIP 条目 ${entry.name} 缺少可靠的解压大小。`)
  }
  return data.uncompressedSize
}

function assertFieldValue(value: unknown): asserts value is FieldValue {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('字段 value 结构无效。')
  if (value.kind === 'empty') return
  if (value.kind === 'scalar') {
    if (!['string', 'number', 'boolean'].includes(typeof value.value)) throw new Error('scalar 字段值无效。')
    return
  }
  if (value.kind === 'list') {
    if (!Array.isArray(value.value)) throw new Error('list 字段值无效。')
    value.value.forEach(assertFieldValue)
    return
  }
  if (value.kind === 'table') {
    if (!isStringArray(value.columns) || !Array.isArray(value.rows)) throw new Error('table 字段值无效。')
    if (!value.rows.every(isRecord)) throw new Error('table rows 字段值无效。')
    return
  }
  if (value.kind === 'reference') {
    if (typeof value.targetId !== 'string') throw new Error('reference 字段值无效。')
    return
  }
  throw new Error('未知字段值类型。')
}

function readStringRecord(value: Record<string, unknown>, key: string, fallback: string): string {
  return typeof value[key] === 'string' && value[key].trim().length > 0 ? value[key] : fallback
}

function createReadOnlyUnsupportedWorkflow(input: Record<string, unknown>): WorkflowSchema {
  const sourceVersion = readStringRecord(input, 'schemaVersion', 'unknown')
  const now = new Date().toISOString()
  const name = readStringRecord(input, 'name', '不兼容工作流')
  const description = readStringRecord(input, 'description', '该文件来自更高版本 Workflow Studio，只读打开可解析元数据。')
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceSchemaVersion: sourceVersion,
    readOnlyReason: `原始 schemaVersion ${sourceVersion} 高于当前应用 ${SCHEMA_VERSION}，当前仅只读打开可解析元数据。`,
    workflowId: `workflow-readonly-${Date.now()}`,
    name,
    description,
    createdAt: now,
    updatedAt: now,
    maintenanceFormat: 'html',
    secondaryFormat: 'markdown',
    documents: [
      {
        id: 'readonly-protocol',
        filename: 'AGENTS.md',
        title: '不兼容版本说明',
        role: 'protocol',
        lifecycle: 'validation',
        description: '说明该导入文件只能只读查看。',
        readPolicy: { whenToRead: ['只读查看导入诊断时读取'], dependsOnDocumentIds: [], readOrderHint: 1 },
        updatePolicy: { updateTriggers: [], replacementMode: 'manual', staleInfoHandling: 'keep-with-warning' },
        order: 1,
        required: true,
        sections: [
          {
            id: 'readonly-summary',
            title: '只读导入摘要',
            purpose: '保留高版本文件可解析的基础元数据。',
            lifecycle: 'validation',
            order: 1,
            repeatable: false,
            fields: [
              createField({
                id: 'readonly-reason',
                label: '只读原因',
                guidance: '高版本文件不得降级编辑，避免丢失未来字段含义。',
                lifecycle: 'validation',
                required: true,
                value: scalarValue(`原始版本：${sourceVersion}`),
              }),
              createField({
                id: 'readonly-source-description',
                label: '原始说明',
                guidance: '来自原始 workflow.json 的 description 元数据。',
                lifecycle: 'validation',
                value: scalarValue(description),
              }),
            ],
          },
        ],
      },
      {
        id: 'readonly-status',
        filename: 'STATUS.html',
        title: '只读状态',
        role: 'status',
        lifecycle: 'realtime',
        description: '当前应用版本不支持编辑该导入文件。',
        readPolicy: { whenToRead: ['只读查看时读取'], dependsOnDocumentIds: [], readOrderHint: 2 },
        updatePolicy: { updateTriggers: [], replacementMode: 'manual', staleInfoHandling: 'keep-with-warning' },
        order: 2,
        required: true,
        sections: [
          {
            id: 'readonly-next-step-section',
            title: '下一原子步骤',
            purpose: '说明用户需要使用兼容版本打开原文件。',
            lifecycle: 'realtime',
            order: 1,
            repeatable: false,
            fields: [
              createField({
                id: 'readonly-next-atomic-step',
                label: '下一原子步骤',
                guidance: '只读导入后不要编辑或覆盖原文件。',
                lifecycle: 'realtime',
                required: true,
                value: scalarValue('使用支持该 schemaVersion 的 Workflow Studio 打开原始文件。'),
              }),
            ],
          },
        ],
      },
    ],
    rules: {
      recoveryOrder: [
        { id: 'recovery-readonly-protocol', documentId: 'readonly-protocol', condition: '只读导入诊断入口', required: true, fallbackStepIds: [] },
        { id: 'recovery-readonly-status', documentId: 'readonly-status', condition: '只读状态入口', required: true, fallbackStepIds: [] },
      ],
      sourcePriority: [],
      updateTriggers: [],
      completionChecks: [],
      conflictPolicy: {
        defaultAction: 'block-until-resolved',
        requireExplicitNoteForManualOverride: true,
        unresolvedConflictSeverity: 'error',
      },
      historyPolicy: {
        appendOnly: true,
        allowedStatuses: ['已失效归档'],
        requireIndexUpdate: false,
        obsoleteHandling: 'mark-obsolete',
      },
    },
    exportSettings: DEFAULT_EXPORT_SETTINGS,
    scoringSettings: DEFAULT_SCORING_SETTINGS,
    acceptedWarnings: [],
  }
}

function assertWorkflowShape(value: unknown): asserts value is WorkflowSchema {
  if (!isRecord(value)) throw new Error('workflow.json 必须是对象。')
  if (typeof value.schemaVersion !== 'string') throw new Error('缺少 schemaVersion。')
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`不支持更高版本 schemaVersion：${value.schemaVersion}`)
  }
  if (value.sourceSchemaVersion !== undefined) assertString(value.sourceSchemaVersion, 'sourceSchemaVersion')
  if (value.readOnlyReason !== undefined) assertString(value.readOnlyReason, 'readOnlyReason')
  assertString(value.workflowId, 'workflowId')
  assertString(value.name, 'name')
  assertString(value.description, 'description')
  assertString(value.createdAt, 'createdAt')
  assertString(value.updatedAt, 'updatedAt')
  assertOneOf(value.maintenanceFormat, maintenanceFormats, 'maintenanceFormat')
  if (value.secondaryFormat !== undefined) assertOneOf(value.secondaryFormat, maintenanceFormats, 'secondaryFormat')
  assertRecordArray(value.documents, 'documents')
  for (const document of value.documents) {
    assertString(document.id, 'document.id')
    assertString(document.filename, 'document.filename')
    assertString(document.title, 'document.title')
    assertOneOf(document.role, documentRoles, 'document.role')
    assertOneOf(document.lifecycle, lifecycles, 'document.lifecycle')
    assertString(document.description, 'document.description')
    assertNumber(document.order, 'document.order')
    assertBoolean(document.required, 'document.required')
    if (!isRecord(document.readPolicy)) throw new Error('readPolicy 结构无效。')
    assertStringArray(document.readPolicy.whenToRead, 'readPolicy.whenToRead')
    assertStringArray(document.readPolicy.dependsOnDocumentIds, 'readPolicy.dependsOnDocumentIds')
    if (document.readPolicy.skipWhen !== undefined) assertStringArray(document.readPolicy.skipWhen, 'readPolicy.skipWhen')
    if (document.readPolicy.readOrderHint !== undefined) assertNumber(document.readPolicy.readOrderHint, 'readPolicy.readOrderHint')
    if (!isRecord(document.updatePolicy)) throw new Error('updatePolicy 结构无效。')
    assertStringArray(document.updatePolicy.updateTriggers, 'updatePolicy.updateTriggers')
    assertOneOf(document.updatePolicy.replacementMode, ['replace-current', 'append-history', 'append-entry', 'manual'] as const, 'updatePolicy.replacementMode')
    assertOneOf(document.updatePolicy.staleInfoHandling, ['remove', 'archive', 'mark-obsolete', 'keep-with-warning'] as const, 'updatePolicy.staleInfoHandling')
    assertRecordArray(document.sections, 'sections')
    for (const section of document.sections) {
      assertString(section.id, 'section.id')
      assertString(section.title, 'section.title')
      assertString(section.purpose, 'section.purpose')
      assertOneOf(section.lifecycle, lifecycles, 'section.lifecycle')
      assertNumber(section.order, 'section.order')
      assertBoolean(section.repeatable, 'section.repeatable')
      assertRecordArray(section.fields, 'fields')
      for (const field of section.fields) {
        assertString(field.id, 'field.id')
        assertString(field.label, 'field.label')
        assertOneOf(field.type, fieldTypes, 'field.type')
        assertString(field.guidance, 'field.guidance')
        assertOneOf(field.lifecycle, lifecycles, 'field.lifecycle')
        assertBoolean(field.required, 'field.required')
        assertBoolean(field.allowEmpty, 'field.allowEmpty')
        assertBoolean(field.repeatable, 'field.repeatable')
        assertFieldValue(field.value)
        if (!isRecord(field.validation) || !Array.isArray(field.validation.customRules)) throw new Error('field.validation 结构无效。')
      }
    }
  }
  if (!isRecord(value.rules)) throw new Error('rules 结构无效。')
  assertRecordArray(value.rules.recoveryOrder, 'rules.recoveryOrder')
  assertRecordArray(value.rules.sourcePriority, 'rules.sourcePriority')
  assertRecordArray(value.rules.updateTriggers, 'rules.updateTriggers')
  assertRecordArray(value.rules.completionChecks, 'rules.completionChecks')
  for (const step of value.rules.recoveryOrder) {
    assertString(step.id, 'recoveryStep.id')
    assertString(step.documentId, 'recoveryStep.documentId')
    assertString(step.condition, 'recoveryStep.condition')
    assertBoolean(step.required, 'recoveryStep.required')
    assertStringArray(step.fallbackStepIds, 'recoveryStep.fallbackStepIds')
  }
  for (const rule of value.rules.sourcePriority) {
    assertString(rule.id, 'sourcePriority.id')
    assertOneOf(rule.scope, ['global', 'document', 'section', 'field'] as const, 'sourcePriority.scope')
    assertRecordArray(rule.orderedSources, 'sourcePriority.orderedSources')
    assertOneOf(rule.tieBreaker, ['newer', 'explicit-user-confirmation', 'manual-review'] as const, 'sourcePriority.tieBreaker')
    assertString(rule.reason, 'sourcePriority.reason')
    for (const source of rule.orderedSources) {
      assertOneOf(source.sourceType, sourceTypes, 'source.sourceType')
      assertString(source.label, 'source.label')
      assertNumber(source.priority, 'source.priority')
      assertOneOf(source.recencyPolicy, recencyPolicies, 'source.recencyPolicy')
    }
  }
  for (const trigger of value.rules.updateTriggers) {
    assertString(trigger.id, 'updateTrigger.id')
    assertString(trigger.targetDocumentId, 'updateTrigger.targetDocumentId')
    assertString(trigger.trigger, 'updateTrigger.trigger')
    assertString(trigger.requiredAction, 'updateTrigger.requiredAction')
  }
  for (const check of value.rules.completionChecks) {
    assertString(check.id, 'completionCheck.id')
    assertString(check.label, 'completionCheck.label')
    assertString(check.description, 'completionCheck.description')
    assertOneOf(check.severityWhenMissing, ['error', 'warning'] as const, 'completionCheck.severityWhenMissing')
    assertStringArray(check.relatedDocumentIds, 'completionCheck.relatedDocumentIds')
  }
  if (!isRecord(value.rules.conflictPolicy) || !isRecord(value.rules.historyPolicy)) throw new Error('规则策略结构无效。')
  assertOneOf(value.rules.conflictPolicy.defaultAction, ['apply-source-priority', 'ask-user', 'block-until-resolved'] as const, 'conflictPolicy.defaultAction')
  assertBoolean(value.rules.conflictPolicy.requireExplicitNoteForManualOverride, 'conflictPolicy.requireExplicitNoteForManualOverride')
  assertOneOf(value.rules.conflictPolicy.unresolvedConflictSeverity, ['error', 'warning'] as const, 'conflictPolicy.unresolvedConflictSeverity')
  assertBoolean(value.rules.historyPolicy.appendOnly, 'historyPolicy.appendOnly')
  assertStringArray(value.rules.historyPolicy.allowedStatuses, 'historyPolicy.allowedStatuses')
  assertBoolean(value.rules.historyPolicy.requireIndexUpdate, 'historyPolicy.requireIndexUpdate')
  assertOneOf(value.rules.historyPolicy.obsoleteHandling, ['mark-obsolete', 'archive-with-replacement', 'delete'] as const, 'historyPolicy.obsoleteHandling')
  if (!isRecord(value.exportSettings) || value.exportSettings.includeWorkflowJson !== true || value.exportSettings.includeReadme !== true) throw new Error('exportSettings 结构无效。')
  assertOneOf(value.exportSettings.htmlMode, ['single-file-static'] as const, 'exportSettings.htmlMode')
  assertOneOf(value.exportSettings.markdownMetadataMode, ['visible'] as const, 'exportSettings.markdownMetadataMode')
  assertOneOf(value.exportSettings.fileNaming, ['document-filename'] as const, 'exportSettings.fileNaming')
  assertString(value.exportSettings.packageNamePattern, 'exportSettings.packageNamePattern')
  if (!isRecord(value.scoringSettings) || !isRecord(value.scoringSettings.weights) || !isRecord(value.scoringSettings.thresholds)) throw new Error('scoringSettings 结构无效。')
  for (const key of ['recoveryStrength', 'maintenanceCost', 'redundancyRisk', 'beginnerFriendliness', 'auditability']) {
    assertNumber(value.scoringSettings.weights[key], `scoringSettings.weights.${key}`)
  }
  for (const key of ['good', 'caution', 'poor']) {
    assertNumber(value.scoringSettings.thresholds[key], `scoringSettings.thresholds.${key}`)
  }
  assertRecordArray(value.acceptedWarnings, 'acceptedWarnings')
  for (const warning of value.acceptedWarnings) {
    assertString(warning.issueId, 'acceptedWarning.issueId')
    assertString(warning.ruleId, 'acceptedWarning.ruleId')
    if (!isRecord(warning.target)) throw new Error('acceptedWarning.target 结构无效。')
    assertString(warning.acceptedAt, 'acceptedWarning.acceptedAt')
    assertString(warning.schemaHash, 'acceptedWarning.schemaHash')
  }
}

function ensureNotAborted(signal?: AbortSignal) {
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

export async function parseWorkflowJson(text: string): Promise<WorkflowSchema> {
  if (byteLength(text) > MAX_JSON_BYTES) {
    throw new Error('workflow.json 超过 5MB 限制。')
  }
  const raw: unknown = JSON.parse(text)
  if (isRecord(raw) && typeof raw.schemaVersion === 'string' && compareSchemaVersion(raw.schemaVersion, SCHEMA_VERSION) > 0) {
    return createReadOnlyUnsupportedWorkflow(raw)
  }
  const parsed: unknown = migrateWorkflowSchema(raw)
  assertWorkflowShape(parsed)
  const issues = validateWorkflow(parsed)
  const blocking = issues.find((issue) => issue.severity === 'error')
  if (blocking) {
    throw new Error(`导入校验失败：${blocking.title}`)
  }
  return { ...parsed, workflowId: `workflow-${Date.now()}`, updatedAt: new Date().toISOString() }
}

export async function parseImportedWorkflow(file: File, options: ImportOptions = {}): Promise<WorkflowSchema> {
  ensureNotAborted(options.signal)
  if (file.name.endsWith('.json')) {
    if (file.size > MAX_JSON_BYTES) {
      throw new Error('workflow.json 超过 5MB 限制。')
    }
    const text = await withTimeout(file.text(), options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS, options.signal)
    ensureNotAborted(options.signal)
    return parseWorkflowJson(text)
  }
  if (!file.name.endsWith('.zip')) {
    throw new Error('只支持 workflow.json 或本应用导出的 ZIP。')
  }
  if (file.size > MAX_ZIP_BYTES) {
    throw new Error('ZIP 超过 10MB 限制。')
  }
  const zip = await withTimeout(JSZip.loadAsync(file), options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS, options.signal)
  const entries = Object.values(zip.files)
  if (entries.length > MAX_ENTRIES) {
    throw new Error('ZIP 条目数超过 200。')
  }
  for (const entry of entries) {
    const normalized = normalizeZipPath(entry.name)
    const checkedName = entry.dir ? normalized.replace(/\/+$/, '') : normalized
    const reason = unsafePathReason(checkedName)
    if (reason) throw new Error(`ZIP 包含非法路径：${entry.name}，${reason}`)
    if (!checkedName.trim()) throw new Error('ZIP 包含空文件名。')
  }
  const workflowEntries = entries.filter((entry) => !entry.dir && normalizeZipPath(entry.name).endsWith('workflow.json'))
  if (workflowEntries.length !== 1) {
    throw new Error('ZIP 中必须且只能包含一个 workflow.json。')
  }
  let declaredTotalBytes = 0
  for (const entry of entries) {
    if (entry.dir) continue
    const size = declaredUncompressedSize(entry)
    if (size > MAX_UNZIPPED_TEXT_BYTES) {
      throw new Error('ZIP 单个条目解压后文本内容超过 25MB 限制。')
    }
    declaredTotalBytes += size
    if (declaredTotalBytes > MAX_UNZIPPED_TEXT_BYTES) {
      throw new Error('ZIP 解压后文本内容超过 25MB 限制。')
    }
  }
  let totalTextBytes = 0
  let workflowJsonText = ''
  for (const entry of entries) {
    if (entry.dir) continue
    ensureNotAborted(options.signal)
    const text = await withTimeout(entry.async('string'), options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS, options.signal)
    totalTextBytes += byteLength(text)
    if (totalTextBytes > MAX_UNZIPPED_TEXT_BYTES) {
      throw new Error('ZIP 解压后文本内容超过 25MB 限制。')
    }
    if (entry === workflowEntries[0]) workflowJsonText = text
  }
  return parseWorkflowJson(workflowJsonText)
}
