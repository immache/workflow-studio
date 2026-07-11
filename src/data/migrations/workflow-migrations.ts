import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SCORING_SETTINGS,
  LEGACY_SCHEMA_VERSION,
  PREVIOUS_SCHEMA_VERSION,
  SCHEMA_VERSION,
  type ContentDocument,
  type PersistedWorkflowSchema,
  emptyProtocolState,
  type ProtocolDocument,
  type WorkflowRules,
} from '../../domain/schema'
import {
  canGenerateSystemProtocol,
  createDefaultProtocolOrderingPreferences,
  createSystemProtocolBundle,
  previousProtocolSourceHash,
  protocolSourceHash,
} from '../../domain/protocol-state'
import { assertWorkflowShape } from '../../domain/strict-workflow-shape'

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
    const synthesizedProtocol = createSystemProtocolBundle(base as never).document
    protocolState.legacyManualOverride = {
      documents: [synthesizedProtocol],
      rules: structuredClone(rules),
      selectedDocumentId: synthesizedProtocol.id,
    }
  }

  const migrated = structuredClone(input)
  delete migrated.rules
  migrated.schemaVersion = PREVIOUS_SCHEMA_VERSION
  migrated.mode = 'legacy-content'
  migrated.documents = contentDocuments
  migrated.protocolState = protocolState
  return migrated
}

function migrate11To12(input: UnknownRecord): PersistedWorkflowSchema {
  const migrated = structuredClone(input)
  const documents = Array.isArray(migrated.documents)
    ? migrated.documents.filter(isRecord) as ContentDocument[]
    : []
  const previousSystem = isRecord(migrated.protocolState) && isRecord(migrated.protocolState.system)
    ? migrated.protocolState.system
    : undefined
  const previousSystemWasCurrent = previousSystem?.status === 'ready'
    && typeof previousSystem.sourceHash === 'string'
    && previousSystem.sourceHash === previousProtocolSourceHash({
      name: typeof migrated.name === 'string' ? migrated.name : '',
      description: typeof migrated.description === 'string' ? migrated.description : '',
      documents,
    })
  if (!isRecord(migrated.protocolState)) {
    migrated.schemaVersion = SCHEMA_VERSION
    assertWorkflowShape(migrated)
  }
  migrated.schemaVersion = SCHEMA_VERSION
  const protocolState = migrated.protocolState as UnknownRecord
  protocolState.orderingPreferences = createDefaultProtocolOrderingPreferences(documents)

  assertWorkflowShape(migrated)
  if (migrated.protocolState.system.status === 'ready' && previousSystemWasCurrent) {
    migrated.protocolState.system = {
      status: 'ready',
      generatorVersion: '1',
      sourceHash: protocolSourceHash(migrated),
      bundle: createSystemProtocolBundle(migrated),
    }
  }
  return migrated
}

/**
 * Migration owns persisted-shape completion. Runtime normalization must never
 * repair a malformed current-version object or write derived values back into it.
 */
export function migrateWorkflowSchema(input: unknown): unknown {
  if (!isRecord(input)) return input
  const version = input.schemaVersion
  if (version === SCHEMA_VERSION) return input
  if (typeof version !== 'string') return input

  if (version === '0.9.0') return migrate11To12(movedProtocolState(migrate09To10(input)))
  if (version === LEGACY_SCHEMA_VERSION) return migrate11To12(movedProtocolState(input))
  if (version === PREVIOUS_SCHEMA_VERSION) return migrate11To12(input)
  throw new Error(`迁移失败：暂不支持从 ${version} 迁移到 ${SCHEMA_VERSION}。`)
}
