// adb 的极薄封装：全部异步、全部带超时。
import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, isAbsolute } from 'node:path'
import { delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/** adb 守护进程的日志目录。 */
function adbTempDir() {
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  // 按可写性依次尝试：插件目录、DSH 数据目录、系统临时目录。
  const candidates = [
    join(pluginRoot, '.tmp'),
    join(dshHome, 'tmp', 'phone-mirror'),
    join(tmpdir(), 'dsh-phone-mirror')
  ]
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true })
      return candidate
    } catch {}
  }
  return undefined
}

/** 插件自带的 adb 路径。 */
const ADB_NAME = process.platform === 'win32' ? 'adb.exe' : 'adb'
export const BUNDLED_ADB = join(pluginRoot, 'tools', 'platform-tools', ADB_NAME)

/** 官方 platform-tools 按系统分三个包，没有通用包。 */
const PLATFORM_TOOLS = {
  win32: 'platform-tools-latest-windows.zip',
  darwin: 'platform-tools-latest-darwin.zip',
  linux: 'platform-tools-latest-linux.zip'
}
const runFile = promisify(execFile)

/** PATH 里是否已有 adb。 */
export function hasAdbOnPath() {
  const names = process.platform === 'win32' ? ['adb.exe', 'adb.cmd', 'adb.bat'] : ['adb']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      try { if (existsSync(join(dir, name))) return true } catch {}
    }
  }
  return false
}

/** 解压 zip：Windows 自带的 tar 即可，Unix 退回 unzip。 */
async function extractZip(zipPath, targetDir) {
  for (const [command, args] of [['tar', ['-xf', zipPath, '-C', targetDir]], ['unzip', ['-o', zipPath, '-d', targetDir]]]) {
    try {
      await runFile(command, args)
      return true
    } catch {}
  }
  return false
}

/** 下载并解压 platform-tools，返回 adb 路径。 */
export async function ensurePlatformTools({ timeoutMs = 180000 } = {}) {
  if (existsSync(BUNDLED_ADB)) return BUNDLED_ADB
  const tools = join(pluginRoot, 'tools')
  await mkdir(tools, { recursive: true })
  const archive = PLATFORM_TOOLS[process.platform]
  if (!archive) throw new Error(`暂不支持在 ${process.platform} 上自动下载 adb，请在配置里指定 adbPath`)
  const zip = join(tools, archive)
  if (!existsSync(zip)) {
    const response = await fetch(`https://dl.google.com/android/repository/${archive}`, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok || !response.body) throw new Error(`下载 platform-tools 失败：HTTP ${response.status}`)
    const temp = `${zip}.part`
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
    await rename(temp, zip)
  }
  const size = await stat(zip).then((info) => info.size).catch(() => 0)
  if (size === 0) throw new Error('platform-tools 下载不完整')
  if (!(await extractZip(zip, tools))) throw new Error('解压 platform-tools 失败：系统缺少 tar 或 unzip')
  if (!existsSync(BUNDLED_ADB)) throw new Error(`解压后未找到 ${ADB_NAME}`)
  return BUNDLED_ADB
}

export function resolveAdb(configured) {
  if (configured && configured.length > 0) {
    return isAbsolute(configured) ? configured : join(pluginRoot, configured)
  }
  return existsSync(BUNDLED_ADB) ? BUNDLED_ADB : 'adb'
}

export class Adb {
  constructor(binary) {
    this.binary = binary
    this.env = { ...process.env }
    this.tempDir = adbTempDir()
    if (this.tempDir) {
      this.env.TEMP = this.tempDir
      this.env.TMP = this.tempDir
      this.env.TMPDIR = this.tempDir
    }
  }

  /** 补建临时目录。 */
  ensureTemp() {
    if (!this.tempDir) return
    try { mkdirSync(this.tempDir, { recursive: true }) } catch {}
  }

