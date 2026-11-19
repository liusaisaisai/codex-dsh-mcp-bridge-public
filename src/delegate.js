import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  readApplicableInstructions,
  resolveAllowedPaths,
  validateWorkspace,
} from './workspace.js'

const MAX_OUTPUT_CHARS = 16000
const MAX_SUMMARY_CHARS = 4000

export const DELEGATION_INPUT_SCHEMA = z.object({
  task: z.string().trim().min(10).max(20000),
  workspace: z.string().trim().min(1).max(4096),
  mode: z.enum(['analysis', 'edit']),
  allowed_paths: z.array(z.string().trim().min(1).max(1024)).max(100).optional(),
  acceptance_criteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  checks: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
  timeout_seconds: z.number().int().min(10).max(3600).optional(),
}).strict()

const CHECK_RESULT_SCHEMA = z.object({
  command: z.string(),
  exit_code: z.number().int().nullable(),
  result: z.string(),
  status: z.enum(['passed', 'failed', 'not_reported']),
})

export const DELEGATION_RESULT_SCHEMA = z.object({
  task_id: z.string().uuid(),
  status: z.enum(['completed', 'partial', 'blocked', 'cancelled', 'failed']),
  summary: z.string(),
  details: z.string(),
  files_changed: z.array(z.string()),
  agent_reported_files: z.array(z.string()),
  checks: z.array(CHECK_RESULT_SCHEMA),
  worktree_path: z.string().nullable(),
  baseline_commit: z.string().nullable(),
  unresolved_questions: z.array(z.string()),
  error_kind: z.string().nullable(),
})

const agentReportSchema = z.object({
  summary: z.string().max(5000),
  findings: z.string().max(12000).optional().default(''),
  files_changed: z.array(z.string().max(1024)).max(100).optional().default([]),
  checks: z.array(z.object({
    command: z.string().min(1).max(1000),
    exit_code: z.number().int().nullable().optional().default(null),
    result: z.string().max(2000).optional().default(''),
  }).strict()).max(30).optional().default([]),
  unresolved_questions: z.array(z.string().max(2000)).max(30).optional().default([]),
}).passthrough()

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n[truncated]`
}

function failureResult(taskId, errorKind, summary, details = '') {
  return {
    task_id: taskId,
    status: errorKind === 'edit_mode_disabled' ? 'blocked' : 'failed',
    summary,
    details: truncate(details, MAX_OUTPUT_CHARS),
    files_changed: [],
    agent_reported_files: [],
    checks: [],
    worktree_path: null,
    baseline_commit: null,
    unresolved_questions: [],
    error_kind: errorKind,
  }
}

function validationDetails(error) {
  return error.issues
    .map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`)
    .join('; ')
}

function parseReportCandidate(candidate) {
  try {
    const parsed = agentReportSchema.safeParse(JSON.parse(candidate))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function findJsonReport(output) {
  let candidates = 0
  for (let start = output.indexOf('{'); start !== -1 && candidates < 256; start = output.indexOf('{', start + 1)) {
    candidates += 1
    let depth = 0
    let inString = false
    let escaped = false

    for (let end = start; end < output.length; end += 1) {
      const character = output[end]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          const report = parseReportCandidate(output.slice(start, end + 1))
          if (report !== undefined) return report
          break
        }
      }
    }
  }
  return undefined
}

function extractJsonReport(output) {
  const trimmed = output.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const report = parseReportCandidate(fenced?.[1] ?? trimmed) ?? findJsonReport(trimmed)
  if (report === undefined) return { valid: false }
  return { report, valid: true }
}

function normalizeChecks(requestedChecks, reportedChecks) {
  const reports = new Map(reportedChecks.map(item => [item.command, item]))
  const results = []
  const seen = new Set()

  for (const command of requestedChecks) {
    const reported = reports.get(command)
    seen.add(command)
    results.push(reported === undefined
      ? { command, exit_code: null, result: 'DSH did not report this check.', status: 'not_reported' }
      : {
        command,
        exit_code: reported.exit_code,
        result: reported.result,
        status: reported.exit_code === null ? 'not_reported' : reported.exit_code === 0 ? 'passed' : 'failed',
      })
  }

  for (const reported of reportedChecks) {
    if (seen.has(reported.command)) continue
    results.push({
      command: reported.command,
      exit_code: reported.exit_code,
      result: reported.result,
      status: reported.exit_code === null ? 'not_reported' : reported.exit_code === 0 ? 'passed' : 'failed',
    })
  }
  return results
}

