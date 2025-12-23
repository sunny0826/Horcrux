import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const frontendDir = path.resolve(repoRoot, 'frontend')

test('Makefile 使用 7626 启动开发环境', async () => {
  const makefilePath = path.resolve(repoRoot, 'Makefile')
  const content = await readFile(makefilePath, 'utf8')

  assert.ok(
    content.includes('Starting development environment on http://localhost:7626'),
    'Makefile 应提示通过 7626 访问开发环境',
  )
  assert.ok(
    content.includes('HORCRUX_DEV=1'),
    'Makefile 应开启后端开发代理模式',
  )
  assert.ok(
    /HORCRUX_VITE_DEV_SERVER=http:\/\/localhost:\$\(VITE_PORT\)/.test(content),
    'Makefile 应通过 VITE_PORT 变量指定 Vite 开发服务器地址',
  )
  assert.ok(
    content.includes('PORT=7626'),
    'Makefile 应强制后端使用 7626',
  )
  assert.ok(
    /VITE_PORT\s*:=\s*\$\(shell\s+sh\s+-c\s+'p=7627;/.test(content),
    'Makefile 应从 7627 开始选择可用的 Vite 内部端口',
  )
  assert.ok(
    /pnpm dev -- --port \$\(VITE_PORT\) --strictPort/.test(content),
    'Makefile 应使用 VITE_PORT 启动 Vite 开发服务器',
  )
})

test('Vite 配置：dev server 7627 + HMR client 走 7626', async () => {
  const viteConfigPath = path.resolve(frontendDir, 'vite.config.ts')
  const content = await readFile(viteConfigPath, 'utf8')

  assert.match(content, /server:\s*\{[\s\S]*?port:\s*7627[\s\S]*?\}/m)
  assert.match(content, /hmr:\s*\{[\s\S]*?clientPort:\s*7626[\s\S]*?\}/m)
})
