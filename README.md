# sv-dsh —— SV2 ⇄ DSH 双向桥

> 在 **DSH** 里装一个插件、在 **Synthesizer V Studio 2** 里装一个配套脚本,
> 让 DSH 的 agent 直接读写 SV2 里打开的工程,同时让 SV2 侧栏里的人话能进 DSH 会话。
> 不引入 Electron 客户端,不引入 MCP server 进程。

## 它长什么样

```
DSH(Host 进程)
 └─ 插件 dsh-sv-bridge
      ├─ 工具 sv_status / sv_context / sv_notes / sv_transpose / sv_lyrics /
      │       sv_note_attrs / sv_bind / sv_say / sv_call
      ├─ 看门狗:尾随 chat-in.jsonl → agent.followup() 注入会话
      ├─ 常驻提示词 + 只读状态路由 GET /dsh-sv-bridge/status
      └─ client 半边:输入框下面一枚状态徽标
                     │
                     │  文件通道  %USERPROFILE%\.dsh\sv-bridge\
                     │  svdsh-{req,res,hb,boot}-sv.json
                     │  svdsh-chat-in.jsonl / svdsh-chat-out.json
                     ▼
SV2(宿主进程内)
 ├─ DSHBridge.lua   常驻菜单脚本:轮询请求、执行 op、写心跳、中继面板
 └─ DSHPanel.js     侧栏面板:聊天框(它没有文件权限,只能靠 project scriptData 说话)
```

## 目录

```
sv-dsh/
├── plugin/                     ← DSH bundle(**包根就是这一层**)
│   ├── package.json            dsh.bundle.patch + dsh.client
│   ├── cordis.patch.yml        声明 agent 预设「SV 控制台」并在其中挂载本插件
│   ├── index.js                host 半边
│   ├── client.js               browser 半边(状态徽标)
│   └── sv/                     要部署到 SV2 scripts 目录的两个脚本
│       ├── DSHBridge.lua
│       └── DSHPanel.js
├── probe/                      P0:能力探针(先跑这个)
├── tools/                      离线校验:luaparse 语法检查 + fengari 假宿主跑测
├── docs/研究与方案.md          研究结论 + 方案 + 分阶段计划
└── install-sv-scripts.ps1      把 sv/ 下的脚本部署到 SV2
```

## 安装(四步)

### 1. 跑一次能力探针

见 [`probe/README.md`](probe/README.md)。它只读宿主状态,不改工程。

### 2. 装 DSH 插件

⚠️ **不能用命令行装。** `dsh plugin --profile desktop` 会被硬性拒绝
(「profile "desktop" is managed exclusively by the Electron application」)。
唯一受支持的路径是**应用内的插件管理器**。

在 DSH 里让 agent 调用 `plugin_manager`:

```
action: install_bundle
target: <本目录>\plugin        ← 传**绝对路径**
```

它需要一次 Full access 批准。返回 `application: "applied"` 才算生效。
装完会多出两行:`preset-sv-console`(预设)与预设内的 `dsh-sv-bridge`。

> 想让它对所有会话可用(而不是只在这个预设里):在 `cordis.patch.yml` 顶层
> `insert:` 下再加一行 `- id: dsh-sv-bridge` / `  name: 'dsh-sv-bridge'`,
> 并删掉预设 `plugins:` 里的那一行 —— 否则会挂载两次。

### 3. 部署 SV2 侧脚本

```powershell
pwsh -File install-sv-scripts.ps1
```

然后在 SV2 里:**[脚本] > [重新扫描]** → (跑过旧版的话)**[脚本] > [中止所有脚本]**
→ 运行 **[脚本] > [DSH] > [DSH Bridge]** → 从侧栏打开 **[DSH]** 面板。

> 桥是常驻脚本,**不会热更**:改了源码再点"运行"不会替换旧实例。必须先中止再重跑。

### 4. 用「SV 控制台」预设开一个会话

设置 → General → Agent preset 选 **SV 控制台**,或在新会话的选择器里选它。
然后问一句「SV 里现在开着什么」,agent 会调 `sv_status` / `sv_context`。

## 设计上的硬约束(为什么是这个形状)

