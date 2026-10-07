// check-mutants-js.mjs — 证明**插件 / 面板 / 浏览器**那三半的测试真的会失败。
//
// 桥那半边有 check-mutants.mjs;这个文件把同一条纪律补齐到另外三半:
// `make-mutants-js.mjs` 把真会犯的错打进副本,这里逐个跑**指定的那个测试**,
// 要求每一个都必须让它变红。任何一个"全绿通过",就说明对应的断言是空的。
//
//   node check-mutants-js.mjs
//
// ⚠️ 子进程一律用 `stdio: ['ignore','ignore','inherit']`,**不用管道**:
//    管道在某些受限环境(沙箱)里会 EPERM,而且这里本来也不需要子进程的 stdout ——
//    我们只看退出码。stderr 留着,真出错时看得见原因。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUTANTS } from './make-mutants-js.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MUTANTS_DIR = path.join(HERE, '.mutants-js')
const NO_PIPE = ['ignore', 'ignore', 'inherit']

// ① 先生成(它的 stdout 直接放出来:模式没对上时要看得到是哪条)
const gen = spawnSync(process.execPath, [path.join(HERE, 'make-mutants-js.mjs')], {
  cwd: HERE,
  stdio: ['ignore', 'inherit', 'inherit'],
})
if (gen.status !== 0) {
  console.error('make-mutants-js.mjs 失败')
  if (gen.error) console.error(`  子进程没跑起来:${gen.error.message}`)
  process.exit(1)
}

// ② 清单**直接 import** 进来(不跑 --list 再解析:那要管道,受限环境会 EPERM)
const plan = MUTANTS.map(([name, why, which, test]) => ({ name, why, which, test }))

// ③ 逐个跑:必须让**指定的那个测试**失败
const caught = []
let missed = 0
let broken = 0

for (const m of plan) {
  const file = path.join(MUTANTS_DIR, `${m.name}.js`)
  if (!fs.existsSync(file)) {
    broken += 1
    console.log(`  ERROR    ${m.name}   ← 副本没生成`)
    continue
  }
  const arg =
    m.test === 'check-client.mjs'
      ? [file]
      : m.test === 'panel-tests.mjs'
        ? ['--panel', file]
        : m.test === 'plugin-tests.mjs'
          ? ['--plugin', file]
          : null
  if (arg === null) {
    broken += 1
    console.log(`  ERROR    ${m.name}   ← 清单里的测试名不认识:${m.test}`)
    continue
  }

  const r = spawnSync(process.execPath, [path.join(HERE, m.test), ...arg], {
    cwd: HERE,
    stdio: NO_PIPE,
  })
  // ⚠️ 没跑起来时 status 是 null,而 `null !== 0` 会被算成"抓到了" —— 必须单独计数
  if (r.error) {
    broken += 1
    console.log(`  ERROR    ${m.name}   ← 子进程没跑起来:${r.error.message}`)
    continue
  }
  if (r.status !== 0) {
    caught.push(m.name)
    console.log(`  caught   ${m.name}   (${m.test})`)
  } else {
    missed += 1
    console.log(`  MISSED   ${m.name}   ← ${m.test} 没抓到:${m.why}`)
  }
}

console.log('')
console.log(`${caught.length}/${plan.length} 个变异被抓到`)
if (broken > 0) {
  console.log(`✗ ${broken} 个变异**根本没跑** —— 这次运行不构成证据`)
  process.exit(1)
}
if (missed > 0) {
  console.log(`✗ ${missed} 个漏网 —— 对应的断言是空的,必须补`)
  process.exit(1)
}
console.log('✓ 插件 / 面板 / 浏览器三半的测试确实会失败(不是永远绿的摆设)')
