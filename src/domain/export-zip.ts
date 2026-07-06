import JSZip from 'jszip'
import { exportHtmlDocuments } from './export-html'
import { exportMarkdownDocuments, exportReadme } from './export-markdown'
import type { WorkflowSchema } from './schema'
import { hasBlockingErrors, validateWorkflow } from './validation'

export type ExportPackage = {
  files: Record<string, string>
  blob: Blob
}

export function packageName(workflow: WorkflowSchema): string {
  return `${workflow.name.trim().replace(/[^\w\u4e00-\u9fff-]+/g, '-') || 'workflow'}-workflow.zip`
}

export async function createWorkflowZip(workflow: WorkflowSchema): Promise<ExportPackage> {
  const issues = validateWorkflow(workflow)
  const blocking = issues.find((issue) => issue.severity === 'error')
  if (hasBlockingErrors(issues)) {
    throw new Error(`导出被阻止：${blocking?.title ?? '存在未解决 Error'}`)
  }
  const zip = new JSZip()
  const files: Record<string, string> = {
    'workflow.json': JSON.stringify(workflow, null, 2),
    'README.md': exportReadme(workflow),
  }
  const htmlDocs = exportHtmlDocuments(workflow)
  const markdownDocs = exportMarkdownDocuments(workflow)
  const primary = workflow.maintenanceFormat === 'html' ? htmlDocs : markdownDocs
  const secondary = workflow.secondaryFormat === 'html' ? htmlDocs : workflow.secondaryFormat === 'markdown' ? markdownDocs : {}
  const secondaryDir = workflow.secondaryFormat === 'html' ? 'documents-html' : 'documents-md'

  for (const [name, content] of Object.entries(primary)) {
    files[`documents/${name}`] = content
  }
  for (const [name, content] of Object.entries(secondary)) {
    files[`${secondaryDir}/${name}`] = content
  }
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content)
  }
  return { files, blob: await zip.generateAsync({ type: 'blob' }) }
}
