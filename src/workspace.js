import { realpath, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_ALLOWED_PATHS = 100
const MAX_AGENT_FILE_BYTES = 64 * 1024
const MAX_INSTRUCTIONS_BYTES = 256 * 1024

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function normalizedKey(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

async function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`)
  }

  let resolved
  try {
    resolved = await realpath(value)
  } catch {
    throw new Error(`${label} does not exist or cannot be resolved`)
  }

  try {
    if (!(await stat(resolved)).isDirectory()) {
      throw new Error(`${label} must be a directory`)
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be a directory`) throw error
    throw new Error(`${label} cannot be inspected`)
  }

  return resolved
}

export async function validateWorkspace(workspace, allowedWorkspaceRoots) {
  if (!Array.isArray(allowedWorkspaceRoots) || allowedWorkspaceRoots.length === 0) {
    throw new Error('at least one allowed workspace root is required')
  }

  const workspacePath = await canonicalDirectory(workspace, 'workspace')
  const roots = await Promise.all(allowedWorkspaceRoots.map((root, index) => (
    canonicalDirectory(root, `workspace root ${index + 1}`)
  )))
  const matchingRoots = roots
    .filter(root => isWithin(root, workspacePath))
    .sort((left, right) => right.length - left.length)

  if (matchingRoots.length === 0) {
    throw new Error('workspace is outside configured workspace roots')
  }

  return {
    workspacePath,
    allowedRoot: matchingRoots[0],
  }
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('allowed_paths entries must be non-empty relative paths')
  }

  const candidate = value.trim()
  if (
    path.isAbsolute(candidate)
    || /^[a-zA-Z]:/.test(candidate)
    || candidate.startsWith('\\\\')
  ) {
    throw new Error(`allowed_paths entry must be a project-relative path: ${candidate}`)
  }

  const segments = candidate.split(/[\\/]+/)
  if (segments.some(segment => segment === '..' || segment === '')) {
    throw new Error(`allowed_paths entry must not traverse outside the workspace: ${candidate}`)
  }

  return path.normalize(candidate)
}

export async function resolveAllowedPaths(workspace, allowedPaths = []) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length > MAX_ALLOWED_PATHS) {
    throw new Error(`allowed_paths must contain at most ${MAX_ALLOWED_PATHS} entries`)
  }

  const workspacePath = await canonicalDirectory(workspace, 'workspace')
  const resolved = []
  const seen = new Set()

  for (const entry of allowedPaths) {
    const relativePath = validateRelativePath(entry)
    const lexicalPath = path.resolve(workspacePath, relativePath)
    if (!isWithin(workspacePath, lexicalPath)) {
      throw new Error(`allowed_paths entry resolves outside workspace: ${entry}`)
    }

    let absolutePath
    try {
      absolutePath = await realpath(lexicalPath)
    } catch {
      throw new Error(`allowed_paths target does not exist: ${entry}`)
    }

    if (!isWithin(workspacePath, absolutePath)) {
      throw new Error(`allowed_paths target resolves outside workspace: ${entry}`)
    }

    let metadata
    try {
      metadata = await stat(absolutePath)
    } catch {
      throw new Error(`allowed_paths target cannot be inspected: ${entry}`)
    }
    if (!metadata.isFile() && !metadata.isDirectory()) {
      throw new Error(`allowed_paths target must be a file or directory: ${entry}`)
    }

    const key = normalizedKey(absolutePath)
    if (!seen.has(key)) {
      seen.add(key)
      resolved.push({
        relativePath: path.relative(workspacePath, lexicalPath).split(path.sep).join('/'),
        absolutePath,
        isDirectory: metadata.isDirectory(),
      })
    }
  }

  return resolved
}

function directoryChain(root, targetDirectory) {
  if (!isWithin(root, targetDirectory)) {
    throw new Error('instruction target is outside the allowed workspace root')
  }

  const chain = [targetDirectory]
  let current = targetDirectory
  while (normalizedKey(current) !== normalizedKey(root)) {
    const parent = path.dirname(current)
    if (normalizedKey(parent) === normalizedKey(current) || !isWithin(root, parent)) {
      throw new Error('cannot construct the workspace instruction path')
    }
    chain.push(parent)
    current = parent
  }
  return chain.reverse()
}

export async function readApplicableInstructions({ workspacePath, allowedRoot, allowedPaths = [] }) {
  const validated = await validateWorkspace(workspacePath, [allowedRoot])
  const targets = await resolveAllowedPaths(
    validated.workspacePath,
    allowedPaths.map(item => item.relativePath),
  )
  const directories = new Map()

  for (const directory of directoryChain(validated.allowedRoot, validated.workspacePath)) {
    directories.set(normalizedKey(directory), directory)
  }

  for (const target of targets) {
    const targetDirectory = target.isDirectory ? target.absolutePath : path.dirname(target.absolutePath)
    for (const directory of directoryChain(validated.workspacePath, targetDirectory)) {
      directories.set(normalizedKey(directory), directory)
    }
  }

  const instructions = []
  let totalBytes = 0
  for (const directory of directories.values()) {
    const instructionPath = path.join(directory, 'AGENTS.md')
    let metadata
    try {
      metadata = await stat(instructionPath)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw new Error(`cannot inspect applicable instructions at ${instructionPath}`)
    }

    if (!metadata.isFile()) {
      throw new Error(`applicable AGENTS.md is not a regular file: ${instructionPath}`)
    }
    if (metadata.size > MAX_AGENT_FILE_BYTES) {
      throw new Error(`applicable AGENTS.md exceeds ${MAX_AGENT_FILE_BYTES} bytes: ${instructionPath}`)
    }

    let physicalPath
    let content
    try {
      physicalPath = await realpath(instructionPath)
      if (!isWithin(validated.allowedRoot, physicalPath)) {
        throw new Error('instruction path resolves outside the allowed root')
      }
      content = await readFile(physicalPath, 'utf8')
    } catch {
      throw new Error(`cannot read applicable instructions at ${instructionPath}`)
    }

    totalBytes += Buffer.byteLength(content, 'utf8')
    if (totalBytes > MAX_INSTRUCTIONS_BYTES) {
      throw new Error(`applicable AGENTS.md files exceed ${MAX_INSTRUCTIONS_BYTES} bytes in total`)
    }
    instructions.push({ path: physicalPath, content })
  }

  return instructions
}
