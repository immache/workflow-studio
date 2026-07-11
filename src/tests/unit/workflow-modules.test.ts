import { describe, expect, it } from 'vitest'
import { createModularWorkflow, displayFormatLabels } from '../../data/modules/standard-workflow-modules'
import { fieldValueToText } from '../../domain/schema'

describe('Workflow Studio template modules', () => {
  it('keeps the standard module library on the three beginner-facing display formats', () => {
    expect(displayFormatLabels['bullet-list']).toBe('项目列表')
    const workflow = createModularWorkflow({
      name: '模块库',
      description: '检查新手模板。',
      selectedDocumentIds: ['spec', 'status', 'memory'],
      firstAction: '先设计文档结构。',
      recoveryRisk: '模块不清楚。',
    })
    const formats = workflow.documents
      .filter((document) => document.role !== 'protocol')
      .flatMap((document) => document.sections)
      .flatMap((section) => section.fields)
      .map((field) => field.displayFormat)

    expect(formats.every((format) => ['paragraph', 'bullet-list', 'steps'].includes(format ?? 'paragraph'))).toBe(true)
  })

  it('does not seed standard modules with project-specific runtime values', () => {
    const workflow = createModularWorkflow({
      name: '无运行值',
      description: '所有信息项从空槽开始。',
      selectedDocumentIds: ['status'],
      firstAction: '这段文字不能进入字段当前内容。',
      recoveryRisk: '设计与运行事实混淆。',
    })
    const contentFields = workflow.documents
      .filter((document) => document.role !== 'protocol')
      .flatMap((document) => document.sections)
      .flatMap((section) => section.fields)

    expect(contentFields.every((field) => fieldValueToText(field.value) === '')).toBe(true)
  })
})