function buildPrompt({ task, workspace, allowedPaths, acceptanceCriteria, checks, instructions }) {
  const instructionText = instructions.length === 0
    ? 'No applicable AGENTS.md files were found.'
    : instructions.map(item => {
      const relative = item.path.startsWith(workspace)
        ? item.path.slice(workspace.length).replace(/^[\\/]+/, '') || 'AGENTS.md'
        : `ancestor/${item.path.split(/[\\/]/).at(-2)}/AGENTS.md`
      return `### ${relative}\n${item.content.trim()}`
    }).join('\n\n')
  const scopeText = allowedPaths.length === 0
    ? 'No narrower allowed_paths scope was specified.'
    : allowedPaths.map(item => `- ${item.relativePath}`).join('\n')
  const checksText = checks.length === 0 ? 'No checks requested.' : checks.map(item => `- ${item}`).join('\n')

  return [
    'You are DeepSeek Harness performing one bounded analysis task for Codex.',
    'This task is read-only. Do not create, edit, rename, or delete files. The bridge enforces DSH_PERMISSION_MODE=read-only and rejects ACP permission requests.',
    'Treat the supplied project rules as applicable instructions. Do not assume access outside the supplied workspace.',
    '',
    'Applicable project instructions:',
    instructionText,
    '',
    `Workspace: ${workspace}`,
    'Requested path scope:',
    scopeText,
    '',
    'Task:',
    task,
    '',
    'Acceptance criteria:',
    acceptanceCriteria.map(item => `- ${item}`).join('\n'),
    '',
    'Requested checks:',
    checksText,
    '',
    'Run only checks that are compatible with read-only mode. Never claim a check ran unless it actually ran; use a null exit_code for checks not run.',
    'Return only one JSON object with this shape: {"summary":"...","findings":"...","files_changed":[],"checks":[{"command":"...","exit_code":0,"result":"..."}],"unresolved_questions":[]}.',
    'In analysis mode files_changed must be an empty array. Keep the summary concise and use paths relative to the workspace.',
  ].join('\n')
}

function statusForStopReason(stopReason) {
  switch (stopReason) {
    case 'end_turn': return 'completed'
    case 'max_tokens': return 'partial'
    case 'refusal': return 'blocked'
    case 'cancelled': return 'cancelled'
    default: return 'failed'
  }
}

export class DshDelegate {
  #config
  #acpClient
  #activeTasks = 0

  constructor({ config, acpClient }) {
    this.#config = config
    this.#acpClient = acpClient
  }

