// 下载 Android 工具链：platform-tools（adb）与 scrcpy-server。
// 走 NODE_USE_ENV_PROXY 让 node 的 fetch 使用系统代理；工具链不进 git。
import { mkdir, writeFile, stat, rename } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tools = join(here, '..', 'tools')
const SCRCPY_TAG = process.env.SCRCPY_TAG ?? 'v5.0.1'

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

async function download(url, target) {
  if (await exists(target)) {
    console.log(`skip (exists): ${target}`)
    return
  }
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`${response.status} ${url}`)
  const temp = `${target}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
  await rename(temp, target)
  const { size } = await stat(target)
  console.log(`saved ${target} (${size} bytes)`)
}

await mkdir(tools, { recursive: true })

await download(
  'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  join(tools, 'platform-tools.zip')
)

await download(
  `https://github.com/Genymobile/scrcpy/releases/download/${SCRCPY_TAG}/scrcpy-server-${SCRCPY_TAG}`,
  join(tools, 'scrcpy-server.jar')
)
