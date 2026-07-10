import {
  fieldValueToText,
  type WorkflowDocument,
  type WorkflowField,
  type WorkflowSchema,
} from './schema'

function isNextAtomicStepField(field: WorkflowField): boolean {
  const normalizedId = field.id.trim().toLowerCase().replaceAll('_', '-')
  return field.lifecycle === 'realtime' && (
    normalizedId === 'next-atomic-step' ||
    normalizedId.endsWith('-next-atomic-step') ||
    field.label.trim() === '下一原子步骤'
  )
}

function isProtocolFallbackNextStepField(field: WorkflowField): boolean {
  return field.id.trim().toLowerCase().replaceAll('_', '-') === 'protocol-fallback-next-atomic-step'
}

export function realtimeStatusDocuments(workflow: WorkflowSchema): WorkflowDocument[] {
  return workflow.documents.filter((document) => document.role === 'status' && document.lifecycle === 'realtime')
}

export function nextAtomicStepFields(document: WorkflowDocument): WorkflowField[] {
  if (document.role !== 'status' || document.lifecycle !== 'realtime') return []
  return document.sections.flatMap((section) => section.fields).filter(isNextAtomicStepField)
}

export function protocolFallbackNextStepFields(document: WorkflowDocument): WorkflowField[] {
  if (document.role !== 'protocol') return []
  return document.sections.flatMap((section) => section.fields).filter(isProtocolFallbackNextStepField)
}

export function resolveNextAtomicStep(workflow: WorkflowSchema, readableDocumentIds?: ReadonlySet<string>): {
  document?: WorkflowDocument
  field?: WorkflowField
  value?: string
} {
  const recoveryIndex = new Map(workflow.rules.recoveryOrder.map((step, index) => [step.documentId, index]))
  const orderedStatuses = realtimeStatusDocuments(workflow)
    .filter((document) => !readableDocumentIds || readableDocumentIds.has(document.id))
    .sort((left, right) => (
    (recoveryIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (recoveryIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    ))
  for (const document of orderedStatuses) {
    const fields = nextAtomicStepFields(document)
    const field = fields.find((candidate) => fieldValueToText(candidate.value).trim().length > 0) ?? fields[0]
    if (field) {
      const value = fieldValueToText(field.value).trim()
      return { document, field, value: value || undefined }
    }
  }
  if (realtimeStatusDocuments(workflow).length === 0) {
    const protocols = workflow.documents.filter((document) => (
      document.role === 'protocol' && (!readableDocumentIds || readableDocumentIds.has(document.id))
    ))
    for (const document of protocols) {
      const fields = protocolFallbackNextStepFields(document)
      const field = fields.find((candidate) => fieldValueToText(candidate.value).trim().length > 0) ?? fields[0]
      if (field) {
        const value = fieldValueToText(field.value).trim()
        return { document, field, value: value || undefined }
      }
    }
  }
  return { document: orderedStatuses[0] }
}
