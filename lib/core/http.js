// 本机同源校验、JSON 响应与控制请求解析。

export function json(res, status, data) {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(JSON.stringify(data))
}

/** 只接受本机同源请求。 */
export function isLocalSameOrigin(req) {
  const address = req.socket?.remoteAddress
  const loopback = address === '::1' || address === '127.0.0.1' || address?.startsWith('::ffff:127.')
  if (!loopback) return false
  // 转发链中出现非回环地址时视为远端代理。
  const forwardedRaw = `${req.headers.forwarded ?? ''},${req.headers['x-forwarded-for'] ?? ''}`
  const hops = forwardedRaw
    .split(/[,\s;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const normalizeHop = (raw) => raw
    .replace(/^for=/i, '')
    .replace(/["'[\]]/g, '')
  const isLoopbackHop = (raw) => {
    const value = normalizeHop(raw)
    const withoutPort = value.replace(/:\d+$/, '')
    return value === '::1' || withoutPort === '::1' ||
      /^127\./.test(value) || /^127\./.test(withoutPort) ||
      /^::ffff:127\./.test(value) || /^::ffff:127\./.test(withoutPort)
  }
  const remoteHop = hops.find((entry) => !isLoopbackHop(entry))
  if (remoteHop !== undefined) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export async function readJson(req, limit = 64 * 1024) {
  let body = ''
  for await (const part of req) {
    body += part.toString('utf8')
    if (body.length > limit) throw new Error('请求体过大')
  }
  if (body.length === 0) return {}
  return JSON.parse(body)
}

const CONTROL_NUMBERS = new Set(['x', 'y', 'dx', 'dy', 'keycode', 'repeat', 'metastate'])
const CONTROL_BOOLEANS = new Set(['on'])

/** 解析控制指令：优先读查询参数，为空时回退到 JSON body。 */
export async function readControlMessage(req) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const message = {}
  for (const [key, value] of url.searchParams) {
    if (CONTROL_NUMBERS.has(key)) {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`参数 ${key} 不是数字`)
      message[key] = parsed
    } else if (CONTROL_BOOLEANS.has(key)) {
      message[key] = value !== 'false' && value !== '0'
    } else {
      message[key] = value
    }
  }
  if (Object.keys(message).length > 0) {
    if (typeof message.kind !== 'string' || message.kind.length === 0) throw new Error('缺少 kind')
    return message
  }
  const body = await Promise.race([
    readJson(req),
    new Promise((_, reject) => setTimeout(() => reject(new Error('读取控制请求体超时')), 1500))
  ])
  if (typeof body?.kind !== 'string' || body.kind.length === 0) throw new Error('缺少 kind')
  return body
}
