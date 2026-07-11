export const SCHEMA_VERSION = '1.1.0'
export const LEGACY_SCHEMA_VERSION = '1.0.0'

export type MaintenanceFormat = 'html' | 'markdown'

export type DisplayFormatId =
  | 'paragraph'
  | 'bullet-list'
  | 'checklist'
  | 'steps'
  | 'key-value'
  | 'decision-table'
  | 'timeline'
  | 'code'
  | 'path-list'

export type InformationLifecycle =
  | 'realtime'
  | 'stable'
  | 'historical'
  | 'preference'
  | 'reference'
  | 'validation'
  | 'mixed'

export type DocumentRole =
  | 'protocol'
  | 'plan'
  | 'status'
  | 'preference'
  | 'history'
  | 'context'
  | 'validation'
  | 'custom'

export type WorkflowMode = 'template' | 'legacy-content'

export type FieldType =
  | 'shortText'
  | 'longText'
  | 'richText'
  | 'select'
  | 'multiSelect'
  | 'boolean'
  | 'date'
  | 'path'
  | 'url'
  | 'email'
  | 'code'
  | 'list'
  | 'table'
  | 'reference'

export type FieldValue =
  | { kind: 'empty' }
  | { kind: 'scalar'; value: string | number | boolean }
  | { kind: 'list'; value: FieldValue[] }
  | { kind: 'table'; columns: string[]; rows: Record<string, string>[] }
  | { kind: 'reference'; targetId: string }

export type FieldOption = {
  value: string
  label: string
  description?: string
}

export type ValidationRule = {
  id: string
  description: string
  severity: ValidationSeverity
  predicate: 'non-empty' | 'valid-path' | 'valid-url' | 'valid-email' | 'matches-pattern' | 'custom'
}

export type FieldValidation = {
  minLength?: number
  maxLength?: number
  pattern?: string
  allowedValues?: string[]
  customRules: ValidationRule[]
}

export type WorkflowField = {
  id: string
  label: string
  type: FieldType
  guidance: string
  lifecycle: InformationLifecycle
  required: boolean
  allowEmpty: boolean
  defaultValue?: unknown
  value: FieldValue
  options?: FieldOption[]
  repeatable: boolean
  validation: FieldValidation
  displayFormat?: DisplayFormatId
}

export type WorkflowSection = {
  id: string
  title: string
  purpose: string
  lifecycle: InformationLifecycle
  order: number
  repeatable: boolean
  fields: WorkflowField[]
}

export type ReadPolicy = {
  whenToRead: string[]
  readOrderHint?: number
  skipWhen?: string[]
  dependsOnDocumentIds: string[]
}

export type UpdatePolicy = {
  updateTriggers: string[]
  replacementMode: 'replace-current' | 'append-history' | 'append-entry' | 'manual'
  staleInfoHandling: 'remove' | 'archive' | 'mark-obsolete' | 'keep-with-warning'
  ownerHint?: string
}

export type WorkflowDocument = {
  id: string
  filename: string
  title: string
  role: DocumentRole
  lifecycle: InformationLifecycle
  description: string
  readPolicy: ReadPolicy
  updatePolicy: UpdatePolicy
  order: number
  required: boolean
  sections: WorkflowSection[]
}

export type RecoveryStep = {
  id: string
  documentId: string
  condition: string
  required: boolean
  fallbackStepIds: string[]
}

export type SourceRef = {
  sourceType:
    | 'latest-user-instruction'
    | 'workspace-fact'
    | 'current-status'
    | 'stable-plan'
    | 'user-preference'
    | 'session-history'
    | 'memory-history'
    | 'context-reference'
    | 'older-history'
  label: string
  documentId?: string
  priority: number
  recencyPolicy: 'prefer-newer' | 'ignore-recency' | 'manual'
}

export type SourcePriorityRule = {
  id: string
  scope: 'global' | 'document' | 'section' | 'field'
  targetId?: string
  orderedSources: SourceRef[]
  tieBreaker: 'newer' | 'explicit-user-confirmation' | 'manual-review'
  reason: string
}

export type UpdateTriggerRule = {
  id: string
  targetDocumentId: string
  trigger: string
  requiredAction: string
}

export type CompletionCheck = {
  id: string
  label: string
  description: string
  severityWhenMissing: 'error' | 'warning'
  relatedDocumentIds: string[]
}

