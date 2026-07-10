import type { MaintenanceFormat, WorkflowDocument, WorkflowSchema } from './schema'

export type DocumentNameProjection = {
  byDocumentId: Map<string, string>
  bySourceFilename: Map<string, string>
}

function replaceExtension(filename: string, extension: '.html' | '.md'): string {
  const trimmed = filename.trim()
  if (/\.(?:html|md)$/i.test(trimmed)) return trimmed.replace(/\.(?:html|md)$/i, extension)
  return `${trimmed}${extension}`
}

export function projectDocumentFilename(document: WorkflowDocument, format: MaintenanceFormat): string {
  if (format === 'markdown' || document.role === 'protocol') {
    return replaceExtension(document.filename, '.md')
  }
  return replaceExtension(document.filename, '.html')
}

export function projectDocumentNames(workflow: WorkflowSchema, format: MaintenanceFormat): DocumentNameProjection {
  const byDocumentId = new Map<string, string>()
  const bySourceFilename = new Map<string, string>()
  for (const document of workflow.documents) {
    const projected = projectDocumentFilename(document, format)
    byDocumentId.set(document.id, projected)
    bySourceFilename.set(document.filename, projected)
  }
  return { byDocumentId, bySourceFilename }
}

export function rewriteDocumentReferences(text: string, projection: DocumentNameProjection): string {
  let rewritten = text
  const entries = [...projection.bySourceFilename.entries()]
    .filter(([source, target]) => source !== target)
    .sort(([left], [right]) => right.length - left.length)
  for (const [source, target] of entries) {
    rewritten = rewritten.replaceAll(source, target)
  }
  return rewritten
}

export function projectedFilenameCollisions(workflow: WorkflowSchema, format: MaintenanceFormat): string[] {
  const counts = new Map<string, { filename: string; count: number }>()
  for (const document of workflow.documents) {
    const filename = projectDocumentFilename(document, format)
    const key = filename.toLocaleLowerCase()
    const current = counts.get(key)
    counts.set(key, { filename, count: (current?.count ?? 0) + 1 })
  }
  return [...counts.values()].filter((item) => item.count > 1).map((item) => item.filename)
}
