import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SCORING_SETTINGS,
  SCHEMA_VERSION,
  createField,
  scalarValue,
  type DocumentRole,
  type InformationLifecycle,
  type WorkflowDocument,
  type WorkflowSchema,
  type WorkflowSection,
} from '../../domain/schema'

const now = () => new Date().toISOString()

function section(
  id: string,
  title: string,
  purpose: string,
  lifecycle: InformationLifecycle,
  order: number,
  fields: ReturnType<typeof createField>[],
): WorkflowSection {
  return { id, title, purpose, lifecycle, order, repeatable: false, fields }
}

function document(input: {
  id: string
  filename: string
  title: string
  role: DocumentRole
  lifecycle: InformationLifecycle
  description: string
  order: number
  sections: WorkflowSection[]
}): WorkflowDocument {
  return {
    ...input,
    required: true,
    readPolicy: {
      whenToRead: input.role === 'history' ? ['实时文档不足时按关键词读取'] : ['恢复时按规则读取'],
      dependsOnDocumentIds: [],
      readOrderHint: input.order,
    },
    updatePolicy: {
      updateTriggers: ['职责范围内事实变化时'],
      replacementMode: input.lifecycle === 'historical' ? 'append-history' : 'replace-current',
      staleInfoHandling: input.lifecycle === 'historical' ? 'archive' : 'remove',
    },
  }
}

