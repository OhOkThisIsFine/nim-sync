import fs from 'fs/promises'
import path from 'path'
import { applyEdits, modify as modifyJSONC, parse as parseJSONC } from 'jsonc-parser/lib/esm/main.js'
import type { LockMetadata, PlatformPaths } from '../types/index.js'

/**
 * Options for atomic file write operations.
 */
export interface AtomicWriteOptions {
  /** Whether to create a backup before overwriting */
  backup?: boolean
  /** Whether to create backup directory if it doesn't exist */
  createBackupDir?: boolean
}

/**
 * Timeout for NVIDIA API requests in milliseconds.
 */
export const API_TIMEOUT_MS = 30_000

/**
 * Time-to-live for cached model data in milliseconds (24 hours).
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Threshold for considering a lock stale in milliseconds (5 minutes).
 */
export const LOCK_STALE_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Interval between lock acquisition retry attempts in milliseconds.
 */
export const LOCK_RETRY_INTERVAL_MS = 100

/**
 * Minimum interval between manual refresh operations in milliseconds (60 seconds).
 */
export const MIN_MANUAL_REFRESH_INTERVAL_MS = 60_000

/**
 * Maximum number of backup files to retain.
 */
export const MAX_BACKUPS = 5

/**
 * Reads and parses a JSONC (JSON with Comments) file.
 * 
 * @param filePath - Path to the JSONC file
 * @param validate - Optional validation function to ensure type safety
 * @returns Parsed content of type T, or empty object if file doesn't exist
 * @throws Error if file read fails (except ENOENT) or if validation fails
 */
export async function readJSONC<T = unknown>(
  filePath: string,
  validate?: (data: unknown) => data is T
): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const errors: { error: number; offset: number; length: number }[] = []
    const result = parseJSONC(content, errors)

    if (errors.length > 0) {
      const errorDetails = errors
        .map(e => `Parse error code ${e.error} at offset ${e.offset}`)
        .join('; ')
      throw new Error(`JSONC parse errors in ${filePath}: ${errorDetails}`)
    }

    if (validate && !validate(result)) {
      throw new Error(`Invalid data structure in ${filePath}`)
    }

    return result as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {} as T
    }
    throw error
  }
}

/**
 * Writes data to a JSONC file with atomic operations.
 * 
 * @param filePath - Path to write the file
 * @param data - Data to serialize as JSON
 * @param options - Optional backup and directory creation settings
 */
export async function writeJSONC<T = unknown>(
  filePath: string,
  data: T,
  options?: AtomicWriteOptions
): Promise<void> {
  const content = JSON.stringify(data, null, 2)
  await atomicWrite(filePath, content, options)
}

/**
 * Updates a specific path within a JSONC file while preserving unrelated
 * comments and formatting.
 *
 * @param filePath - Path to the JSONC file
 * @param jsonPath - JSON path to update
 * @param data - Value to write at the given path
 * @param options - Optional backup and directory creation settings
 */
export async function updateJSONCPath<T = unknown>(
  filePath: string,
  jsonPath: Array<string | number>,
  data: T,
  options?: AtomicWriteOptions
): Promise<void> {
  let existingContent = ''

  try {
    existingContent = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const eol = existingContent.includes('\r\n') ? '\r\n' : '\n'
  const edits = modifyJSONC(existingContent, jsonPath, data, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol
    }
  })
  const updatedContent = applyEdits(existingContent, edits)

  await atomicWrite(filePath, updatedContent, options)
}

/**
 * Atomically writes content to a file using temp file + rename pattern.
 * Optionally creates backups before overwriting and cleans up old backups.
 * 
 * @param filePath - Path to write the file
 * @param content - String content to write
 * @param options - Optional backup and directory creation settings
 */
