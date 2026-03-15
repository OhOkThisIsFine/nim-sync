import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs/promises'
import type { MockFileHandle } from './mocks.js'
import {
  readJSONC,
  writeJSONC,
  atomicWrite,
  ensureDir,
  getConfigDir,
  getCacheDir,
  acquireLock
} from '../lib/file-utils.js'

vi.mock('fs/promises')

describe('File Utils', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.USERPROFILE = '/test/user'
    process.env.HOME = '/test/user'
  })

  describe('readJSONC', () => {
    it('reads and parses JSONC file', async () => {
      const mockContent = '{ "key": "value" }'
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await readJSONC('/test/file.json')
      expect(result).toEqual({ key: 'value' })
    })

    it('returns empty object for ENOENT error', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      vi.mocked(fs.readFile).mockRejectedValue(error)

      const result = await readJSONC('/test/missing.json')
      expect(result).toEqual({})
    })

    it('throws error for other read failures', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Permission denied'))

      await expect(readJSONC('/test/file.json')).rejects.toThrow('Permission denied')
    })
  })

  describe('writeJSONC', () => {
    it('writes JSON data to file', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
      vi.mocked(fs.rename).mockResolvedValue(undefined)

      await writeJSONC('/test/file.json', { key: 'value' })

      expect(fs.writeFile).toHaveBeenCalled()
    })
  })

  describe('atomicWrite', () => {
    it('writes file atomically', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
      vi.mocked(fs.rename).mockResolvedValue(undefined)

      await atomicWrite('/test/file.txt', 'content')

      expect(fs.mkdir).toHaveBeenCalled()
      expect(fs.writeFile).toHaveBeenCalled()
      expect(fs.rename).toHaveBeenCalled()
    })

    it('creates backup when requested', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
      vi.mocked(fs.rename).mockResolvedValue(undefined)
      vi.mocked(fs.copyFile).mockResolvedValue(undefined)

      await atomicWrite('/test/file.txt', 'content', { backup: true, createBackupDir: true })

      expect(fs.mkdir).toHaveBeenCalled()
    })

    it('cleans up old backups beyond MAX_BACKUPS threshold', async () => {
      const now = Date.now()
      const mockFiles = Array.from({ length: 10 }, (_, i) => 
        `file.txt.${now - i * 1000}.bak`
      )
      
      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any)
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
      vi.mocked(fs.rename).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockResolvedValue(undefined)
      vi.mocked(fs.copyFile).mockResolvedValue(undefined)
      vi.mocked(fs.unlink).mockResolvedValue(undefined)
      
      await atomicWrite('/test/file.txt', 'content', { 
        backup: true, 
        createBackupDir: true 
      })
      
      // Should delete 5 oldest backups (10 total - 5 MAX_BACKUPS)
      // +1 for the temp file cleanup call = 6 total unlink calls
      const unlinkCalls = vi.mocked(fs.unlink).mock.calls
      const backupDeletions = unlinkCalls.filter(call => 
        String(call[0]).includes('.bak')
      )
      expect(backupDeletions.length).toBe(5)
    })

    it('handles backup cleanup failures gracefully', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory read failed'))
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
      vi.mocked(fs.rename).mockResolvedValue(undefined)
      vi.mocked(fs.access).mockResolvedValue(undefined)
      vi.mocked(fs.copyFile).mockResolvedValue(undefined)
      
      // Should not throw even if cleanup fails
      await expect(atomicWrite('/test/file.txt', 'content', { 
        backup: true, 
        createBackupDir: true 
      })).resolves.toBeUndefined()
    })

    it('cleans up temp file on error', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'))
      vi.mocked(fs.unlink).mockResolvedValue(undefined)

      await expect(atomicWrite('/test/file.txt', 'content')).rejects.toThrow('Write failed')
      expect(fs.unlink).toHaveBeenCalled()
    })
  })

  describe('ensureDir', () => {
    it('creates directory recursively', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)

      await ensureDir('/test/dir')

      expect(fs.mkdir).toHaveBeenCalledWith('/test/dir', { recursive: true })
    })

    it('ignores EEXIST error', async () => {
      const error = new Error('Directory exists') as NodeJS.ErrnoException
      error.code = 'EEXIST'
      vi.mocked(fs.mkdir).mockRejectedValue(error)

      await expect(ensureDir('/test/dir')).resolves.toBeUndefined()
    })

    it('throws other errors', async () => {
      vi.mocked(fs.mkdir).mockRejectedValue(new Error('Permission denied'))

      await expect(ensureDir('/test/dir')).rejects.toThrow('Permission denied')
    })
  })

  describe('getConfigDir', () => {
    it('returns Windows config path on Windows', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      
      const dir = getConfigDir()
      expect(dir).toContain('AppData')
      expect(dir).toContain('Roaming')
      expect(dir).toContain('opencode')
      
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })

    it('returns Unix config path on Linux/macOS', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      
      const dir = getConfigDir()
      expect(dir).toContain('.config')
      expect(dir).toContain('opencode')
      
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })
  })

  describe('getCacheDir', () => {
    it('returns Windows cache path on Windows', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      
      const dir = getCacheDir()
      expect(dir).toContain('AppData')
      expect(dir).toContain('Local')
      expect(dir).toContain('opencode')
      expect(dir).toContain('cache')
      
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })

    it('returns Unix cache path on Linux/macOS', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      
      const dir = getCacheDir()
      expect(dir).toContain('.cache')
      expect(dir).toContain('opencode')
      
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    })
  })

  describe('acquireLock', () => {
    beforeEach(() => {
      // Suppress expected console.error output in lock tests
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    it('acquires lock successfully', async () => {
      const mockFd: MockFileHandle = {
        close: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined)
      }
      vi.mocked(fs.open).mockResolvedValue(mockFd as never)
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.unlink).mockResolvedValue(undefined)

      const release = await acquireLock('test-lock')
      expect(typeof release).toBe('function')

      // Release the lock
      await release()
      expect(fs.unlink).toHaveBeenCalled()
    })

    it('retries on EEXIST and eventually succeeds', async () => {
      const mockFd: MockFileHandle = {
        close: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined)
      }
      const error = new Error('Lock exists') as NodeJS.ErrnoException
      error.code = 'EEXIST'

      vi.mocked(fs.open)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(mockFd as never)
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.unlink).mockResolvedValue(undefined)

      const release = await acquireLock('test-lock')
      expect(typeof release).toBe('function')
    })

    it('throws after timeout', async () => {
      const error = new Error('Lock exists') as NodeJS.ErrnoException
      error.code = 'EEXIST'
      
      vi.mocked(fs.open).mockRejectedValue(error)
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)

      await expect(acquireLock('test-lock', 100)).rejects.toThrow('Failed to acquire lock')
    })

    it('throws non-EEXIST errors immediately', async () => {
      vi.mocked(fs.open).mockRejectedValue(new Error('Permission denied'))
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)

      await expect(acquireLock('test-lock')).rejects.toThrow('Permission denied')
    })

    it('cleans up stale lock from crashed process', async () => {
      const mockFd: MockFileHandle = {
        close: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined)
      }
      
      // Simulate a stale lock file with old timestamp
      const staleLockMetadata = JSON.stringify({
        pid: 99999, // Non-existent process
        timestamp: Date.now() - (10 * 60 * 1000) // 10 minutes ago (stale)
      })
      
      vi.mocked(fs.readFile).mockResolvedValueOnce(staleLockMetadata)
      vi.mocked(fs.unlink).mockResolvedValue(undefined)
      vi.mocked(fs.open).mockResolvedValue(mockFd as never)
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)

      const release = await acquireLock('test-lock')
      expect(typeof release).toBe('function')
      
      // Should have called unlink to remove the stale lock
      expect(fs.unlink).toHaveBeenCalled()
    })

    it('handles release lock failure gracefully', async () => {
      const mockFd: MockFileHandle = {
        close: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined)
      }
      vi.mocked(fs.open).mockResolvedValue(mockFd as never)
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      
      // First call for stale cleanup (if any), second for release
      vi.mocked(fs.unlink)
        .mockRejectedValue(new Error('Failed to release lock'))

      const release = await acquireLock('test-lock')
      
      // Release should not throw even if unlink fails
      await expect(release()).resolves.toBeUndefined()
    })
  })
})
