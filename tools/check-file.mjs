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
import { fileURLToPath } from 'node:url'

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

// ---- 随包文档:prompt 点名的文档必须真的在包里 -------------------------------
// 起因(2026-10-07,用户问"工作区清空对插件有没有影响"):prompt 里原本写的是
// `sv-dsh/docs/全参流程.md` —— 一个**工作区相对**路径。用户清空或搬走工作区之后,
// 这句话就变成空话:agent 会去找一个不存在的文件,白花一步。
// 现在文档随包发一份、路径运行时算;这条守卫钉住"清单与文件不许脱节"。
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.join(here, '..', 'plugin')
// ⚠️ 文本取自**调用方指定的那份**宿主入口 —— 变异测试传的是 .mutants-js/ 下的副本,
//    文件名不叫 index.js(叫变异名),所以**按内容识别**,不能按文件名。
//    如果这里写死查仓库那份,变异就永远"抓不到"(这个守卫自己就成了摆设)。
//    而 docs/ 目录**始终**是仓库里的 plugin/docs:变异体旁边没有 docs,
//    不能因为这个就把无关的变异也判红(那会掩盖真正的漏网)。
const indexArg = files.find((f) => {
  try {
    return /BUNDLED_DOCS/.test(fs.readFileSync(path.resolve(f), 'utf8'))
  } catch {
    return false
  }
})
const indexSrc = indexArg ? path.resolve(indexArg) : path.join(pluginDir, 'index.js')
const docsDir = path.join(pluginDir, 'docs')
if (fs.existsSync(indexSrc)) {
  const src = fs.readFileSync(indexSrc, 'utf8')
  // ⚠️ 先剥掉注释再查:注释里**引用**旧路径是解释历史,不是问题本身。
  //    (与 check-client.mjs 处理"注释里出现 document.body"同一个做法。)
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const m = code.match(/BUNDLED_DOCS\s*=\s*\[([^\]]*)\]/)
  const listed = m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : []
  if (listed.length === 0) {
    bad += 1
    console.log('FAIL  随包文档          index.js 里找不到 BUNDLED_DOCS 清单')
  }
  for (const n of listed) {
    const p = path.join(docsDir, n)
    if (fs.existsSync(p)) {
      console.log(`OK    随包文档          docs/${n}  (${fs.statSync(p).size} B)`)
    } else {
      bad += 1
      console.log(`FAIL  随包文档          docs/${n} 不在包里 ⇒ prompt 会指向一个不存在的文件`)
    }
  }
  if (/sv-dsh\/docs\//.test(code)) {
    bad += 1
    console.log('FAIL  随包文档          index.js 里还有工作区相对的 `sv-dsh/docs/` 路径(注释之外)')
  }
}

process.exit(bad === 0 ? 0 : 1)
