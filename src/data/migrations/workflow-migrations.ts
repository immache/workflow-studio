import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SCORING_SETTINGS,
  LEGACY_SCHEMA_VERSION,
  SCHEMA_VERSION,
  emptyProtocolState,
  type ProtocolDocument,
  type WorkflowRules,
} from '../../domain/schema'
import {
  canGenerateSystemProtocol,
  createSystemProtocolBundle,
  protocolSourceHash,
} from '../../domain/protocol-state'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function migrate09To10(input: UnknownRecord): UnknownRecord {
  const migrated = structuredClone(input)
  migrated.schemaVersion = LEGACY_SCHEMA_VERSION
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

function movedProtocolState(input: UnknownRecord): UnknownRecord {
  const documents = Array.isArray(input.documents) ? input.documents.filter(isRecord) : []
  const protocolDocuments = documents.filter((document) => document.role === 'protocol') as ProtocolDocument[]
  const contentDocuments = documents.filter((document) => document.role !== 'protocol')
  const rules = input.rules as WorkflowRules | undefined
  const base = {
    name: typeof input.name === 'string' ? input.name : '',
    description: typeof input.description === 'string' ? input.description : '',
    documents: contentDocuments,
  }
  const protocolState = emptyProtocolState()

  if (protocolDocuments.length > 0 && rules) {
    protocolState.legacyManualOverride = {
      documents: structuredClone(protocolDocuments),
      rules: structuredClone(rules),
      ...(protocolDocuments.length === 1 ? { selectedDocumentId: protocolDocuments[0].id } : {}),
    }
  } else if (rules && canGenerateSystemProtocol(base as never)) {
    protocolState.system = {
      status: 'ready',
      generatorVersion: '1',
      sourceHash: protocolSourceHash(base as never),
      bundle: {
        document: createSystemProtocolBundle(base as never).document,
        rules: structuredClone(rules),
      },
    }
  }

  const migrated = structuredClone(input)
  delete migrated.rules
  migrated.schemaVersion = SCHEMA_VERSION
  migrated.mode = 'legacy-content'
  migrated.documents = contentDocuments
  migrated.protocolState = protocolState
  return migrated
}

/**
 * Migration owns persisted-shape completion. Runtime normalization must never
 * repair a malformed 1.1 object or write derived values back into it.
 */
export function migrateWorkflowSchema(input: unknown): unknown {
  if (!isRecord(input)) return input
  const version = input.schemaVersion
  if (version === SCHEMA_VERSION) return input
  if (typeof version !== 'string') return input

  if (version === '0.9.0') return movedProtocolState(migrate09To10(input))
  if (version === LEGACY_SCHEMA_VERSION) return movedProtocolState(input)
  throw new Error(`迁移失败：暂不支持从 ${version} 迁移到 ${SCHEMA_VERSION}。`)
}
