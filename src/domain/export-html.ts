import { projectDocumentNames, rewriteDocumentReferences, type DocumentNameProjection } from './export-naming'
import { fieldValueToText, type WorkflowDocument, type WorkflowField, type WorkflowSchema } from './schema'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-|-$/g, '') || 'section'
}

function valueLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function renderTable(value: string, className: string): string {
  const rows = valueLines(value).map((line) => {
    const cells = line.split(/\s*\|\s*|[：:]\s*/).filter(Boolean)
    const [label, ...rest] = cells
    return `<tr><th>${escapeHtml(label ?? '')}</th><td>${escapeHtml(rest.join(' | '))}</td></tr>`
  }).join('')
  return `<table class="${className}"><tbody>${rows}</tbody></table>`
}

function renderValue(field: WorkflowField, value: string): string {
  const empty = value.trim().length === 0
  if (empty) return '<div class="value empty" data-value="true" data-empty="true">未填写</div>'
  const lines = valueLines(value)
  if (field.displayFormat === 'checklist') return `<ul class="value checklist" data-value="true">${lines.map((line) => `<li>${escapeHtml(line.replace(/^[-*]\s*/, ''))}</li>`).join('')}</ul>`
  if (field.displayFormat === 'steps') return `<ol class="value steps" data-value="true">${lines.map((line) => `<li>${escapeHtml(line.replace(/^\d+[.)、]\s*/, ''))}</li>`).join('')}</ol>`
  if (field.displayFormat === 'code') return `<pre class="value code" data-value="true"><code>${escapeHtml(value)}</code></pre>`
  if (field.displayFormat === 'path-list') return `<ul class="value path-list" data-value="true">${lines.map((line) => `<li><code>${escapeHtml(line)}</code></li>`).join('')}</ul>`
  if (field.displayFormat === 'key-value' || field.displayFormat === 'decision-table' || field.displayFormat === 'timeline') {
    return renderTable(value, `value ${field.displayFormat}`)
  }
  return `<div class="value paragraph" data-value="true">${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</div>`
}

export function renderHtmlDocument(document: WorkflowDocument, projection: DocumentNameProjection): string {
  const nav = document.sections.map((section) => `<a href="#${slugify(section.id)}">${escapeHtml(section.title)}</a>`).join('')
  const sections = document.sections.map((section) => {
    const fields = section.fields.map((field) => {
      const guidance = rewriteDocumentReferences(field.guidance, projection)
      const value = rewriteDocumentReferences(fieldValueToText(field.value), projection)
      return `<section class="field" data-field="${escapeHtml(field.id)}"><h3>${escapeHtml(field.label)}</h3><p class="guidance" data-guidance="true">${escapeHtml(guidance)}</p>${renderValue(field, value)}</section>`
    }).join('')
    return `<section id="${slugify(section.id)}"><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.purpose)}</p>${fields}</section>`
  }).join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(document.title)}</title><style>
:root{--bg:#F4F1EA;--paper:#FFFDF8;--line:#E8E6DC;--ink:#1A1915;--muted:#6F6D66;--accent:#9B442E;--serif:Georgia,"Times New Roman",serif;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.72 var(--sans)}main{max-width:960px;margin:0 auto;padding:48px 28px 72px}h1,h2{font-family:var(--serif);font-weight:400}h1{font-size:48px;line-height:1.05}.nav{display:flex;flex-wrap:wrap;gap:10px 18px;margin:28px 0 36px;padding:14px 0;border-block:1px solid var(--line)}.nav a{color:var(--muted);text-decoration:none}.nav a:hover{color:var(--accent)}section{border-top:1px solid var(--line);padding:28px 0;scroll-margin-top:72px}.field{padding:14px 0;border-top:1px solid var(--line)}.guidance{margin:0 0 8px;color:var(--muted);font-size:13px}.value{margin:0;padding:0}.value p{margin:0 0 8px}.empty{padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--muted)}ul.value,ol.value{padding-left:24px}.code{overflow:auto;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--paper)}table.value{width:100%;border-collapse:collapse}table.value th,table.value td{padding:9px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}table.value th{width:30%;font-weight:600}.path-list code{overflow-wrap:anywhere}
</style></head><body><main><p style="color:var(--accent);font-size:12px;text-transform:uppercase">Workflow Recovery Document</p><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(document.description)}</p><nav class="nav" aria-label="章节">${nav}</nav>${sections}</main></body></html>`
}

export function exportHtmlDocuments(workflow: WorkflowSchema): Record<string, string> {
  const projection = projectDocumentNames(workflow, 'html')
  return Object.fromEntries(workflow.documents.map((document) => [document.filename.replace(/\.(?:md|html)$/i, '.html'), renderHtmlDocument(document, projection)]))
}