export function createCurrentStandardWorkflow(): WorkflowSchema {
  const createdAt = now()
  const documents = [
    document({
      id: 'agents',
      filename: 'AGENTS.md',
      title: '工作流协议',
      role: 'protocol',
      lifecycle: 'mixed',
      description: '恢复路径、来源优先级、文档职责、更新规则、完成协议和 HTML 字段编辑规则。',
      order: 1,
      sections: [
        section('recovery-path', '恢复路径', '说明恢复时读取哪些文档。', 'validation', 1, [
          createField({
            id: 'read-order',
            label: '读取顺序',
            guidance: '恢复后按顺序读取协议、稳定计划、状态和按需文档。',
            lifecycle: 'validation',
            required: true,
            value: scalarValue('AGENTS.md -> SPEC.html -> STATUS.html -> USER.html(按需) -> MEMORY.html(按需) -> CONTEXT.html(按需)'),
          }),
        ]),
        section('source-priority', '来源优先级', '记录信息冲突时的裁决顺序。', 'validation', 2, [
          createField({
            id: 'source-priority-rules',
            label: '全局来源优先级',
            guidance: '最新明确用户指令最高，其次是新鲜工作区事实，再到恢复文档和历史。',
            lifecycle: 'validation',
            required: true,
            value: scalarValue('最新用户指令 -> 工作区事实 -> STATUS -> SPEC -> USER -> 当前会话历史 -> MEMORY -> 更早历史 -> CONTEXT'),
          }),
        ]),
        section('document-responsibility', '文档职责', '说明每个恢复文档只维护自己的事实生命周期。', 'validation', 3, [
          createField({
            id: 'document-responsibilities',
            label: '职责分离',
            guidance: '避免把同一个实时事实复制到多个文档；历史演变进入 MEMORY。',
            lifecycle: 'validation',
            required: true,
            value: scalarValue('协议、稳定计划、状态、偏好、历史、术语分别维护。'),
          }),
        ]),
        section('update-rules', '更新规则', '说明何时替换实时文档、何时追加历史。', 'validation', 4, [
          createField({
            id: 'update-rules-field',
            label: '维护触发',
            guidance: '事实变化后按职责更新对应文档；实时文档替换失效信息，历史文档追加或归档。',
            lifecycle: 'validation',
            required: true,
            value: scalarValue('状态变更更新 STATUS；计划变更更新 SPEC；偏好稳定后更新 USER；方向变化写入 MEMORY。'),
          }),
        ]),
        section('completion-protocol', '完成协议', '声明交付前检查。', 'validation', 5, [
          createField({
            id: 'completion-checks',
            label: '完成前检查',
            guidance: '记录交付前必须完成的验证和文档维护。',
            lifecycle: 'validation',
            required: true,
            value: scalarValue('验证结果、更新恢复文档、检查失效信息、汇报维护内容。'),
          }),
        ]),
        section('html-editing', 'HTML 字段编辑规则', '记录常驻 guidance 和可替换 value slot 的编辑协议。', 'validation', 6, [
          createField({
            id: 'html-field-editing',
            label: '字段编辑方式',
            guidance: '模型只替换 data-value 内容，不删除 data-guidance 常驻说明。',
            lifecycle: 'validation',
            required: true,
            value: scalarValue('保留 data-field、data-guidance、data-value；空值使用 data-empty 标记。'),
          }),
        ]),
      ],
    }),
    document({
      id: 'spec',
      filename: 'SPEC.html',
      title: '稳定计划',
      role: 'plan',
      lifecycle: 'stable',
      description: '长期目标、成功标准、范围、阶段计划、当前阶段和持久约束。',
      order: 2,
      sections: [
        section('mission', '项目使命', '记录项目长期存在原因。', 'stable', 1, [
          createField({ id: 'mission-field', label: '项目使命', guidance: '用 1-3 句话说明项目长期目标。', lifecycle: 'stable', required: true, allowEmpty: true }),
        ]),
        section('success-criteria', '成功标准', '记录怎样才算完成。', 'stable', 2, [
          createField({ id: 'success-criteria-field', label: '成功标准', guidance: '列出可验证的完成标准，不写过程流水。', lifecycle: 'stable', required: true, allowEmpty: true }),
        ]),
        section('scope', '范围边界', '记录目标与非目标。', 'stable', 3, [
          createField({ id: 'goals', label: '目标', guidance: '明确要做的事。', lifecycle: 'stable', required: true, allowEmpty: true }),
          createField({ id: 'non-goals', label: '非目标', guidance: '明确不做的事。', lifecycle: 'stable' }),
        ]),
        section('phases', '阶段计划', '维护当前有效阶段计划。', 'stable', 4, [
          createField({ id: 'phase-plan', label: '阶段计划', guidance: '只保留当前有效阶段；旧阶段背景进入 MEMORY。', lifecycle: 'stable' }),
          createField({ id: 'current-phase', label: '当前阶段', guidance: '当前阶段必须指向阶段计划中的一个阶段。', lifecycle: 'stable' }),
        ]),
        section('persistent-constraints', '持久约束', '记录跨多数任务仍有效的边界。', 'stable', 5, [
          createField({ id: 'persistent-constraints-field', label: '持久约束', guidance: '写长期边界，不写一次性执行要求。', lifecycle: 'stable' }),
        ]),
        section('users-scenarios', '使用者与场景', '记录使用者、关键场景和恢复场景。', 'stable', 6, [
          createField({ id: 'users-field', label: '使用者', guidance: '说明谁会使用这套工作流。', lifecycle: 'stable' }),
          createField({ id: 'key-scenarios-field', label: '关键场景', guidance: '列出工作流必须支持的典型场景。', lifecycle: 'stable' }),
        ]),
        section('open-questions', '开放问题', '记录计划级仍未解决的问题。', 'stable', 7, [
          createField({ id: 'plan-open-questions', label: '计划级开放问题', guidance: '只记录影响长期计划或范围的未决问题。', lifecycle: 'stable' }),
        ]),
      ],
    }),
    document({
      id: 'status',
      filename: 'STATUS.html',
      title: '状态快照',
      role: 'status',
      lifecycle: 'realtime',
      description: '项目锚点、当前状态、下一原子步骤、关键事实、阻塞与确认。',
      order: 3,
      sections: [
        section('anchor', '项目锚点', '记录工作入口和交付物。', 'realtime', 1, [
          createField({ id: 'work-entry', label: '工作入口', guidance: '允许项目根、worktree、子目录、远端或容器路径。', lifecycle: 'realtime', required: true, allowEmpty: true }),
          createField({ id: 'current-goal', label: '当前目标', guidance: '当前仍有效目标，不写历史流水。', lifecycle: 'realtime', required: true, allowEmpty: true }),
        ]),
        section('state', '当前状态', '记录当前可恢复状态和验证方式。', 'realtime', 2, [
          createField({ id: 'status-state', label: '状态', guidance: '进行中、待审查、完成或阻塞；不要混入历史。', lifecycle: 'realtime', required: true, allowEmpty: true }),
          createField({ id: 'verification', label: '验证方式', guidance: '记录当前目标的验证入口，如命令、测试或检查清单。', lifecycle: 'realtime' }),
        ]),
        section('next-step', '下一原子步骤', '恢复后唯一具体入口。', 'realtime', 3, [
          createField({ id: 'next-atomic-step', label: '下一原子步骤', guidance: '唯一、具体、可执行。', lifecycle: 'realtime', required: true, value: scalarValue('恢复后读取 STATUS.html，并执行其中记录的下一原子步骤。') }),
        ]),
        section('facts', '关键事实', '记录仍有效的恢复事实。', 'realtime', 4, [
          createField({ id: 'verified-facts', label: '已验证事实', guidance: '只保留当前仍有效且足以恢复判断的事实。', lifecycle: 'realtime' }),
        ]),
        section('blockers', '阻塞与确认', '记录当前阻塞、等待项和需要用户确认的问题。', 'realtime', 5, [
          createField({ id: 'blockers-field', label: '阻塞', guidance: '写解除条件，不拆成项目级和动作级重复维护。', lifecycle: 'realtime' }),
          createField({ id: 'confirmation-needed', label: '需要确认', guidance: '只有必须问用户才能继续时填写。', lifecycle: 'realtime' }),
        ]),
        section('recovery-pointers', '恢复指针', '指向稳定计划、偏好、历史和术语文档。', 'realtime', 6, [
          createField({ id: 'stable-plan-pointer', label: '稳定计划指针', guidance: '说明长期计划应读取哪个文档。', lifecycle: 'realtime', value: scalarValue('SPEC.html') }),
          createField({ id: 'memory-pointer', label: '历史指针', guidance: '说明历史演变应按索引读取哪个文档。', lifecycle: 'realtime', value: scalarValue('MEMORY.html') }),
          createField({ id: 'context-pointer', label: '术语指针', guidance: '说明术语不清楚时读取哪个文档。', lifecycle: 'realtime', value: scalarValue('CONTEXT.html') }),
        ]),
      ],
    }),
    document({
      id: 'user',
      filename: 'USER.html',
      title: '用户偏好',
      role: 'preference',
      lifecycle: 'preference',
      description: '长期稳定用户偏好，不记录一次性要求。',
      order: 4,
      sections: [
        section('collaboration', '协作偏好', '记录长期协作方式。', 'preference', 1, [
          createField({ id: 'communication', label: '沟通方式', guidance: '只记录长期稳定偏好。', lifecycle: 'preference' }),
        ]),
        section('output', '输出偏好', '记录长期稳定的交付和表达偏好。', 'preference', 2, [
          createField({ id: 'output-style', label: '输出方式', guidance: '不根据单次行为推断；用户明确表达后再写。', lifecycle: 'preference' }),
        ]),
        section('execution', '执行偏好', '记录长期稳定的工具、验证和协作要求。', 'preference', 3, [
          createField({ id: 'execution-style', label: '执行方式', guidance: '只记录多数未来任务都会影响的偏好。', lifecycle: 'preference' }),
        ]),
        section('user-boundaries', '技术与边界', '记录长期安全边界或不做事项。', 'preference', 4, [
          createField({ id: 'stable-boundaries', label: '稳定边界', guidance: '一次性范围要求写入 STATUS 或 SPEC，不写入 USER。', lifecycle: 'preference' }),
        ]),
        section('user-maintenance-rules', '维护规则', '说明何时更新用户偏好。', 'preference', 5, [
          createField({ id: 'user-maintenance', label: '维护规则', guidance: '只有用户明确表达或反复确认的长期偏好才写入 USER。', lifecycle: 'preference' }),
        ]),
      ],
    }),
    document({
      id: 'memory',
      filename: 'MEMORY.html',
      title: '演变历史',
      role: 'history',
      lifecycle: 'historical',
      description: '项目演变、废弃方案、替代关系和关键证据。',
      order: 5,
      sections: [
        section('memory-usage-section', '使用方式', '说明 MEMORY 只用于理解演变，不判断当前状态。', 'historical', 1, [
          createField({ id: 'memory-usage', label: '使用方式', guidance: '快速恢复先读索引，再按关键词选择性读取时间线。', lifecycle: 'historical' }),
        ]),
        section('memory-index', '记忆索引', '记录可检索关键词和条目状态。', 'historical', 2, [
          createField({ id: 'memory-index-field', label: '索引条目', guidance: '新增、改名或改状态时同步维护索引。', lifecycle: 'historical' }),
        ]),
        section('timeline', '演变时间线', '记录仍有效参考或已失效归档。', 'historical', 3, [
          createField({ id: 'history-entry-template', label: '历史条目模板', guidance: '包含状态、关键词、事件、原因、当前结果和证据。', lifecycle: 'historical' }),
        ]),
        section('memory-rules', '维护规则', '说明历史追加、归档和替代关系。', 'historical', 4, [
          createField({ id: 'memory-maintenance', label: '维护规则', guidance: '旧条目不删除；失效后标为已失效归档并写清替代关系。', lifecycle: 'historical' }),
        ]),
      ],
    }),
    document({
      id: 'context',
      filename: 'CONTEXT.html',
      title: '术语解释',
      role: 'context',
      lifecycle: 'reference',
      description: '术语解释和边界澄清，不记录实时状态。',
      order: 6,
      sections: [
        section('context-usage-section', '使用方式', '说明何时读取术语解释。', 'reference', 1, [
          createField({ id: 'context-usage', label: '使用方式', guidance: '只有术语含义、边界或归属不清楚时按需读取。', lifecycle: 'reference' }),
        ]),
        section('entry-fields', '条目字段', '说明术语条目应包含哪些字段。', 'reference', 2, [
          createField({ id: 'term-entry-fields', label: '条目字段', guidance: '术语条目应包含含义、不等于、归属、例子和维护说明。', lifecycle: 'reference' }),
        ]),
        section('basic-terms', '基础术语', '记录工作流模板中的基础概念。', 'reference', 3, [
          createField({ id: 'basic-term-status', label: '状态文档', guidance: '解释状态文档与稳定计划、历史文档的区别。', lifecycle: 'reference' }),
          createField({ id: 'basic-term-next-step', label: '下一原子步骤', guidance: '解释恢复后唯一具体执行入口的含义。', lifecycle: 'reference' }),
        ]),
        section('custom-term-template', '自定义术语模板', '解释概念、反例和归属。', 'reference', 4, [
          createField({ id: 'term-template', label: '术语模板', guidance: '含义、不等于、归属、例子。', lifecycle: 'reference' }),
        ]),
        section('context-boundaries', '边界说明', '记录术语不覆盖实时事实的边界。', 'reference', 5, [
          createField({ id: 'context-boundary', label: '边界', guidance: 'CONTEXT 只解释术语，不能覆盖实时状态、计划或历史。', lifecycle: 'reference' }),
        ]),
        section('context-maintenance-rules', '维护规则', '说明术语新增、改名和变更时如何维护。', 'reference', 6, [
          createField({ id: 'context-maintenance', label: '维护规则', guidance: '新增抽象术语、改名术语或改变含义时更新 CONTEXT。', lifecycle: 'reference' }),
        ]),
      ],
    }),
  ]

  return {
    schemaVersion: SCHEMA_VERSION,
    workflowId: `workflow-${Date.now()}`,
    name: '当前标准工作流',
    description: 'AGENTS.md + 5 个 HTML 恢复文档的本地优先工作流预设。',
    createdAt,
    updatedAt: createdAt,
    maintenanceFormat: 'html',
    secondaryFormat: 'markdown',
    documents,
    rules: {
      recoveryOrder: documents.map((doc, index) => ({
        id: `recovery-${doc.id}`,
        documentId: doc.id,
        condition: index < 3 ? '恢复时必读' : '按需读取',
        required: index < 3,
        fallbackStepIds: [],
      })),
      sourcePriority: [
        {
          id: 'global-source-priority',
          scope: 'global',
          tieBreaker: 'explicit-user-confirmation',
          reason: '按最新用户指令和新鲜工作区事实优先裁决。',
          orderedSources: [
            { sourceType: 'latest-user-instruction', label: '最新明确用户指令', priority: 1, recencyPolicy: 'prefer-newer' },
            { sourceType: 'workspace-fact', label: '新鲜工作区事实和工具输出', priority: 2, recencyPolicy: 'prefer-newer' },
            { sourceType: 'current-status', label: 'STATUS.html', documentId: 'status', priority: 3, recencyPolicy: 'prefer-newer' },
            { sourceType: 'stable-plan', label: 'SPEC.html', documentId: 'spec', priority: 4, recencyPolicy: 'ignore-recency' },
            { sourceType: 'user-preference', label: 'USER.html', documentId: 'user', priority: 5, recencyPolicy: 'ignore-recency' },
            { sourceType: 'session-history', label: '当前会话历史', priority: 6, recencyPolicy: 'prefer-newer' },
            { sourceType: 'memory-history', label: 'MEMORY.html', documentId: 'memory', priority: 7, recencyPolicy: 'manual' },
            { sourceType: 'older-history', label: '更早历史', priority: 8, recencyPolicy: 'manual' },
            { sourceType: 'context-reference', label: 'CONTEXT.html', documentId: 'context', priority: 9, recencyPolicy: 'ignore-recency' },
          ],
        },
      ],
      updateTriggers: documents.map((doc) => ({
        id: `trigger-${doc.id}`,
        targetDocumentId: doc.id,
        trigger: `${doc.title} 职责范围内信息变化`,
        requiredAction: doc.lifecycle === 'historical' ? '追加历史条目' : '替换失效实时信息',
      })),
      completionChecks: [
        {
          id: 'check-verify',
          label: '验证交付结果',
          description: '用命令、测试、截图或清单验证交付结果。',
          severityWhenMissing: 'error',
          relatedDocumentIds: ['agents', 'status'],
        },
        {
          id: 'check-docs-current',
          label: '恢复文档最新',
          description: '确认实时文档没有失效信息，历史写入 MEMORY。',
          severityWhenMissing: 'warning',
          relatedDocumentIds: ['status', 'memory'],
        },
      ],
      conflictPolicy: {
        defaultAction: 'apply-source-priority',
        requireExplicitNoteForManualOverride: true,
        unresolvedConflictSeverity: 'error',
      },
      historyPolicy: {
        appendOnly: true,
        allowedStatuses: ['仍有效参考', '已失效归档'],
        requireIndexUpdate: true,
        obsoleteHandling: 'archive-with-replacement',
      },
    },
    exportSettings: DEFAULT_EXPORT_SETTINGS,
    scoringSettings: DEFAULT_SCORING_SETTINGS,
    acceptedWarnings: [],
  }
}