  async delegate(input, { signal } = {}) {
    const taskId = randomUUID()
    const parsed = DELEGATION_INPUT_SCHEMA.safeParse(input)
    if (!parsed.success) {
      return failureResult(taskId, 'invalid_request', 'The delegation request is invalid.', validationDetails(parsed.error))
    }
    const request = parsed.data

    if (request.mode === 'edit') {
      return failureResult(
        taskId,
        'edit_mode_disabled',
        'Edit mode is disabled until the Windows sandbox boundary is verified.',
      )
    }
    if (request.timeout_seconds !== undefined && request.timeout_seconds > this.#config.maxTimeoutSeconds) {
      return failureResult(taskId, 'invalid_timeout', 'The requested timeout exceeds the configured maximum.')
    }
    if (signal?.aborted) {
      const result = failureResult(taskId, 'cancelled', 'The task was cancelled before it started.')
      result.status = 'cancelled'
      return result
    }
    if (this.#activeTasks >= this.#config.maxConcurrentTasks) {
      return failureResult(taskId, 'capacity', 'The configured DSH task capacity is full.')
    }

    this.#activeTasks += 1
    try {
      let workspace
      try {
        workspace = await validateWorkspace(request.workspace, this.#config.allowedWorkspaceRoots)
      } catch (error) {
        return failureResult(taskId, 'invalid_workspace', 'The workspace is invalid or outside configured roots.', error.message)
      }

      let allowedPaths
      let instructions
      try {
        allowedPaths = await resolveAllowedPaths(workspace.workspacePath, request.allowed_paths ?? [])
        instructions = await readApplicableInstructions({
          workspacePath: workspace.workspacePath,
          allowedRoot: workspace.allowedRoot,
          allowedPaths,
        })
      } catch (error) {
        return failureResult(taskId, 'invalid_scope', 'The requested workspace scope or project instructions could not be loaded.', error.message)
      }

      const timeoutSeconds = request.timeout_seconds ?? this.#config.defaultTimeoutSeconds
      const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000)
      const taskSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
      const prompt = buildPrompt({
        task: request.task,
        workspace: workspace.workspacePath,
        allowedPaths,
        acceptanceCriteria: request.acceptance_criteria,
        checks: request.checks ?? [],
        instructions,
      })

      let execution
      try {
        execution = await this.#acpClient.runTask({
          cwd: workspace.workspacePath,
          prompt,
          signal: taskSignal,
        })
      } catch (error) {
        if (signal?.aborted) {
          const result = failureResult(taskId, 'cancelled', 'The delegated task was cancelled.', error.partialOutput ?? '')
          result.status = 'cancelled'
          return result
        }
        if (timeoutSignal.aborted) {
          const result = failureResult(taskId, 'timeout', 'The delegated task exceeded its timeout.', error.partialOutput ?? '')
          result.status = 'cancelled'
          return result
        }
        return failureResult(taskId, error.kind ?? 'acp_error', 'DeepSeek Harness could not complete the delegated task.', error.partialOutput ?? '')
      }

      if (signal?.aborted || execution.stopReason === 'cancelled') {
        const result = failureResult(taskId, 'cancelled', 'The delegated task was cancelled.', execution.output ?? '')
        result.status = 'cancelled'
        return result
      }
      if (timeoutSignal.aborted) {
        const result = failureResult(taskId, 'timeout', 'The delegated task exceeded its timeout.', execution.output ?? '')
        result.status = 'cancelled'
        return result
      }

      const output = truncate(execution.output ?? '', MAX_OUTPUT_CHARS)
      const parsedReport = extractJsonReport(output)
      const report = parsedReport.valid ? parsedReport.report : {
        summary: output || 'DeepSeek Harness returned no assistant text.',
        findings: output,
        files_changed: [],
        checks: [],
        unresolved_questions: [],
      }
      let status = statusForStopReason(execution.stopReason)
      let errorKind = status === 'failed' ? `agent_${execution.stopReason ?? 'unknown_stop_reason'}` : null
      const unresolvedQuestions = [...report.unresolved_questions]

      if (!parsedReport.valid) {
        unresolvedQuestions.push('DSH did not return the required JSON report; check statuses could not be verified.')
      }
      if (execution.permissionDenied) {
        status = 'blocked'
        errorKind = 'permission_denied'
        unresolvedQuestions.push('The bridge rejected an ACP permission request.')
      }
      if (report.files_changed.length > 0) {
        status = 'blocked'
        errorKind = 'reported_changes_in_analysis'
        unresolvedQuestions.push('DSH reported file changes during an analysis-only task; inspect the workspace before continuing.')
      }

      return {
        task_id: taskId,
        status,
        summary: truncate(report.summary || 'Analysis completed.', MAX_SUMMARY_CHARS),
        details: truncate(report.findings || output, MAX_OUTPUT_CHARS),
        files_changed: [],
        agent_reported_files: [...new Set(report.files_changed)],
        checks: normalizeChecks(request.checks ?? [], report.checks),
        worktree_path: null,
        baseline_commit: null,
        unresolved_questions: unresolvedQuestions,
        error_kind: errorKind,
      }
    } catch (error) {
      return failureResult(taskId, 'bridge_error', 'The bridge could not prepare the delegated task.', error.message)
    } finally {
      this.#activeTasks -= 1
    }
  }
}
