import {
  HISTORY_STATUSES,
  SCHEMA_VERSION,
  type FieldValue,
  type PersistedWorkflowSchema,
} from './schema'

type UnknownRecord = Record<string, unknown>

const maintenanceFormats = ['html', 'markdown'] as const
const lifecycles = ['realtime', 'stable', 'historical', 'preference', 'reference', 'validation', 'mixed'] as const
const contentRoles = ['plan', 'status', 'preference', 'history', 'context', 'validation', 'custom'] as const
const protocolRoles = ['protocol'] as const
const fieldTypes = ['shortText', 'longText', 'richText', 'select', 'multiSelect', 'boolean', 'date', 'path', 'url', 'email', 'code', 'list', 'table', 'reference'] as const
const displayFormats = ['paragraph', 'bullet-list', 'checklist', 'steps', 'key-value', 'decision-table', 'timeline', 'code', 'path-list'] as const
const newDisplayFormats = ['paragraph', 'bullet-list', 'steps'] as const
const validationPredicates = ['non-empty', 'valid-path', 'valid-url', 'valid-email', 'matches-pattern', 'custom'] as const
const sourceTypes = ['latest-user-instruction', 'workspace-fact', 'current-status', 'stable-plan', 'user-preference', 'session-history', 'memory-history', 'context-reference', 'older-history', 'document-reference'] as const
const recencyPolicies = ['prefer-newer', 'ignore-recency', 'manual'] as const

