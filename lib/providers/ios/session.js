// iOS CoreDevice 投屏会话：管理 Python sidecar（bridge/ios_bridge.py），
// 订阅 /stream.bin（HEVC hvcC）与 /audio.bin（48kHz 立体声 s16le PCM），并转发 HID 反控指令。
import { EventEmitter } from 'node:events'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { charToHidUsages, keycodeToHidUsages } from './keymap.js'
import { resolveIosPython } from './runtime.js'

const runFile = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 结束 Python 启动器及其子进程（Windows 的 venv python.exe 会再拉起基础解释器）。 */
async function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    await runFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}
const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..', '..')
export const BRIDGE_SCRIPT = join(pluginRoot, 'bridge', 'ios_bridge.py')
export const BRIDGE_REQUIREMENTS = join(pluginRoot, 'bridge', 'requirements.txt')

// 按 UDID 持久化的 iPhone 无线地址。
const WIRELESS_HOSTS_FILE = join(pluginRoot, '.tmp', 'ios-wireless-hosts.json')

function loadWirelessHosts() {
  try {
    return JSON.parse(readFileSync(WIRELESS_HOSTS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function learnedWirelessHost(udid) {
  const entry = loadWirelessHosts()[udid]
  return typeof entry?.host === 'string' && entry.host ? entry.host : ''
}

// 只保留最近一次学到的无线地址：出现新地址时旧地址直接作废。
export function saveLearnedWirelessHost(udid, host) {
  if (!udid || !host) return
  try {
    const data = { [udid]: { host: String(host), learnedAt: Date.now() } }
    if (loadWirelessHosts()[udid]?.host === String(host)) return
    mkdirSync(dirname(WIRELESS_HOSTS_FILE), { recursive: true })
    writeFileSync(WIRELESS_HOSTS_FILE, JSON.stringify(data, null, 1))
  } catch {}
}

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0))
const toHidCoord = (norm) => Math.round(clamp01(norm) * 65535)

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function candidateVenvPythons() {
  const rel = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return [
    join(pluginRoot, '.tmp', 'py', ...rel),
    join(dshHome, 'phone-mirror-ios-venv', ...rel)
  ]
}

async function hasRequiredPackages(pythonBin) {
  if (!pythonBin || !existsSync(pythonBin)) return false
  try {
    await runFile(pythonBin, ['-c', 'import pymobiledevice3, av'], { timeout: 8000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** 查找或自动准备带 pymobiledevice3 + av 的 Python 运行时。 */
let cachedPython = ''

export async function ensureIosPython({ onStage } = {}) {
  if (cachedPython && existsSync(cachedPython)) return cachedPython
  const runtime = await resolveIosPython({ onStage })
  if (runtime) {
    cachedPython = runtime
    return runtime
  }
  for (const candidate of candidateVenvPythons()) {
    if (await hasRequiredPackages(candidate)) {
      cachedPython = candidate
      return candidate
    }
  }
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const venvDir = join(dshHome, 'phone-mirror-ios-venv')
  const rel = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const targetPython = join(venvDir, ...rel)

  onStage?.('首次连接 iOS，正在准备 Python 投屏环境…')
  const sysPython = process.platform === 'win32' ? 'python' : 'python3'
  if (!existsSync(targetPython)) {
    try {
      await runFile(sysPython, ['-m', 'venv', venvDir], { timeout: 60000, windowsHide: true })
    } catch (error) {
      throw new Error(`iOS 运行时不可用：本机没有可用的 Python 3.11+（${error.message}）`)
    }
  }
  const uvCandidates = [
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
    'uv'
  ]
  let installed = false
  for (const uvBin of uvCandidates) {
    try {
      await runFile(
        uvBin,
        ['pip', 'install', '--python', targetPython, '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', '-r', BRIDGE_REQUIREMENTS],
        { timeout: 300000, windowsHide: true }
      )
      installed = true
      break
    } catch {}
  }
  if (!installed) {
    await runFile(
      targetPython,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', '-r', BRIDGE_REQUIREMENTS],
      { timeout: 300000, windowsHide: true }
    )
  }
  if (!(await hasRequiredPackages(targetPython))) {
    throw new Error('iOS 运行时不可用：pymobiledevice3 / av 安装未完成，请检查网络后重试')
  }
  cachedPython = targetPython
  return targetPython
}

export function sidecarEnv(extra = {}) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', ...extra }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[key]
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1'
  env.no_proxy = '127.0.0.1,localhost,::1'
  return env
}

/** 执行一次无线配对（在 USB 连接下生成 RemotePairing 记录）。 */
export async function pairIosWireless(udid, host = '') {
  const pythonBin = await ensureIosPython()
  return new Promise((resolve) => {
    const args = [BRIDGE_SCRIPT, 'pair-wireless', '--udid', udid]
    if (host) args.push('--host', host)
    const child = spawn(pythonBin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sidecarEnv()
    })
    let lastJson = null
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      for (const line of stdout.split(/\r?\n/)) {
        try { lastJson = JSON.parse(line) } catch {}
      }
      if (code === 0 && lastJson?.type === 'paired') {
        if (lastJson.wirelessHost) saveLearnedWirelessHost(udid, lastJson.wirelessHost)
        resolve({ ok: true, address: lastJson.serial, udid: lastJson.udid, wirelessHost: lastJson.wirelessHost || '', directReady: lastJson.directReady === true, wirelessError: lastJson.wirelessError || '' })
      } else {
        resolve({
          ok: false,
          error: lastJson?.message || stderr.trim() || 'iOS 无线配对失败'
        })
      }
    })
    child.on('error', (error) => resolve({ ok: false, error: error.message }))
  })
}

export class IosSession extends EventEmitter {
  constructor({ serial, audio = true, usbPresent, host = '', explicitHost = false }) {
    super()
    this.serial = serial
    this.wireless = serial.startsWith('wifi:')
    this.udid = this.wireless ? serial.slice('wifi:'.length) : serial
    this.wantAudio = audio
    this.usbPresent = usbPresent
    this.host = String(host ?? '').trim()
    this.explicitHost = explicitHost
    this.usbTimer = null
    this.keyboardQueue = Promise.resolve()
    this.platform = 'ios'
    this.mode = 'coredevice'
    this.port = 0
    this.child = null
    this.state = 'idle'
    this.deviceName = 'iPhone'
    this.screen = null
    this.baseScreen = null
    this.rotation = 0
    this.videoCodec = null
    this.videoDescription = null
    this.audioCodec = null
    this.audioAbort = null
    this.ptsBase = Date.now()
  }

  $nextPts() {
    return Math.max(0, (Date.now() - this.ptsBase) * 1000)
  }

  async start() {
    this.state = 'starting'
    const pythonBin = await ensureIosPython()
    this.port = await freePort()
    const args = [BRIDGE_SCRIPT, 'serve', '--udid', this.udid, '--port', String(this.port)]
    if (this.wireless) args.push('--wireless')
    if (this.wireless && this.host) {
      args.push('--host', this.host)
      if (this.explicitHost) args.push('--explicit-host')
    }

    this.child = spawn(pythonBin, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sidecarEnv({ PHONE_MIRROR_STDIN_QUIT: '1' }),
      detached: process.platform !== 'win32'
    })

    const readyInfo = await new Promise((resolve, reject) => {
      let stderrTail = ''
      const timer = setTimeout(() => {
        reject(new Error('启动 iOS 投屏超时：若首次挂载开发者镜像，请保持手机解锁后再试一次'))
      }, 75000)

      const onLine = (line) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return
        let msg
        try { msg = JSON.parse(trimmed) } catch { return }
        if (msg.type === 'ready') {
          clearTimeout(timer)
          // 手填地址直连未知设备：配对完成后桥接层回传真实 UDID，会话换成真实序列号。
          if (this.wireless && msg.udid && msg.udid !== this.udid) {
            this.udid = msg.udid
            this.serial = `wifi:${msg.udid}`
          }
          resolve(msg)
        } else if (msg.type === 'wireless-address') {
          // USB 会话期间 bridge 学到的手机 Wi-Fi 地址，供拔线后的无线直连用。
          if (msg.host) saveLearnedWirelessHost(this.udid, msg.host)
        } else if (msg.type === 'error') {
          clearTimeout(timer)
          reject(new Error(msg.message || 'iOS 投屏启动失败'))
        }
      }

      let stdoutBuf = ''
      this.child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdoutBuf += chunk
        const lines = stdoutBuf.split(/\r?\n/)
        stdoutBuf = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      })
      this.child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1200)
      })
      this.child.once('exit', (code) => {
        clearTimeout(timer)
        if (this.state === 'starting') {
          reject(new Error(stderrTail.trim() || `iOS 桥接进程退出（code ${code}）`))
        } else if (this.state === 'running') {
          this.state = 'failed'
          this.emit('error', { message: 'iOS 画面流已断开' })
          this.emit('close')
        }
      })
      this.child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    this.deviceName = readyInfo.deviceName || 'iPhone'
    if (readyInfo.screen?.width && readyInfo.screen?.height) {
      this.baseScreen = { width: readyInfo.screen.width, height: readyInfo.screen.height }
      this.rotation = readyInfo.screen.rotation ?? 0
    }

    const codecInfo = readyInfo.codec && readyInfo.description
      ? readyInfo
      : await this.$fetchCodec()
    this.videoCodec = codecInfo.codec
    this.videoDescription = codecInfo.description
    if (codecInfo.display?.width && codecInfo.display?.height) {
      this.baseScreen = { width: codecInfo.display.width, height: codecInfo.display.height }
      this.rotation = codecInfo.display.rotation ?? 0
    }
    this.screen = this.baseScreen

    this.state = 'running'
    // 本机没有 AAC-ELD 解码能力时不订阅音频，界面如实显示无音频；音频由引擎直连 sidecar /audio.bin。
    if (readyInfo.audio === false) this.wantAudio = false
    if (this.wantAudio) {
      this.audioCodec = 'pcm-s16le'
      this.emit('audio-codec', { codec: this.audioCodec })
    }
    this.emit('ready', {
      deviceName: this.deviceName,
      // screen 是流缓冲的原生尺寸，旋转由 rotation 单独下发，渲染端负责转正。
      screen: this.baseScreen,
      rotation: this.rotation,
      audio: Boolean(this.audioCodec),
      videoCodec: this.videoCodec,
      videoDescription: this.videoDescription
    })

    if (!this.wireless && this.usbPresent) {
      let checking = false
      let missed = 0
      this.usbTimer = setInterval(async () => {
        if (checking || this.state !== 'running') return
        checking = true
        const present = await this.usbPresent().catch(() => null)
        checking = false
        if (this.state !== 'running') return
        missed = present === false ? missed + 1 : 0
        if (missed >= 2) this.emit('error', { message: 'iPhone USB 已断开' })
      }, 1000)
      this.usbTimer.unref?.()
    }
  }

  async $fetchCodec() {
    const url = `http://127.0.0.1:${this.port}/codec`
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
        if (res.ok) return await res.json()
      } catch {}
      await sleep(300)
    }
    throw new Error('读取 iOS HEVC 解码器配置超时')
  }

  $startAudioRelay() {
    if (this.audioAbort || !this.wantAudio || this.state !== 'running') return
    void this.$pumpAudio()
  }

  $stopAudioRelay() {
    if (!this.audioAbort) return
    try { this.audioAbort.abort() } catch {}
    this.audioAbort = null
  }

  async $pumpAudio() {
    const controller = new AbortController()
    this.audioAbort = controller
    const url = `http://127.0.0.1:${this.port}/audio.bin`
    let buffer = Buffer.alloc(0)
    try {
      while (this.state === 'running' && this.wantAudio && this.audioAbort === controller) {
        try {
          const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
          if (!res.ok || !res.body) return
          const reader = res.body.getReader()
          buffer = Buffer.alloc(0)
          for (;;) {
            const { done, value } = await reader.read()
            if (done || this.state !== 'running' || this.audioAbort !== controller) break
            if (!value) continue
            const incoming = Buffer.isBuffer(value) ? value : Buffer.from(value)
            buffer = buffer.length === 0 ? incoming : Buffer.concat([buffer, incoming])
            let offset = 0
            while (buffer.length - offset >= 4) {
              const length = buffer.readUInt32BE(offset)
              if (length === 0 || length > 32 * 1024 * 1024) { offset += 4; continue }
              if (buffer.length - offset < 4 + length) break
              const pcm = buffer.subarray(offset + 4, offset + 4 + length)
              offset += 4 + length
              if (pcm.length > 0) this.emit('audio', { data: pcm, pts: this.$nextPts(), config: false, pcm: true })
            }
            if (offset > 0) buffer = buffer.subarray(offset)
          }
        } catch {
          if (controller.signal.aborted || this.state !== 'running') return
          await sleep(800)
        }
      }
    } finally {
      if (this.audioAbort === controller) this.audioAbort = null
    }
  }

  $updateRotation(rotation) {
    if (!Number.isFinite(rotation) || rotation % 90 !== 0) return
    const degrees = ((rotation % 360) + 360) % 360
    if (this.rotation === degrees) return
    this.rotation = degrees
    this.emit('meta', { rotation: degrees })
  }

  $keyboard(action) {
    const next = this.keyboardQueue.then(action)
    this.keyboardQueue = next.catch(() => {})
    return next
  }

  async $postJson(path, payload) {
    if (this.state !== 'running' || !this.port) return false
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload !== undefined ? JSON.stringify(payload) : '',
        signal: AbortSignal.timeout(4000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** POST 并返回解析后的 JSON；失败返回 null。 */
  async $postJsonBody(path, payload) {
    if (this.state !== 'running' || !this.port) return null
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload !== undefined ? JSON.stringify(payload) : '',
        signal: AbortSignal.timeout(6000)
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  /**
   * 在 HID 触控面上走一段手势。
   * @param {{steps?: number, durationMs?: number, holdStartMs?: number, holdEndMs?: number}} [opts]
   */
  async $swipeHid(x1, y1, x2, y2, opts = {}) {
    const steps = opts.steps ?? 8
    const durationMs = opts.durationMs ?? 220
    const holdStartMs = opts.holdStartMs ?? 40
    const holdEndMs = opts.holdEndMs ?? 0
    const stepDelay = Math.max(12, Math.floor(durationMs / Math.max(1, steps)))
    const first = await this.$postJson('/touch', { type: 'contact', x: x1, y: y1 })
    if (!first) return false
    if (holdStartMs > 0) await sleep(holdStartMs)
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      const x = Math.round(x1 + (x2 - x1) * t)
      const y = Math.round(y1 + (y2 - y1) * t)
      await this.$postJson('/touch', { type: 'contact', x, y })
      if (i < steps) await sleep(stepDelay)
    }
    if (holdEndMs > 0) await sleep(holdEndMs)
    return this.$postJson('/touch', { type: 'release', x: x2, y: y2 })
  }

  async $pressHidKey(usages) {
    if (!Array.isArray(usages) || usages.length === 0) return false
    // 完整按下与抬起由 sidecar 在单次请求内原子执行，避免多趟 HTTP 与修饰键半路丢失。
    return this.$postJson('/key', { tap: usages })
  }

  async $sendText(rawText) {
    // 电脑键盘作为外接键盘逐键发送；中文由手机输入法组字，用数字/空格/回车选字。
    const text = String(rawText ?? '')
    const taps = []
    for (const char of text) {
      const usages = charToHidUsages(char)
      if (usages) taps.push(usages)
    }
    if (taps.length === 0) return true
    if (taps.length === 1) return this.$postJson('/key', { tap: taps[0] })
    return this.$postJson('/key', { taps })
  }

  requestKeyframe() {
    this.$postJson('/pli').catch(() => {})
  }

  keepalive() {}

  async handleControl(message) {
    switch (message.kind) {
      case 'touch': {
        const type = message.action === 'up' ? 'release' : 'contact'
        return this.$postJson('/touch', {
          type,
          x: toHidCoord(message.x),
          y: toHidCoord(message.y)
        })
      }
      case 'scroll':
        // 滚轮每个事件立即发送；手势的开启/收尾由桥接维护，停下即停住。
        return this.$postJson('/key', {
          scroll: {
            x: message.x ?? 0.5, y: message.y ?? 0.5,
            dx: message.dx ?? 0, dy: message.dy ?? 0
          }
        })
      // ---- iOS 工具栏动作 ----
      case 'home':
        return this.$postJson('/button', { name: 'home', state: 'press' })
      case 'app-switcher':
        // App 切换器 = 连按两次 Home，与 Xcode Device Hub 一致。
        return this.$postJson('/key', { recents: true })
      case 'volume-up':
        return this.$postJson('/button', { name: 'volume-up', state: 'press' })
      case 'volume-down':
        return this.$postJson('/button', { name: 'volume-down', state: 'press' })
      case 'key': {
        // 键盘按键（真实键盘转发），不是工具栏按钮。
        const usages = keycodeToHidUsages(message.keycode, message.metastate ?? 0)
        if (!usages) return false
        return this.$keyboard(() => this.$pressHidKey(usages))
      }
      case 'text':
        return this.$keyboard(() => this.$sendText(message.text))
      case 'power':
        return this.$postJson('/button', { name: 'lock', state: 'press' })
      case 'rotate': {
        const degrees = ((this.rotation % 360) + 360) % 360
        // 横屏时转回正向竖屏，不转到倒置。
        const direction = degrees === 90 ? 'left' : 'right'
        return Boolean(await this.$postJsonBody('/rotate', { direction }))
      }
      case 'notifications':
        // 左上角下拉 = 通知中心。
        return this.$swipeHid(12000, 1200, 12000, 44000, { steps: 10, durationMs: 260, holdStartMs: 80 })
      case 'control-center':
        // 右上角下拉 = 控制中心（必须从屏幕最右上角起手）。
        return this.$swipeHid(54000, 1200, 54000, 46000, { steps: 10, durationMs: 260, holdStartMs: 80 })
      case 'reset':
        this.requestKeyframe()
        return true
      case 'audio-relay':
        if (message.on) this.$startAudioRelay()
        else this.$stopAudioRelay()
        return true
      default:
        return false
    }
  }

  async stop() {
    if (this.state === 'stopped' || this.state === 'stopping') return
    this.state = 'stopping'
    clearInterval(this.usbTimer)
    this.usbTimer = null
    this.$stopAudioRelay()
    const proc = this.child
    this.child = null
    if (proc) {
      let exited = false
      const onExit = () => { exited = true }
      proc.once('exit', onExit)
      // 先让 bridge 自己收尾（关流、释放设备媒体会话），超时再杀进程树。
      try {
        proc.stdin?.write('quit\n')
        proc.stdin?.end()
      } catch {}
      for (let i = 0; i < 15 && !exited; i += 1) await sleep(100)
      if (!exited) await killProcessTree(proc.pid)
      if (!exited) {
        await new Promise((resolve) => {
          proc.once('exit', resolve)
          setTimeout(resolve, 1500)
        })
      }
      proc.removeListener('exit', onExit)
      try { proc.kill() } catch {}
    }
    this.state = 'stopped'
    this.emit('close')
  }
}
