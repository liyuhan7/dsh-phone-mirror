import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  runtimeCacheDir,
  runtimeCandidates,
  runtimeManifest,
  runtimePlatform
} from '../lib/providers/ios/runtime.js'

const platform = runtimePlatform()

test('runtime candidates prefer the configured python, then the bundled copy', () => {
  const previous = process.env.DSH_PHONE_MIRROR_IOS_PYTHON
  try {
    delete process.env.DSH_PHONE_MIRROR_IOS_PYTHON
    const plain = runtimeCandidates()
    assert.equal(plain[0].source, 'bundled')
    assert.ok(plain[0].python.includes(join('tools', 'ios-runtime', platform)))

    const configuredPath = resolve('/custom/python.exe')
    process.env.DSH_PHONE_MIRROR_IOS_PYTHON = configuredPath
    const configured = runtimeCandidates()
    assert.equal(configured[0].source, 'env')
    assert.equal(configured[0].python, configuredPath)
  } finally {
    if (previous === undefined) delete process.env.DSH_PHONE_MIRROR_IOS_PYTHON
    else process.env.DSH_PHONE_MIRROR_IOS_PYTHON = previous
  }
})

test('runtime cache lives under DSH_HOME and follows the manifest version', () => {
  const previous = process.env.DSH_HOME
  try {
    const home = resolve('dsh-home')
    process.env.DSH_HOME = home
    assert.equal(runtimeCacheDir(3), join(home, 'phone-mirror-ios-runtime', '3'))
    const version = runtimeManifest()?.runtimeVersion
    if (version != null) {
      assert.ok(runtimeCandidates().some((entry) => entry.source === 'cache'))
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('runtime manifest points at the Windows x64 release asset', () => {
  const manifest = runtimeManifest()
  assert.ok(manifest, 'runtime-manifest.json should be readable')
  const entry = manifest.platforms?.['win32-x64']
  assert.ok(entry, 'manifest should describe win32-x64')
  assert.match(entry.url, /\/releases\/download\/ios-runtime-v\d+\//)
  assert.equal(entry.file, 'dsh-phone-mirror-ios-runtime-win32-x64.zip')
  assert.equal(typeof entry.sha256, 'string')
})
