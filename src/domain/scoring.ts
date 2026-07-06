import type { ValidationIssue, WorkflowSchema } from './schema'

export type ScoreDimension =
  | 'recoveryStrength'
  | 'maintenanceCost'
  | 'redundancyRisk'
  | 'beginnerFriendliness'
  | 'auditability'

export type ScoreResult = {
  total: number
  status: 'good' | 'caution' | 'poor'
  dimensions: Record<ScoreDimension, { score: number; reasons: string[] }>
}

const dimensionLabels: Record<ScoreDimension, string> = {
  recoveryStrength: '恢复强度',
  maintenanceCost: '维护成本',
  redundancyRisk: '冗余风险',
  beginnerFriendliness: '新手友好度',
  auditability: '可审计性',
}

function severityPenalty(severity: ValidationIssue['severity']) {
  if (severity === 'error') return 25
  if (severity === 'warning') return 10
  if (severity === 'suggestion') return 3
  return 0
}

function issueDimension(issue: ValidationIssue): ScoreDimension {
  if (issue.ruleId.startsWith('recovery')) return 'recoveryStrength'
  if (issue.ruleId.startsWith('responsibility')) return 'redundancyRisk'
  if (issue.ruleId.startsWith('model') || issue.ruleId.startsWith('readability')) return 'beginnerFriendliness'
  if (issue.ruleId.startsWith('structure')) return 'auditability'
  return 'maintenanceCost'
}

export function scoreWorkflow(workflow: WorkflowSchema, issues: ValidationIssue[]): ScoreResult {
  const dimensions = Object.fromEntries(
    (Object.keys(dimensionLabels) as ScoreDimension[]).map((dimension) => [
      dimension,
      { score: 100, reasons: [] as string[] },
    ]),
  ) as ScoreResult['dimensions']

  for (const issue of issues) {
    if (issue.severity === 'pass' || issue.accepted) continue
    const dimension = issueDimension(issue)
    dimensions[dimension].score = Math.max(0, dimensions[dimension].score - severityPenalty(issue.severity))
    if (dimensions[dimension].reasons.length < 3) {
      dimensions[dimension].reasons.push(`${issue.title}: ${issue.message}`)
    }
  }

  if (workflow.documents.length > 12) {
    dimensions.maintenanceCost.score = Math.max(0, dimensions.maintenanceCost.score - 8)
    dimensions.maintenanceCost.reasons.push('文档数量较多，维护成本会上升。')
  }

  const weights = workflow.scoringSettings.weights
  const total = Math.round(
    dimensions.recoveryStrength.score * weights.recoveryStrength +
      dimensions.maintenanceCost.score * weights.maintenanceCost +
      dimensions.redundancyRisk.score * weights.redundancyRisk +
      dimensions.beginnerFriendliness.score * weights.beginnerFriendliness +
      dimensions.auditability.score * weights.auditability,
  )
  const status = total >= workflow.scoringSettings.thresholds.good ? 'good' : total >= workflow.scoringSettings.thresholds.caution ? 'caution' : 'poor'
  return { total, status, dimensions }
}

export { dimensionLabels }
