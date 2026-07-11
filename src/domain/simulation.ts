import { type SimulatedConflict, type SimulationResult, type SimulationScenario, type SimulationStep, type SourceRef, type WorkflowSchema } from './schema'
import { resolveNextAtomicStep } from './recovery-semantics'
import { validateWorkflow } from './validation'

const recoveryBlockingRules = new Set([
  'recovery-protocol-entry',
  'recovery-protocol-first',
  'recovery-realtime-status',
  'recovery-required-document-order',
  'recovery-document-coverage',
  'recovery-next-atomic-step-present',
  'recovery-next-atomic-step-value',
  'recovery-global-source-priority-present',
  'recovery-global-source-priority-non-empty',
  'recovery-global-source-priority-sequence',
])

const scenarioLabels: Record<SimulationScenario, string> = {
  'new-session': '新会话',
  'context-compaction': '上下文压缩',
  'goal-conflict': '目标冲突',
  'missing-preference': '用户偏好缺失',
  'unclear-term': '术语不清楚',
  'stale-status': '状态过期',
  'insufficient-history': '历史不足',
  'unclear-work-entry': '工具或工作入口不明确',
  'handoff-after-failure': '失败后交接',
}

function globalSourcePriorityRule(workflow: WorkflowSchema) {
  return workflow.rules.sourcePriority.find((rule) => rule.scope === 'global')
}

