// zip 解压：优先用系统自带的 tar（Windows 10+ / macOS），Unix 退回 unzip。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export async function extractZip(zipPath, targetDir) {
  const candidates = [
    ['tar', ['-xf', zipPath, '-C', targetDir]],
    ['unzip', ['-o', zipPath, '-d', targetDir]]
  ]
  for (const [command, args] of candidates) {
    try {
      await runFile(command, args)
      return true
    } catch {}
  }
  return false
}
