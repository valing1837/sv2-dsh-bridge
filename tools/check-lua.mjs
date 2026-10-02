// Lua 语法校验 + 宿主元数据守卫。
//
// 为什么要单独守这几条:
//   · 常驻脚本里一个语法错 = 给用户在 DAW 里弹一个模态错误框。真机没法"试错"
//     (绑定错误穿透 pcall),所以语法必须先在本机跑绿。
//   · SV2 对 SidePanelSection 的**脚本名**强制纯 ASCII,含中文会被直接拒绝加载
//     (实测:「SidePanelSection 脚本名称必须仅包含 ASCII 字符」)。
//     中文只能出现在 Label / Button 的 text 等内容字段里。
//   · 面板脚本的 minEditorVersion 官方下限是 131330(2.1.2);菜单脚本用低值更稳。
//
//   node check-lua.mjs <file.lua> [...]
import fs from 'node:fs'
import path from 'node:path'
import luaparse from 'luaparse'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node check-lua.mjs <file.lua> [...]')
  process.exit(2)
}

const ASCII = /^[\x20-\x7e]*$/

/** 抓 `name = "..."` / `name: '...'` 这类字面量赋值(只看元数据键)。 */
function literalFields(source, keys) {
  const out = []
  for (const key of keys) {
    const re = new RegExp(`\\b${key}\\s*[:=]\\s*(['"])([^'"]*)\\1`, 'g')
    let m
    while ((m = re.exec(source)) !== null) out.push({ key, value: m[2] })
  }
  return out
}

let failed = 0

