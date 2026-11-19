import { realpath, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const configSchema = z.object({
  dshCommandPath: z.string().trim().min(1),
  allowedWorkspaceRoots: z.array(z.string().trim().min(1)).min(1).max(100),
  maxConcurrentTasks: z.number().int().min(1).max(8).default(3),
  defaultTimeoutSeconds: z.number().int().min(10).max(3600).default(900),
  maxTimeoutSeconds: z.number().int().min(10).max(3600).default(3600),
}).strict().superRefine((config, context) => {
  if (config.defaultTimeoutSeconds > config.maxTimeoutSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultTimeoutSeconds'],
      message: 'must not exceed maxTimeoutSeconds',
    })
  }

  if (!path.isAbsolute(config.dshCommandPath)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dshCommandPath'],
      message: 'must be an absolute path',
    })
  }

  config.allowedWorkspaceRoots.forEach((root, index) => {
    if (!path.isAbsolute(root)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedWorkspaceRoots', index],
        message: 'must be an absolute path',
      })
    }
  })
})

function userConfigPath(env) {
  if (env.CODEX_DSH_BRIDGE_CONFIG?.trim()) {
    return env.CODEX_DSH_BRIDGE_CONFIG.trim()
  }

  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'CodexDshBridge', 'config.json')
}

function formatIssues(error) {
  return error.issues
    .map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`)
    .join('; ')
}

async function canonicalFile(filePath, label) {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute path`)
  }

  let resolved
  try {
    resolved = await realpath(filePath)
  } catch {
    throw new Error(`${label} does not exist or cannot be resolved`)
  }

  let metadata
  try {
    metadata = await stat(resolved)
  } catch {
    throw new Error(`${label} cannot be inspected`)
  }

  if (!metadata.isFile()) {
    throw new Error(`${label} must be a file`)
  }

  return resolved
}

async function canonicalDirectory(directoryPath, label) {
  if (!path.isAbsolute(directoryPath)) {
    throw new Error(`${label} must be an absolute path`)
  }

  let resolved
  try {
    resolved = await realpath(directoryPath)
  } catch {
    throw new Error(`${label} does not exist or cannot be resolved`)
  }

  let metadata
  try {
    metadata = await stat(resolved)
  } catch {
    throw new Error(`${label} cannot be inspected`)
  }

  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be a directory`)
  }

  return resolved
}

export async function loadConfig({ env = process.env } = {}) {
  const requestedPath = userConfigPath(env)
  if (!path.isAbsolute(requestedPath)) {
    throw new Error('bridge config path must be absolute')
  }

  const configPath = path.resolve(requestedPath)
  let raw
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`bridge config contains invalid JSON: ${error.message}`)
    }
    throw new Error(`cannot read bridge config at ${configPath}`)
  }

  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`invalid bridge config: ${formatIssues(parsed.error)}`)
  }

  const dshCommandPath = await canonicalFile(parsed.data.dshCommandPath, 'DSH launcher')
  const roots = await Promise.all(parsed.data.allowedWorkspaceRoots.map((root, index) => (
    canonicalDirectory(root, `workspace root ${index + 1}`)
  )))
  const seenRoots = new Set()
  const allowedWorkspaceRoots = roots.filter(root => {
    const key = process.platform === 'win32' ? root.toLocaleLowerCase('en-US') : root
    if (seenRoots.has(key)) return false
    seenRoots.add(key)
    return true
  })

  return {
    configPath,
    dshCommandPath,
    allowedWorkspaceRoots,
    maxConcurrentTasks: parsed.data.maxConcurrentTasks,
    defaultTimeoutSeconds: parsed.data.defaultTimeoutSeconds,
    maxTimeoutSeconds: parsed.data.maxTimeoutSeconds,
  }
}
