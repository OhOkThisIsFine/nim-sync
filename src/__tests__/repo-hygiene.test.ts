import { execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { describe, expect, it } from 'vitest'

describe('repo hygiene', () => {
  it('keeps node_modules ignored and untracked', async () => {
    const gitignore = await fs.readFile(path.join(process.cwd(), '.gitignore'), 'utf-8')
    expect(gitignore).toContain('node_modules/')

    const trackedNodeModules = execFileSync('git', ['ls-files', 'node_modules'], {
      cwd: process.cwd(),
      encoding: 'utf-8'
    }).trim()

    expect(trackedNodeModules).toBe('')
  })
})