export type ConflictPolicy = {
  defaultAction: 'apply-source-priority' | 'ask-user' | 'block-until-resolved'
  requireExplicitNoteForManualOverride: boolean
  unresolvedConflictSeverity: 'error' | 'warning'
}

export const HISTORY_STATUSES = ['仍有效参考', '已失效归档', 'active-reference', 'obsolete-archive'] as const
export type HistoryStatus = typeof HISTORY_STATUSES[number]

export type HistoryPolicy = {
  appendOnly: boolean
  allowedStatuses: HistoryStatus[]
  requireIndexUpdate: boolean
  obsoleteHandling: 'mark-obsolete' | 'archive-with-replacement' | 'delete'
}

export type WorkflowRules = {
  recoveryOrder: RecoveryStep[]
  sourcePriority: SourcePriorityRule[]
  updateTriggers: UpdateTriggerRule[]
  completionChecks: CompletionCheck[]
  conflictPolicy: ConflictPolicy
  historyPolicy: HistoryPolicy
}

export type ContentDocument = Omit<WorkflowDocument, 'role'> & {
  role: Exclude<DocumentRole, 'protocol'>
}

export type ProtocolDocument = Omit<WorkflowDocument, 'role'> & {
  role: 'protocol'
}

export type ProtocolBundle = {
  document: ProtocolDocument
  rules: WorkflowRules
}

export type ProtocolSystemState =
  | { status: 'empty'; generatorVersion: '1' }
  | { status: 'ready'; generatorVersion: '1'; sourceHash: string; bundle: ProtocolBundle }

export type ProtocolSupplement = {
  id: string
  title: string
  instruction: string
  displayFormat: Extract<DisplayFormatId, 'paragraph' | 'bullet-list' | 'steps'>
}

export type LegacyProtocolOverride = {
  documents: ProtocolDocument[]
  rules: WorkflowRules
  selectedDocumentId?: string
}

export type ProtocolState = {
  system: ProtocolSystemState
  supplements: ProtocolSupplement[]
  legacyManualOverride?: LegacyProtocolOverride
}

export type ProtocolDiagnostic = {
  id: string
  severity: 'error' | 'warning'
  title: string
  message: string
}

export type ProtocolProjection = {
  generated: ProtocolBundle | null
  effective: ProtocolBundle | null
  freshness: 'empty' | 'current' | 'stale'
  owner: {
    document: 'none' | 'system' | 'legacy-manual'
    rules: 'none' | 'system' | 'legacy-manual'
  }
  diagnostics: ProtocolDiagnostic[]
}

export type ExportSettings = {
  packageNamePattern: string
  includeWorkflowJson: true
  includeReadme: true
  htmlMode: 'single-file-static'
  markdownMetadataMode: 'visible'
  fileNaming: 'document-filename'
}

export type ScoringSettings = {
  weights: {
    recoveryStrength: number
    maintenanceCost: number
    redundancyRisk: number
    beginnerFriendliness: number
    auditability: number
  }
  thresholds: {
    good: number
    caution: number
    poor: number
  }
}

export type ValidationTarget = {
  documentId?: string
  sectionId?: string
  fieldId?: string
  ruleId?: string
}

export type AcceptedWarning = {
  issueId: string
  ruleId: string
  target: ValidationTarget
  acceptedAt: string
  schemaHash: string
  reason?: string
}

export type WorkflowSchema = {
  schemaVersion: string
  sourceSchemaVersion?: string
  readOnlyReason?: string
  workflowId: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  maintenanceFormat: MaintenanceFormat
  secondaryFormat?: MaintenanceFormat
  mode: WorkflowMode
  documents: WorkflowDocument[]
  protocolState: ProtocolState
  /**
   * Runtime compatibility view. It is derived from protocolState and never
   * written into a 1.1 workflow.json.
   */
  rules: WorkflowRules
  protocolProjection?: ProtocolProjection
  exportSettings: ExportSettings
  scoringSettings: ScoringSettings
  acceptedWarnings: AcceptedWarning[]
}

/** The JSON/IndexedDB shape. It deliberately has no top-level rules. */
export type PersistedWorkflowSchema = Omit<
  WorkflowSchema,
  'documents' | 'rules' | 'protocolProjection'
> & {
  schemaVersion: typeof SCHEMA_VERSION
  documents: ContentDocument[]
}

