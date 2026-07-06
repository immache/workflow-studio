import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SCORING_SETTINGS,
  SCHEMA_VERSION,
  type WorkflowSchema,
} from '../../domain/schema'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function migrateWorkflowSchema(input: unknown): unknown {
  if (!isRecord(input)) return input
  const version = input.schemaVersion
  if (version === SCHEMA_VERSION) return input
  if (typeof version !== 'string') return input
  if (version > SCHEMA_VERSION) {
    throw new Error(`不支持更高版本 schemaVersion：${version}`)
  }
  if (version !== '0.9.0') {
    throw new Error(`迁移失败：暂不支持从 ${version} 迁移到 ${SCHEMA_VERSION}。`)
  }

  const migrated = structuredClone(input) as Partial<WorkflowSchema>
  migrated.schemaVersion = SCHEMA_VERSION
  migrated.exportSettings = {
    ...DEFAULT_EXPORT_SETTINGS,
    ...(isRecord(input.exportSettings) ? input.exportSettings : {}),
  }
  migrated.scoringSettings = {
    weights: {
      ...DEFAULT_SCORING_SETTINGS.weights,
      ...(isRecord(input.scoringSettings) && isRecord(input.scoringSettings.weights) ? input.scoringSettings.weights : {}),
    },
    thresholds: {
      ...DEFAULT_SCORING_SETTINGS.thresholds,
      ...(isRecord(input.scoringSettings) && isRecord(input.scoringSettings.thresholds) ? input.scoringSettings.thresholds : {}),
    },
  }
  migrated.acceptedWarnings = Array.isArray(input.acceptedWarnings) ? input.acceptedWarnings : []
  return migrated
}
