import { projectDocumentNames, rewriteDocumentReferences, type DocumentNameProjection } from './export-naming'
import { renderMarkdownDocument } from './export-markdown'
import { fieldValueToText, type WorkflowDocument, type WorkflowField, type WorkflowSchema } from './schema'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

const semanticTerms = [
  '目标、范围与成功标准',
  '入口协议草案',
  '下一原子步骤',
  '恢复读取顺序',
  '来源优先级',
  '项目使命',
  '范围边界',
  '成功标准',
  '当前目标',
  '入口协议',
  '完成检查',
  '第一步',
  '信什么',
  '工作流',
]

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

function renderTableRows(value: string): string {
  return valueLines(value).map((line) => {
    const cells = line.split(/\s*\|\s*|[：:]\s*/).filter(Boolean)
    const [label, ...rest] = cells
    return `<tr><th>${renderProseText(label ?? '')}</th><td>${renderProseText(rest.join(' | '))}</td></tr>`
  }).join('')
}

function renderSkeleton(format: string): string {
  if (format === 'steps') return '<ol class="value-skeleton list-skeleton steps-skeleton" data-empty-skeleton="true" aria-hidden="true"><li><span></span></li><li><span></span></li><li><span class="short"></span></li></ol>'
  if (format === 'bullet-list' || format === 'checklist' || format === 'path-list') return '<ul class="value-skeleton list-skeleton" data-empty-skeleton="true" aria-hidden="true"><li><span></span></li><li><span></span></li><li><span class="short"></span></li></ul>'
  if (format === 'key-value' || format === 'decision-table' || format === 'timeline') return '<div class="value-skeleton table-skeleton" data-empty-skeleton="true" aria-hidden="true"><span></span><span></span><span></span><span></span></div>'
  if (format === 'code') return '<div class="value-skeleton code-skeleton" data-empty-skeleton="true" aria-hidden="true"><span></span><span></span><span class="short"></span></div>'
  return '<div class="value-skeleton paragraph-skeleton" data-empty-skeleton="true" aria-hidden="true"><span></span><span></span><span class="short"></span></div>'
}

function renderValueShell(input: {
  format: string
  tag: 'div' | 'ul' | 'ol' | 'pre' | 'table'
  className: string
  allowedChild: string
  content: string
}): string {
  return `<div class="value-shell" data-display-format="${escapeHtml(input.format)}" data-format-lock="true" data-slot="future-model"><${input.tag} class="${input.className}" data-value="true" data-edit-scope="children-only" data-allowed-child="${input.allowedChild}"><!-- workflow-value:start -->${input.content}<!-- workflow-value:end --></${input.tag}>${renderSkeleton(input.format)}</div>`
}

function renderValue(field: WorkflowField, value: string): string {
  const lines = valueLines(value)
  if (field.displayFormat === 'bullet-list' || field.displayFormat === 'checklist') {
    return renderValueShell({
      format: field.displayFormat,
      tag: 'ul',
      className: `value ${field.displayFormat}`,
      allowedChild: 'li',
      content: lines.map((line) => `<li>${renderProseText(line.replace(/^[-*]\s*/, ''))}</li>`).join(''),
    })
  }
  if (field.displayFormat === 'steps') return renderValueShell({
    format: 'steps',
    tag: 'ol',
    className: 'value steps',
    allowedChild: 'li',
    content: lines.map((line) => `<li>${renderProseText(line.replace(/^\d+[.)、]\s*/, ''))}</li>`).join(''),
  })
  if (field.displayFormat === 'code') return renderValueShell({ format: 'code', tag: 'pre', className: 'value code', allowedChild: 'code', content: value.trim() ? `<code>${escapeHtml(value)}</code>` : '' })
  if (field.displayFormat === 'path-list') return renderValueShell({
    format: 'path-list',
    tag: 'ul',
    className: 'value path-list',
    allowedChild: 'li',
    content: lines.map((line) => `<li><code>${escapeHtml(line)}</code></li>`).join(''),
  })
  if (field.displayFormat === 'key-value' || field.displayFormat === 'decision-table' || field.displayFormat === 'timeline') {
    return renderValueShell({ format: field.displayFormat, tag: 'table', className: `value ${field.displayFormat}`, allowedChild: 'tbody', content: lines.length > 0 ? `<tbody>${renderTableRows(value)}</tbody>` : '' })
  }
  return renderValueShell({
    format: 'paragraph',
    tag: 'div',
    className: 'value paragraph',
    allowedChild: 'p',
    content: lines.map((line) => `<p>${renderProseText(line)}</p>`).join(''),
  })
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
:root{--bg:#F4F1EA;--paper:#FFFDF8;--line:#E8E6DC;--ink:#1A1915;--muted:#64625C;--accent:#9B442E;--serif:Georgia,"Times New Roman",serif;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.72 var(--sans)}main{max-width:960px;margin:0 auto;padding:48px 28px 72px}h1,h2{font-family:var(--serif);font-weight:400}h1{font-size:48px;line-height:1.05}.semantic-unit{display:inline-block;white-space:nowrap}.nav{display:flex;flex-wrap:wrap;gap:10px 18px;margin:28px 0 36px;padding:14px 0;border-block:1px solid var(--line)}.nav a{color:var(--muted);text-decoration:none}.nav a:hover{color:var(--accent)}section{border-top:1px solid var(--line);padding:28px 0;scroll-margin-top:72px}.field{padding:14px 0;border-top:1px solid var(--line)}.guidance{margin:0 0 8px;color:var(--muted);font-size:13px}.value-shell{position:relative}.value{margin:0;padding:0}.value:empty{display:none}.value:not(:empty)+.value-skeleton{display:none}.value p{margin:0 0 8px}ul.value,ol.value{padding-left:24px}.value-skeleton{margin:0}.paragraph-skeleton,.code-skeleton{display:grid;gap:8px;padding:12px;border:1px dashed var(--line);border-radius:8px;background:var(--paper)}.value-skeleton span{display:block;width:92%;height:8px;border-radius:4px;background:var(--line)}.value-skeleton span.short{width:62%}.list-skeleton{display:grid;gap:7px;padding:10px 0 10px 26px;border:1px dashed var(--line);border-radius:8px;background:var(--paper);color:var(--muted)}.list-skeleton li{padding-left:2px}.steps-skeleton{list-style:decimal}.table-skeleton{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;padding:1px;border:1px solid var(--line);background:var(--line)}.table-skeleton span{width:100%;height:30px;border-radius:0;background:var(--paper)}.code{overflow:auto;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--paper)}table.value{width:100%;border-collapse:collapse}table.value th,table.value td{padding:9px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}table.value th{width:30%;font-weight:600}.path-list code{overflow-wrap:anywhere}@media(max-width:520px){main{padding:32px 18px 56px}h1{font-size:38px}.nav{margin:22px 0 28px}section{padding:24px 0}table.value th,table.value td{padding:8px 7px}}
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
