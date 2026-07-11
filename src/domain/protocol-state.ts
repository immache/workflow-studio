import {
  cloneWorkflowRules,
  contentDocuments,
  createField,
  emptyProtocolState,
  scalarValue,
  type ContentDocument,
  type ProtocolBundle,
  type ProtocolDiagnostic,
  type ProtocolProjection,
  type ProtocolState,
  type WorkflowRules,
  type WorkflowSchema,
} from './schema'

const PROTOCOL_GENERATOR_VERSION = '1' as const

function ordered<T extends { id: string; order: number }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A browser-safe synchronous SHA-256 implementation for stale detection. */
export function sha256Hex(input: string): string {
  const bytes = Array.from(new TextEncoder().encode(input))
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while ((bytes.length % 64) !== 56) bytes.push(0)
  const high = Math.floor(bitLength / 0x1_0000_0000)
  const low = bitLength >>> 0
  for (const value of [high, low]) {
    bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
  }

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64)
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4
      words[index] = ((bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]
      const right = words[index - 2]
      const small0 = ((left >>> 7) | (left << 25)) ^ ((left >>> 18) | (left << 14)) ^ (left >>> 3)
      const small1 = ((right >>> 17) | (right << 15)) ^ ((right >>> 19) | (right << 13)) ^ (right >>> 10)
      words[index] = (((words[index - 16] + small0) >>> 0) + ((words[index - 7] + small1) >>> 0)) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let index = 0; index < 64; index += 1) {
      const large1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const choose = (e & f) ^ (~e & g)
      const temp1 = (((((h + large1) >>> 0) + choose) >>> 0) + ((constants[index] + words[index]) >>> 0)) >>> 0
      const large0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (large0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((value) => value.toString(16).padStart(8, '0')).join('')
}

export function canonicalProtocolSource(workflow: Pick<WorkflowSchema, 'name' | 'description' | 'documents'>): string {
  const documents = ordered(contentDocuments(workflow)).map((document) => ({
    id: document.id,
    filename: document.filename,
    title: document.title,
    role: document.role,
    description: document.description,
    sections: ordered(document.sections).map((section) => ({
      id: section.id,
      title: section.title,
      purpose: section.purpose,
      fields: section.fields.map((field) => ({
        id: field.id,
        label: field.label,
        guidance: field.guidance,
        displayFormat: field.displayFormat ?? 'paragraph',
      })),
    })),
  }))
  return stableJson({
    generatorVersion: PROTOCOL_GENERATOR_VERSION,
    name: workflow.name,
    description: workflow.description,
    documents,
  })
}

export function protocolSourceHash(workflow: Pick<WorkflowSchema, 'name' | 'description' | 'documents'>): string {
  return sha256Hex(canonicalProtocolSource(workflow))
}

function defaultRules(documents: readonly ContentDocument[], protocolId: string): WorkflowRules {
  const orderedDocuments = ordered(documents)
  const priority: WorkflowRules['sourcePriority'][number]['orderedSources'] = [
    { sourceType: 'latest-user-instruction' as const, label: '最新明确用户指令', priority: 0, recencyPolicy: 'prefer-newer' as const },
    { sourceType: 'workspace-fact' as const, label: '新鲜工作区事实和工具输出', priority: 0, recencyPolicy: 'prefer-newer' as const },
  ]
  for (const document of orderedDocuments) {
    const sourceType = document.role === 'status' ? 'current-status'
      : document.role === 'plan' ? 'stable-plan'
        : document.role === 'preference' ? 'user-preference'
          : document.role === 'history' ? 'memory-history'
            : document.role === 'context' ? 'context-reference'
              : null
    if (!sourceType) continue
    priority.push({
      sourceType,
      label: document.filename,
      documentId: document.id,
      priority: 0,
      recencyPolicy: document.role === 'status' ? 'prefer-newer' : 'ignore-recency',
    })
  }
  return {
    recoveryOrder: [
      { id: `recovery-${protocolId}`, documentId: protocolId, condition: '恢复时先读取入口协议。', required: true, fallbackStepIds: [] },
      ...orderedDocuments.map((document, index) => ({
        id: `recovery-${document.id}`,
        documentId: document.id,
        condition: index === 0 ? '入口协议后读取这份内容文档。' : '需要这份文档职责内的信息时读取。',
        required: document.role === 'status' || document.role === 'plan' || (index === 0 && !orderedDocuments.some((item) => item.role === 'status' || item.role === 'plan')),
        fallbackStepIds: [],
      })),
    ],
    sourcePriority: [{
      id: 'global-source-priority',
      scope: 'global',
      orderedSources: priority.map((source, index) => ({ ...source, priority: index + 1 })),
      tieBreaker: 'explicit-user-confirmation',
      reason: '先按最新明确用户指令和新鲜工作区事实裁决，再按文档职责使用恢复资料。',
    }],
    updateTriggers: orderedDocuments.map((document) => ({
      id: `trigger-${document.id}`,
      targetDocumentId: document.id,
      trigger: `${document.title}职责范围内的信息变化`,
      requiredAction: document.lifecycle === 'historical' ? '追加历史条目或标记归档。' : '替换失效信息并保留当前有效内容。',
    })),
    completionChecks: [{
      id: 'completion-verify',
      label: '验证交付结果',
      description: '交付前运行适合本项目的检查，并更新负责当前事实的文档。',
      severityWhenMissing: 'warning',
      relatedDocumentIds: orderedDocuments.map((document) => document.id),
    }],
    conflictPolicy: {
      defaultAction: 'apply-source-priority',
      requireExplicitNoteForManualOverride: true,
      unresolvedConflictSeverity: 'error',
    },
    historyPolicy: {
      appendOnly: true,
      allowedStatuses: ['仍有效参考', '已失效归档'],
      requireIndexUpdate: true,
      obsoleteHandling: 'archive-with-replacement',
    },
  }
}

function documentList(documents: readonly ContentDocument[]): string {
  return ordered(documents).map((document, index) => `${index + 1}. ${document.filename}：${document.description}`).join('\n')
}

function readOrder(rules: WorkflowRules, documents: readonly ContentDocument[]): string {
  const byId = new Map(documents.map((document) => [document.id, document.filename]))
  return rules.recoveryOrder.map((step, index) => {
    const filename = step.documentId === 'protocol-system' ? 'AGENTS.md' : byId.get(step.documentId) ?? step.documentId
    return `${index + 1}. ${filename}：${step.condition}`
  }).join('\n')
}

function sourcePriority(rules: WorkflowRules): string {
  return rules.sourcePriority.find((rule) => rule.scope === 'global')?.orderedSources
    .map((source, index) => `${index + 1}. ${source.label}`).join('\n') ?? ''
}

function updateRules(rules: WorkflowRules, documents: readonly ContentDocument[]): string {
  const byId = new Map(documents.map((document) => [document.id, document.filename]))
  return rules.updateTriggers.map((rule) => `${byId.get(rule.targetDocumentId) ?? rule.targetDocumentId}：${rule.requiredAction}`).join('\n')
}

function completionChecks(rules: WorkflowRules): string {
  return rules.completionChecks.map((check, index) => `${index + 1}. ${check.label}：${check.description}`).join('\n')
}

export function canGenerateSystemProtocol(workflow: Pick<WorkflowSchema, 'documents'>): boolean {
  const documents = contentDocuments(workflow)
  return documents.length > 0 && documents.every((document) => document.sections.some((section) => section.fields.length > 0))
}

export function createSystemProtocolBundle(workflow: Pick<WorkflowSchema, 'documents'>): ProtocolBundle {
  const documents = ordered(contentDocuments(workflow))
  const protocolId = 'protocol-system'
  const rules = defaultRules(documents, protocolId)
  return {
    document: {
      id: protocolId,
      filename: 'AGENTS.md',
      title: '入口协议',
      role: 'protocol',
      lifecycle: 'validation',
      description: '由已确认的内容文档、章节和信息项生成的恢复入口协议。',
      readPolicy: { whenToRead: ['恢复、交接或不确定下一步时先读取。'], dependsOnDocumentIds: [], readOrderHint: 1 },
      updatePolicy: { updateTriggers: ['内容文档结构变化后重新生成。'], replacementMode: 'replace-current', staleInfoHandling: 'remove' },
      order: 1,
      required: true,
      sections: [
        {
          id: 'protocol-document-list', title: '文档清单', purpose: '说明每份内容文档保存什么。', lifecycle: 'validation', order: 1, repeatable: false,
          fields: [createField({ id: 'protocol-document-list-value', label: '包含的文档', guidance: '由文档名称和职责自动生成。', lifecycle: 'validation', value: scalarValue(documentList(documents)), displayFormat: 'bullet-list' })],
        },
        {
          id: 'protocol-read-order', title: '读取顺序', purpose: '说明模型始终该读什么、信什么、接着做什么。', lifecycle: 'validation', order: 2, repeatable: false,
          fields: [createField({ id: 'protocol-read-order-value', label: '恢复时怎么读', guidance: '由文档职责和当前顺序自动生成。', lifecycle: 'validation', value: scalarValue(readOrder(rules, documents)), displayFormat: 'steps' })],
        },
        {
          id: 'protocol-source-priority', title: '来源优先级', purpose: '说明信息冲突时采用的默认裁决顺序。', lifecycle: 'validation', order: 3, repeatable: false,
          fields: [createField({ id: 'protocol-source-priority-value', label: '冲突时先信什么', guidance: '由已选文档的职责自动生成。', lifecycle: 'validation', value: scalarValue(sourcePriority(rules)), displayFormat: 'bullet-list' })],
        },
        {
          id: 'protocol-update-rules', title: '维护规则', purpose: '说明职责范围内的信息变化后应如何维护。', lifecycle: 'validation', order: 4, repeatable: false,
          fields: [createField({ id: 'protocol-update-rules-value', label: '何时更新', guidance: '由内容文档的职责自动生成。', lifecycle: 'validation', value: scalarValue(updateRules(rules, documents)), displayFormat: 'bullet-list' })],
        },
        {
          id: 'protocol-completion', title: '完成检查', purpose: '说明交付前需要完成的最小核对。', lifecycle: 'validation', order: 5, repeatable: false,
          fields: [createField({ id: 'protocol-completion-value', label: '交付前核对', guidance: '由系统生成的完成检查组成。', lifecycle: 'validation', value: scalarValue(completionChecks(rules)), displayFormat: 'bullet-list' })],
        },
      ],
    },
    rules,
  }
}

export function createSystemProtocolState(workflow: Pick<WorkflowSchema, 'name' | 'description' | 'documents'>): ProtocolState {
  if (!canGenerateSystemProtocol(workflow)) return emptyProtocolState()
  return {
    system: {
      status: 'ready',
      generatorVersion: PROTOCOL_GENERATOR_VERSION,
      sourceHash: protocolSourceHash(workflow),
      bundle: createSystemProtocolBundle(workflow),
    },
    supplements: [],
  }
}

function base64Url(value: string): string {
  const binary = Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join('')
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function normalizeRulesForProjection(rules: WorkflowRules): WorkflowRules {
  const cloned = cloneWorkflowRules(rules)
  cloned.sourcePriority = cloned.sourcePriority.map((rule) => ({
    ...rule,
    orderedSources: rule.orderedSources.map((source, index) => ({ ...source, priority: index + 1 })),
  }))
  return cloned
}

function appendSupplements(bundle: ProtocolBundle, state: ProtocolState, diagnostics: ProtocolDiagnostic[]): ProtocolBundle | null {
  if (state.supplements.length === 0) return bundle
  const document = structuredClone(bundle.document)
  const seen = new Set<string>([
    ...document.sections.map((section) => section.id),
    ...document.sections.flatMap((section) => section.fields.map((field) => field.id)),
  ])
  const supplementIds = new Set<string>()
  for (const supplement of state.supplements) {
    const sectionId = `supplement/${base64Url(supplement.id)}`
    if (!supplement.id.trim() || supplementIds.has(supplement.id) || seen.has(sectionId) || seen.has(`${sectionId}/content`)) {
      diagnostics.push({
        id: `protocol-supplement-collision-${supplement.id || 'empty'}`,
        severity: 'error',
        title: '补充说明无法安全加入入口协议',
        message: '补充说明的标识为空、重复，或与协议中的既有标识冲突。请先修复兼容数据。',
      })
      return null
    }
    supplementIds.add(supplement.id)
    seen.add(sectionId)
    seen.add(`${sectionId}/content`)
    document.sections.push({
      id: sectionId,
      title: supplement.title.trim() || '补充说明',
      purpose: '用户明确追加到入口协议的静态说明。',
      lifecycle: 'validation',
      order: document.sections.length + 1,
      repeatable: false,
      fields: [createField({
        id: `${sectionId}/content`,
        label: supplement.title.trim() || '补充说明',
        guidance: '这是用户明确添加的协议补充，不会改写系统生成的结构规则。',
        lifecycle: 'validation',
        value: scalarValue(supplement.instruction),
        displayFormat: supplement.displayFormat,
      })],
    })
  }
  return { document, rules: normalizeRulesForProjection(bundle.rules) }
}

function legacyBundle(state: ProtocolState, diagnostics: ProtocolDiagnostic[]): ProtocolBundle | null {
  const legacy = state.legacyManualOverride
  if (!legacy) return null
  if (legacy.documents.length === 0) {
    diagnostics.push({
      id: 'legacy-protocol-missing-document',
      severity: 'error',
      title: '旧版入口协议缺少可用文档',
      message: '导入的旧版规则没有对应的入口协议文档，不能自动选择导出内容。',
    })
    return null
  }
  if (legacy.documents.length === 1) {
    return { document: structuredClone(legacy.documents[0]), rules: cloneWorkflowRules(legacy.rules) }
  }
  const selected = legacy.documents.find((document) => document.id === legacy.selectedDocumentId)
  if (!selected) {
    diagnostics.push({
      id: 'legacy-protocol-selection-required',
      severity: 'error',
      title: '需要选择当前入口协议',
      message: '导入文件含有多份旧版入口协议，系统不会静默选择其中一份。请在兼容修复中选择当前版本。',
    })
    return null
  }
  return { document: structuredClone(selected), rules: cloneWorkflowRules(legacy.rules) }
}

export function buildProtocolProjection(workflow: Pick<WorkflowSchema, 'name' | 'description' | 'documents' | 'protocolState'>): ProtocolProjection {
  const diagnostics: ProtocolDiagnostic[] = []
  const sourceHash = protocolSourceHash(workflow)
  const system = workflow.protocolState.system
  const generated = system.status === 'ready' && system.sourceHash === sourceHash
    ? { document: structuredClone(system.bundle.document), rules: cloneWorkflowRules(system.bundle.rules) }
    : null
  const freshness = system.status === 'empty' ? 'empty' : generated ? 'current' : 'stale'
  const manual = legacyBundle(workflow.protocolState, diagnostics)

  if (freshness === 'stale') {
    diagnostics.push({
      id: 'protocol-system-stale',
      severity: manual ? 'warning' : 'error',
      title: '系统入口协议需要刷新',
      message: manual
        ? '内容文档结构已变化，但当前仍可使用已选择的旧版人工协议。'
        : '内容文档结构已变化，必须重新生成入口协议后才能继续确认、演练或导出。',
    })
  }

  let base: ProtocolBundle | null = manual ?? generated
  let documentOwner: ProtocolProjection['owner']['document'] = manual ? 'legacy-manual' : generated ? 'system' : 'none'
  let rulesOwner: ProtocolProjection['owner']['rules'] = manual ? 'legacy-manual' : generated ? 'system' : 'none'
  if (!base && freshness === 'empty' && contentDocuments(workflow).length > 0) {
    diagnostics.push({
      id: 'protocol-system-not-generated',
      severity: 'error',
      title: '入口协议尚未生成',
      message: '至少确认一份包含信息项的内容文档后，生成入口协议草案。',
    })
  }

  if (base) {
    base = appendSupplements(base, workflow.protocolState, diagnostics)
    if (!base) {
      documentOwner = 'none'
      rulesOwner = 'none'
    }
  }

  return {
    generated,
    effective: base ? { document: base.document, rules: normalizeRulesForProjection(base.rules) } : null,
    freshness,
    owner: { document: documentOwner, rules: rulesOwner },
    diagnostics,
  }
}

function fallbackRules(): WorkflowRules {
  return {
    recoveryOrder: [],
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
      allowedStatuses: ['仍有效参考', '已失效归档'],
      requireIndexUpdate: false,
      obsoleteHandling: 'mark-obsolete',
    },
  }
}

/**
 * Produces the in-memory view used by the existing application. The protocol
 * document and rules are virtual projections and are stripped before save.
 */
export function normalizeWorkflowForRuntime(workflow: Omit<WorkflowSchema, 'rules' | 'protocolProjection'> & Partial<Pick<WorkflowSchema, 'rules' | 'protocolProjection'>>): WorkflowSchema {
  const inputRules = workflow.rules
  const cloned = structuredClone(workflow) as Omit<WorkflowSchema, 'rules' | 'protocolProjection'>
  const projection = buildProtocolProjection(cloned)
  const docs = contentDocuments(cloned)
  const fallback = inputRules
    ?? (cloned.protocolState.system.status === 'ready' ? cloneWorkflowRules(cloned.protocolState.system.bundle.rules) : fallbackRules())
  return {
    ...cloned,
    documents: projection.effective
      ? [{ ...projection.effective.document, order: 0 }, ...ordered(docs)]
      : ordered(docs),
    rules: projection.effective?.rules ?? fallback,
    protocolProjection: projection,
  }
}

export function withRegeneratedSystemProtocol(workflow: WorkflowSchema): WorkflowSchema {
  const persisted = toPersistedWorkflow(workflow)
  persisted.protocolState = {
    ...persisted.protocolState,
    system: canGenerateSystemProtocol(persisted)
      ? {
        status: 'ready',
        generatorVersion: PROTOCOL_GENERATOR_VERSION,
        sourceHash: protocolSourceHash(persisted),
        bundle: createSystemProtocolBundle(persisted),
      }
      : { status: 'empty', generatorVersion: PROTOCOL_GENERATOR_VERSION },
  }
  return normalizeWorkflowForRuntime(persisted)
}

export function toPersistedWorkflow(workflow: WorkflowSchema): import('./schema').PersistedWorkflowSchema {
  const clonedState = structuredClone(workflow.protocolState)
  return {
    schemaVersion: '1.1.0',
    sourceSchemaVersion: workflow.sourceSchemaVersion,
    readOnlyReason: workflow.readOnlyReason,
    workflowId: workflow.workflowId,
    name: workflow.name,
    description: workflow.description,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    maintenanceFormat: workflow.maintenanceFormat,
    secondaryFormat: workflow.secondaryFormat,
    mode: workflow.mode,
    documents: structuredClone(contentDocuments(workflow)),
    protocolState: clonedState,
    exportSettings: structuredClone(workflow.exportSettings),
    scoringSettings: structuredClone(workflow.scoringSettings),
    acceptedWarnings: structuredClone(workflow.acceptedWarnings),
  }
}

export function remapWorkflowRootIdentity(workflow: WorkflowSchema, workflowId = `workflow-${crypto.randomUUID()}`): WorkflowSchema {
  return normalizeWorkflowForRuntime({
    ...toPersistedWorkflow(workflow),
    workflowId,
    updatedAt: new Date().toISOString(),
  })
}
