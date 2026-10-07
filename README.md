# sv2-dsh-bridge

**把 Synthesizer V Studio 2 接进 DeepSeek Harness —— 让 AI 助手直接读写工程、调参、审歌词。**

[![CI](https://github.com/valing1837/sv2-dsh-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/valing1837/sv2-dsh-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Ops](https://img.shields.io/badge/ops-46-blue.svg)](plugin/sv/DSHBridge.lua)
[![Tests](https://img.shields.io/badge/tests-44%2F44-brightgreen.svg)](tools/harness.mjs)
[![Mutants](https://img.shields.io/badge/mutants-58%2F58%20caught-brightgreen.svg)](tools/check-mutants.mjs)

---

## 这是什么

Synthesizer V Studio 2 的脚本 API 只给了 `SV` 一个全局对象。能做的事情很多,
但**没有一个安全的作业层**:批量编辑没有事务,参数越界会静默失败,
一个错误的索引会改到相邻的轨。

这个项目就是那层作业层。它由两半组成:

```
┌──────────────────────────┐        文件通道          ┌──────────────────────────┐
│  Synthesizer V Studio 2  │  %USERPROFILE%\.dsh\     │   DeepSeek Harness       │
│                          │  └─ sv-bridge\           │                          │
│  DSHBridge.lua  ─────────┼──►  chat-in.jsonl  ──────┼──►  plugin/index.js      │
│  (43 个 op)              │  ◄── chat-out.jsonl ◄────┼───  (9 个 sv_* 工具)      │
│                          │                          │                          │
│  DSHPanel.js             │  panel.out / panel.in    │   侧栏聊天面板            │
│  (侧栏面板)              │                          │                          │
└──────────────────────────┘                          └──────────────────────────┘
```

- **`plugin/sv/`** —— 跑在 SV2 里的 Lua(桥,46 个 op)和 JS(侧栏面板)
- **`plugin/`** —— 跑在 DSH 里的宿主插件(11 个工具 + 常驻提示词 + 输入框下的状态卡)

没有网络通信:两边靠**固定文件名的轮询**交换 JSONL。
这绕开了 SV2 沙箱不给 socket 的限制。

---

## 能做什么

46 个 op,按用途分组:

| 类别 | op |
|---|---|
| **工程** | `get_context` · `get_summary` · `track_ops` · `group_ops` · `get_tempo` · `set_tempo` · `set_meter` |
| **音符** | `get_notes` · `get_selected_notes` · `get_layout` · `write_notes` · `set_note_attrs` · `split_notes` · `delete_notes` · `transpose_selected` · `select_notes` |
| **歌词** | `set_lyrics` · `apply_lyrics` · `align_lyrics` · `check_lyrics` |
| **布局** | `quantize` · `get_pit` · `write_pit` · `clear_pit` |
| **调参** | `auto_tone_shift` · `auto_expression` · `get_automation` · `set_automation` · `get_voice` · `set_voice` |
| **声库** | `list_voices` · `list_voice_presets` |
| **音频** | `get_audio_tracks` · `align_audio` |
| **安全网** | `snapshot` · `restore` · `selftest` |
| **宿主** | `get_computed` · `transport` · `panel_ask` · `chat_send` · `ping` · `stop` |

五个 op 值得一提:

- **`snapshot` / `restore`** —— **写错了能回去**。每个改音符的写操作之前,插件会自动留一份
  组状态;写出来的东西"合法但不对"时,一句 `sv_undo` 回到写之前,不用手工反向改。
  覆盖音符层(起始 / 时值 / 音高 / 歌词),**不含**属性层、组的增删、自动化曲线和声音属性 ——
  这些在返回里逐条写明,免得以为它能救一切。目标组按快照里的 **UUID 全局找**,
  所以你中途切到别的组了也能回滚对。
- **`selftest`** —— 全链路自检:目录可写 · 原子替换 · 读回 · 删除 · 心跳 · 日志 ·
  计时链 · 宿主与工程可读 · 快照存储,逐项给 ok/detail。
  「桥不在线」有七八种原因(没跑 / 被关 / 两端目录不一致 / 心跳过期 / 被模态框冻住…),
  用户在聊天里描述不出来 —— 让桥自己验一遍,DSH 侧的 `sv_doctor` 就能给一句能照做的结论。
- **`get_summary`** —— 只回统计量。500 个音符的明细有 20~50 KB,会把调用方的上下文冲垮;
  这个 op 回音符数、音高范围、**重叠数**、间隙数、音节数,一行搞定。
- **`auto_tone_shift`** —— 按音高把超出声库音域的**两端往中间拉**,而不是整曲移调。
  旋律走向和调性都保留。
- **`auto_expression`** —— 按**旋律走向逐音符**生成气声 / 张力 / 颤音曲线:
  上行加气声、下行加大张力、长音加颤音、句尾收。这才叫"参数随歌曲进行"。

---

## 快速开始

### 1. 部署 SV2 侧脚本

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-sv-scripts.ps1
```

会复制到 `%APPDATA%\Dreamtonics\Synthesizer V Studio 2\scripts\DSH\`。

### 2. 在 SV2 里启动

```
[脚本] > [重新扫描]  →  [脚本] > [DSH] > [DSH Bridge]
侧栏面板:            [脚本] > [DSH] > [DSH Panel]
```

### 3. 装进 DeepSeek Harness

把 `plugin/` 作为本地插件加入 profile —— **两处都要写**:

```jsonc
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": {
    "dsh-sv-bridge": "link:C:/path/to/sv2-dsh-bridge/plugin"
  },
  "dsh": {
    "profile": {
      // ⚠️ 只写 dependencies 不够:bundle 的 patch 只有在它被列进 dsh.profile.bundles
      //    时才会被应用(profile 的 cordis.yml 第一行就写着这条规则)。
      //    少了这一行 = 包装上了,但插件没挂载、预设也不会出现。
      "bundles": ["dsh-sv-bridge"]
    }
  }
}
```

> ⚠️ `plugin/index.js` 改动需要**重启 DSH**(ESM 模块缓存);SV2 侧脚本只需重跑。

### 4. 自检

```bash
cd tools
npm install
node harness.mjs           # 44 条行为测试
node check-mutants.mjs     # 58 个变异,漏一个就红
node check-lua.mjs ../plugin/sv/DSHBridge.lua
node check-plugin.mjs
node check-client.mjs      # 浏览器半边:主题 token / 字形 / DOM 纪律
node plugin-tests.mjs      # 插件半边行为(模拟的桥状态,20 条断言)
```

---

## 安全设计

这个项目的重点不是"能改",而是"**改不坏**"。

**① 写入前校验,写入后回读**

每个写 op 都先做完整校验(索引是整数吗?越界吗?键名在白名单里吗?),
校验通过才碰宿主。写完把值读回来比对,不一致就如实报错。

**② 批量操作 fail-closed**

`quantize` 如果会造出重叠,**整批不写**,并报出前几处冲突:

```
量化会造成 13 处音符重叠,已整批不写:
(50→55 重叠 0.250 拍) (58→57 重叠 0.250 拍) …
```

写一半再报错,比不写更糟。

**③ 破坏性操作默认 dry-run**

`auto_tone_shift` / `auto_expression` 默认只出计划,要显式 `dryRun: false` 才写。

**④ 宿主回调里绝不做 IO**

> 这是真机上付过代价的一条。

桥的 op 跑在**宿主的定时器回调**里。`io.popen` 起子进程会**阻塞 UI 线程** ——
实测把 SV2 整个冻住。所有 `io.popen` 调用点已替换成立刻报错的桩。
需要文件信息就 `io.open` 读已知路径,或者直接问用户。

**⑤ 不猜**

`getVoice()` 只能读到**显式设过**的唱法,继承来的读不出来 —— 这是官方 API 的硬限制。
遇到这种就 `panel_ask` 让用户点一下,**不猜**。

---

## 测试

**44 条行为测试**,跑在一个离线装置上:
[fengari](https://github.com/fengari-lua/fengari)(纯 JS 的 Lua 5.4)执行真的桥代码,
配一个假宿主(`tools/fake-sv.lua`),不需要开 SV2。

**58 个变异,每个都必须让测试变红。**

一个从没红过的测试套件不是证据。`tools/make-mutants.mjs` 把**真实发生过的 bug**
打进桥的副本,`check-mutants.mjs` 逐个跑,要求全部被抓到:

```
caught   group-move-wrong-index.lua
caught   split-notes-ascending.lua
caught   restore-remove-ascending.lua
caught   dir-candidates-windows-only.lua
...
58/58 个变异被抓到
✓ 测试套件确实会失败(不是永远绿的摆设)
```

这套纪律已经抓到过自己的失效两次:两个变异的替换串在加了新代码后
**匹配到两处**,等于什么都没改 —— 现在生成器要求每条替换**恰好命中一次**。

**五道守卫**:

| 守卫 | 拦什么 |
|---|---|
| `check-lua.mjs` · 元数据 | `SidePanelSection` 的脚本名含中文会被宿主拒绝加载 |
| `check-lua.mjs` · **ES5 兼容** | `f(a,b,)` 尾逗号是 ES2017 —— `node --check` 放行,但 Duktape 拒绝 |
| `check-lua.mjs` · **emoji** | SV2 侧栏字体不渲染 emoji,会显示成乱码 |
| `check-file.mjs` · 编码 | BOM / 编码损坏(仓库里有大量中文) |
| `check-client.mjs` · 浏览器半边 | **写死的色值**(暗色下会瞎眼)· 非 `--dsw-*` 变量 · emoji · 碰组件外的 DOM · 槽位注册缺件 |

最后那道是给"界面好看"立的规矩:client.js 是手写的、没有构建步骤也没有类型检查,
它错了没人会告诉你 —— 只会在 DSH 里安静地难看。所以把要求写成判据,
连**"状态卡必须显示能不能回滚 / 卡在哪个 op / 快照失败过没有"**都一起钉住。

**插件半边也有行为测试**(`plugin-tests.mjs`,20 条断言):在 `.harness-run/` 里造一份
假的 home 与通道目录,把心跳 / 面包屑 / 快照栈写成**精心构造的那几种状态**,
再真的去调 `sv_status` / `sv_doctor` / `sv_transpose`,断言输出。
`check-plugin.mjs` 只验"工具定义合法",不跑业务逻辑 —— 而插件侧最容易错的就是
**状态判断**(桥算不算在线?面包屑算不算"冻住"?自动快照失败了有没有说出来?)。
这道测试第一次跑就抓到一个:桥**没在跑**时,盘上残留的 `stage=running` 面包屑
会被误判成"宿主被模态框冻住了" —— 而这两件事的处置完全不同。
现在"没有心跳就**不下这个结论**"也成了断言。

---

## 调参标准流程

见 **[`docs/全参流程.md`](docs/全参流程.md)** —— 八步流程 + 六条纪律。

> **想把这套经验给别的 agent 用?** 见 **[`docs/AGENT-PROMPT.md`](docs/AGENT-PROMPT.md)** ——
> 一份**不绑定任何工具名**的通用提示词,直接复制进系统提示词即可。
> 它讲的是 SV2 的**语义事实**(唱法互斥、API 读不到继承值、脚本切不了当前组)
> 和**作业纪律**(一次一样、fail-closed、不在宿主回调里做 IO)。

核心判据:**"全参"不是"把所有参数都用上",而是"每个参数都跟着歌曲走"。**
分段常量不算;逐音符变化才算。

里面每条纪律都是真机上踩过的坑:

- 只看"当前组"就开工 ⇒ 漏掉 76% 的音符(多轨工程)
- 同时给多个唱法高值(总和 300+)⇒ 参数打架,出来是"大烟嗓"
- `io.popen` 列目录 ⇒ 把 SV2 冻住

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 没有 `setCurrentGroup` | 官方 API 只有 getter ⇒ 脚本切不了当前组,只能用 `trackIndex`/`groupIndex` 定位 |
| `getVoice()` 只读显式值 | 继承来的唱法读不出来 ⇒ 请用户在面板点一下 |
| **没有保存接口** | 26 个类全查过 ⇒ 助手**没法**替你保存工程 |
| `io.popen` 已封锁 | 它冻过宿主 ⇒ 声库名只能问用户 |
| `pitchDelta` 不要碰 | 它是手画音高线,写它会覆盖转录的演唱 |
| `mouthOpening` 本机不支持 | 文档列了但宿主没有 —— **文档 ≠ 本机能力** |
| **macOS 未经真机验证** | 桥已经不再依赖 Windows 专有的环境变量与分隔符(会挑 `~/.dsh/sv-bridge`),判据由离线测试台在**两个平台**上守着;但真机只有 Windows 跑过 |
| 快照只覆盖音符层 | `sv_undo` 不含属性层、组的增删、自动化曲线、声音属性 —— 返回里逐条写明 |

---

## 仓库结构

```
plugin/              DSH 宿主侧 + SV2 侧脚本
  index.js             11 个 sv_* 工具 + 常驻提示词
  client.js            输入框下的状态卡(浏览器半边)
  sv/DSHBridge.lua     桥本体(46 个 op)
  sv/DSHPanel.js       侧栏面板
tools/               离线测试与工具
  harness.mjs          44 条行为测试
  make-mutants.mjs     生成"故意改坏"的副本
  check-mutants.mjs    要求每个变异都被抓到
  check-lua.mjs        语法 + 元数据 + ES5 + emoji 守卫
  check-file.mjs       编码守卫
  check-client.mjs     浏览器半边守卫(主题 token / 字形 / DOM)
  plugin-tests.mjs     插件半边行为测试(模拟的桥状态)
  analyze-audio.py     BPM / 首拍分析
  analyze-chords.py    和弦分析
  import-musicxml.py   乐谱导入(9 道护栏 + 77 条自测)
  make-package.ps1     一键出包 + 自检
docs/                文档
  PACKAGE-README.md    分发包说明(打包模板)
  全参流程.md           调参标准作业程序(写给本仓库的使用者)
  AGENT-PROMPT.md      **通用 agent 提示词** —— 不绑工具名,可给任何 agent 用
  音频转音符.md         音频转音符的管线笔记
probe/               真机探针脚本
```

---

## License

[MIT](LICENSE)
