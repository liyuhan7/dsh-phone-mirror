// 把 lib/client.js 组装成 DSH 客户端模块入口。
// client.js 自身已经是 window.__ModuleLoader__.load({...}) 的形式，
// 引擎源码在此内联（浏览器端没有模块加载器），并补充来源说明。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourceUrl = new URL('../lib/client.js', import.meta.url)
const engineUrl = new URL('../lib/engine.js', import.meta.url)
const outputUrl = new URL('../lib/client.bundle.js', import.meta.url)
const MARKER = '//#inline ./engine.js'

function buildClientBundle() {
  const engine = readFileSync(engineUrl, 'utf8')
  const source = readFileSync(sourceUrl, 'utf8')
  if (!source.includes(MARKER)) throw new Error(`client.js 缺少 ${MARKER} 标记`)
  // 用函数形式替换，避免源码里的 $ 被当成替换模式。
  const inlined = source.replace(MARKER, () => engine.trimEnd())
  return `// 本文件由 npm run build 生成，请修改 lib/client.js 后重新构建。\n${inlined}`
}

const bundle = buildClientBundle()
if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(outputUrl, 'utf8') } catch {}
  if (current !== bundle) {
    console.error('client.bundle.js 已过期，请运行 npm run build')
    process.exitCode = 1
  }
} else {
  writeFileSync(outputUrl, bundle)
  console.log(`已写入 ${fileURLToPath(outputUrl)}`)
}
