# sv2-dsh-bridge

**把 Synthesizer V Studio 2 接进 DeepSeek Harness —— 让 AI 助手直接读写工程、调参、审歌词。**

[![CI](https://github.com/valing1837/sv2-dsh-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/valing1837/sv2-dsh-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Ops](https://img.shields.io/badge/ops-46-blue.svg)](plugin/sv/DSHBridge.lua)
[![Tests](https://img.shields.io/badge/tests-47%2F47-brightgreen.svg)](tools/harness.mjs)
[![Mutants](https://img.shields.io/badge/mutants-66%2F66%20caught-brightgreen.svg)](tools/check-mutants.mjs)

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
  覆盖两层:
  - **音符层**:起始 / 时值 / 音高 / 歌词;
  - **编排布局**:哪条轨挂了哪些组、顺序、时间范围与时间/音高偏移 ⇒ **新建的组会被摘掉、
    删掉的组会被挂回来、挪到别的轨的组会被挪回来**。

  **不含**:属性层(音素 / detune / attributes)、组库里的孤儿数据、自动化曲线、声音属性、
  速度与拍号标记 —— 这些在返回里逐条写明,免得以为它能救一切。目标组按快照里的
  **UUID 全局找**,所以你中途切到别的组了也能回滚对。主组与外部音频引用**一律不碰**。
- **`selftest`** —— 全链路自检:目录可写 · 原子替换 · 读回 · 删除 · 心跳 · 日志 ·
  计时链 · 宿主与工程可读 · 快照存储 · **组库可读**(撤销"删组"要靠它),逐项给 ok/detail。
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
>
> **把 `plugin/` 拷进 profile 再 link**(例如 `~/.dsh/profiles/<name>/plugins/sv2-dsh-bridge`),
> 不要直接 link 到你的开发目录:开发目录随时可能被清空或搬走,而插件是**运行时**要用的东西。
> 拷过去之后,清空开发目录**不影响已装好的插件** —— 它的所有文件、link、以及 prompt 里
> 点名的文档(`plugin/docs/`,随包发出、路径运行时算)都在 profile 里。

### 4. 自检

```bash
cd tools
npm install
node harness.mjs           # 47 条行为测试
node check-mutants.mjs     # 66 个变异,漏一个就红
node check-mutants-js.mjs  # 另外三半:23 个变异,漏一个就红
node check-lua.mjs ../plugin/sv/DSHBridge.lua
node check-plugin.mjs
node check-client.mjs      # 浏览器半边:主题 token / 字形 / DOM 纪律
node plugin-tests.mjs      # 插件半边行为(模拟的桥状态,51 条断言)
node panel-tests.mjs       # 面板半边:布局 / 最窄侧栏 / 刷新纪律 / 版面顺序(40 条断言)
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

**47 条行为测试**,跑在一个离线装置上:
[fengari](https://github.com/fengari-lua/fengari)(纯 JS 的 Lua 5.4)执行真的桥代码,
配一个假宿主(`tools/fake-sv.lua`),不需要开 SV2。

**66 个变异,每个都必须让测试变红。**

一个从没红过的测试套件不是证据。`tools/make-mutants.mjs` 把**真实发生过的 bug**
打进桥的副本,`check-mutants.mjs` 逐个跑,要求全部被抓到:

```
caught   group-move-wrong-index.lua
caught   split-notes-ascending.lua
caught   restore-remove-ascending.lua
caught   dir-candidates-windows-only.lua
...
66/66 个变异被抓到
✓ 测试套件确实会失败(不是永远绿的摆设)
```

这套纪律已经抓到过自己的失效两次:两个变异的替换串在加了新代码后
**匹配到两处**,等于什么都没改 —— 现在生成器要求每条替换**恰好命中一次**。

**另外三半也上同一套门禁**(`make-mutants-js.mjs` / `check-mutants-js.mjs`,23 个变异):
插件 / 面板 / 浏览器那三半的测试以前**从没被证明过**会不会失败。现在每个变异都指定
"由哪个测试抓",逐条要求它变红:

```
caught   plugin-frozen-ignores-missing-heartbeat   (plugin-tests.mjs)
caught   panel-ask-refreshes-immediately           (panel-tests.mjs)
caught   client-hardcoded-color                    (check-client.mjs)
...
23/23 个变异被抓到
✓ 插件 / 面板 / 浏览器三半的测试确实会失败(不是永远绿的摆设)
```

> ⚠️ 两条门禁的子进程**一律不走管道**(`stdio: ignore/inherit`):管道在受限环境里会
> EPERM,而"环境坏了也要能跑"恰恰是门禁的本分。改成不看子进程 stdout 之后,
> **在本机沙箱里也能跑完**(以前只能靠 CI)。变异体的失败报告又长又没用 ——
> 每个变异都**应该**失败,全打出来只会淹掉真正的信息;stderr 留着,真出错时看得见。

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

**插件半边也有行为测试**(`plugin-tests.mjs`,51 条断言):在 `.harness-run/` 里造一份
假的 home 与通道目录,把心跳 / 面包屑 / 快照栈写成**精心构造的那几种状态**,
再真的去调 `sv_status` / `sv_doctor` / `sv_transpose`,断言输出。
`check-plugin.mjs` 只验"工具定义合法",不跑业务逻辑 —— 而插件侧最容易错的就是
**状态判断**(桥算不算在线?面包屑算不算"冻住"?自动快照失败了有没有说出来?)。
这道测试第一次跑就抓到一个:桥**没在跑**时,盘上残留的 `stage=running` 面包屑
会被误判成"宿主被模态框冻住了" —— 而这两件事的处置完全不同。
现在"没有心跳就**不下这个结论**"也成了断言。
它还管**发给面板的那份文本**:面板的 TextArea 不渲染 markdown,
所以 `**粗体**` / 反引号 / `##` 要先变回纯文本(在两百多像素宽的框里,
那些字符既占宽度又是噪音);超过 1200 字则**自述**截断并指路到 DSH。

**面板半边同样有离线测试**(`panel-tests.mjs`,40 条断言):用一个假 SV 把
`DSHPanel.js` 真的加载起来,调它自己的 `getSidePanelSectionState()` 看交出来的 rows。
它守的是面板**看不见**的三件事:

- **文字会不会被截断** —— SV2 的侧栏很窄,按钮文案放不下就是被切掉,而"切掉"不报错。
  测试按最窄的侧栏算每个按钮的可用宽度,并算出**让所有按钮都不被截断所需的最小宽度**
  (现在 ≈ **122px**,远小于真实侧栏)。
- **刷新时机** —— `refreshSidePanel()` 会重建面板、冲掉输入框焦点和没发出去的字
  (用户抱怨过"不要一直刷新,我没法打字")。这类 bug 只有"你正在打字时题目来了"才现形。
  现在这是断言:题目到达时**只挂待刷新标记**,等输入框干净了再由轮询那一拍去刷。
- **版面顺序** —— 用户 2026-10-07 要求"选项下面加个小输入框":现在这是三条断言
  (回复区 → 选项 → 小输入框;选项下面必须有"不满意就自己写"那行提示;选项在底部按钮之前)。
  顺序这种东西**看一眼代码觉得对**,改别处时最容易悄悄错位 —— 所以钉住。

它还钉住了面板的**自适应**:有选项时回复区从 9 行收到 4 行、小输入框从 56 收到 44,
把地方让给最多 6 个竖排选项 —— 整块从 ≈408px 变成 ≈362px,在小侧栏里**不用滚**就能看全。
(2026-10-07 大改:快捷动作与一键调参都删了,面板只剩 状态行 · 回复区 · 选项 · 小输入框 ·
三个按钮;用户原话"那些快捷方式可有可无了"。)

**面板与桥之间那条通路**(project scriptData 两个键)也有测试(harness 的「面板中继」,
20 条断言)。它守的是一个**安全设计**:面板**不能**调任意 op,只有一张白名单
(只读 + 改本组声音属性),其余一律拒 —— 现在连"拒了之后音符一个没少"都是断言。

> 顺带:0.8.5 把面板里那条**已经死掉的调参链路**删了(1012 → 721 行)。用户裁定
> "不要滑条、不要预设"之后,那些控件再没被渲染过,回调永远不会触发 —— 死代码既没测试
> 也没真机路径,留着只会让人以为"面板能直接调参"。**桥那边的白名单能力保留**,
> 而且现在有测试守着,将来要加回控件直接 `emit({kind:'op', ...})` 即可。

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
| 快照不含属性层 | `sv_undo` 覆盖**音符层 + 编排布局**(组的增删/移动/几何都能回滚);音素 / detune / attributes、自动化曲线、声音属性、速度与拍号标记还没有回滚点 |
| 撤销"删组"依赖组库 API | 靠 `getNumNoteGroups` / `getNoteGroup` 找回孤儿组 —— 这两个**本机没验证过**;拿不到会如实报"找不到那个组",`selftest` 里的 `group-library` 一条专门验它 |

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
  make-mutants.mjs     生成"故意改坏"的副本(桥)
  check-mutants.mjs    要求每个变异都被抓到(桥,58 个)
  make-mutants-js.mjs  生成"故意改坏"的副本(插件 / 面板 / 浏览器)
  check-mutants-js.mjs 要求每个变异都被抓到(另外三半,12 个)
  check-lua.mjs        语法 + 元数据 + ES5 + emoji 守卫
  check-file.mjs       编码守卫
  check-client.mjs     浏览器半边守卫(主题 token / 字形 / DOM)
  plugin-tests.mjs     插件半边行为测试(模拟的桥状态)
  panel-tests.mjs      面板半边离线测试(假 SV:布局 / 最窄宽度 / 刷新纪律)
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
