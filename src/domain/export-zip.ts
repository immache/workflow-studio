import JSZip from 'jszip'
import { exportDocumentsForFormat } from './export-documents'
import { exportReadme } from './export-markdown'
import type { WorkflowSchema } from './schema'
import { hasBlockingErrors, validateWorkflow } from './validation'

export type ExportPackage = {
  files: Record<string, string>
  blob: Blob
}

export function packageName(workflow: WorkflowSchema): string {
  const name = workflow.name.trim() || 'workflow'
  const pattern = workflow.exportSettings.packageNamePattern.trim() || '{name}-workflow'
  const expanded = pattern.replaceAll('{name}', name).replace(/\.zip$/i, '')
  return `${expanded.replace(/[^\w\u4e00-\u9fff-]+/g, '-') || 'workflow'}.zip`
}

function assertExportableVersion(workflow: WorkflowSchema): void {
  if (workflow.readOnlyReason) {
    throw new Error('导出被阻止：该工作流来自更高 schemaVersion，只能查看，不能降级导出。')
  }
}

export function serializeWorkflowJson(workflow: WorkflowSchema): string {
  assertExportableVersion(workflow)
  return JSON.stringify(workflow, null, 2)
}

export async function createWorkflowZip(workflow: WorkflowSchema): Promise<ExportPackage> {
  assertExportableVersion(workflow)
  const issues = validateWorkflow(workflow)
  const blocking = issues.find((issue) => issue.severity === 'error')
  if (hasBlockingErrors(issues)) {
    throw new Error(`导出被阻止：${blocking?.title ?? '存在未解决 Error'}`)
  }
  const zip = new JSZip()
  const files: Record<string, string> = {
    'workflow.json': serializeWorkflowJson(workflow),
    'README.md': exportReadme(workflow, workflow.maintenanceFormat),
  }
  const primary = exportDocumentsForFormat(workflow, workflow.maintenanceFormat)
  const secondary = workflow.secondaryFormat ? exportDocumentsForFormat(workflow, workflow.secondaryFormat) : {}
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
