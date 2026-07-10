import { renderHtmlDocument } from './export-html'
import { projectDocumentNames } from './export-naming'
import { renderMarkdownDocument } from './export-markdown'
import type { MaintenanceFormat, WorkflowSchema } from './schema'

export function exportDocumentsForFormat(workflow: WorkflowSchema, format: MaintenanceFormat): Record<string, string> {
  const projection = projectDocumentNames(workflow, format)
  return Object.fromEntries(workflow.documents.map((document) => {
    const filename = projection.byDocumentId.get(document.id)!
    const content = filename.toLocaleLowerCase().endsWith('.html')
      ? renderHtmlDocument(document, projection)
      : renderMarkdownDocument(document, projection)
    return [filename, content]
  }))
}
