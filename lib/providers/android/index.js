// 安卓设备提供方：管理 adb、设备发现、scrcpy / screencap 会话、输入注入与无线调试。
import { existsSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { createSocket as udpConnect } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { Adb, BUNDLED_ADB, ensurePlatformTools, hasAdbOnPath, resolveAdb } from '../../adb.js'
import { BUNDLED_SERVER, ScreencapSession, SCRCPY_VERSION } from '../../session.js'
import { AndroidDirectSession } from './direct-session.js'

const HOST_PORT = /^[A-Za-z0-9._-]+:\d{1,5}$/
const DEVICE_SERIAL = /^[A-Za-z0-9._-]+$/
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 本机出口地址的掩码长度，从网络接口信息里取。 */
function localPrefixFor(address) {
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.address !== address || !info.cidr) continue
      const prefix = Number(info.cidr.split('/')[1])
      if (Number.isFinite(prefix)) return prefix
    }
  }
  return null
}

/** 两个地址是否落在同一个子网。 */
function sameSubnet(a, aPrefix, b, bPrefix) {
  if (!Number.isFinite(aPrefix) || !Number.isFinite(bPrefix)) return false
  const toInt = (ip) => ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0)
  const mask = (prefix) => (prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)
  return ((toInt(a) & mask(aPrefix)) >>> 0) === ((toInt(b) & mask(bPrefix)) >>> 0)
}

/** 到达目标地址所用的本机出口 IP。 */
function localAddressFor(host) {
  return new Promise((resolve) => {
    const socket = udpConnect('udp4')
    const done = (value) => {
      try { socket.close() } catch {}
      resolve(value)
    }
    try {
      socket.connect(5555, host, () => {
        try { done(socket.address().address) } catch { done('') }
      })
    } catch { done('') }
    socket.once('error', () => done(''))
  })
}

/** 探测平板端口：open 可连，refused 可达但未监听，timeout 网络不通。 */
function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port })
    const finish = (result) => {
      try { socket.destroy() } catch {}
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish('open'))
    socket.once('timeout', () => finish('timeout'))
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'refused' : 'error'))
  })
}

/** 探测端口直到就绪：800ms 超时、400ms 间隔，open/refused 即返回。 */
async function waitForPort(host, port, deadline) {
  let reachable = 'timeout'
  while (Date.now() < deadline) {
    reachable = await probeTcp(host, port, 800)
    if (reachable === 'open' || reachable === 'refused') return reachable
    await sleep(400)
  }
  return reachable
}

/** 设备未就绪时的提示文案。 */
function deviceUnreadyReason(serial, state) {
  if (state === 'authorizing' || state === 'unauthorized') {
    return '平板在等调试授权：解锁平板，点「允许」后再试一次'
  }
  if (state === 'offline') return `设备 ${serial} 处于离线状态：重新插拔数据线，或再点一次「转无线」`
  if (state === '') return `找不到设备 ${serial}：确认数据线和无线连接是否还在`
  return `设备 ${serial} 状态异常（${state}）：重新插拔数据线，或再点一次「转无线」`
}

/** 连不上时按 adb 的输出区分原因：拒绝、超时、等待授权。 */
function connectFailure(connected, address) {
  if (connected.state === 'authorizing' || connected.state === 'unauthorized') {
    return '平板弹出了「允许 USB 调试吗？」，点允许后再试一次'
  }
  const output = connected.output ?? ''
  if (/10061|refused|积极拒绝/i.test(output)) {
    return '平板没有监听调试端口：确认「USB 调试」仍开着，再点一次「转无线」'
  }
  if (connected.state === 'offline') {
    return '平板锁屏时确认不了调试授权：解锁平板，再点一次「转无线」'
  }
  if (/10060|10065|timed out|没有正确答复|超时/i.test(output)) {
    return `连不上 ${address}：平板和电脑要在同一局域网内，校园网和访客网络常隔离设备`
  }
  return output || `连不上 ${address}`
}