| 事实 | 后果 |
|---|---|
| SV2 脚本 API **没有任何网络/文件能力**;只有 Lua 绑定的 `io`/`os` 可用 | 桥必须是 **Lua**;通道只能是本机文件 |
| Lua 没有 socket、不能列目录、**不能 mkdir** | 固定文件名 + 轮询;目录由 DSH 插件预先创建 |
| **面板脚本(连 Lua 面板)没有文件能力**,`io.open` 返回 nil | 面板只能走 project `scriptData`,由桥中继 |
| `SidePanelSection` 用 `getSidePanelSectionState()` **取代** `main()` | 桥与面板必须是**两个脚本** |
| Lua 绑定的错误**穿透 `pcall`、弹模态框并冻住宿主** | **绝不试探**;写前查白名单,写后回读 |
| 本机 SV2 上 `getSelectedNotes()` **返回的不是数组**(`#` 恒 0) | 条数必须回落到 `getNumSelectedNotes()`,否则会把整组当选区 |
| `agent.followup()` **不做消息归一化** | 必须自己构造 `{id, role:'user', content, source}` |
| `dsh plugin --profile desktop` 被拒绝 | 只能用应用内 `plugin_manager` |
| 常驻脚本不会热更 | 心跳里带版本号;改桥必须 `stop` 后重跑 |

## 工具一览

| 工具 | 作用 |
|---|---|
| `sv_status` | 桥在不在线、宿主版本、它自报支持哪些 op、绑定了哪个会话、有几条消息积压 |
| `sv_context` | 工程/轨/当前组/音符数/速度/选中数 |
| `sv_notes` | 选中音符 + **整选区指纹 `fp`** |
| `sv_transpose` | 选区移调(需 `expectFp`) |
| `sv_lyrics` | 选区写歌词(需 `expectFp`) |
| `sv_note_attrs` | 批量改 pitch/duration/lyrics/phonemes/language/rapAccent/detune(整批先校验,非法就一条不写) |
| `sv_bind` | 指定哪个 DSH 会话接收 SV2 面板里的话 |
| `sv_say` | 在 SV2 侧栏显示一行字 |
| `sv_call` | 直接调任意 op(逃生口) |

### 桥的 op 清单(32 个)

`sv_call` 可以直接调下面任何一个。**只改 Lua 就能加 op,不用重启 DSH** —— 这是这套架构最值钱的地方。