export async function atomicWrite(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const dir = path.dirname(filePath)
  const tempPath = `${filePath}.${Date.now()}.tmp`

  try {
    await fs.mkdir(dir, { recursive: true })

    if (options.backup) {
      try {
        await fs.access(filePath)

        const backupDir = path.join(dir, 'backups')
        if (options.createBackupDir) {
          await fs.mkdir(backupDir, { recursive: true })
        }

        const backupPath = path.join(backupDir, `${path.basename(filePath)}.${Date.now()}.bak`)
        await fs.copyFile(filePath, backupPath)
        
        // Clean up old backups after creating new one
        await cleanupOldBackups(backupDir, path.basename(filePath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Failed to create backup: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      }
    }

    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  } catch (error) {
    try {
      await fs.unlink(tempPath)
    } catch {
      // Ignore temp file cleanup failures
    }
    throw error
  }
}

/**
 * Ensures a directory exists, creating it recursively if needed.
 * 
 * @param dirPath - Path to the directory
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
}

/**
 * Returns platform-specific paths for config, data, and cache directories.
 * Handles Windows, Linux, and macOS path conventions.
 * 
 * @returns Platform-specific directory paths
 * @example
 * ```typescript
 * const paths = getPlatformPaths()
 * // Windows: { config: 'C:\\Users\\username\\AppData\\Roaming\\opencode', ... }
 * // Linux: { config: '/home/username/.config/opencode', ... }
 * ```
 */
function getPlatformPaths(): PlatformPaths {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const isWindows = process.platform === 'win32'
  
  return {
    config: isWindows 
      ? path.join(home, 'AppData', 'Roaming', 'opencode')
      : path.join(home, '.config', 'opencode'),
    data: isWindows
      ? path.join(home, 'AppData', 'Roaming', 'opencode')
      : path.join(home, '.local', 'share', 'opencode'),
    cache: isWindows
      ? path.join(home, 'AppData', 'Local', 'opencode', 'cache')
      : path.join(home, '.cache', 'opencode')
  }
}

/**
 * Returns the platform-specific config directory path.
 * 
 * @returns Config directory path
 */
export function getConfigDir(): string {
  return getPlatformPaths().config
}

/**
 * Returns the platform-specific cache directory path.
 * 
 * @returns Cache directory path
 */
export function getCacheDir(): string {
  return getPlatformPaths().cache
}

/**
 * Returns the platform-specific data directory path.
 * 
 * @returns Data directory path
 */
export function getDataDir(): string {
  return getPlatformPaths().data
}

/**
 * Checks if a process with the given PID is currently running.
 * Uses a non-destructive signal (0) to check process existence.
 * 
 * @param pid - Process ID to check
 * @returns true if the process exists, false otherwise
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Cleans up old backup files, keeping only the most recent MAX_BACKUPS.
 * 
 * @param backupDir - Directory containing backup files
 * @param baseName - Base name of the file being backed up
 */
async function cleanupOldBackups(backupDir: string, baseName: string): Promise<void> {
  try {
    const files = await fs.readdir(backupDir)
    const backups = files
      .filter(f => f.startsWith(baseName) && f.endsWith('.bak'))
      .map(f => ({
        name: f,
        // Extract timestamp from filename like "file.json.1234567890.bak"
        timestamp: parseInt(f.split('.').slice(-2, -1)[0]) || 0
      }))
      .sort((a, b) => b.timestamp - a.timestamp) // Sort newest first
    
    // Keep only the most recent backups
    for (const oldBackup of backups.slice(MAX_BACKUPS)) {
      await fs.unlink(path.join(backupDir, oldBackup.name))
    }
  } catch {
    // Ignore cleanup failures - don't want to fail the main operation
  }
}

/**
 * Acquires an exclusive lock for coordinating file operations.
 * Automatically cleans up stale locks from crashed processes.
 * 
 * @param lockName - Name of the lock
 * @param timeoutMs - Maximum time to wait for lock acquisition (default: 5000ms)
 * @returns Function to release the lock
 * @throws Error if lock cannot be acquired within timeout
 */
export async function acquireLock(lockName: string, timeoutMs = 5000): Promise<() => Promise<void>> {
  const lockDir = getCacheDir()
  const lockPath = path.join(lockDir, `${lockName}.lock`)

  await ensureDir(lockDir)

  try {
    const lockContent = await fs.readFile(lockPath, 'utf-8')
    const metadata = JSON.parse(lockContent) as LockMetadata
    const staleThreshold = Date.now() - LOCK_STALE_THRESHOLD_MS
    
    // Check if timestamp is stale OR if the holding process is no longer running
    const isStale = metadata.timestamp < staleThreshold
    const processExists = metadata.pid ? isProcessRunning(metadata.pid) : true
    
    // Note: TOCTOU race possible between check and delete, but mitigated by
    // atomic 'wx' flag in subsequent fs.open() call which provides ultimate protection
    if (isStale || !processExists) {
      await fs.unlink(lockPath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Failed to clean up stale lock')
    }
  }

  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    try {
      const fd = await fs.open(lockPath, 'wx')
      const metadata: LockMetadata = {
        pid: process.pid,
        timestamp: Date.now()
      }
      await fd.writeFile(JSON.stringify(metadata))
      await fd.close()

      return async () => {
        try {
          await fs.unlink(lockPath)
        } catch {
          // Ignore unlock failures
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS))
    }
  }

  throw new Error(`Failed to acquire lock "${lockName}" after ${timeoutMs}ms`)
}
