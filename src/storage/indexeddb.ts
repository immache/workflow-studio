import { createStore, del, get, keys, set } from 'idb-keyval'
import type { WorkflowSchema } from '../domain/schema'

export type WorkflowProjectMeta = {
  id: string
  name: string
  description: string
  updatedAt: string
}

const database = createStore('workflow-studio', 'workflows')
const projectPrefix = 'workflow:'
const activeProjectKey = 'active-workflow-id'

function projectKey(id: string): string {
  return `${projectPrefix}${id}`
}

export async function assertStorageAvailable(): Promise<void> {
  const probeKey = '__workflow_studio_probe__'
  await set(probeKey, { ok: true }, database)
  await del(probeKey, database)
}

export async function listWorkflowProjects(): Promise<WorkflowProjectMeta[]> {
  const allKeys = await keys(database)
  const workflowKeys = allKeys.filter((key): key is string => typeof key === 'string' && key.startsWith(projectPrefix))
  const workflows = await Promise.all(workflowKeys.map((key) => get<WorkflowSchema>(key, database)))
  return workflows
    .filter((workflow): workflow is WorkflowSchema => Boolean(workflow))
    .map((workflow) => ({
      id: workflow.workflowId,
      name: workflow.name,
      description: workflow.description,
      updatedAt: workflow.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function loadWorkflowProject(id: string): Promise<WorkflowSchema | undefined> {
  return get<WorkflowSchema>(projectKey(id), database)
}

export async function loadActiveWorkflowProjectId(): Promise<string | undefined> {
  return get<string>(activeProjectKey, database)
}

export async function saveActiveWorkflowProjectId(id: string): Promise<void> {
  await set(activeProjectKey, id, database)
}

export async function saveWorkflowProject(workflow: WorkflowSchema): Promise<void> {
  await set(projectKey(workflow.workflowId), workflow, database)
}

export async function deleteWorkflowProject(id: string): Promise<void> {
  await del(projectKey(id), database)
}
