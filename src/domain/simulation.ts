import type { SimulatedConflict, SimulationResult, SimulationScenario, SimulationStep, WorkflowSchema } from './schema'
import { validateWorkflow } from './validation'

const recoveryBlockingRules = new Set([
  'recovery-protocol-entry',
  'recovery-realtime-status',
  'recovery-next-atomic-step-present',
  'recovery-next-atomic-step-value',
])

const scenarioLabels: Record<SimulationScenario, string> = {
  'new-session': '新会话',
  'context-compaction': '上下文压缩',
  'goal-conflict': '目标冲突',
  'missing-preference': '用户偏好缺失',
  'unclear-term': '术语不清楚',
  'unclear-work-entry': '工具或工作入口不明确',
  'handoff-after-failure': '失败后交接',
}

export function simulateRecovery(workflow: WorkflowSchema, scenario: SimulationScenario): SimulationResult {
  const documentById = new Map(workflow.documents.map((document) => [document.id, document]))
  const steps: SimulationStep[] = []
  const blockers: string[] = []
  const readDocuments: string[] = []
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
    const shouldRead = recoveryStep.required || scenario === 'new-session' || scenario === 'context-compaction'
    steps.push({
      order: steps.length + 1,
      action: shouldRead ? `读取 ${document.filename}` : `按需跳过 ${document.filename}`,
      documentId: document.id,
      reason: recoveryStep.condition,
      outcome: shouldRead ? 'read' : 'skip',
    })
    if (shouldRead) readDocuments.push(document.filename)
  })

  if (scenario === 'goal-conflict') {
    const sourceRule = workflow.rules.sourcePriority[0]
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

  if (scenario === 'unclear-term' && !workflow.documents.some((document) => document.role === 'context')) {
    blockers.push('没有术语解释文档，术语不清楚时需要询问用户。')
  }
  if (scenario === 'missing-preference' && !workflow.documents.some((document) => document.role === 'preference')) {
    blockers.push('没有用户偏好文档，不能恢复长期偏好。')
  }
  if (scenario === 'unclear-work-entry' && !workflow.documents.some((document) => document.sections.some((section) => section.fields.some((field) => field.id.includes('work-entry'))))) {
    blockers.push('没有工作入口字段，恢复时可能误填根目录。')
  }

  const nextAtomicStep = blockers.length > 0 ? '先解决模拟器列出的阻塞项。' : '读取状态入口后继续执行下一原子步骤。'
  steps.push({
    order: steps.length + 1,
    action: '推导下一原子步骤',
    reason: scenarioLabels[scenario],
    outcome: blockers.length > 0 ? 'blocked' : 'complete',
  })

  return {
    scenario,
    status: blockers.length > 0 ? 'blocked' : steps.some((step) => step.outcome === 'conflict') ? 'risky' : 'pass',
    steps,
    readDocuments,
    conflicts,
    nextAtomicStep,
    blockers,
  }
}

export { scenarioLabels }