  run(args, { timeout = 20000, encoding = 'utf8', maxBuffer = 16 * 1024 * 1024 } = {}) {
    this.ensureTemp()
    return new Promise((resolve) => {
      execFile(this.binary, args, { timeout, windowsHide: true, encoding, maxBuffer, env: this.env }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        // ENOENT 时补一句可读的原因。
        const message = error?.code === 'ENOENT'
          ? '未找到 adb 可执行文件'
          : (stderr ?? (error?.message ?? ''))
        resolve({ code, ok: !error, stdout: stdout ?? '', stderr: message })
      })
    })
  }

  async version() {
    const { ok, stdout, stderr } = await this.run(['version'])
    if (!ok) throw new Error(stderr.trim() || 'adb 执行失败')
    return stdout.split('\n')[0].trim()
  }

  /** 解析 `adb devices -l`，返回 [{ serial, state, model }]。 */
  async devices() {
    const { ok, stdout, stderr } = await this.run(['devices', '-l'])
    if (!ok) throw new Error(`adb devices 失败：${stderr.trim()}`)
    const out = []
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('List of devices')) continue
      if (trimmed.startsWith('*')) continue
      const parts = trimmed.split(/\s+/)
      const serial = parts[0]
      const state = parts[1] ?? 'unknown'
      const model = /model:([^\s]+)/.exec(trimmed)?.[1] ?? ''
      if (serial) out.push({ serial, state, model })
    }
    return out
  }

  /** 设备上某个文件的大小；文件不存在或读不到时返回 -1。 */
  async remoteSize(serial, remote) {
    const { ok, stdout } = await this.run(['-s', serial, 'shell', `wc -c < ${remote}`], { timeout: 8000 })
    if (!ok) return -1
    const size = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(size) ? size : -1
  }

  /**
   * 推送 scrcpy server；设备上已有同尺寸文件时跳过，写入先落临时文件再改名。
   */
  async pushJar(serial, jarPath, remote) {
    const { size } = await stat(jarPath).catch(() => ({ size: 0 }))
    if (size > 0 && (await this.remoteSize(serial, remote)) === size) return
    const staging = `${remote}.part`
    const { ok, stderr, stdout } = await this.run(['-s', serial, 'push', jarPath, staging], { timeout: 60000 })
    if (!ok) {
      // 失败时清理临时文件。
      await this.run(['-s', serial, 'shell', `rm -f ${staging}`], { timeout: 5000 })
      throw new Error(`推送 scrcpy server 失败：${(stderr || stdout).trim()}`)
    }
    const moved = await this.run(['-s', serial, 'shell', `mv -f ${staging} ${remote}`], { timeout: 8000 })
    if (!moved.ok) {
      throw new Error(`准备 scrcpy server 失败：${(moved.stderr || moved.stdout).trim()}`)
    }
  }

  async reverseAdd(serial, local, remote) {
    const { ok, stderr } = await this.run(['-s', serial, 'reverse', local, remote])
    if (!ok) throw new Error(`adb reverse 失败：${stderr.trim()}`)
  }

  async reverseRemove(serial, local) {
    await this.run(['-s', serial, 'reverse', '--remove', local]).catch(() => {})
  }

  /** 列出当前设备的 reverse 转发，返回 [{ local, remote }]。 */
  async reverseList(serial) {
    const { ok, stdout } = await this.run(['-s', serial, 'reverse', '--list'], { timeout: 8000 })
    if (!ok) return []
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // 每行形如「host-12 localabstract:scrcpy_xxx tcp:59001」，首列是传输标识。
      .map((line) => {
        const parts = line.split(/\s+/)
        return { local: parts[1] ?? '', remote: parts[2] ?? '' }
      })
      .filter((entry) => entry.local.length > 0)
  }

  async shell(serial, command, timeout = 15000) {
    return this.run(['-s', serial, 'shell', command], { timeout })
  }

  /** 二进制模式执行，输出按 Buffer 返回。 */
  execOut(serial, args, timeout = 20000) {
    this.ensureTemp()
    return new Promise((resolve) => {
      execFile(
        this.binary,
        ['-s', serial, 'exec-out', ...args],
        { timeout, windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, env: this.env },
        (error, stdout) => resolve({ ok: !error, data: stdout ?? Buffer.alloc(0), error })
      )
    })
  }

  async screenSize(serial) {
    const { ok, stdout } = await this.shell(serial, 'wm size')
    if (!ok) return null
    // 优先用 Override size（分辨率被改过时以它为准）。
    const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout)
    const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout)
    const match = override ?? physical
    if (!match) return null
    return { width: Number(match[1]), height: Number(match[2]) }
  }
}
