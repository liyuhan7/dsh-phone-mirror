// 构建 Windows x64 的 iOS 运行时：可移植 CPython + pymobiledevice3 + PyAV/FFmpeg。
// 产物有两个用途：发布成 npm 平台包（安装即用），或压缩成 zip 上传 GitHub Release（首次连接时下载）。
//
// 用法：
//   npm run build:ios-runtime                 # 用 PATH 里的 python 安装依赖
//   npm run build:ios-runtime -- --python C:/Python311/python.exe --force
//
// 需要一次性联网：下载 Python 嵌入式包与 PyPI wheel。构建完成后会写好 bridge/runtime-manifest.json 的 sha256。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

const PYTHON_VERSION = '3.11.9'
const EMBED_FILE = `python-${PYTHON_VERSION}-embed-amd64.zip`
const EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${EMBED_FILE}`
const PLATFORM = 'win32-x64'
const PACKAGE_NAME = 'dsh-phone-mirror-ios-runtime-win32-x64'
const DEFAULT_REPO = 'liyuhan7/dsh-phone-mirror'
const DEFAULT_PYPI = 'https://pypi.tuna.tsinghua.edu.cn/simple'
const MANIFEST_FILE = join(pluginRoot, 'bridge', 'runtime-manifest.json')
const REQUIREMENTS = join(pluginRoot, 'bridge', 'requirements.txt')
const BUILD_CACHE = join(pluginRoot, '.tmp', 'ios-runtime-build')

function parseArgs(argv) {
  const out = { python: 'python', version: '1.0.0', out: join(pluginRoot, 'dist', 'ios-runtime'), repo: DEFAULT_REPO, pypi: DEFAULT_PYPI, force: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--force') { out.force = true; continue }
    if (arg === '--python') { out.python = argv[++index]; continue }
    if (arg === '--version') { out.version = String(argv[++index]); continue }
    if (arg === '--out') { out.out = resolve(argv[++index]); continue }
    if (arg === '--repo') { out.repo = argv[++index]; continue }
    if (arg === '--pypi') { out.pypi = argv[++index]; continue }
  }
  return out
}

async function download(url, target) {
  if (existsSync(target)) return
  mkdirSync(dirname(target), { recursive: true })
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status} ${url}`)
  const temp = `${target}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
  renameSync(temp, target)
}

function sha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

function sizeOf(target) {
  try {
    return statSync(target).size
  } catch {
    return 0
  }
}

function walkSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    total += entry.isDirectory() ? walkSize(full) : statSync(full).size
  }
  return total
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function patchPth(pythonDir) {
  const pth = join(pythonDir, 'python311._pth')
  if (!existsSync(pth)) throw new Error('未找到 python311._pth，嵌入式 Python 版本可能已变化')
  const lines = readFileSync(pth, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^#?\s*import site$/.test(line))
    .filter((line) => line !== 'Lib\\site-packages' && line !== 'Lib/site-packages')
  writeFileSync(pth, [...lines, 'Lib\\site-packages', 'import site'].join('\n') + '\n')
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`当前只构建 ${PLATFORM} 运行时，请在 Windows x64 上执行`)
  }
  const args = parseArgs(process.argv.slice(2))
  const pythonDir = join(args.out, PACKAGE_NAME, 'python')
  const sitePackages = join(pythonDir, 'Lib', 'site-packages')
  const runtimePython = join(pythonDir, 'python.exe')

  if (args.force) rmSync(join(args.out, PACKAGE_NAME), { recursive: true, force: true })
  mkdirSync(pythonDir, { recursive: true })

  const embedZip = join(BUILD_CACHE, EMBED_FILE)
  console.log(`[1/6] 准备嵌入式 Python ${PYTHON_VERSION}`)
  await download(EMBED_URL, embedZip)
  if (!existsSync(join(pythonDir, 'python.exe'))) {
    const ok = await runFile('tar', ['-xf', embedZip, '-C', pythonDir]).then(() => true).catch(() => false)
    if (!ok) throw new Error('解压嵌入式 Python 失败，请确认系统自带 tar')
  }
  patchPth(pythonDir)
  console.log(`      ${pythonDir}`)

  console.log('[2/6] 安装 pymobiledevice3 与 PyAV')
  const hostVersion = await runFile(args.python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { timeout: 30000, windowsHide: true })
  if (hostVersion.stdout.trim() !== '3.11') {
    throw new Error(`构建用的 Python 必须是 3.11（当前 ${hostVersion.stdout.trim()}），请用 --python 指定`)
  }
  if (args.force) rmSync(sitePackages, { recursive: true, force: true })
  mkdirSync(sitePackages, { recursive: true })
  const pipArgs = [
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--no-compile',
    '--prefer-binary',
    '--upgrade',
    '--target', sitePackages,
    '-r', REQUIREMENTS,
    '--index-url', args.pypi
  ]
  await runFile(args.python, pipArgs, { timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  console.log(`      ${sitePackages}`)

  console.log('[3/6] 冒烟测试')
  const probe = await runFile(runtimePython, [
    '-c',
    'import av, pymobiledevice3, sys; print(sys.version.split()[0], av.__version__)'
  ], { timeout: 120000, windowsHide: true })
  console.log(`      python ${probe.stdout.trim()}`)

  console.log('[4/6] 清理缓存与测试目录')
  let removed = 0
  const stack = [sitePackages]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') {
          rmSync(full, { recursive: true, force: true })
          removed++
        } else {
          stack.push(full)
        }
      } else if (entry.name.endsWith('.pyc')) {
        rmSync(full, { force: true })
        removed++
      }
    }
  }
  console.log(`      删除 ${removed} 个缓存文件`)

  console.log('[5/6] 写入运行时包元数据')
  const runtimePackage = {
    name: PACKAGE_NAME,
    version: String(args.version),
    description: 'dsh-phone-mirror 的 iOS 运行时：可移植 CPython 与 pymobiledevice3、PyAV',
    license: 'MIT',
    os: ['win32'],
    cpu: ['x64'],
    files: ['python', 'THIRD-PARTY.md'],
    dshIosRuntime: { python: 'python/python.exe' }
  }
  writeFileSync(join(args.out, PACKAGE_NAME, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`)
  writeFileSync(join(args.out, PACKAGE_NAME, 'THIRD-PARTY.md'), [
    '# iOS 运行时第三方组件',
    '',
    `- Python ${PYTHON_VERSION}（嵌入式发行版），PSF-2.0 许可：<https://docs.python.org/3/license.html>`,
    '- pymobiledevice3（GPL-3.0-or-later）：<https://github.com/doronz88/pymobiledevice3>',
    '- PyAV（BSD-3-Clause）：<https://github.com/PyAV-Org/PyAV>',
    '- FFmpeg 动态库随 PyAV wheel 提供，LGPL-2.1-or-later，未做修改；具体许可以 wheel 内附带文件为准',
    '',
    '本目录只在 `dsh-phone-mirror` 的 iOS bridge 子进程中按需加载，插件自身不静态链接以上组件。',
    ''
  ].join('\n'))

  console.log('[6/6] 打包并更新清单')
  const zipPath = join(args.out, `${PACKAGE_NAME}.zip`)
  rmSync(zipPath, { force: true })
  await runFile('tar', ['-a', '-c', '-f', zipPath, '-C', join(args.out, PACKAGE_NAME), '.'])
  const digest = await sha256(zipPath)

  const major = Number.parseInt(String(args.version), 10) || 1
  const manifest = {
    runtimeVersion: major,
    python: PYTHON_VERSION,
    platforms: {
      [PLATFORM]: {
        file: `${PACKAGE_NAME}.zip`,
        url: `https://github.com/${args.repo}/releases/download/ios-runtime-v${major}/${PACKAGE_NAME}.zip`,
        sha256: digest
      }
    }
  }
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`)

  const unpacked = walkSize(join(args.out, PACKAGE_NAME))
  console.log('')
  console.log(`运行时目录：${join(args.out, PACKAGE_NAME)}（${formatMb(unpacked)}）`)
  console.log(`压缩包：${zipPath}（${formatMb(sizeOf(zipPath))}）`)
  console.log(`sha256：${digest}`)
  console.log(`清单：${MANIFEST_FILE}`)
  console.log('')
  console.log('下一步：')
  console.log(`  npm publish ${join(args.out, PACKAGE_NAME)} --access public`)
  console.log(`  gh release create ios-runtime-v${major} "${zipPath}" --title "iOS runtime v${major}" --notes "Windows x64 iOS 运行时"`)
}

main().catch((error) => {
  console.error(`构建失败：${error.message}`)
  process.exitCode = 1
})