export function createBlankWorkflow(): WorkflowSchema {
  const createdAt = now()
  return {
    schemaVersion: SCHEMA_VERSION,
    workflowId: `workflow-${Date.now()}`,
    name: '空白工作流',
    description: '从零开始设计文档、字段和恢复规则。',
    createdAt,
    updatedAt: createdAt,
    maintenanceFormat: 'html',
    documents: [
      document({
        id: 'protocol',
        filename: 'AGENTS.md',
        title: '工作流协议',
        role: 'protocol',
        lifecycle: 'mixed',
        description: '恢复入口和协议说明。',
        order: 1,
        sections: [
          section('recovery', '恢复路径', '定义恢复读取顺序。', 'validation', 1, [
            createField({ id: 'recovery-order', label: '恢复顺序', guidance: '至少说明恢复入口。', lifecycle: 'validation', required: true }),
          ]),
        ],
      }),
      document({
        id: 'blank-status',
        filename: 'STATUS.html',
        title: '状态快照',
        role: 'status',
        lifecycle: 'realtime',
        description: '当前状态、工作入口、下一原子步骤和阻塞确认。',
        order: 2,
        sections: [
          section('blank-anchor', '项目锚点', '记录工作入口和当前目标。', 'realtime', 1, [
            createField({ id: 'blank-work-entry', label: '工作入口', guidance: '允许项目根、worktree、子目录、远端或容器路径。', lifecycle: 'realtime' }),
            createField({ id: 'blank-current-goal', label: '当前目标', guidance: '记录当前仍有效目标。', lifecycle: 'realtime' }),
          ]),
          section('blank-next-step-section', '下一原子步骤', '恢复后唯一具体入口。', 'realtime', 2, [
            createField({ id: 'blank-next-atomic-step', label: '下一原子步骤', guidance: '唯一、具体、可执行。', lifecycle: 'realtime', required: true }),
          ]),
        ],
      }),
    ],
    rules: {
      recoveryOrder: [
        { id: 'recovery-protocol', documentId: 'protocol', condition: '恢复时读取', required: true, fallbackStepIds: [] },
        { id: 'recovery-blank-status', documentId: 'blank-status', condition: '恢复当前状态和下一步时读取', required: true, fallbackStepIds: [] },
      ],
      sourcePriority: [],
      updateTriggers: [
        { id: 'trigger-protocol', targetDocumentId: 'protocol', trigger: '协议规则变化', requiredAction: '更新 AGENTS.md' },
        { id: 'trigger-blank-status', targetDocumentId: 'blank-status', trigger: '当前状态变化', requiredAction: '替换 STATUS.html 中失效状态' },
      ],
      completionChecks: [],
      conflictPolicy: {
        defaultAction: 'ask-user',
        requireExplicitNoteForManualOverride: true,
        unresolvedConflictSeverity: 'warning',
      },
      historyPolicy: {
        appendOnly: true,
        allowedStatuses: ['active-reference', 'obsolete-archive'],
        requireIndexUpdate: false,
        obsoleteHandling: 'mark-obsolete',
      },
    },
    exportSettings: DEFAULT_EXPORT_SETTINGS,
    scoringSettings: DEFAULT_SCORING_SETTINGS,
    acceptedWarnings: [],
  }
}