| 类别 | op |
|---|---|
| 基础 | `ping` · `stop` · `chat_send` |
| 读工程 | `get_context` · `get_selected_notes` · `get_notes`(整组) · `get_note_attrs`(完整属性) · `get_tempo` · `get_layout`(布局体检) · `get_audio_tracks`(音频轨) |
| 选区 | `select_notes`(all / indices / group / none)—— 没有它,批量改写就只能靠用户手点 |
| 音符写入 | `write_notes`(建组+音符+歌词) · `split_notes`(拆分) · `delete_notes` · `transpose_selected` · `set_lyrics` · `set_note_attrs` |
| 节奏清理 | `quantize`(吸附到网格,支持量化强度与 dry-run;**会造重叠就整批不写**) |
| 歌词对位 | `apply_lyrics`(按顺序分配) · `align_lyrics`(按 LRC 时间戳,支持 dry-run) |
| 音高线 | `get_pit` · `write_pit` · `clear_pit` |
| 参数曲线 | `get_automation` · `set_automation` |
| 速度/拍号 | `get_tempo` · `set_tempo` · `set_meter` |
| 音频对齐 | `align_audio`(把音频挪到锚点 + 写速度标) · `get_audio_tracks` |
| 组/轨 | `group_ops`(info/rename/mute/offset/delete/clone/**move**) · `track_ops`(list/add/remove/rename/color/mixer/setMixer) |
| 计算数据 | `get_computed`(音高曲线 / 音素 / 说唱属性) |
| 播放 | `transport`(status/play/pause/stop/seek/loop) |

### `set_note_attrs` 能改什么

除了 `pitch` / `duration` / `lyrics`,还有:

| 字段 | 说明 |
|---|---|
| `phonemes` | 音素串(X-SAMPA)。**只限长度不限字符集** —— 自编白名单会拒掉合法音素 |
| `language` | 语种覆盖。⚠️ 改语种会让该音符的**全部音素重算** |
| `rapAccent` | 说唱声调 `"1".."5"`(阴平/阳平/上声/去声/轻声)。⚠️ 值是**字符串**,且**只对 rap 音符有效** |
| `detune` | 音高微调(音分) |
| `musicalType` | `sing` / `rap` |
| `pitchAutoMode` | 音高是否交给宿主自动算 |
| **`attributes`** | **SV2 2.1.1+ 的属性层**(见下) |

`attributes` 里可用的键(**逐键白名单 + 类型/范围校验**,不认识的键一律拒):

| 键 | 说明 |
|---|---|
| `muted` | 该音符是否静音 |
| `evenSyllableDuration` | 一个音符里多个音节时是否均分 |
| `dF0VbrMod` | 颤音调制 |
| `rTone` / `rIntonation` | 说唱声调 / 语调 |
| `expValueX` / `expValueY` | 表达式垫参数 |
| `phonesetOverride` | 音素集覆盖 |
| **`phonemes`** | **逐音素属性数组** `[{leftOffset, position, activity, strength}]` |

> ⚠️ **为什么要逐键白名单**:参考项目在 SV1 上踩过 —— 键不存在时 `setAttributes` 会
> **直接弹模态错误框**("setAttributes: 无效的输入类型。"),框一弹宿主主线程就停。
>
> ⚠️ **`leftOffset = 0` ⇒ 提前量归零 ⇒ 辅音会消失**(参考项目真机听感确认)。
> 收边要留余量(如 −0.05)。这是修"短音符的辅音吃掉前一个音符"的唯一手段。
>
> ⚠️ 宿主的 `getAttributes()` **只返回写过的键** —— 没出现过的是 nil,**不是默认值**。

### 已知不能碰的 API(崩溃清单)

| API | 后果 |
|---|---|
| `getParameter("dynamics")` | 返回「像真的假对象」,读点写点**写坏宿主内存**,几秒后在无关位置崩(空工程也复现)⇒ 桥里**硬拒,连 `getParameter` 都不调** |
| `Automation#getPoints / getAllPoints / getLinear / getDefinition` | 旧宿主上「调用即冻桥」⇒ 桥改用 `get(b)` 单点采样;参数范围按官方手册**硬编码** |
| `Automation#remove(单参)` | 同上 ⇒ 只允许区间重载 |

### 一条"不是 bug 但一定会遇到"的平台事实

**语种与声库不兼容 ⇒ 无音素 ⇒ 该组不渲染,而且不报错。**
语言链是 `音符 > 音符组 > 轨道 > 声库`;都不指定就取声库的录制语言。
英文声库唱中文歌词就是典型:计算类接口全返回空/null,**看起来像"没算完"**。

⇒ `get_computed(kind="phonemes")` 在返回空数组时会一并给出逐音符的**语种覆盖 + 歌词**,
并说明这两种可能,免得把"语言不兼容"误判成"接口没数据"。
**桥不会去改用户的语种** —— 那属于用户的决定(参考项目 SV-006 的裁定)。

> 声库/歌手的选择**不在脚本 API 里**(手册里没有 Voice 类),只能在 SV2 界面里选。

### 真机上量出来的两个约定(手册没写)

| 约定 | 事实 | 踩法 |
|---|---|---|
| **速度标记的位置字段** | 是 `position`,**不是** `positionBlick` | 只读 `positionBlick` 会拿到 nil 并当成 0 ⇒ **所有速度标记都显示在第 0 拍** |
| **`addMeasureMark` 的小节号** | **0 起**(传 `measure=1` 落在第 4 拍 @4/4) | 直接透传对外 1 起的号 ⇒ **差一个小节** |

两条都是 2026-10-02 在真机 SV2 2.3.0tp1 上量出来的,桥里已按此处理(对外仍用 1 起,内部 -1)。

**写前指纹**是这套设计里最关键的一环:读音符会算一个覆盖整选区(或整组)的指纹,
写操作必须把它原样带回来。用户在宿主里动过一笔 ⇒ 指纹不匹配 ⇒ 直接拒绝
(`STALE_SELECTION`),而不是按位置改错音符。这是参考项目点名「规格已定、实现未做」的那一环。

## 离线校验

```powershell
cd tools
node check-lua.mjs ..\plugin\sv\DSHBridge.lua ..\probe\Probe.lua ..\probe\ProbePanel.lua
node harness.mjs        # 用 fengari 假宿主真跑一遍桥(见 tools/README.md)
```

真机里没法"试错" —— 错误会弹模态框冻住宿主。所以能离线跑的部分必须先跑绿。
当前:**14/14 PASS**(JSON 编解码、指纹拦截写错对象、按 id 幂等、坏请求被消费、
原子覆盖写、非法写入失败即关闭……),另有 11 项变异测试确认这些断言真的抓得住 bug。

## 参考


- `../` —— 上一轮对该项目的静态审查
- `../reference/dsh-plugin-skills/` —— 官方 DSH 插件开发技能包(从 `app.asar` 导出)
- `../DSH-host-plugin-API-调研报告.md`、`../dsh-plugin-preset-research.md` —— 本轮两份子调研
