// 无线地址学习存储的回环测试：备份 .tmp/ios-wireless-hosts.json，测完恢复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const storePath = join(pluginRoot, '.tmp', 'ios-wireless-hosts.json')
const backup = existsSync(storePath) ? readFileSync(storePath, 'utf8') : null

const { learnedWirelessHost, saveLearnedWirelessHost } = await import('../lib/providers/ios/session.js')

test('learned wireless hosts round-trip and prefer fresh values', () => {
  try {
    const udid = 'TEST-0000-LEARN'
    assert.equal(learnedWirelessHost(udid), '')
    saveLearnedWirelessHost(udid, '10.4.53.159')
    assert.equal(learnedWirelessHost(udid), '10.4.53.159')
    // 重新学习覆盖旧地址（DHCP 换 IP 后的场景）。
    saveLearnedWirelessHost(udid, '10.4.99.2')
    assert.equal(learnedWirelessHost(udid), '10.4.99.2')
    // 空 host 不写入、不覆盖已有值。
    saveLearnedWirelessHost(udid, '')
    assert.equal(learnedWirelessHost(udid), '10.4.99.2')
    // 只保留最新一台设备的地址，换设备时旧记录直接作废。
    saveLearnedWirelessHost('TEST-0000-OTHER', '10.4.7.7')
    assert.equal(learnedWirelessHost('TEST-0000-OTHER'), '10.4.7.7')
    assert.equal(learnedWirelessHost(udid), '')
  } finally {
    if (backup === null) {
      rmSync(storePath, { force: true })
    } else {
      writeFileSync(storePath, backup, 'utf8')
    }
  }
})
