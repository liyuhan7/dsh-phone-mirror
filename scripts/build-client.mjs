// 把 lib/client.js 组装成 DSH 客户端模块入口。
// client.js 自身已经是 window.__ModuleLoader__.load({...}) 的形式，
// 这里只做一次拷贝并加来源说明，避免手工维护两份文件。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourceUrl = new URL('../lib/client.js', import.meta.url)
const outputUrl = new URL('../lib/client.bundle.js', import.meta.url)

export function buildClientBundle() {
  const source = readFileSync(sourceUrl, 'utf8')
  return `// 本文件由 npm run build 生成，请修改 lib/client.js 后重新构建。\n${source}`
}

const invokedDirectly = Boolean(process.argv[1])

if (process.argv[1]) {
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
}
