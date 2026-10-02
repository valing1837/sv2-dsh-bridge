// check-mutants.mjs — 证明测试套件**真的会失败**。
//
//   node check-mutants.mjs
//
// 为什么需要它:一个从没红过的测试套件不是证据。`make-mutants.mjs` 把一批
// **真实发生过的 bug** 打进桥的副本,这里逐个跑,要求**每一个都必须让测试失败**。
// 任何一个变异"全绿通过",就说明对应的测试是空的。
//
// 退出码:全部被抓到 ⇒ 0;有漏网的 ⇒ 1。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mutantsDir = path.join(here, '.mutants')

// ① 先生成
const gen = spawnSync(process.execPath, [path.join(here, 'make-mutants.mjs')], {
  cwd: here,
  encoding: 'utf8',
})
if (gen.status !== 0) {
  console.error('make-mutants.mjs 失败:')
  console.error(gen.stdout || '', gen.stderr || '')
  process.exit(1)
}

if (!fs.existsSync(mutantsDir)) {
  console.error(`没有生成 .mutants/ —— make-mutants.mjs 的输出和预期不一致`)
  process.exit(1)
}

const mutants = fs
  .readdirSync(mutantsDir)
  .filter((f) => f.endsWith('.lua'))
  .sort()

if (mutants.length === 0) {
  console.error('.mutants/ 是空的 —— 没有变异就证明不了任何事')
  process.exit(1)
}

// ② 逐个跑,要求失败
const escaped = []
let missed = 0

for (const name of mutants) {
  const r = spawnSync(
    process.execPath,
    [path.join(here, 'harness.mjs'), '--bridge', path.join(mutantsDir, name)],
    { cwd: here, encoding: 'utf8' },
  )
  const caught = r.status !== 0
  if (caught) {
    escaped.push(name)
    console.log(`  caught   ${name}`)
  } else {
    missed += 1
    console.log(`  MISSED   ${name}   ← 这个 bug 没有任何测试能发现`)
  }
}

console.log('')
console.log(`${escaped.length}/${mutants.length} 个变异被抓到`)
if (missed > 0) {
  console.log(`✗ ${missed} 个漏网 —— 对应的测试是空的,必须补`)
  process.exit(1)
}
console.log('✓ 测试套件确实会失败(不是永远绿的摆设)')
