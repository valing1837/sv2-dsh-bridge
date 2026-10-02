// 源码文件体检:BOM / 编码损坏 / 关键常量。
//
// 为什么需要它:
//   在 Windows PowerShell 5.1 下用 `Set-Content -Encoding UTF8` 改源码会写入 **BOM**,
//   而 `Get-Content -Raw` 不带 -Encoding 时按 **ANSI(936)** 读 —— 两者都会把中文源码毁掉。
//   这个脚本用来在改完之后立刻验一遍,而不是等宿主加载时才炸。
//
//   node check-file.mjs <file> [...]
import fs from 'node:fs'
import path from 'node:path'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node check-file.mjs <file> [...]')
  process.exit(2)
}

let bad = 0
for (const file of files) {
  const abs = path.resolve(file)
  const buf = fs.readFileSync(abs)
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const text = buf.toString('utf8')
  const replacement = (text.match(/\uFFFD/g) ?? []).length
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const version = text.match(/(?:BRIDGE_VERSION|VERSION)\s*[:=]\s*['"]([^'"]+)['"]/)
  const ops = (text.match(/^function OPS\./gm) ?? []).length

  const problems = []
  if (hasBom) problems.push('有 UTF-8 BOM(PowerShell Set-Content 的痕迹;宿主加载可能报错)')
  if (replacement > 0) problems.push(`有 ${replacement} 个替换字符 ⇒ 编码已损坏`)

  const line = `${path.basename(abs).padEnd(20)} cjk=${String(cjk).padEnd(5)} ${
    version ? `ver=${version[1]}` : ''
  } ${ops ? `ops=${ops}` : ''}`

  if (problems.length > 0) {
    bad += 1
    console.log(`FAIL  ${line}`)
    for (const p of problems) console.log(`        · ${p}`)
  } else {
    console.log(`OK    ${line}`)
  }
}

process.exit(bad === 0 ? 0 : 1)
