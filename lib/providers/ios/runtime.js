// iOS 运行时：优先使用随插件分发的可移植 Python（含 pymobiledevice3 与 PyAV），
// 找不到时按 runtime-manifest.json 下载到 DSH 数据目录，最后才回退到本机 Python 虚拟环境。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { extractZip } from '../../core/zip.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..', '..')
const require = createRequire(import.meta.url)
const runFile = promisify(execFile)

const MANIFEST_FILE = join(pluginRoot, 'bridge', 'runtime-manifest.json')
// 平台运行时包名，与 optionalDependencies 对应。
const RUNTIME_PACKAGES = {
  'win32-x64': 'dsh-phone-mirror-ios-runtime-win32-x64'
}
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
const verifiedPython = new Set()

/** 面板据此显示首次下载进度，避免长时间停在「正在连接…」。 */
export const runtimeState = { preparing: false, message: '' }

export function runtimePlatform() {
  return `${process.platform}-${process.arch}`
}

/** 运行时的 python 可执行文件路径。 */
export function pythonPath(runtimeDir, platform = runtimePlatform()) {
  const rel = platform.startsWith('win32')
    ? ['python', 'python.exe']
    : ['python', 'bin', 'python3']
  return join(runtimeDir, ...rel)
}

export function runtimeManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
  } catch {
    return null
  }
}

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function runtimeCacheDir(version) {
  return join(dshHome(), 'phone-mirror-ios-runtime', String(version))
}

function optionalRuntimePython(platform) {
  const name = RUNTIME_PACKAGES[platform]
  if (!name) return ''
  try {
    const pkgPath = require.resolve(`${name}/package.json`)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const rel = pkg?.dshIosRuntime?.python
    return rel ? join(dirname(pkgPath), rel) : pythonPath(dirname(pkgPath), platform)
  } catch {
    return ''
  }
}

/** 按优先级列出可用的运行时 python，不一定存在。 */
export function runtimeCandidates(platform = runtimePlatform()) {
  const list = []
  const configured = String(process.env.DSH_PHONE_MIRROR_IOS_PYTHON ?? '').trim()
  if (configured) {
    list.push({ source: 'env', python: isAbsolute(configured) ? configured : join(pluginRoot, configured) })
  }
  list.push({ source: 'bundled', python: pythonPath(join(pluginRoot, 'tools', 'ios-runtime', platform), platform) })
  const fromPackage = optionalRuntimePython(platform)
  if (fromPackage) list.push({ source: 'npm', python: fromPackage })
  const manifest = runtimeManifest()
  if (manifest?.runtimeVersion != null) {
    list.push({ source: 'cache', python: pythonPath(runtimeCacheDir(manifest.runtimeVersion), platform) })
  }
  const rel = platform.startsWith('win32') ? ['Scripts', 'python.exe'] : ['bin', 'python']
  list.push({ source: 'local-venv', python: join(pluginRoot, '.tmp', 'py', ...rel) })
  list.push({ source: 'user-venv', python: join(dshHome(), 'phone-mirror-ios-venv', ...rel) })
  return list
}

/** 确认这个 python 能导入投屏依赖。 */
export async function verifyPython(pythonBin) {
  if (!pythonBin || !existsSync(pythonBin)) return false
  if (verifiedPython.has(pythonBin)) return true
  try {
    await runFile(pythonBin, ['-c', 'import pymobiledevice3, av'], { timeout: 20000, windowsHide: true })
    verifiedPython.add(pythonBin)
    return true
  } catch {
    return false
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function downloadRuntimeZip(entry, target) {
  const response = await fetch(entry.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const temp = `${target}.part`
  mkdirSync(dirname(target), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
  renameSync(temp, target)
}

/** 下载并解压清单里的运行时，成功返回 python 路径。 */
async function downloadRuntime(platform, { onStage } = {}) {
  const manifest = runtimeManifest()
  const entry = manifest?.platforms?.[platform]
  const version = manifest?.runtimeVersion
  if (!entry?.url || !entry?.sha256 || version == null) return ''

  const cacheRoot = join(dshHome(), 'phone-mirror-ios-runtime')
  const target = join(cacheRoot, String(version))
  const archive = join(cacheRoot, `${version}.zip`)
  runtimeState.preparing = true
  runtimeState.message = '首次连接，正在下载 iOS 运行时（约 100 MB）…'
  try {
    mkdirSync(cacheRoot, { recursive: true })
    if (!existsSync(archive)) {
      onStage?.('首次连接 iOS，正在下载运行时…')
      await downloadRuntimeZip(entry, archive)
    }
    const digest = await sha256(archive)
    if (digest.toLowerCase() !== String(entry.sha256).toLowerCase()) {
      rmSync(archive, { force: true })
      return ''
    }
    const staging = `${target}.part`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    if (!(await extractZip(archive, staging))) {
      rmSync(staging, { recursive: true, force: true })
      return ''
    }
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    rmSync(archive, { force: true })
    const python = pythonPath(target, platform)
    return statSync(python).isFile() ? python : ''
  } catch {
    return ''
  } finally {
    runtimeState.preparing = false
    runtimeState.message = ''
  }
}

/**
 * 找到可用的 iOS 运行时 python；顺序为：
 * 环境变量 → 插件内 tools/ios-runtime → npm 平台包 → 缓存 → 已有 venv → 按清单下载。
 * 都不可用时返回空串，由调用方回退到本机 Python。
 */
export async function resolveIosPython({ onStage } = {}) {
  const platform = runtimePlatform()
  for (const candidate of runtimeCandidates(platform)) {
    if (await verifyPython(candidate.python)) return candidate.python
  }
  const downloaded = await downloadRuntime(platform, { onStage })
  if (downloaded && (await verifyPython(downloaded))) return downloaded
  return ''
}