function isRecord(value: unknown): value is UnknownRecord {
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
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label} 无效。`)
}

function assertRecordArray(value: unknown, label: string): asserts value is UnknownRecord[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`${label} 必须是对象数组。`)
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
    if (value.columns.some((column) => !column.trim()) || new Set(value.columns).size !== value.columns.length) {
      throw new Error('table columns 必须是非空且不重复的字符串。')
    }
    const columns = new Set(value.columns)
    if (!value.rows.every((row) => isRecord(row) && Object.entries(row).every(([key, cell]) => columns.has(key) && typeof cell === 'string'))) {
      throw new Error('table rows 的键必须来自 columns，且单元格必须是字符串。')
    }
    return
  }
  if (value.kind === 'reference' && typeof value.targetId === 'string') return
  throw new Error('未知字段值类型。')
}

function assertDocument(value: UnknownRecord, label: string, roles: readonly string[]): void {
  assertString(value.id, `${label}.id`)
  assertString(value.filename, `${label}.filename`)
  assertString(value.title, `${label}.title`)
  assertOneOf(value.role, roles, `${label}.role`)
  assertOneOf(value.lifecycle, lifecycles, `${label}.lifecycle`)
  assertString(value.description, `${label}.description`)
  assertNumber(value.order, `${label}.order`)
  assertBoolean(value.required, `${label}.required`)
  if (!isRecord(value.readPolicy)) throw new Error(`${label}.readPolicy 结构无效。`)
  assertStringArray(value.readPolicy.whenToRead, `${label}.readPolicy.whenToRead`)
  assertStringArray(value.readPolicy.dependsOnDocumentIds, `${label}.readPolicy.dependsOnDocumentIds`)
  if (value.readPolicy.skipWhen !== undefined) assertStringArray(value.readPolicy.skipWhen, `${label}.readPolicy.skipWhen`)
  if (value.readPolicy.readOrderHint !== undefined) assertNumber(value.readPolicy.readOrderHint, `${label}.readPolicy.readOrderHint`)
  if (!isRecord(value.updatePolicy)) throw new Error(`${label}.updatePolicy 结构无效。`)
  assertStringArray(value.updatePolicy.updateTriggers, `${label}.updatePolicy.updateTriggers`)
  assertOneOf(value.updatePolicy.replacementMode, ['replace-current', 'append-history', 'append-entry', 'manual'] as const, `${label}.updatePolicy.replacementMode`)
  assertOneOf(value.updatePolicy.staleInfoHandling, ['remove', 'archive', 'mark-obsolete', 'keep-with-warning'] as const, `${label}.updatePolicy.staleInfoHandling`)
  assertRecordArray(value.sections, `${label}.sections`)
  for (const section of value.sections) {
    assertString(section.id, `${label}.section.id`)
    assertString(section.title, `${label}.section.title`)
    assertString(section.purpose, `${label}.section.purpose`)
    assertOneOf(section.lifecycle, lifecycles, `${label}.section.lifecycle`)
    assertNumber(section.order, `${label}.section.order`)
    assertBoolean(section.repeatable, `${label}.section.repeatable`)
    assertRecordArray(section.fields, `${label}.section.fields`)
    for (const field of section.fields) {
      assertString(field.id, `${label}.field.id`)
      assertString(field.label, `${label}.field.label`)
      assertOneOf(field.type, fieldTypes, `${label}.field.type`)
      assertString(field.guidance, `${label}.field.guidance`)
      assertOneOf(field.lifecycle, lifecycles, `${label}.field.lifecycle`)
      assertBoolean(field.required, `${label}.field.required`)
      assertBoolean(field.allowEmpty, `${label}.field.allowEmpty`)
      assertBoolean(field.repeatable, `${label}.field.repeatable`)
      assertFieldValue(field.value)
      if (field.displayFormat !== undefined) assertOneOf(field.displayFormat, displayFormats, `${label}.field.displayFormat`)
      if (field.options !== undefined) {
        assertRecordArray(field.options, `${label}.field.options`)
        for (const option of field.options) {
          assertString(option.value, `${label}.field.option.value`)
          assertString(option.label, `${label}.field.option.label`)
          if (option.description !== undefined) assertString(option.description, `${label}.field.option.description`)
        }
      }
      if (!isRecord(field.validation)) throw new Error(`${label}.field.validation 结构无效。`)
      if (field.validation.minLength !== undefined) assertNumber(field.validation.minLength, `${label}.field.validation.minLength`)
      if (field.validation.maxLength !== undefined) assertNumber(field.validation.maxLength, `${label}.field.validation.maxLength`)
      if (field.validation.pattern !== undefined) assertString(field.validation.pattern, `${label}.field.validation.pattern`)
      if (field.validation.allowedValues !== undefined) assertStringArray(field.validation.allowedValues, `${label}.field.validation.allowedValues`)
      assertRecordArray(field.validation.customRules, `${label}.field.validation.customRules`)
      for (const rule of field.validation.customRules) {
        assertString(rule.id, `${label}.field.validation.rule.id`)
        assertString(rule.description, `${label}.field.validation.rule.description`)
        assertOneOf(rule.severity, ['error', 'warning', 'suggestion', 'pass'] as const, `${label}.field.validation.rule.severity`)
        assertOneOf(rule.predicate, validationPredicates, `${label}.field.validation.rule.predicate`)
      }
    }
  }
}

function assertRules(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} 结构无效。`)
  assertRecordArray(value.recoveryOrder, `${label}.recoveryOrder`)
  assertRecordArray(value.sourcePriority, `${label}.sourcePriority`)
  assertRecordArray(value.updateTriggers, `${label}.updateTriggers`)
  assertRecordArray(value.completionChecks, `${label}.completionChecks`)
  for (const step of value.recoveryOrder) {
    assertString(step.id, `${label}.recoveryStep.id`)
    assertString(step.documentId, `${label}.recoveryStep.documentId`)
    assertString(step.condition, `${label}.recoveryStep.condition`)
    assertBoolean(step.required, `${label}.recoveryStep.required`)
    assertStringArray(step.fallbackStepIds, `${label}.recoveryStep.fallbackStepIds`)
  }
  for (const rule of value.sourcePriority) {
    assertString(rule.id, `${label}.sourcePriority.id`)
    assertOneOf(rule.scope, ['global', 'document', 'section', 'field'] as const, `${label}.sourcePriority.scope`)
    if (rule.targetId !== undefined) assertString(rule.targetId, `${label}.sourcePriority.targetId`)
    assertRecordArray(rule.orderedSources, `${label}.sourcePriority.orderedSources`)
    assertOneOf(rule.tieBreaker, ['newer', 'explicit-user-confirmation', 'manual-review'] as const, `${label}.sourcePriority.tieBreaker`)
    assertString(rule.reason, `${label}.sourcePriority.reason`)
    for (const source of rule.orderedSources) {
      assertOneOf(source.sourceType, sourceTypes, `${label}.source.sourceType`)
      assertString(source.label, `${label}.source.label`)
      assertNumber(source.priority, `${label}.source.priority`)
      assertOneOf(source.recencyPolicy, recencyPolicies, `${label}.source.recencyPolicy`)
      if (source.documentId !== undefined) assertString(source.documentId, `${label}.source.documentId`)
      if (source.sourceType === 'document-reference' && source.documentId === undefined) throw new Error(`${label}.source.documentId 不能为空。`)
    }
  }
  for (const trigger of value.updateTriggers) {
    assertString(trigger.id, `${label}.updateTrigger.id`)
    assertString(trigger.targetDocumentId, `${label}.updateTrigger.targetDocumentId`)
    assertString(trigger.trigger, `${label}.updateTrigger.trigger`)
    assertString(trigger.requiredAction, `${label}.updateTrigger.requiredAction`)
  }
  for (const check of value.completionChecks) {
    assertString(check.id, `${label}.completionCheck.id`)
    assertString(check.label, `${label}.completionCheck.label`)
    assertString(check.description, `${label}.completionCheck.description`)
    assertOneOf(check.severityWhenMissing, ['error', 'warning'] as const, `${label}.completionCheck.severityWhenMissing`)
    assertStringArray(check.relatedDocumentIds, `${label}.completionCheck.relatedDocumentIds`)
  }
  if (!isRecord(value.conflictPolicy) || !isRecord(value.historyPolicy)) throw new Error(`${label} 策略结构无效。`)
  assertOneOf(value.conflictPolicy.defaultAction, ['apply-source-priority', 'ask-user', 'block-until-resolved'] as const, `${label}.conflictPolicy.defaultAction`)
  assertBoolean(value.conflictPolicy.requireExplicitNoteForManualOverride, `${label}.conflictPolicy.requireExplicitNoteForManualOverride`)
  assertOneOf(value.conflictPolicy.unresolvedConflictSeverity, ['error', 'warning'] as const, `${label}.conflictPolicy.unresolvedConflictSeverity`)
  assertBoolean(value.historyPolicy.appendOnly, `${label}.historyPolicy.appendOnly`)
  assertStringArray(value.historyPolicy.allowedStatuses, `${label}.historyPolicy.allowedStatuses`)
  for (const status of value.historyPolicy.allowedStatuses) assertOneOf(status, HISTORY_STATUSES, `${label}.historyPolicy.allowedStatuses[]`)
  assertBoolean(value.historyPolicy.requireIndexUpdate, `${label}.historyPolicy.requireIndexUpdate`)
  assertOneOf(value.historyPolicy.obsoleteHandling, ['mark-obsolete', 'archive-with-replacement', 'delete'] as const, `${label}.historyPolicy.obsoleteHandling`)
}