for (const file of files) {
  const abs = path.resolve(file)
  const name = path.basename(abs)
  const src = fs.readFileSync(abs, 'utf8')

  // ① 语法(luaparse 最高 5.3;SV2 是 5.4,但我们不用 5.4 独有语法)
  //    .js 脚本由 `node --check` 单独校验,这里只做元数据守卫。
  const isJs = abs.endsWith('.js')
  if (!isJs) {
    try {
      luaparse.parse(src, {
        luaVersion: '5.3',
        comments: false,
        scope: false,
        locations: true,
        extendedIdentifiers: false,
      })
    } catch (error) {
      failed += 1
      console.log(`FAIL  ${name}  line ${error.line ?? '?'}: ${error.message}`)
      continue
    }
  }

  // ② 元数据守卫
  const problems = []
  const isPanel = /type\s*[:=]\s*['"]SidePanelSection['"]/.test(src)

  for (const field of literalFields(src, ['name', 'title', 'category', 'author'])) {
    if (!ASCII.test(field.value)) {
      // name/title 在面板里是硬性要求;category/author 一并要求,免得踩别的校验
      problems.push(`${field.key} 含非 ASCII 字符:"${field.value}"`)
    }
  }

  if (isPanel) {
    const version = src.match(/minEditorVersion\s*[:=]\s*(\d+)/)
    if (!version) problems.push('SidePanelSection 缺少 minEditorVersion')
    else if (Number(version[1]) < 131330) {
      problems.push(`SidePanelSection 的 minEditorVersion=${version[1]} 低于官方下限 131330(2.1.2)`)
    }
    if (!/getSidePanelSectionState\s*\(/.test(src)) {
      problems.push('SidePanelSection 缺少 getSidePanelSectionState()')
    }
  }

  // ③ emoji / 星形符号守卫 —— **只对面板生效**。
  //
  // 为什么只查面板:emoji 在**侧栏面板**里会显示成乱码(用户 2026-10-02 实测:
  // "🔵和🟢显示的是乱码")。而**桥**返回的字符串是给 DSH 看的(聊天里 emoji 正常),
  // 两边要求不同 —— 所以这里按 isPanel 分流。
  //
  // 判定范围:U+1F000 以上(emoji 主体)、U+2600–27BF(杂项符号,含 ⚠)、
  // U+FE0F(变体选择符)、U+2B00–2BFF。
  // ⚠️ 制表符(━ U+2501)不在范围内 —— 它是普通制表符,能正常显示。
  if (isPanel) {
    const BAD_SYMBOL = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu
    const symbolHits = []
    // ⚠️ **先剥掉块注释再逐行看** —— 只跳过以 `--`/`*` 开头的行是不够的:
    //    `--[[ ]]` / `/* */` 内部的行走不到那条规则(这个文件的头部就是块注释)。
    const noBlock = src
      .replace(/--\[\[[\s\S]*?\]\]/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const lines2 = noBlock.split('\n')
    for (let i = 0; i < lines2.length; i++) {
      const t = lines2[i].trim()
      if (t.startsWith('--') || t.startsWith('//')) continue // 行注释:不渲染,不算
      const m = lines2[i].match(BAD_SYMBOL)
      if (m) symbolHits.push(`第 ${i + 1} 行有 ${m.length} 个:${m.join('')}`)
    }
    if (symbolHits.length > 0) {
      problems.push(
        `含 emoji / 装饰符号(宿主侧栏字体不渲染,会显示成乱码):\n          ` +
          symbolHits.slice(0, 5).join('\n          '),
      )
    }

    // ④ Duktape(ES5.1)兼容性
    //
    // ⚠️ 为什么必须有这一条:`node --check` 用的是现代 V8,**会放行 Duktape 不认的语法**。
    //    真机实测(2026-10-02):面板报 `SyntaxError: empty expression not allowed(line 908)`,
    //    而本机 node --check 是通过的 —— 差别就是**调用参数表末尾那个逗号**:
    //        f(a, b,)     ← ES2017 才允许,Duktape 直接拒绝
    //    宿主里脚本加载失败 = 面板整个不出来,而本机检查却是绿的。所以在这里钉死。
    const lines3 = noBlock.split('\n')
    const es5Problems = []
    // ⚠️ 用**全文正则**而不是"逐行看下一行" —— 第一版只查了"逗号在行尾 + ) 在下一行",
    //    结果同一行写的 `f(a, b,)` 直接漏掉(自测注入时发现的)。
    //    `,\s*\)` 只会命中**调用参数表**:数组字面量的尾逗号是 `,]`,ES5 本来就允许。
    {
      const re = /,\s*\)/g
      let m
      while ((m = re.exec(noBlock)) !== null) {
        const ln = noBlock.slice(0, m.index).split('\n').length
        es5Problems.push(`第 ${ln} 行:调用参数表末尾多了逗号(ES2017 语法,Duktape 拒绝)`)
      }
    }
    // 语法合法但**运行时不存在**的 ES6+ 方法 —— 这类更阴,加载能过、点了才崩
    const ES6_METHODS = [
      'includes', 'padStart', 'padEnd', 'startsWith', 'endsWith',
      'repeat', 'flat', 'flatMap', 'replaceAll', 'findLast',
    ]
    for (let i = 0; i < lines3.length; i++) {
      const t2 = lines3[i].trim()
      if (t2.startsWith('--') || t2.startsWith('//')) continue
      for (const m of ES6_METHODS) {
        if (new RegExp(`\\.${m}\\s*\\(`).test(lines3[i])) {
          es5Problems.push(`第 ${i + 1} 行用了 ES6+ 方法 .${m}() —— 宿主(ES5.1)没有这个函数`)
        }
      }
    }
    if (es5Problems.length > 0) {
      problems.push(
        `Duktape(ES5.1)不兼容 —— 本机 node 可能放行,但宿主会拒绝/崩:\n          ` +
          es5Problems.slice(0, 8).join('\n          '),
      )
    }
  }

  if (problems.length > 0) {
    failed += 1
    console.log(`FAIL  ${name}`)
    for (const p of problems) console.log(`        · ${p}`)
  } else {
    const kind = isPanel ? 'panel' : 'menu '
    console.log(`OK    ${name}  [${kind}]  (${src.split('\n').length} 行)`)
  }
}

process.exit(failed === 0 ? 0 : 1)
