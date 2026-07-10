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

export function realtimeStatusDocuments(workflow: WorkflowSchema): WorkflowDocument[] {
  return workflow.documents.filter((document) => document.role === 'status' && document.lifecycle === 'realtime')
}

export function nextAtomicStepFields(document: WorkflowDocument): WorkflowField[] {
  if (document.role !== 'status' || document.lifecycle !== 'realtime') return []
  return document.sections.flatMap((section) => section.fields).filter(isNextAtomicStepField)
}

export function resolveNextAtomicStep(workflow: WorkflowSchema): {
  document?: WorkflowDocument
  field?: WorkflowField
  value?: string
} {
  const recoveryIndex = new Map(workflow.rules.recoveryOrder.map((step, index) => [step.documentId, index]))
  const orderedStatuses = realtimeStatusDocuments(workflow).sort((left, right) => (
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
  return { document: orderedStatuses[0] }
}