function assertUniqueIds(value: UnknownRecord): void {
  const ids: string[] = []
  const capture = (id: unknown, label: string) => {
    assertString(id, label)
    if (!id.trim()) throw new Error(`${label} 不能为空。`)
    ids.push(id)
  }
  const visitDocument = (document: UnknownRecord, label: string) => {
    capture(document.id, `${label}.id`)
    for (const section of document.sections as UnknownRecord[]) {
      capture(section.id, `${label}.section.id`)
      for (const field of section.fields as UnknownRecord[]) capture(field.id, `${label}.field.id`)
    }
  }
  for (const document of value.documents as UnknownRecord[]) visitDocument(document, 'document')
  const state = value.protocolState as UnknownRecord
  const system = state.system as UnknownRecord
  if (system.status === 'ready') visitDocument((system.bundle as UnknownRecord).document as UnknownRecord, 'protocolState.system.bundle.document')
  const legacy = state.legacyManualOverride
  if (isRecord(legacy) && Array.isArray(legacy.documents)) {
    for (const document of legacy.documents.filter(isRecord)) visitDocument(document, 'protocolState.legacyManualOverride.document')
  }
  if (new Set(ids).size !== ids.length) throw new Error('ID 重复。')
}

export function assertWorkflowShape(value: unknown): asserts value is PersistedWorkflowSchema {
  if (!isRecord(value)) throw new Error('workflow.json 必须是对象。')
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`不支持 schemaVersion：${String(value.schemaVersion)}`)
  if ('rules' in value) throw new Error(`${SCHEMA_VERSION} workflow.json 不接受顶层 rules。`)
  if (value.sourceSchemaVersion !== undefined) assertString(value.sourceSchemaVersion, 'sourceSchemaVersion')
  if (value.readOnlyReason !== undefined) assertString(value.readOnlyReason, 'readOnlyReason')
  assertString(value.workflowId, 'workflowId')
  assertString(value.name, 'name')
  assertString(value.description, 'description')
  assertString(value.createdAt, 'createdAt')
  assertString(value.updatedAt, 'updatedAt')
  assertOneOf(value.maintenanceFormat, maintenanceFormats, 'maintenanceFormat')
  if (value.secondaryFormat !== undefined) assertOneOf(value.secondaryFormat, maintenanceFormats, 'secondaryFormat')
  assertOneOf(value.mode, ['template', 'legacy-content'] as const, 'mode')
  assertRecordArray(value.documents, 'documents')
  for (const document of value.documents) assertDocument(document, 'document', contentRoles)
  if (!isRecord(value.protocolState)) throw new Error('protocolState 结构无效。')
  if (!isRecord(value.protocolState.system)) throw new Error('protocolState.system 结构无效。')
  assertOneOf(value.protocolState.system.status, ['empty', 'ready'] as const, 'protocolState.system.status')
  if (value.protocolState.system.generatorVersion !== '1') throw new Error('protocolState.system.generatorVersion 无效。')
  if (value.protocolState.system.status === 'ready') {
    assertString(value.protocolState.system.sourceHash, 'protocolState.system.sourceHash')
    if (!isRecord(value.protocolState.system.bundle)) throw new Error('protocolState.system.bundle 结构无效。')
    if (!isRecord(value.protocolState.system.bundle.document)) throw new Error('protocolState.system.bundle.document 结构无效。')
    assertDocument(value.protocolState.system.bundle.document, 'protocolState.system.bundle.document', protocolRoles)
    assertRules(value.protocolState.system.bundle.rules, 'protocolState.system.bundle.rules')
  }
  if (!isRecord(value.protocolState.orderingPreferences)) throw new Error('protocolState.orderingPreferences 结构无效。')
  assertRecordArray(value.protocolState.orderingPreferences.readOrder, 'protocolState.orderingPreferences.readOrder')
  assertRecordArray(value.protocolState.orderingPreferences.sourcePriority, 'protocolState.orderingPreferences.sourcePriority')
  const readItemIds: string[] = []
  for (const item of value.protocolState.orderingPreferences.readOrder) {
    assertString(item.itemId, 'protocolState.orderingPreferences.readOrder.itemId')
    assertBoolean(item.enabled, 'protocolState.orderingPreferences.readOrder.enabled')
    assertBoolean(item.required, 'protocolState.orderingPreferences.readOrder.required')
    assertNumber(item.order, 'protocolState.orderingPreferences.readOrder.order')
    if (item.itemId !== 'protocol:system' && !item.itemId.startsWith('document:')) throw new Error('protocolState.orderingPreferences.readOrder.itemId 无效。')
    readItemIds.push(item.itemId)
  }
  const sourceKeys: string[] = []
  for (const item of value.protocolState.orderingPreferences.sourcePriority) {
    assertString(item.sourceKey, 'protocolState.orderingPreferences.sourcePriority.sourceKey')
    assertBoolean(item.enabled, 'protocolState.orderingPreferences.sourcePriority.enabled')
    assertNumber(item.order, 'protocolState.orderingPreferences.sourcePriority.order')
    if (!item.sourceKey.startsWith('builtin:') && !item.sourceKey.startsWith('document:')) throw new Error('protocolState.orderingPreferences.sourcePriority.sourceKey 无效。')
    sourceKeys.push(item.sourceKey)
  }
  const documentKeys = (value.documents as UnknownRecord[]).map((document) => `document:${String(document.id)}`)
  const expectedReadKeys = new Set(['protocol:system', ...documentKeys])
  const expectedSourceKeys = new Set(['builtin:latest-user-instruction', 'builtin:workspace-fact', ...documentKeys])
  if (readItemIds.length !== expectedReadKeys.size || readItemIds.some((itemId) => !expectedReadKeys.has(itemId))) {
    throw new Error('protocolState.orderingPreferences.readOrder 必须完整对应当前文档。')
  }
  if (sourceKeys.length !== expectedSourceKeys.size || sourceKeys.some((sourceKey) => !expectedSourceKeys.has(sourceKey))) {
    throw new Error('protocolState.orderingPreferences.sourcePriority 必须完整对应当前来源。')
  }
  const readOrders = value.protocolState.orderingPreferences.readOrder.map((item) => Number(item.order)).sort((left, right) => left - right)
  const sourceOrders = value.protocolState.orderingPreferences.sourcePriority.map((item) => Number(item.order)).sort((left, right) => left - right)
  if (readOrders.some((order, index) => order !== index + 1) || sourceOrders.some((order, index) => order !== index + 1)) {
    throw new Error('protocolState.orderingPreferences 的 order 必须从 1 连续递增。')
  }
  if (new Set(readItemIds).size !== readItemIds.length || new Set(sourceKeys).size !== sourceKeys.length) {
    throw new Error('protocolState.orderingPreferences 中存在重复项。')
  }
  assertRecordArray(value.protocolState.supplements, 'protocolState.supplements')
  for (const supplement of value.protocolState.supplements) {
    assertString(supplement.id, 'protocolState.supplement.id')
    assertString(supplement.title, 'protocolState.supplement.title')
    assertString(supplement.instruction, 'protocolState.supplement.instruction')
    assertOneOf(supplement.displayFormat, newDisplayFormats, 'protocolState.supplement.displayFormat')
  }
  if (value.protocolState.legacyManualOverride !== undefined) {
    if (!isRecord(value.protocolState.legacyManualOverride)) throw new Error('protocolState.legacyManualOverride 结构无效。')
    assertRecordArray(value.protocolState.legacyManualOverride.documents, 'protocolState.legacyManualOverride.documents')
    for (const document of value.protocolState.legacyManualOverride.documents) assertDocument(document, 'protocolState.legacyManualOverride.document', protocolRoles)
    assertRules(value.protocolState.legacyManualOverride.rules, 'protocolState.legacyManualOverride.rules')
    if (value.protocolState.legacyManualOverride.selectedDocumentId !== undefined) assertString(value.protocolState.legacyManualOverride.selectedDocumentId, 'protocolState.legacyManualOverride.selectedDocumentId')
  }
  if (!isRecord(value.exportSettings) || value.exportSettings.includeWorkflowJson !== true || value.exportSettings.includeReadme !== true) throw new Error('exportSettings 结构无效。')
  assertOneOf(value.exportSettings.htmlMode, ['single-file-static'] as const, 'exportSettings.htmlMode')
  assertOneOf(value.exportSettings.markdownMetadataMode, ['visible'] as const, 'exportSettings.markdownMetadataMode')
  assertOneOf(value.exportSettings.fileNaming, ['document-filename'] as const, 'exportSettings.fileNaming')
  assertString(value.exportSettings.packageNamePattern, 'exportSettings.packageNamePattern')
  if (!isRecord(value.scoringSettings) || !isRecord(value.scoringSettings.weights) || !isRecord(value.scoringSettings.thresholds)) throw new Error('scoringSettings 结构无效。')
  for (const key of ['recoveryStrength', 'maintenanceCost', 'redundancyRisk', 'beginnerFriendliness', 'auditability']) assertNumber(value.scoringSettings.weights[key], `scoringSettings.weights.${key}`)
  for (const key of ['good', 'caution', 'poor']) assertNumber(value.scoringSettings.thresholds[key], `scoringSettings.thresholds.${key}`)
  assertRecordArray(value.acceptedWarnings, 'acceptedWarnings')
  for (const warning of value.acceptedWarnings) {
    assertString(warning.issueId, 'acceptedWarning.issueId')
    assertString(warning.ruleId, 'acceptedWarning.ruleId')
    if (!isRecord(warning.target)) throw new Error('acceptedWarning.target 结构无效。')
    assertString(warning.acceptedAt, 'acceptedWarning.acceptedAt')
    assertString(warning.schemaHash, 'acceptedWarning.schemaHash')
  }
  assertUniqueIds(value)
}

export function compareSchemaVersion(left: string, right: string): number {
  const parse = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
