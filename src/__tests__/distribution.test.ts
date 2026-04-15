import fs from 'fs/promises'
import path from 'path'
import { describe, expect, it } from 'vitest'

describe('distribution metadata', () => {
  it('points package metadata at the bundled plugin artifact', async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8')
    ) as {
      main?: string
      files?: string[]
      scripts?: Record<string, string>
    }

    expect(packageJson.main).toBe('dist/nim-sync.mjs')
    expect(packageJson.files).toEqual(
      expect.arrayContaining(['dist', 'README.md'])
    )
    expect(packageJson.scripts?.prepack).toBe('npm run build')
  })

  it('documents npm-based OpenCode installation instead of manual file copying', async () => {
    const readme = await fs.readFile(path.join(process.cwd(), 'README.md'), 'utf-8')

    expect(readme).toContain('"plugin": ["opencode-nim-sync"]')
    expect(readme).toContain('installed automatically using Bun at startup')
    expect(readme).not.toContain('Copy-Item dist/nim-sync.mjs')
    expect(readme).not.toContain('cp dist/nim-sync.mjs')
  })
})