export function simulateRecovery(workflow: WorkflowSchema, scenario: SimulationScenario): SimulationResult {
  const documentById = new Map(workflow.documents.map((document) => [document.id, document]))
  const hasRealtimeStatus = workflow.documents.some((document) => document.role === 'status' && document.lifecycle === 'realtime')
  const steps: SimulationStep[] = []
  const blockers: string[] = []
  const readDocuments: string[] = []
  const readDocumentIds = new Set<string>()
  const conflicts: SimulatedConflict[] = []
  const recoveryIssues = validateWorkflow(workflow).filter((issue) => issue.severity === 'error' && recoveryBlockingRules.has(issue.ruleId))

  function makeSourceAvailable(source: SourceRef | undefined, reason: string): source is SourceRef {
    if (!source) {
      blockers.push('来源优先级为空，无法完成冲突裁决。')
      return false
    }
    if (!source.documentId || readDocumentIds.has(source.documentId)) return true
    const document = documentById.get(source.documentId)
    if (!document) {
      blockers.push(`来源“${source.label}”引用了不存在的文档，无法完成冲突裁决。`)
      return false
    }
    steps.push({
      order: steps.length + 1,
      action: `为裁决冲突读取 ${document.filename}`,
      documentId: document.id,
      reason,
      outcome: 'read',
    })
    readDocuments.push(document.filename)
    readDocumentIds.add(document.id)
    return true
  }

  if (recoveryIssues.length > 0) {
    blockers.push(...recoveryIssues.map((issue) => issue.message))
    steps.push({
      order: 1,
      action: '基础恢复能力检查失败',
      reason: recoveryIssues.map((issue) => issue.title).join('；'),
      outcome: 'blocked',
    })
  }

  workflow.rules.recoveryOrder.forEach((recoveryStep) => {
    const document = documentById.get(recoveryStep.documentId)
    if (!document) {
      blockers.push(`恢复步骤 ${recoveryStep.id} 引用了不存在的文档。`)
      steps.push({
        order: steps.length + 1,
        action: '读取失败',
        reason: '恢复规则引用失效。',
        outcome: 'blocked',
      })
      return
    }
    const shouldRead = recoveryStep.required || (
      (document.role === 'preference' && scenario === 'missing-preference') ||
      (document.role === 'context' && scenario === 'unclear-term') ||
      (document.role === 'history' && (scenario === 'insufficient-history' || scenario === 'handoff-after-failure'))
    )
    const isStaleStatusCheck = scenario === 'stale-status' && document.role === 'status' && document.lifecycle === 'realtime'
    steps.push({
      order: steps.length + 1,
      action: shouldRead
        ? isStaleStatusCheck
          ? `读取 ${document.filename}，仅用于识别过期状态`
          : `读取 ${document.filename}`
        : `按需跳过 ${document.filename}`,
      documentId: document.id,
      reason: recoveryStep.condition,
      outcome: shouldRead ? 'read' : 'skip',
    })
    if (shouldRead) {
      readDocuments.push(document.filename)
      readDocumentIds.add(document.id)
    }
  })

  const scenarioDocumentRole = scenario === 'missing-preference'
    ? 'preference'
    : scenario === 'unclear-term'
      ? 'context'
      : scenario === 'insufficient-history' || scenario === 'handoff-after-failure'
        ? 'history'
        : undefined
  if (scenarioDocumentRole) {
    const scenarioDocument = workflow.documents.find((document) => document.role === scenarioDocumentRole)
    if (!scenarioDocument) {
      blockers.push(`没有${scenarioDocumentRole === 'preference' ? '用户偏好' : scenarioDocumentRole === 'context' ? '术语解释' : '历史'}文档，无法完成“${scenarioLabels[scenario]}”恢复。`)
    } else if (!readDocumentIds.has(scenarioDocument.id)) {
      blockers.push(`${scenarioDocument.filename} 没有进入本次恢复读取路径，无法完成“${scenarioLabels[scenario]}”恢复。`)
    }
  }

  if (scenario === 'goal-conflict') {
    const sourceRule = globalSourcePriorityRule(workflow)
    if (!sourceRule || sourceRule.orderedSources.length === 0) {
      blockers.push('缺少来源优先级规则，无法裁决目标冲突。')
      steps.push({
        order: steps.length + 1,
        action: '冲突裁决失败',
        reason: 'sourcePriority 为空。',
        outcome: 'blocked',
      })
    } else {
      const selectedSource = sourceRule.orderedSources[0]
      const sourceAvailable = makeSourceAvailable(selectedSource, `全局来源优先级将“${selectedSource?.label ?? '未配置来源'}”列为首选。`)
      steps.push({
        order: steps.length + 1,
        action: `按来源优先级选择 ${selectedSource?.label ?? '最高优先级来源'}`,
        reason: sourceRule.reason,
        outcome: sourceAvailable ? 'conflict' : 'blocked',
      })
      conflicts.push({
        id: 'goal-conflict-source-priority',
        description: '模拟最新用户目标、工作区事实和恢复文档之间存在冲突。',
        competingSources: sourceRule.orderedSources,
        selectedSource: sourceAvailable ? selectedSource : undefined,
        resolution: sourceAvailable ? 'resolved' : 'blocked',
        reason: sourceAvailable ? sourceRule.reason : '最高优先级来源不可用，不能据此裁决。',
      })
    }
  }

  if (scenario === 'stale-status') {
    const statusDocument = workflow.documents.find((document) => document.role === 'status' && document.lifecycle === 'realtime')
    if (!statusDocument) {
      blockers.push('没有实时状态文档，无法核对状态是否过期。')
    } else {
      const sourceRule = globalSourcePriorityRule(workflow)
      const selectedSource = sourceRule?.orderedSources[0]
      const sourceAvailable = Boolean(sourceRule && sourceRule.orderedSources.length > 0) && makeSourceAvailable(selectedSource, `状态过期时忽略 ${statusDocument.filename} 的过期状态，改按全局来源优先级读取“${selectedSource?.label ?? '未配置来源'}”。`)
      if (!sourceRule || sourceRule.orderedSources.length === 0) {
        blockers.push('缺少可用的全局来源优先级，无法在状态过期时完成裁决。')
      }
      steps.push({
        order: steps.length + 1,
        action: sourceAvailable
          ? `忽略 ${statusDocument.filename} 的过期状态，按来源优先级选择 ${selectedSource?.label ?? '最高优先级来源'}`
          : `无法替代 ${statusDocument.filename} 的过期状态`,
        documentId: statusDocument.id,
        reason: sourceRule?.reason ?? '缺少全局来源优先级。',
        outcome: sourceAvailable ? 'conflict' : 'blocked',
      })
      conflicts.push({
        id: 'stale-status-source-priority',
        description: '模拟实时状态与其他事实来源不一致。',
        competingSources: sourceRule?.orderedSources ?? [],
        selectedSource: sourceAvailable ? selectedSource : undefined,
        resolution: sourceAvailable ? 'resolved' : 'blocked',
        reason: sourceAvailable ? sourceRule?.reason ?? '按全局来源优先级裁决。' : '缺少可用的全局最高优先级来源。',
      })
    }
  }
  if (scenario === 'unclear-work-entry' && !workflow.documents.some((document) => document.sections.some((section) => section.fields.some((field) => field.id.includes('work-entry'))))) {
    blockers.push('没有工作入口字段，恢复时可能误填根目录。')
  }

  const nextAtomicStep = resolveNextAtomicStep(workflow, readDocumentIds).value
  const templateNextStepSlot = workflow.mode === 'template' && hasRealtimeStatus && !nextAtomicStep
  if (!nextAtomicStep && hasRealtimeStatus && !templateNextStepSlot) {
    blockers.push('本次实际读取的文档中没有可执行的下一原子步骤。')
  }
  steps.push({
    order: steps.length + 1,
    action: templateNextStepSlot ? '确认模板保留下一原子步骤空槽' : '推导下一原子步骤',
    reason: templateNextStepSlot ? '模板阶段不填写项目运行事实；实际使用时在状态资料中填写。' : scenarioLabels[scenario],
    outcome: blockers.length > 0 ? 'blocked' : 'complete',
  })

  return {
    scenario,
    status: blockers.length > 0 ? 'blocked' : steps.some((step) => step.outcome === 'conflict') || !hasRealtimeStatus || (!nextAtomicStep && !templateNextStepSlot) ? 'risky' : 'pass',
    steps,
    readDocuments,
    conflicts,
    nextAtomicStep,
    blockers,
  }
}

export { scenarioLabels }
