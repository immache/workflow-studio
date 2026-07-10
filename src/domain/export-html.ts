import { projectDocumentNames, rewriteDocumentReferences, type DocumentNameProjection } from './export-naming'
import { renderMarkdownDocument } from './export-markdown'
import { fieldValueToText, type WorkflowDocument, type WorkflowField, type WorkflowSchema } from './schema'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

const semanticTerms = ['下一原子步骤', '来源优先级', '恢复读取顺序', '范围边界', '成功标准', '当前目标', '入口协议', '完成检查', '工作流']

function renderProseText(value: string): string {
  let rendered = escapeHtml(value)
  for (const term of semanticTerms) rendered = rendered.replaceAll(term, `<span class="semantic-unit">${term}</span>`)
  return rendered
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
    return `<tr><th>${renderProseText(label ?? '')}</th><td>${renderProseText(rest.join(' | '))}</td></tr>`
  }).join('')
  return `<table class="${className}"><tbody>${rows}</tbody></table>`
}

function renderValue(field: WorkflowField, value: string): string {
  const empty = value.trim().length === 0
  if (empty) return '<div class="value empty" data-value="true" data-empty="true">未填写</div>'
  const lines = valueLines(value)
  if (field.displayFormat === 'checklist') return `<ul class="value checklist" data-value="true">${lines.map((line) => `<li>${renderProseText(line.replace(/^[-*]\s*/, ''))}</li>`).join('')}</ul>`
  if (field.displayFormat === 'steps') return `<ol class="value steps" data-value="true">${lines.map((line) => `<li>${renderProseText(line.replace(/^\d+[.)、]\s*/, ''))}</li>`).join('')}</ol>`
  if (field.displayFormat === 'code') return `<pre class="value code" data-value="true"><code>${escapeHtml(value)}</code></pre>`
  if (field.displayFormat === 'path-list') return `<ul class="value path-list" data-value="true">${lines.map((line) => `<li><code>${escapeHtml(line)}</code></li>`).join('')}</ul>`
  if (field.displayFormat === 'key-value' || field.displayFormat === 'decision-table' || field.displayFormat === 'timeline') {
    return renderTable(value, `value ${field.displayFormat}`)
  }
  return `<div class="value paragraph" data-value="true">${lines.map((line) => `<p>${renderProseText(line)}</p>`).join('')}</div>`
}

export function renderHtmlDocument(document: WorkflowDocument, projection: DocumentNameProjection): string {
  const rewrite = (text: string) => rewriteDocumentReferences(text, projection)
  const nav = document.sections.map((section) => `<a href="#${slugify(section.id)}">${renderProseText(rewrite(section.title))}</a>`).join('')
  const sections = document.sections.map((section) => {
    const fields = section.fields.map((field) => {
      const guidance = rewrite(field.guidance)
      const value = rewrite(fieldValueToText(field.value))
      return `<section class="field" data-field="${escapeHtml(field.id)}"><h3>${renderProseText(rewrite(field.label))}</h3><p class="guidance" data-guidance="true">${renderProseText(guidance)}</p>${renderValue(field, value)}</section>`
    }).join('')
    return `<section id="${slugify(section.id)}"><h2>${renderProseText(rewrite(section.title))}</h2><p>${renderProseText(rewrite(section.purpose))}</p>${fields}</section>`
  }).join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(rewrite(document.title))}</title><style>
:root{--bg:#F4F1EA;--paper:#FFFDF8;--line:#E8E6DC;--ink:#1A1915;--muted:#6F6D66;--accent:#9B442E;--serif:Georgia,"Times New Roman",serif;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.72 var(--sans)}main{max-width:960px;margin:0 auto;padding:48px 28px 72px}h1,h2{font-family:var(--serif);font-weight:400}h1{font-size:48px;line-height:1.05}.semantic-unit{white-space:nowrap}.nav{display:flex;flex-wrap:wrap;gap:10px 18px;margin:28px 0 36px;padding:14px 0;border-block:1px solid var(--line)}.nav a{color:var(--muted);text-decoration:none}.nav a:hover{color:var(--accent)}section{border-top:1px solid var(--line);padding:28px 0;scroll-margin-top:72px}.field{padding:14px 0;border-top:1px solid var(--line)}.guidance{margin:0 0 8px;color:var(--muted);font-size:13px}.value{margin:0;padding:0}.value p{margin:0 0 8px}.empty{padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--muted)}ul.value,ol.value{padding-left:24px}.code{overflow:auto;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--paper)}table.value{width:100%;border-collapse:collapse}table.value th,table.value td{padding:9px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}table.value th{width:30%;font-weight:600}.path-list code{overflow-wrap:anywhere}@media(max-width:520px){main{padding:32px 18px 56px}h1{font-size:38px}.nav{margin:22px 0 28px}section{padding:24px 0}table.value th,table.value td{padding:8px 7px}}
</style></head><body><main><p style="color:var(--accent);font-size:12px;text-transform:uppercase">Workflow Recovery Document</p><h1>${renderProseText(rewrite(document.title))}</h1><p>${renderProseText(rewrite(document.description))}</p><nav class="nav" aria-label="章节">${nav}</nav>${sections}</main></body></html>`
}

export function exportHtmlDocuments(workflow: WorkflowSchema): Record<string, string> {
  const projection = projectDocumentNames(workflow, 'html')
  return Object.fromEntries(workflow.documents.map((document) => {
    const filename = projection.byDocumentId.get(document.id)!
    const content = filename.toLocaleLowerCase().endsWith('.html')
      ? renderHtmlDocument(document, projection)
      : renderMarkdownDocument(document, projection)
    return [filename, content]
  }))
}
