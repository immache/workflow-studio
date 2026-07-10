import { type SimulatedConflict, type SimulationResult, type SimulationScenario, type SimulationStep, type WorkflowSchema } from './schema'
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
  return workflow.rules.sourcePriority.find((rule) => rule.scope === 'global') ?? workflow.rules.sourcePriority[0]
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
    steps.push({
      order: steps.length + 1,
      action: shouldRead ? `读取 ${document.filename}` : `按需跳过 ${document.filename}`,
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
    if (!sourceRule) {
      blockers.push('缺少来源优先级规则，无法裁决目标冲突。')
      steps.push({
        order: steps.length + 1,
        action: '冲突裁决失败',
        reason: 'sourcePriority 为空。',
        outcome: 'blocked',
      })
    } else {
      const selectedSource = sourceRule.orderedSources[0]
      steps.push({
        order: steps.length + 1,
        action: `按来源优先级选择 ${selectedSource?.label ?? '最高优先级来源'}`,
        reason: sourceRule.reason,
        outcome: 'conflict',
      })
      conflicts.push({
        id: 'goal-conflict-source-priority',
        description: '模拟最新用户目标、工作区事实和恢复文档之间存在冲突。',
        competingSources: sourceRule.orderedSources,
        selectedSource,
        resolution: selectedSource ? 'resolved' : 'manual-review-required',
        reason: selectedSource ? sourceRule.reason : '来源优先级为空，需要人工确认。',
      })
    }
  }

  if (scenario === 'stale-status') {
    const statusDocument = workflow.documents.find((document) => document.role === 'status' && document.lifecycle === 'realtime')
    if (!statusDocument) {
      blockers.push('没有实时状态文档，无法核对状态是否过期。')
    } else {
      const sourceRule = globalSourcePriorityRule(workflow)
      const workspaceSource = sourceRule?.orderedSources.find((source) => source.sourceType === 'workspace-fact')
      steps.push({
        order: steps.length + 1,
        action: `核对 ${statusDocument.filename} 与新鲜工作区事实`,
        documentId: statusDocument.id,
        reason: '状态可能已经过期，不能直接沿用旧事实。',
        outcome: 'conflict',
      })
      conflicts.push({
        id: 'stale-status-workspace-fact',
        description: '模拟实时状态与新鲜工作区事实不一致。',
        competingSources: sourceRule?.orderedSources ?? [],
        selectedSource: workspaceSource,
        resolution: workspaceSource ? 'resolved' : 'manual-review-required',
        reason: workspaceSource ? '状态过期时优先采用新鲜工作区事实。' : '缺少工作区事实来源，需要人工确认。',
      })
    }
  }
  if (scenario === 'unclear-work-entry' && !workflow.documents.some((document) => document.sections.some((section) => section.fields.some((field) => field.id.includes('work-entry'))))) {
    blockers.push('没有工作入口字段，恢复时可能误填根目录。')
  }

  const nextAtomicStep = resolveNextAtomicStep(workflow, readDocumentIds).value
  if (!nextAtomicStep && hasRealtimeStatus) {
    blockers.push('本次实际读取的文档中没有可执行的下一原子步骤。')
  }
  steps.push({
    order: steps.length + 1,
    action: '推导下一原子步骤',
    reason: scenarioLabels[scenario],
    outcome: blockers.length > 0 ? 'blocked' : 'complete',
  })

  return {
    scenario,
    status: blockers.length > 0 ? 'blocked' : steps.some((step) => step.outcome === 'conflict') || !hasRealtimeStatus || !nextAtomicStep ? 'risky' : 'pass',
    steps,
    readDocuments,
    conflicts,
    nextAtomicStep,
    blockers,
  }
}

export { scenarioLabels }
