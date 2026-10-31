// adb 的极薄封装：只做本插件需要的几件事，全部异步、全部带超时。
// 不引入 adbkit 之类依赖，避免把 Electron 的模块解析拖进来。
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/**
 * adb 守护进程默认把日志写到系统临时目录；该目录不可写时守护进程无法启动
 * （cannot open ...\adb.log: Permission denied）。给它一个自家目录最稳。
 */
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

/** 插件自带的 adb（随仓库 tools/ 分发，不进 npm 包时回退到 PATH）。 */
const BUNDLED_ADB = join(pluginRoot, 'tools', 'platform-tools', 'adb.exe')

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

  /** 白名单化参数，避免把 shell 字符串拼进命令行。 */
  /**
   * 临时目录可能不存在或不可写，调用前补建一次，保证守护进程能正常启动。
   */
  ensureTemp() {
    if (!this.tempDir) return
    try { mkdirSync(this.tempDir, { recursive: true }) } catch {}
  }

  run(args, { timeout = 20000, encoding = 'utf8', maxBuffer = 16 * 1024 * 1024 } = {}) {
    this.ensureTemp()
    return new Promise((resolve) => {
      execFile(this.binary, args, { timeout, windowsHide: true, encoding, maxBuffer, env: this.env }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, ok: !error, stdout: stdout ?? '', stderr: stderr ?? (error?.message ?? '') })
      })
    })
  }

  async version() {
    const { ok, stdout, stderr } = await this.run(['version'])
    if (!ok) throw new Error(`adb 不可用：${stderr.trim() || '未知错误'}`)
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

  /**
   * 每次启动都重新推。缓存看起来能省一次 20ms 的传输，但设备上的文件可能被
   * 清理掉（/data/local/tmp 不保证持久），缓存过期就会变成「服务端一启动就 SIGABRT」，
   * 排查成本远高于这点开销。
   */
  async pushJar(serial, jarPath, remote) {
    const { ok, stderr, stdout } = await this.run(['-s', serial, 'push', jarPath, remote], { timeout: 60000 })
    if (!ok) {
      // /data/local/tmp 是 shell 可写的；失败通常是设备锁屏未授权。
      throw new Error(`推送 scrcpy server 失败：${(stderr || stdout).trim()}`)
    }
  }

  async reverseAdd(serial, local, remote) {
    const { ok, stderr } = await this.run(['-s', serial, 'reverse', local, remote])
    if (!ok) throw new Error(`adb reverse 失败：${stderr.trim()}`)
  }

  async reverseRemove(serial, local) {
    await this.run(['-s', serial, 'reverse', '--remove', local]).catch(() => {})
  }

  async shell(serial, command, timeout = 15000) {
    return this.run(['-s', serial, 'shell', command], { timeout })
  }

  /** 二进制模式：screencap -p 的输出必须按 Buffer 读，不能经过字符串编码。 */
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