export type ValidationSeverity = 'error' | 'warning' | 'suggestion' | 'pass'

export type ValidationIssue = {
  id: string
  severity: ValidationSeverity
  title: string
  message: string
  target: ValidationTarget
  ruleId: string
  canAccept?: boolean
  accepted?: boolean
}

export type SimulationScenario =
  | 'new-session'
  | 'context-compaction'
  | 'goal-conflict'
  | 'missing-preference'
  | 'unclear-term'
  | 'stale-status'
  | 'insufficient-history'
  | 'unclear-work-entry'
  | 'handoff-after-failure'

export type SimulationStep = {
  order: number
  action: string
  documentId?: string
  reason: string
  outcome: 'read' | 'skip' | 'conflict' | 'blocked' | 'complete'
}

export type SimulatedConflict = {
  id: string
  description: string
  competingSources: SourceRef[]
  selectedSource?: SourceRef
  resolution: 'resolved' | 'manual-review-required' | 'blocked'
  reason: string
}

export type SimulationResult = {
  scenario: SimulationScenario
  status: 'pass' | 'blocked' | 'risky'
  steps: SimulationStep[]
  readDocuments: string[]
  conflicts: SimulatedConflict[]
  nextAtomicStep?: string
  blockers: string[]
}

export const DEFAULT_SCORING_SETTINGS: ScoringSettings = {
  weights: {
    recoveryStrength: 0.3,
    maintenanceCost: 0.2,
    redundancyRisk: 0.2,
    beginnerFriendliness: 0.15,
    auditability: 0.15,
  },
  thresholds: {
    good: 80,
    caution: 60,
    poor: 0,
  },
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  packageNamePattern: '{name}-workflow',
  includeWorkflowJson: true,
  includeReadme: true,
  htmlMode: 'single-file-static',
  markdownMetadataMode: 'visible',
  fileNaming: 'document-filename',
}

export function emptyValue(): FieldValue {
  return { kind: 'empty' }
}

export function scalarValue(value: string | number | boolean): FieldValue {
  return { kind: 'scalar', value }
}

export function fieldValueToText(value: FieldValue): string {
  if (value.kind === 'empty') return ''
  if (value.kind === 'scalar') return String(value.value)
  if (value.kind === 'reference') return value.targetId
  if (value.kind === 'list') return value.value.map(fieldValueToText).filter(Boolean).join('\n')
  return value.rows.map((row) => value.columns.map((column) => row[column] ?? '').join(' | ')).join('\n')
}

export function isFieldEmpty(field: WorkflowField): boolean {
  return field.value.kind === 'empty' || fieldValueToText(field.value).trim().length === 0
}

export function createField(input: {
  id: string
  label: string
  type?: FieldType
  guidance: string
  lifecycle: InformationLifecycle
  required?: boolean
  allowEmpty?: boolean
  value?: FieldValue
  displayFormat?: DisplayFormatId
}): WorkflowField {
  return {
    id: input.id,
    label: input.label,
    type: input.type ?? 'longText',
    guidance: input.guidance,
    lifecycle: input.lifecycle,
    required: input.required ?? false,
    allowEmpty: input.allowEmpty ?? !(input.required ?? false),
    value: input.value ?? emptyValue(),
    repeatable: false,
    validation: { customRules: [] },
    displayFormat: input.displayFormat,
  }
}

export function normalizeSourcePriority(rule: SourcePriorityRule): SourcePriorityRule {
  return {
    ...rule,
    orderedSources: rule.orderedSources.map((source, index) => ({
      ...source,
      priority: index + 1,
    })),
  }
}

export function normalizeWorkflowSourcePriorities(workflow: WorkflowSchema): WorkflowSchema {
  return {
    ...workflow,
    rules: {
      ...workflow.rules,
      sourcePriority: workflow.rules.sourcePriority.map(normalizeSourcePriority),
    },
  }
}

export function contentDocuments(workflow: Pick<WorkflowSchema, 'documents'>): ContentDocument[] {
  return workflow.documents.filter((document): document is ContentDocument => document.role !== 'protocol')
}

export function emptyProtocolState(): ProtocolState {
  return {
    system: { status: 'empty', generatorVersion: '1' },
    supplements: [],
  }
}

export function cloneWorkflowRules(rules: WorkflowRules): WorkflowRules {
  return structuredClone(rules)
}