export function createAndroidProvider({ getSettings, warn }) {
  const configuredAdb = getSettings().adbPath
  let adb = new Adb(resolveAdb(configuredAdb))
  let adbPreparing = false
  if (!configuredAdb && !existsSync(BUNDLED_ADB) && !hasAdbOnPath()) {
    adbPreparing = true
    ensurePlatformTools()
      .then((binary) => { adb = new Adb(binary) })
      .catch((error) => warn(`准备 adb 失败：${error.message}`))
      .finally(() => { adbPreparing = false })
  }

  // 拿不到音频的设备，下次直接跳过带音频的尝试。
  const audioUnsupported = new Set()

  /** 读设备的 WLAN 地址与掩码长度，需在 tcpip 之前调用。 */
  async function deviceAddress(serial) {
    const { ok, stdout } = await adb.shell(serial, 'ip -4 addr', 8000)
    if (!ok) return null
    for (const match of stdout.matchAll(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/g)) {
      const ip = match[1]
      if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue
      return { ip, prefix: Number(match[2]) }
    }
    return null
  }

  /** 反复尝试 adb connect，直到设备进入 device 状态或超时。 */
  async function connectWithRetry(address, timeoutMs = 20000, attemptMs = 10000) {
    let output = ''
    let state = ''
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await adb.run(['connect', address], { timeout: attemptMs })
      output = `${result.stdout}${result.stderr}`.trim()
      if (!/cannot|failed to connect|refused/i.test(output) && /connected to/i.test(output)) {
        const list = await adb.devices()
        state = list.find((device) => device.serial === address)?.state ?? ''
        if (state === 'device') return { ok: true, output, state }
        if (state === 'offline') await adb.run(['disconnect', address], { timeout: 5000 }).catch(() => {})
        if (state === 'authorizing' || state === 'unauthorized') {
          await sleep(1000)
          continue
        }
      }
      await sleep(500)
    }
    return { ok: false, output, state }
  }

  /** 等设备进入 device 状态，返回最后一次看到的状态。 */
  async function waitForDevice(serial, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const list = await adb.devices().catch(() => [])
      const state = list.find((device) => device.serial === serial)?.state ?? ''
      if (state === 'device' || state === '' || Date.now() >= deadline) return state
      await sleep(400)
    }
  }

  /** 清掉设备上残留的 scrcpy reverse 转发。 */
  async function clearReverse(serial) {
    for (const entry of await adb.reverseList(serial)) {
      if (!entry.local.startsWith('localabstract:scrcpy_')) continue
      await adb.reverseRemove(serial, entry.local)
    }
  }

  /** 用 mDNS 查找同一台设备的连接端口，查不到返回空串。 */
  async function mdnsConnectAddress(host) {
    const { ok, stdout } = await adb.run(['mdns', 'services'], { timeout: 8000 })
    if (!ok) return ''
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('_adb-tls-connect._tcp')) continue
      const match = /(\d+\.\d+\.\d+\.\d+):(\d{1,5})/.exec(line)
      if (match && match[1] === host) return `${match[1]}:${match[2]}`
    }
    return ''
  }

  async function status() {
    let version = ''
    let error = ''
    try {
      version = await adb.version()
    } catch (failure) {
      error = failure.message
    }
    let devices = []
    if (version) {
      try {
        const raw = await adb.devices()
        devices = raw.map((device) => ({
          ...device,
          platform: 'android',
          connection: device.serial.includes(':') ? 'wifi' : 'usb'
        }))
      } catch (failure) {
        error = failure.message
      }
    }
    return {
      ok: Boolean(version),
      version,
      error,
      binary: adb.binary,
      preparing: adbPreparing,
      devices
    }
  }

  function decorateSession(target, mode) {
    target.platform = 'android'
    target.mode = mode
    if (target instanceof AndroidDirectSession) return target
    target.handleControl = (message) => target.send(message)
    target.requestKeyframe = () => {}
    target.keepalive = () => {}
    return target
  }

  /** 先带音频试 scrcpy，失败退不带音频，再失败降级截图。 */
  async function startSession({ serial, mode, maxSize, wire }) {
    if (serial.includes(':')) await adb.shell(serial, 'input keyevent 224', 5000).catch(() => {})
    const state = await waitForDevice(serial, 8000)
    if (state !== 'device') throw new Error(deviceUnreadyReason(serial, state))
    await clearReverse(serial)
    const cfg = getSettings()
    const resolvedMode = mode ?? cfg.mode
    const jar = cfg.serverJar.length > 0 ? cfg.serverJar : BUNDLED_SERVER
    const resolvedSize = maxSize ?? cfg.maxSize
    const wantAudio = cfg.audio && !audioUnsupported.has(serial)

    const build = (useScrcpy, audio) => useScrcpy
      ? new AndroidDirectSession({
          adb,
          serial,
          maxSize: resolvedSize,
          maxFps: cfg.maxFps,
          videoBitRate: cfg.videoBitRate,
          audio,
          serverPath: jar,
          version: SCRCPY_VERSION
        })
      : new ScreencapSession({ adb, serial, intervalMs: cfg.screencapIntervalMs })

    const scrcpy = (audio) => ({ mode: 'scrcpy', audio })
    const screencap = { mode: 'screencap', audio: false }
    let plan
    if (resolvedMode === 'screencap') plan = [screencap]
    else if (resolvedMode === 'scrcpy') plan = wantAudio ? [scrcpy(true), scrcpy(true), scrcpy(false)] : [scrcpy(false)]
    else plan = wantAudio
      ? [scrcpy(true), scrcpy(true), scrcpy(false), screencap]
      : [scrcpy(false), scrcpy(false), screencap]

    let lastFailure = ''
    for (const attempt of plan) {
      const target = decorateSession(build(attempt.mode === 'scrcpy', attempt.audio), attempt.mode)
      wire?.(target, attempt.mode)
      try {
        await target.start()
        return {
          session: target,
          info: {
            state: 'running',
            platform: 'android',
            mode: attempt.mode,
            serial,
            deviceName: target.deviceName || serial,
            screen: target.screen ?? null,
            audio: Boolean(target.audioCodec),
            audioCodec: target.audioCodec ?? null,
            // 引擎用此端口直连安卓独立 Worker 的音视频与控制接口，绕开宿主事件循环。
            ...(target.httpPort ? { videoPort: target.httpPort } : {}),
            lastError: lastFailure
          }
        }
      } catch (error) {
        if (attempt.audio && /audio|AudioRecord|opus|codec|音频/i.test(error.message)) {
          audioUnsupported.add(serial)
        }
        lastFailure = attempt.mode === 'scrcpy'
          ? `scrcpy 启动失败：${error.message}`
          : `截屏模式失败：${error.message}`
        warn(lastFailure)
        await target.stop().catch(() => {})
        await sleep(600)
      }
    }
    throw new Error(lastFailure || '启动失败')
  }

  async function connectAddress(rawAddress) {
    const address = String(rawAddress ?? '').trim()
    if (!HOST_PORT.test(address)) {
      return { status: 400, body: { error: '地址格式应为 192.168.1.5:5555' } }
    }
    const result = await adb.run(['connect', address], { timeout: 15000 })
    const output = `${result.stdout}${result.stderr}`.trim()
    if (!result.ok || /cannot connect|failed to connect/i.test(output)) {
      return { status: 502, body: { ok: false, error: output || 'adb connect 失败' } }
    }
    return { status: 200, body: { ok: true, message: output } }
  }

  async function toWireless(rawSerial) {
    const serial = String(rawSerial ?? '').trim()
    if (!DEVICE_SERIAL.test(serial)) {
      return { status: 400, body: { ok: false, error: '需要 USB 设备的序列号' } }
    }
    await adb.shell(serial, 'input keyevent 224', 5000).catch(() => {})
    await adb.shell(serial, 'wm dismiss-keyguard', 5000).catch(() => {})
    const device = await deviceAddress(serial)
    if (!device) {
      return { status: 409, body: { ok: false, error: '读不到设备的 WLAN 地址，确认平板已连上 Wi-Fi' } }
    }
    const { ip } = device
    await adb.run(['disconnect', `${ip}:5555`], { timeout: 5000 }).catch(() => {})
    const cfg = getSettings()
    const jar = cfg.serverJar.length > 0 ? cfg.serverJar : BUNDLED_SERVER
    const remoteJar = `/data/local/tmp/dsh-phone-mirror-${SCRCPY_VERSION}.jar`
    await adb.pushJar(serial, jar, remoteJar).catch((error) => warn(`预推 scrcpy server 失败：${error.message}`))
    const tcp = await adb.run(['-s', serial, 'tcpip', '5555'], { timeout: 20000 })
    if (!tcp.ok) {
      const output = `${tcp.stdout}${tcp.stderr}`.trim()
      return { status: 502, body: { ok: false, error: output || 'adb tcpip 失败' } }
    }
    const address = `${ip}:5555`
    const deadline = Date.now() + 20000
    const reachable = await waitForPort(ip, 5555, deadline)
    if (reachable === 'timeout' || reachable === 'error') {
      const local = await localAddressFor(ip)
      await adb.run(['disconnect', address], { timeout: 5000 }).catch(() => {})
      await adb.run(['-s', serial, 'usb'], { timeout: 10000 }).catch(() => {})
      const localPrefix = local ? localPrefixFor(local) : null
      const from = local
        ? `（本机出口 ${local}${localPrefix != null ? `/${localPrefix}` : ''}）`
        : ''
      const same = sameSubnet(ip, device.prefix, local, localPrefix)
      const reason = same
        ? '同一网段内连不上，通常是网络隔离或防火墙（校园网、访客网络常见），换一个网络再试'
        : '两台设备不在同一网段，确认连的是同一个 Wi-Fi'
      return {
        status: 502,
        body: {
          ok: false,
          error: `电脑连不到平板 ${ip}/${device.prefix}${from}：${reason}`
        }
      }
    }
    const remaining = Math.max(4000, deadline - Date.now())
    const connected = await connectWithRetry(address, remaining, 4000)
    if (!connected.ok) {
      await adb.run(['disconnect', address], { timeout: 5000 }).catch(() => {})
      return { status: 502, body: { ok: false, error: connectFailure(connected, address) } }
    }
    return { status: 200, body: { ok: true, address } }
  }

  async function pair(rawAddress, rawCode) {
    const address = String(rawAddress ?? '').trim()
    const code = String(rawCode ?? '').trim()
    if (!HOST_PORT.test(address)) {
      return { status: 400, body: { ok: false, error: '配对地址格式应为 192.168.1.5:37123' } }
    }
    if (!/^\d{6}$/.test(code)) {
      return { status: 400, body: { ok: false, error: '配对码是 6 位数字' } }
    }
    const result = await adb.run(['pair', address, code], { timeout: 35000 })
    const output = `${result.stdout}${result.stderr}`.trim()
    if (!/Successfully paired/i.test(output)) {
      return { status: 502, body: { ok: false, error: output || 'adb pair 失败' } }
    }
    const host = address.slice(0, address.lastIndexOf(':'))
    const connectAddress = await mdnsConnectAddress(host)
    if (!connectAddress) {
      return { status: 200, body: { ok: true, paired: true, address: null, message: output } }
    }
    const connected = await connectWithRetry(connectAddress)
    if (!connected.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          paired: true,
          address: null,
          error: `配对成功，${connectFailure(connected, connectAddress)}`
        }
      }
    }
    return { status: 200, body: { ok: true, paired: true, address: connectAddress, message: output } }
  }

  async function disconnectWireless(rawAddress) {
    let address = String(rawAddress ?? '').trim()
    if (!address) {
      const list = await adb.devices()
      address = list.find((device) => device.serial.includes(':'))?.serial ?? ''
    }
    if (!address) return { status: 200, address: null, body: { ok: true, address: null, message: '没有无线连接' } }
    if (!HOST_PORT.test(address)) {
      return { status: 400, address: null, body: { ok: false, error: '地址格式应为 192.168.1.5:5555' } }
    }
    const result = await adb.run(['disconnect', address], { timeout: 10000 })
    return {
      status: 200,
      address,
      body: {
        ok: true,
        address,
        message: `${result.stdout}${result.stderr}`.trim()
      }
    }
  }

  async function canRecoverWireless(serial) {
    if (!serial || !serial.includes(':')) return false
    const list = await adb.devices().catch(() => [])
    return list.some((device) => device.serial === serial && device.state === 'device')
  }

  return {
    id: 'android',
    get binary() { return adb.binary },
    status,
    startSession,
    connectAddress,
    toWireless,
    pair,
    disconnectWireless,
    canRecoverWireless
  }
}
