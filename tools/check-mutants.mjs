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

// ⚠️ 子进程一律**不走管道**(stdio 用 ignore/inherit):
//    · 管道在受限环境(沙箱)里会 EPERM —— 而这条门禁恰恰是"环境坏了也要能跑"的东西;
//    · 我们只需要**退出码**,不需要子进程的 stdout —— 变异体跑出来的报告又长又没用
//      (每个变异都**应该**失败,把它们的失败报告全打出来只会淹掉真正的信息)。
//    stderr 留着:生成器的报错(模式没对上 / CRLF 守卫)都走那边,真出事时看得见。
const NO_PIPE = ['ignore', 'ignore', 'inherit']

// ① 先生成
const gen = spawnSync(process.execPath, [path.join(here, 'make-mutants.mjs')], {
  cwd: here,
  stdio: NO_PIPE,
})
if (gen.status !== 0) {
  console.error('make-mutants.mjs 失败(原因见它自己的输出)')
  // ⚠️ 子进程**根本没起来**时(ENOENT/EPERM/沙箱),stdout/stderr 都是空的 ——
  //    只打那两个会得到一行什么都没有的报错。真正的原因在 gen.error 里。
  if (gen.error) console.error(`  子进程没跑起来:${gen.error.message}`)
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
let broken = 0

for (const name of mutants) {
  const r = spawnSync(
    process.execPath,
    [path.join(here, 'harness.mjs'), '--bridge', path.join(mutantsDir, name)],
    { cwd: here, stdio: NO_PIPE },
  )
  // ⚠️ 子进程**没跑起来**时 status 是 null,而 `null !== 0` 会被算成"抓到了" ——
  //    也就是说环境一坏,这个门禁会打印 "N/N 被抓到 ✓" 却一个变异都没跑。
  //    没起来 ≠ 抓到,必须单独计数并且判红。
  if (r.error) {
    broken += 1
    console.log(`  ERROR    ${name}   ← 子进程没跑起来:${r.error.message}`)
    continue
  }
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
if (broken > 0) {
  console.log(`✗ ${broken} 个变异**根本没跑**(子进程起不来)—— 这次运行不构成证据`)
  process.exit(1)
}
if (missed > 0) {
  console.log(`✗ ${missed} 个漏网 —— 对应的测试是空的,必须补`)
  process.exit(1)
}
console.log('✓ 测试套件确实会失败(不是永远绿的摆设)')
