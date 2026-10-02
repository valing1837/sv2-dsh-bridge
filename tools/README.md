# tools/ — DSH ⇄ SV2 桥的离线测试工具

常驻桥脚本 `plugin/sv/DSHBridge.lua` 跑在 Synthesizer V Studio 2 的 Lua 里。
在那里，**一个绑定错误会穿透 `pcall`、弹一个模态错误框并冻住宿主主线程** ——
所以「跑一下试试」不是选项，一个 bug 的代价是用户的整个 session。

这套工具用 **fengari（JS 里的 Lua 5.3 VM）+ 一个假宿主** 在本机把能离线验的全验掉：
真的加载 `DSHBridge.lua`、真的调 `main()`、真的走文件通道、真的写盘。

---

## 一条命令

在 `sv-dsh\tools` 目录下：

```powershell
& "C:\Users\huang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" harness.mjs
```

退出码：`0` = 全部 PASS，`1` = 有 FAIL，`2` = 环境问题（脚本文件找不到等）。

可选参数：

```powershell
# 用别的副本（例如故意改坏的）跑同一套测试，用来证明测试确实有效
node harness.mjs --bridge <path\to\DSHBridge.lua>
```

生成那批"故意改坏的副本"（定义在 `make-mutants.mjs` 里，每条替换必须**恰好命中一次**，
否则直接报错 —— 一个什么都没改的变异证明不了任何事）：

```powershell
node make-mutants.mjs          # 写进 .mutants\，并打印每条的 --bridge 命令
```

当前是 **52 条**（退出码 `0` = 全部写出来了）。**每条替换必须恰好命中一次**，否则脚本报错退出 1 ——
一个什么都没改的变异证明不了任何事。这条纪律已经两次抓到自己的失效：
`delete-notes-no-groupfp`（0.5.7 之后）与 `group-delete-main`（0.6.1 之后，见下）。

首次在新机器上跑，先装依赖：

```powershell
& <node> <pnpm.mjs> install --ignore-scripts
```

---

## 文件

| 文件 | 作用 |
| --- | --- |
| `harness.mjs` | 入口。建状态、装环境、按顺序跑 0–40 号测试、打印表格、决定退出码 |
| `luaenv.mjs` | fengari 状态、**真实文件系统**上的 `io`/`os`、fengari 整数位宽补偿 |
| `fake-sv.lua` | 假宿主：`SV` / `project` / `editor` / `NoteGroupReference`（含 `isInstrumental`）/ `NoteGroup` / `Note`（含 `setAttributes`）/ `Track`（含 `getDisplayOrder`）/ `TrackMixer` / `TimeAxis`（含 `getSecondsFromBlick`/`getBlickFromSeconds`）/ `Automation` / `PitchControlCurve` / `PlaybackControl` / `SelectionState`（`clearAll`/`selectNote`/`selectGroup` 是**有状态**的），以及 `SV.setTimeout` 记录器 |
| `bridge-tests.lua` | Lua 侧测试体（T1–T3）、`__T_*` 包装、整个假宿主的**确定性快照** `__T_snap()`，以及不在快照里的**选区**描述 `__T_selection()` |
| `make-mutants.mjs` | 把一批"故意写坏的 bug"打进桥的副本，写进 `.mutants\`（见"证明测试有效"） |
| `check-lua.mjs` | 独立的纯语法校验（luaparse，Lua 5.3 语法）。harness 的 0 号测试也用它 |

### Python 工具（不在 harness 里，各自 `--selftest`）

桥**没有音频 I/O、没有文件解析**（官方脚本 API 的 26 个类里没有这些），所以这几件事在 SV2 之外做，
再把结果交给桥的 `write_notes` / `align_audio` 写进去。用 DSH 自带的 Python 跑
（`C:\Users\huang\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`），
第三方依赖装在 `sv-dsh\py-deps`（只有 `numpy` 与 `soundfile` —— 后者解 FLAC/OGG）。

| 文件 | 作用 | 自检 |
| --- | --- | --- |
| `analyze-audio.py` | 测音频的 **BPM 与第一拍**（纯 numpy）。喂给桥的 `align_audio` | `--selftest`：合成 120BPM 点击轨，要求 BPM 与相位都对 |
| `analyze-chords.py` | 音频**和弦分析** → 和弦序列 + 可直接写的 `write_notes` 参数 | `--selftest`：合成和弦进行，要求标签按序精确匹配 |
| `import-musicxml.py` | **MusicXML 乐谱 → 音符**，九条护栏（默认只读预览、SHA-256 写前重算、拒 DOCTYPE/ENTITY、512 上限、复调默认拒…） | `--selftest`：77 条断言 |

> ⚠️ **干声转音符(CREPE)那套已删** —— SV2 自带的「音频转音符」质量更好，不需要重复造。
> 删掉的是 `extract-notes.py` / `fetch-crepe.py` / `check-audio-deps.py`、CREPE 模型(6.2MB)
> 与 `onnxruntime` 及其专属依赖(共约 48MB)。`analyze-audio.py` 原来借 `extract-notes.py`
> 兜底解析 WAV，已把那段**内联**进自己(`read_wav_mono`)，所以删掉后仍自足。

> ⚠️ 这几个工具的自检**都是会失败的断言**，不是"跑通就算" —— 事实是它们各自逼出过真 bug：
> `analyze-audio.py` 逼出半速歧义与分析窗延迟；`analyze-chords.py` 逼出"泛音列长得像七和弦"
> (5 次泛音=大三度、7 次=小七度)导致全部认成 maj7/m7；`import-musicxml.py` 逼出
> 小节偏移漏累加、`<backup>` 清掉声部位置、以及把和弦误判成重叠。

**假宿主的行为是"有状态的、照真机抄的"**，几个刻意的怪癖各自被某条测试压着：

* `getSelectedNotes()` 的 `#` 恒为 0（元表 `__len`）—— 桥必须回落到 `getNumSelectedNotes()`；
* **`NoteGroup:addNote()` 按 onset 把新音符插进组里，不是追加到末尾**（桥 0.5.9 的真机实测：
  拆 6..8 的音符，尾段落在 index 9 而不是末尾）⇒ 往组里加一个音之后，它**后面所有音符的下标都 +1**。
  桥里两处纪律都是为这条服务的：`delete_notes` 从后往前删、`split_notes` **倒序**处理。
  onset 相同的音符插在已有的后面，所以 `write_notes` 那种已按 onset 排好的批量退化成"追加"；
* `Note:getIndexInParent()` 是**当前**在组内的位置 ⇒ `removeNote()` 之后后面的音整体前移；
* `TimeAxis:addTempoMark()` 在**同位置已有标记时不更新**，而是再加一个 ——
  `set_tempo` 必须先 `removeTempoMark`；
* **两种时间标记的位置字段不同**（桥 0.5.8 的真机实测）：速度标记是 `position` 且**没有**
  `positionBlick`（读它得 nil）；拍号标记 `positionBlick` 是对的，而 `position` **故意**给一个
  ~1 blick 的垃圾值（真机读出来是 1.4e-9 拍）。所以桥必须按类型分别取字段 ——
  24/25 号测试各压一半；
* `Automation:add()` 在同 blick 上是**覆盖**；`Automation:get()` 在曲线两端**外推**
  （这就是"写一个点会把整组变成那个值"的来源，也是 `closeShape` 存在的理由）；
* `Note:getAttributes()` **只返回显式写过的键**（参考项目 SV-007）：构造函数摆进去的初值不算"写过"，
  所以新建音符的 attributes 是**空表**，没写过的键是 nil 而不是默认值 —— 桥要是自己往里填默认值，
  `note-attrs-fill-defaults` 变异就会把 31 号测试打红；
* `SelectionState:selectNote()` / `selectGroup()` 是**追加**语义，只有 `clearAll()` 会清空选区
  —— 真机的确切语义**没有实测过**，假宿主按最保守的读法建模（写在 `newSelection()` 的注释里）。
  于是 `select_notes` 必须先 `clearAll()`；去掉它的两个变异都被 30 号测试抓住；
* 每个 `NoteGroup#getParameter(type)` 实参、每次 `Automation#get/#add`、每次
  `NoteGroup#getNote/#removeNote` 都被记下来（`__T_paramCalls` / `__T_autoLog` / `__T_calls`）——
  `dynamics` 硬拒、`closeShape` 的"先读后写 + 闭合点在外沿"、以及"**小数下标绝不许递给宿主绑定**"
  都是靠这几本账**可断言**的；
* `Note:setAttributes()` **只更新给到的键**，其余键原样保留（真机语义，参考项目 SV-007）；
  假宿主把它逐键存下来 ⇒「桥把**不认识的键**递给宿主」在 `__T_snap()` 里看得见。
  真机上那正是**弹模态框**的那一类输入，离线能验的只有"桥不会递过去"（38 号测试）；
* `NoteGroupReference:isInstrumental()` 是**外部音频引用**（伴奏/干声）的判据，而且它的
  `getTarget()` 是 **nil**（音频没有可编辑的音符）—— `get_audio_tracks` / `align_audio`
  必须在这个形状下工作。只有控制面 `M.addInstrumentalRef()` 会打开它（36/37 号测试）；
* `Track:getDisplayOrder()` 可以**和存储下标不同**（官方原文：编曲视图永远按显示顺序排）⇒
  "视觉上最上面那条轨"是 `min(displayOrder)` 而不是 index 0；没显式设过时回落到存储下标。
  39 号测试把两者设成**相反**，所以"桥直接拿循环下标当 displayOrder"会立刻变红；
* `Track:addGroupReference()` 会**失败**（返回 nil）：控制面 `M.failAddGroupReference` 按需
  打开它，压的是 `group_ops move` 那条"**先挂新引用、成功后再删旧引用**"的纪律 ——
  反序一旦 add 失败，这个组就从编排里彻底消失（40 号测试）；
* `TimeAxis:getSecondsFromBlick()` / `getBlickFromSeconds()` 按**本假宿主自己的速度标记**
  分段积分（秒↔blick 取决于当前速度，脚本不能自己乘常数）。整套测试跑在 120 bpm，
  即 1 拍 = 0.5 秒；刻意用浮点除法，避开 fengari 的 32 位整数（`705600000*120` 会回绕）。
  这条模型由 `documentLimitations()` 里的 `__T_secondsRoundTrip` 探针**每次运行实时核对**；
* `TimeAxis:getMeasureMarkAt(measure)` 对**任意**小节号**合成**一个标记（真机的 `measure`
  参数是 **0 起**的：传 1 落在第 4 拍 @4/4），而不是"只有显式 `addMeasureMark` 过的小节才有"。
  不这样建模的话，"忘了做 1 起→0 起 转换"会**碰巧报错**而不是静默落错小节，
  37 号测试就压不住它（`align-audio-no-measure-minus-one` 变异）；
* `M.resetWorld()` 重建一个干净工程，破坏性测试先调 `__T_resetWorld()`，测试之间不会互相污染。

**宿主调用账**（`__T_calls(from)` / `__T_callCount()`）专门用来证明"被拒的请求没有把**小数下标**
递给宿主绑定"：真机上非整数实参正是会弹模态错误框、冻住主线程的那一类输入，而假宿主对
`getNote(1.5)` 只会静默返回 nil —— 没有这本账，`split-notes-no-integer` 那种变异在离线环境里
**看不见**（它会把错误变成 `getNote 返回 nil`，看起来仍像是"被拒了"）。

**选区不进 `__T_snap()`**：快照是"工程数据"，选区是 UI 状态，而且 `select_notes` 的全部意义就是改它。
所以 30 号测试用 `__T_selection()`（条数 + `hasSelectedNotes` + 选中音符的组内下标 + 所属组 UUID，
JSON、确定性）在请求前后各取一次**逐字比较** —— 与 `sameSnap` 同样的效果，只是对象不同。
音符的 `attributes`（排序后的 `键=值` 串）则**进了**快照的 note 条目（下标 `[9]`，在 `notesOf()` 依赖的
`[3]..[8]` 之后），这样"偷偷写了一个属性"也会被"一个字节都没写"这条断言抓到。

33–40 号测试又给快照补了两个字段，同样**追加在末尾**（免得动到既有下标）：
`refs[i][9]` = `isInstrumental`（36/37 号测试）、`tracks[i][8]` = `displayOrder`（39 号测试）。
属性的**值可能是表**（`attributes.phonemes` 是逐音素属性数组），所以快照里改用 `attrValue()`
做确定性序列化 —— 对表直接 `tostring()` 给的是**内存地址**，那会让"一个字节都没写"变成偶发红。

**文件路径来自桥自己的 `SVDSH_TEST.PATH`**：`main()` 之后测试台调用 `__T_path(key)` 取回桥真正在用的
路径（而不是自己拼），4 号测试断言它与测试台预期的目录逐字相同。只有在该表为空时（即 W4 那种回归）
才退回预期值，这样一处回归只让 4 号测试变红，不会连带把 5–12 全部拖挂。

运行产物（每次运行前清空重建）：`.harness-run\userprofile\.dsh\sv-bridge\`
—— 就是假宿主里「DSH 插件预先建好的目录」，桥实际写文件的地方。

---

## 测试覆盖

| # | 测什么 | 关键点 |
| --- | --- | --- |
| 0 | `DSHBridge.lua` / `Probe.lua` / `ProbePanel.lua` / `fake-sv.lua` / `bridge-tests.lua` 能否按 Lua 5.3 解析 | 一个语法错 = 宿主里弹一个模态框（测试台自己的两个 Lua 文件也一起验，否则语法错只会以"setup 退出码 2"的形式出现，不点名文件） |
| 1 | `jenc`/`jdec` 往返 | 16 位整数 `1789175384220009` **逐位不变**（`%.14g` 会写成 `1.78917538422e+15`）；含 `"` `\` 换行 制表 CJK NUL 的字符串；嵌套对象/数组；`true`/`false`；空对象/空数组；`0.5`。**W2 回归守卫**：非整数走 `%.10g`，`jenc(1234.5678) == "1234.5678"`（旧的 `%.6g` 会变成 `1234.57`），且一个真实的 blick→拍 值（`1000000/705600000`）相对误差 ≤ 1e-9（`%.6g` 约 2.5e-6）。另带一条**反证断言**：`%.14g` 必须真的丢值，否则大整数那条测试是空的 |
| 2 | `hash32` | 确定性、同输入同结果、不同输入不同结果、8 位小写十六进制，并对 djb2 已知向量（`"hello"` → `0f923099`、`""` → `00001505`） |
| 3 | `selectedNotes()` 的 `#` 回退 | 假宿主复现真机怪癖：`getSelectedNotes()` 的 `#` 恒为 0，而 `getNumSelectedNotes()` 报 3、`result[i]` 仍可取到每个音。断言 `#selectedNotes() == 3` |
| 4 | `main()` 启动 | boot / heartbeat 文件真实存在且能解析；`boot.ok == true`；`hb.bridge == ` 桥自己的 `BRIDGE_VERSION`（**不写死**：升版本号不该让测试变红）；`hb.version == "2.3.0"`（**宿主**版本）；`hb.ops` 含 `get_selected_notes`；`hb.dir` 是 `%USERPROFILE%\.dsh\sv-bridge` 而**不是** TEMP 候选；定时器已挂上。**W3 回归守卫**：`CFG.HB_MS % CFG.POLL_MS == 0` 且 `floor(HB_MS/POLL_MS)*POLL_MS == HB_MS`。**W4 回归守卫**：`SVDSH_TEST.PATH` 的 `dir/req/res/hb/boot` 与真实目录逐字一致 |
| 5 | 端到端读 | 写请求文件 → 走一拍 → 读响应：`res.id` / `res.ok` / `res.result.count == 3` / `fp` 非空，另外验证 16 位 `seq` 原样回显 |
| 6 | 指纹守住写操作 | 拿到 `fp` 后**直接**改一个音的音高（模拟用户在宿主里编辑）→ 用旧 `fp` 调 `transpose_selected` 必须返回含 `STALE_SELECTION` 的错误且**一个音都没动**；重新读拿新 `fp` → 成功，并从假宿主回读音高确认真的 +1 |
| 7 | 缺 `expectFp` | `transpose_selected` 与 `set_lyrics` 都必须报含 `expectFp` 的错，且不写 |
| 8 | 按 `id` 幂等 | 同一个 `id` 送两次、各走一拍：`ST.opsRun` 只 +1；第二次仍返回**缓存的那份**响应；心跳里的 `opsRun`/`reqSeen` 也只 +1 |
| 9 | 未知 op | `res.ok == false`，错误里含 `unknown op`、含那个 op 名、并列出可用 op |
| 10 | 坏 JSON 被消费 | 写 `{ this is not json` → 走一拍后**请求文件被删掉**（不会每拍重读），`ST.pollErrors` 不增长；再走两拍仍然不增长 |
| 11 | 原子覆盖写 | 同一个路径先后写两份不同内容：最终内容是**第二份**，且不残留 `.tmp`；再写第三份仍然生效（Windows 上 rename 覆盖已存在目标的那条路） |
| 12 | `set_note_attrs` 失败即关闭 | (a) 非白名单字段 (b) 越界 pitch (c) 越界 duration (d) **批里后面一条非法则整批不写** —— 每种都必须报错且**没有任何音被改动**；最后验证合法写入仍然生效 |
| 13 | `set_note_attrs` 拒绝非整数（**W1 回归守卫**） | (a) `pitch=60.5` (b) `duration=1000.5` (c) 批里后面一条 `pitch=64.25` —— 三者都在**合法范围内**，所以只有整数检查能挡住；每种都必须 `ok:false`、错误信息含 `integer` 并点名字段与值，且**假宿主里没有任何音被改动**（只断言报错不够：要防的正是「先写了再报错」）。(d) 反向验证不过度拒绝：请求体里写成 `61.0` 的整数值必须被接受并真的写入 |
| 14 | `write_notes` 真的把新组**挂上轨** | 三步各自可断言：① `groupLibraryIndex` 是库里真实槽位；② 新 `NoteGroupReference` 指向新组、窗口 `onset=0` 且 `duration` **盖住全部内容**（3 拍）；③ 轨的组数 1→2。再断言 Main 组一个音都没动 |
| 15 | `get_notes` 读**整组** + `groupFp` 稳定 | 整组 3 个音、`groupName/groupUUID`、每音自带 `fp`；**同一组连读两次 `groupFp` 必须逐字相同**；在宿主侧偷改一个音高后 `groupFp` **必须变化**（否则这条守卫是空的）；`limit` 生效且 `count` 仍报整组 |
| 16 | `delete_notes` 的指纹守卫 | (a) 缺 `expectGroupFp` → 拒；(b) 先在宿主侧改一个音（`groupFp` 变旧）→ 带旧 fp 删 → 必须 `STALE_SELECTION` 且**一个音都没删**（整机快照逐字节相同）；(c) 空串 fp 同样拒 |
| 17 | `delete_notes` 批量语义 | (a) 越界 `indices[0,5]` / 负数 / 重复 / 空数组 / **小数 `[0.5]`** —— **全部在动手之前**拒（快照不变），小数那条还断言 **`removeNote` 一次都没被调用、宿主调用账里没有任何非整数下标**；(b) 合法删 `[0,2]`（0 起）⇒ `removed=2`、`remaining=1`、**活下来的正是中间那个音**（证明批量删除没有中途错位）；(d) 删完之后旧 fp 立刻失效 |
| 18 | `write_pit` / `get_pit` / `clear_pit` | (a) `at < 0` 拒且**一条曲线都没建**；(b) 写两个点 ⇒ 回读的**绝对音高**与**绝对位置**逐点相等（宿主存的是相对锚点的偏移，换算错就是静默跑调）；(c) `get_pit` 同样读到绝对音高；(d) 默认 `clear=true` 清掉旧曲线（`clearedExisting=1`，不叠加）；(e) `clear:false` 才会叠成 2 条；(f) `clear_pit` 清空，空组再清是 0 |
| 19 | `get_computed` 三通道 | 音素 / 属性 / 音高采样；`computedReady=false` 时**如实报空数组**并带"还没算完"提示；音高采样断言 **`blickStart = startQuarter×QUARTER + 组引用的 timeOffset`**（官方文档明确要求，漏掉就是采样窗口整体错位且不报错）；`kind` 未知、`step<=0`、`frames` 越界都拒 |
| 20 | `get_automation` 采样 | 0..1 每 0.25 ⇒ 5 个样本、位置与默认值（voicing 默认 1）逐点相等、`range` 上报；不给 `endQuarter` 时默认用**当前组引用的时长**（3 拍 ⇒ 7 个样本）；`step<=0`、`end<=start`、缺 `type`、未知 `type` 全拒且**没写任何东西** |
| 21 | `set_automation` 校验 + `dynamics` 硬拒 | (a) `tension=5` 越界 → 拒、错误点出类型与区间、**一个点都没写**；(b) `type:"dynamics"` → 拒，且在假宿主上断言 **`getParameter("dynamics")` 从未被调用**（这一笔请求里 `getParameter` 调用次数为 0）—— 真机上碰那个"像真的假对象"会写坏宿主内存；(d) `at<0` 拒；(e) 合法写回读正确 |
| 22 | `set_automation` 的 `closeShape` **写了外沿基线点** | 用假宿主的调用账本断言两件事：① 两个基线点是在**任何写入之前**读的（先写就把基线污染了）；② 两个闭合点落在形状的**外沿**（`首点 − guardQuarter`、`末点 + guardQuarter`），**不与任何用户点同 blick**（同 blick 会被用户点覆盖 ⇒ 等于没闭合）。`closeShape:false` ⇒ 没有任何基线写入 |
| 23 | `set_automation` 的 `closeShape` **真的把基线还回来** | 写形状前后各采样一次：形状**之内**读到 0.3，形状**之外**（前、后两侧）必须仍读到原始基线 1。没有闭合点时形状值会一直保持到整组末尾 —— 那正是"一个点把整组变成那个值"的原始事故 |
| 24 | `set_tempo` 同位置**替换** | 假宿主忠实复现真机：`addTempoMark` 同位置**不更新**而是再加一个。所以 `set_tempo` 写之前必须先 `removeTempoMark`：断言改 120→90 之后 blick 0 处**有且只有一个**标记且 bpm=90；再加一个别的 blick ⇒ 2 个；一次替换两个 ⇒ 仍是 2 个且 bpm 都更新；`bpm=0` 拒且不写。**0.5.8 回归守卫**：`get_tempo` 报出的**第二个**标记必须落在 2 拍（速度标记只有 `position` 字段，读 `positionBlick` 得 nil ⇒ 全被当成第 0 拍） |
| 25 | `set_meter` | 分母非 2 的幂（3）拒、`measure=0` 拒、`numerator=0` 拒、分母 64 拒 —— 全部**一个字节都没写**；`3/4` 接受且回读 `readBackNumerator/Denominator`，假宿主里小节 1 处**只有一个**标记。**0.5.8 回归守卫**：`get_tempo` 报出的拍号位置必须是 **0 拍**（拍号标记只有 `positionBlick` 是对的，`position` 是 ~1 blick 的垃圾值 ⇒ 读错会得到 1.4e-9 拍） |
| 26 | `transport` | `seek` 缺 `seconds` / 负数都拒且**播放头没动**；`seek 1.5` 后 `status` 报出假宿主的播放头 1.5；`play/pause/stop` 的 status 往返，`stop` 把播放头归零；`loop` 要求 `loopBegin < loopEnd`；未知 action 拒并列出可用 action |
| 27 | `group_ops` | `info` 的 0 起 `trackIndex` 与窗口；`rename` 往返（空名字拒且不改）；`offset` 的 `pitchOffset=49` 拒且**引用的两个偏移量都没动**；合法 `offset` 回读；**删主组被拒**（组还在、音还在）；删一个非主组成功且轨上组数回落 |
| 28 | `track_ops` | `list` 报 **0 起下标** / 名字 / 组数 / `isBounced`；`setMixer` 的 `gain=30`、`pan=1.5` 都在**写之前**拒（假宿主混音器逐字段没动，整机快照也相同）；`gain=-6,pan=0.5,muted=true` 往返；`add` 报 `addedIndex=2`；`rename`/`color` 往返；`remove` 删掉第二条后**拒绝删最后一条** |
| 29 | `set_note_attrs` 的四个新字段 | (a) `rapAccent` 给**数字** 3 → 拒（真机值是字符串）；(b) `"6"` → 拒（必须 `1..5` 之一）；(d) `"3"` 接受并回读；(c) `phonemes` 超长（257 > 256）拒；(f) `l@a{#}~` 这类 X-SAMPA 记号**不被过度拒绝**；(g) `language` 含控制字节拒；(h) `zh-cn` 接受；(i) `detune=1201` 越界拒；(j) **小数** `detune=-12.5` 接受（唯一 `integer=false` 的数值字段）；(k) 批里后一条非法 ⇒ **整批不写**。每一条都带"假宿主快照逐字节不变" |
| 30 | `select_notes` 程序化设置选区 | `all` 选中当前组全部音符；`indices` **恰好**选中点名的 0 起下标（先只选第 3 个 ⇒ 证明 `clearAll` 真的**替换**了旧选区而不是合并）；`none` 清空；`group` 选中的是**当前**组（先 `write_notes` 建第二组，用 UUID 证明选的是新组而不是第一组）。负例（六种：越界 / 负数 / 空数组 / 缺 `indices` / 未知 action / **小数 `[0.5]`**）：每一种都必须 `ok:false`、**报错点名 `indices[2]`**，且 **① 选区 `__T_selection()` 逐字不变（0.6.0 之前 `clearAll()` 在校验之前 ⇒ 被拒的请求已经把用户选区清空了）、② `__T_snap()` 逐字节不变、③ 撤销栈一步都没多（`__T_undo` 不变）、④ 宿主调用账里没有任何非整数下标** |
| 31 | `get_note_attrs` 的 scope / limit / 原始 attributes | `group` 报整组 3 个音（pitch/lyrics/onset/duration/每音 fp）；`limit:2` 截断且 `truncated:true`、`count` 仍报整组；`scope:"selection"` 只回选中的 2 个音、且没有 `groupName`。**核心：原始 `attributes` 只含"写过的键"** —— 没写过的音符是**空表**（不是默认值），桥没有实现过的字段（`musicalType` / `pitchAutoMode`）**缺席**而不是被填成默认值；写完 `detune`+`phonemes` / `rapAccent` 之后，每个音符的键集**恰好**是写过的那些（并用假宿主自己的账本交叉验证一次） |
| 32 | `split_notes` 的指纹 / 拆分点边界 / 头尾两半 / **多拆** | (a) 缺 `expectGroupFp` 拒；(b) 宿主侧改一个音高 ⇒ 旧 fp 拒并报 `STALE_SELECTION` 且**一个音都没拆**（快照逐字节相同），把音高改回去之后 fp **原样回来**（证明指纹是内容派生的，不是序号）；(c) 边界与外侧（`0` / `1` / `-0.5` / `1.5` / `2`）以及**余量之内**（`0.124` / `0.876`）全部在动手之前拒，报错点出 `0.125` 的余量；(c2–c6) 越界下标 / 缺 `atQuarter` / 空数组 / 空 fp / **小数 `index:0.5`** 全拒（小数那条还断言**宿主调用账里没有任何非整数下标 —— 连 `getNote(1.5)` 都没发生过**）；(d) 同一个下标拆两次拒；(e) 合法拆分：`remaining == before+1`、头 `duration == at-onset`、尾 `onset == at` 且 `duration == end-at`、两半的音高与歌词都在、**尾段按 onset 插在它自己那个头段后面**（不是末尾）、**它后面的音符下标整体 +1**、返回的 `groupFp` 与输入 fp **不同**；(f) 拆完之后旧 fp 立刻失效；(g) **一次拆两个**（0.5.9 回归守卫）：两个都拆对，第二个头被缩短到 0.5、第二个尾段带的是**第二个音符**的音高与歌词 —— 正序处理会让第二个拆分点打到被挤过来的邻居上，**静默造出两个同 onset 的音** |
| 33 | `get_layout` 布局体检 | 干净组报 0 重叠、`verdict` 以 `OK` 开头、`spanStart/EndQuarter` 与按 onset 排好的 `layout`（带宿主下标、音高、歌词）一致；**首尾相接（end == 下一音 onset）既不是重叠也不是空隙**；故意拉长一个音造成重叠 ⇒ **被检出并上报**（`overlapCount:1`、两个音高、重叠量 0.5 拍、边界 1.5/1 拍、`verdict` 含"违规"）；真空隙进 `gaps`（0.25 拍 ×2）而 `overlaps` 为空；`scope:"selection"` 只看选中的两个音且没有 `groupName`。每次请求前后 `__T_snap()` 逐字节相同（只读 op）。⚠️ 所有 blick 乘法压在 3 拍内：3.5 拍的 `onset+duration` 会撞 fengari 的 32 位整数，`spanEndQuarter` 会静默读成 2.5 |
| 34 | `apply_lyrics` 的切分与**时间序** | (a) 中文"晚风轻轻"给 3 个音 ⇒ 一字一音 + `leftoverTokens:1`；(b) "hello world" ⇒ `["hello","world","-"]`（拉丁按**词**、空白分隔、多余音符填 `filler`）；(c) **核心**：把组的存储顺序打乱成 `[onset2,onset0,onset3,onset1]` 之后，"甲乙丙丁"仍按 **onset** 落到 0/1/2/3 —— 按 `getNote(i)` 顺序分配会得到完全不同的结果（`apply-lyrics-storage-order` 变异）；(d) 6 个字给 3 个音 ⇒ `leftoverTokens:3`；(e) `filler:""` ⇒ 剩下的音符**保持原歌词不动**（不是写空串）；(f) 数字 / 数组 / 空串 / 缺字段四种非法 `lyrics` 全拒且 `__T_snap()` 不变；(g) 负数与小数 `startIndex` 拒且不写；(h) `startIndex:1` 真的跳过头一个字 |
| 35 | `align_lyrics` LRC 对位 + **纯 dry-run** | 120 bpm 下 1 拍 = 0.5 秒，4 个音落在 0/0.5/1.0/1.5 秒。(a) `[00:00.00]甲乙` + `[00:01.00]丙丁` ⇒ 逐音 `甲/乙/丙/丁`，`mapping[].atSec` 报出秒数，**并用假宿主自己的账（`__T_lyricsByOnset`，按 onset 排序）交叉验证**；(b) `apply:false` **一个字节都没写**（`__T_snap()` 逐字节相同）却仍返回完整 mapping（`align-lyrics-writes-on-dryrun` 变异）；(c) `[mm:ss]` 无小数解析；(c2) `[00:00.50]` 认小数、乱序 LRC 会按时间排序；(d) 没有合法行 / 只有时间戳没有文字 / 缺 `lrc` 全拒且不写；(e) 段里字不够时回落到 `filler`，多余的段进 `unusedSegments`（`{sec:1,left:1}`） |
| 36 | `get_audio_tracks` | (a) 没有音频引用时 `count:0`、`audio:[]`，并给出"先把伴奏拖进 SV2"的提示，且只读（快照不变）；(b) 给第二条轨挂一个 `isInstrumental` 引用（onset 1 拍、长 2 拍）⇒ `trackIndex:1` / `groupIndex:0` / `trackName` / `onsetQuarter:1` / `durationQuarter:2` / `endQuarter:3` / `timeOffsetQuarter:0` 全部按 **0 起**上报；(c) 再给第一条轨挂一个 ⇒ `count:2` 且顺序是 `[[0,1],[1,0]]`（先轨后组），时间偏移按拍报出，**非音频的主组永远不会被列进来** |
| 37 | `align_audio` 锚点 / 移位 / 速度标 | (a) 没有音频引用 ⇒ **报错且不写**（错误点名 `isInstrumental`）；(d) 缺 `firstBeatSec` 拒；(e) `measure:0` 拒（对外 1 起）；(b) `anchor:"measure",measure:1` ⇒ 音频首拍**正好落在第 1 小节的 blick（0 拍）**，回读 `firstBeatLandsAtQuarter:0`；(b2) `firstBeatSec:0.5`（120 bpm 的 1 拍）⇒ 音频起点 **−1 拍**、首拍仍落在 0 —— 秒→blick 走的是宿主的 `getBlickFromSeconds`，不是常数；(c) `shiftBeats:2` 把锚点整体移 2 拍（假宿主里的引用真的移到 2 拍）；(f) 给 `bpm` 时在锚点写速度标，且同 blick 的旧标是**替换不是叠加**（写前先 `removeTempoMark`）；(f2) 不给 `bpm` 时一条速度标都不动。⚠️ `measure:1 → getMeasureMarkAt(0)` 的 **1 起→0 起**转换由 `align-audio-no-measure-minus-one` 变异压着 |
| 38 | `set_note_attrs` 的 `attributes` 层（SV2 2.1.1+） | (a) `{muted:true}` 写入并回读，假宿主里**恰好只有这一个键**；(b) **不认识的键被拒**、报错点名该键并列出允许键、`__T_snap()` 不变（真机上把不认识的键递给 `setAttributes` 会**弹模态框冻住宿主**；`note-attrs-accept-unknown-key` 变异复现"递过去"的后果）；(c) 类型错（`muted:"yes"` / `dF0VbrMod:"loud"` / `phonesetOverride:42`）全拒且不写；(d) 越界数值（`rTone:200`）拒并点出区间；(e) `phonemes:[{leftOffset:-0.1,position:0.5}]` 接受且**只有这两个子键**，未知子键 `{foo:1}` 与越界子值 `{position:5}` 拒且不覆盖上一次的数组；(f) **批里后一条非法 ⇒ 整批不写**（第一条的 `muted` 也没落下去） |
| 39 | `track_ops list` 的 `displayOrder` / `noteCount` | 单轨 3 个音 ⇒ `noteCount:3`；同一轨再写一个组 ⇒ `groupCount:2` 而 `noteCount` 是**跨组求和 4**（不是组数）；空轨报 `noteCount:0`。把两条轨的 `displayOrder` 设成**和存储下标相反**（0↔1）⇒ `index` 不变而 `displayOrder` 跟着宿主走，于是"视觉最上面那条轨"是 `min(displayOrder)` 的那条（index 1）而不是 index 0（`track-list-reuses-index` / `track-list-notecount-is-groupcount` 两个变异） |
| 40 | `group_ops {action:"move"}` | (a) 移到**同一条轨** ⇒ `moved:false`、说明原因、`__T_snap()` 不变；(b) **主组拒绝移动**（报错点名"主组"、快照不变、主引用还在轨上）；(c) **让 `addGroupReference` 按需失败** ⇒ 请求失败、错误点名 `addGroupReference`、**源引用一个都没少**（2 个仍在）、目标轨没拿到东西、组在库里音符还在、整机快照逐字节相同 —— 这条压的是"**先挂新引用、成功后再删旧引用**"的顺序（`group-move-remove-before-add` 变异）；(d) 移到另一条轨 ⇒ 目标轨拿到的**确实是同一个组**（UUID 相等）、组还在库里且音符还在，**并且源轨不再引用它、只剩主组一个引用** —— 后半句是 0.6.6 那个严重 bug 的回归守卫（`group-move-wrong-index` 变异） |

> 11 号测试的说明：`writeAtomic` 不在 `SVDSH_TEST` 的导出列表里，所以它通过桥自己的调用者
> `writeHeartbeat()` 驱动（同一路径、不同内容、连写两次）。被测的序列完全一样：
> `writeFile(path..".tmp")` → `os.rename(tmp, path)` 且目标已存在。

### 表格之外

**已知取舍**会以 `NOTE` 打印（不影响退出码）。五条都是**实时算出来的探针**：
一旦行为变了（或者桥被修好了），文字会跟着变或直接消失，不会变成过期注释。
（第 2 条目前**什么都不打印** —— 它探到的两个 op 都已经修好了，探针现在是一台回归探测器；
第 4 条**现在每次都打印** —— 它探到的那个 bug 还没修，见"已知缺陷"一节。）

1. `jenc` 非整数用 `%.10g`，需要 10 位以上有效数字的浮点无法逐位往返。
2. **有没有 op 在校验之前就 `newUndoRecord()`**：`group_ops {action:"offset"}` 曾经是（0.5.3 修）、
   `select_notes {action:"indices"}` 也曾经是（0.6.0 修）。被拒的请求工程数据一个字节都没写
   （27/30 号测试压着），但用户的撤销栈里会多出一条空步。探针每次运行**分别**检查这两个 op
   （`resetWorld()` 会把计数归零），谁回退就点谁的名。
   > 0.6.0 之前的 `select_notes` 还有更严重的一半：`clearAll()` 也在校验之前 ⇒ 一个本该被拒的
   > 请求**已经把用户的选区清空了**。这一条现在由 30 号测试的"选区逐字不变"压着（不是探针）。
3. **fengari 的整数是 32 位，整数运算在 2^31 以上会回绕**（真机 Lua 5.4 是 64 位）：
   `705600000 * 4` 在 fengari 里等于 `-1472567296`。所以离线测试里所有 blick 乘法都刻意压在
   3 拍以内；**更长位置上的行为（长工程、`write_notes` 超过约 3 拍、`ATTR_WHITELIST` 里
   `705600000*64` 这个 duration 上限）只能在真机验**。
4. **`group_ops {action:"move"}` 删错了引用**：探针真的走一遍"把轨 0 的第 2 个组移到轨 1"，
   发现返回 `moved:true` 却**把主组从编排里删掉了**、被移动的组挂了两遍。完整症状、
   最小复现与建议修法见"已知缺陷"一节；**本次没有改桥**。
5. **假宿主的秒↔blick 模型是否还自洽**：`align_lyrics` / `align_audio` 的全部秒数断言都建立在
   "120 bpm ⇒ 1 拍 = 0.5 秒"上。探针每次运行做一次往返（1 拍 → 0.5 秒 → 1 拍），
   模型一变就点名 35/37 号测试，免得那两条断言悄悄变成空的。

---

## 依赖说明

`package.json` 里除了 `fengari` / `luaparse`，还显式列了 `tmp`、`sprintf-js`、`readline-sync`。
这不是多余的：它们是 **fengari 自己的运行时依赖**（`loslib.js` 顶层就 `require('tmp')`），
而 pnpm 在这台机器上用 junction 做隔离布局，Node 不会把 junction 解析回 `.pnpm`，
于是 fengari 内部 `require('tmp')` 找不到。把它们提为直接依赖后，
`node_modules/tmp` 就在解析路径上，`import 'fengari'` 才能成功。
（删掉它们会立刻报 `Cannot find module 'tmp'`。）

---

## fengari 与真 Lua 的差异，以及补偿

1. **整数只有 32 位**（`LUA_MAXINTEGER = 2147483647`），而 SV2 的 Lua 是 64 位。
   后果：`string.format("%08x", h)` 对任何 `h >= 2^31` 会抛
   `number has no integer representation` —— 而 `hash32()` 约一半的输出都 ≥ 2^31，
   于是 `selectionFp()` 会炸，harness 会报一个**假的**桥 bug。
   `luaenv.mjs` 覆写 `lvm.tointeger`（`lapi.lua_tointegerx` 是运行时查表，所以覆盖有效）
   把整数语义放宽到 double 范围。**这只改测试环境，不碰被测脚本。**

   ⚠️ 这个覆写只救**格式化**，救不了**运算**：fengari 里 `705600000 * 4` 会回绕成 `-1472567296`
   （真机是 `2822400000`）。所以离线测试里所有 blick 乘法都刻意压在 3 拍以内，
   而且假宿主的 `getDuration()` 特意取 3 拍而不是 4 拍。这一条由 `documentLimitations()` 里的
   `__T_overflowProbe` **每次运行实时报出来**，不是一句会过期的注释。
   （若哪天想让测试覆盖更长位置，得先把 fengari 的整数运算一起补掉，那比 `tointeger` 深得多。）
2. `_VERSION` 是 `Lua 5.3`（SV2 是 5.4）。脚本不使用 5.4 独有语法，所以解析与运行都成立；
   `math.type` 对大整数返回 `"float"`，走的是 `jenc` 的 `%.0f` 分支，输出与 5.4 的 `%d` 分支**逐字节相同**。
3. `tostring(1789175384220009)` 在 fengari 里是 `1789175384220000.0`（`%.14g` 显示）。
   只是显示差异，桥没有把它写进协议。
4. `os.date` / `os.time` / `os.remove` / `os.rename` 用 fengari 自带的真实文件系统实现；
   只有 `io`（fengari 的 `io.open` 未实现）和 `os.getenv`（需要指向每次运行独立的目录）被替换。
5. 假宿主的 `getNote(i)` 是 **1 起**，`SV.setTimeout` 只记录回调、由 harness 手动走拍（绝不递归）。

---

## 证明测试有效（变异测试）

把故意的 bug 打进 `DSHBridge.lua` 的**副本**，再用 `--bridge` 跑。变异集定义在 `make-mutants.mjs`
里，一条命令重新生成（每条替换必须**恰好命中一次**，否则脚本直接报错 —— 一个什么都没改的变异
证明不了任何事）：

```powershell
node make-mutants.mjs
```

**52/52 全部被抓到**（下表"实际 FAIL"是这台机器上跑出来的真实结果，不是预期值）：

| 变异 | 说明 | 实际 FAIL 的测试 |
| --- | --- | --- |
| `delete-notes-no-groupfp` | `delete_notes` 去掉 `expectGroupFp`/STALE 检查 | 16, 17 |
| `delete-notes-forward` | `delete_notes` 改成正序删（下标中途错位） | 17 |
| `delete-notes-no-integer` | `delete_notes` 去掉**整数检查**（`removeNote(1.5)` 递给宿主） | 17 |
| `automation-ignore-closeshape` | `set_automation` 忽略 `closeShape` | 22, 23 |
| `dynamics-not-rejected` | `dynamics` 不再硬拒，一路走到 `getParameter` | 21 |
| `set-tempo-no-pre-remove` | `set_tempo` 跳过写前的 `removeTempoMark` | 24 |
| `tempo-mark-reads-positionblick` | `get_tempo` 用 `positionBlick` 读速度标记**且去掉回落**（0.5.8 之前的形状 ⇒ 速度全落在第 0 拍） | 24 |
| `measure-mark-reads-position` | `get_tempo` 用 `position` 读拍号标记（真机那里是 ~1 blick 的垃圾值） | 25, 37 |
| `write-pit-relative-pitch` | `write_pit` 忘掉"宿主存的是相对锚点的偏移" | 18 |
| `write-notes-no-mount` | `write_notes` 跳过第③步（挂轨） | 14, 27, 30, 39, 40 |
| `get-computed-no-offset` | `get_computed` 忘了加组引用的 `timeOffset` | 19 |
| `get-notes-unstable-fp` | `groupFingerprint` 只哈希音符**个数**，不看内容 | 15, 16, 32 |
| `set-meter-no-pow2` | `set_meter` 去掉 2 的幂检查 | 25 |
| `set-mixer-no-range` | `track_ops setMixer` 去掉 gain/pan 范围检查 | 28 |
| `group-delete-main` | `group_ops delete` 去掉"主组不能删" | 27 |
| `track-remove-last` | `track_ops remove` 去掉"不能删最后一条轨" | 28 |
| `note-attrs-no-maxlen` | `set_note_attrs` 去掉文本长度上限 | 29 |
| `note-attrs-no-language-pattern` | `set_note_attrs` 去掉语种码格式检查 | 29 |
| `jenc-pct14g` | `jenc`: `%.0f` → `%.14g`（经典大整数 bug） | 1, 5 |
| `jenc-pct6g` | `jenc`: `%.10g` → `%.6g`（W2 回归） | 1 |
| `selectednotes-trust-len` | `selectedNotes()` 信 `#`，去掉 `getNumSelectedNotes()` 回退 | 3, 5, 6, 7, 12, 13, 29, 31, 33, 38 |
| `require-expectfp` | `requireFreshSelection` 不要求 `expectFp` | 7 |
| `note-attrs-no-range` | `set_note_attrs` 去掉数值范围检查 | 12, 29 |
| `note-attrs-no-integer` | `set_note_attrs` 去掉**整数检查**（W1 回归） | 13 |
| `pollonce-no-id-dedup` | `pollOnce` 不看响应缓存（无 id 去重） | 8 |
| `pollonce-keep-bad-json` | `pollOnce` 不消费坏 JSON（每拍重读） | 10 |
| `writeatomic-refuse-overwrite` | `writeAtomic`: 目标已存在就拒绝写 | 8, 11 |
| `cfg-poll-ms-300` | `CFG`: `POLL_MS` 改回 300（W3 回归） | 4 |
| `buildpaths-rebind` | `buildPaths` 改回重新绑定 `PATH`（W4 回归） | 4 |
| `split-notes-no-groupfp` | `split_notes` 去掉 `expectGroupFp`/STALE 检查（拆错音符） | 32 |
| `split-notes-no-inner-bounds` | `split_notes` 允许拆分点落在音符边界/外侧（零长或负长的半边） | 32 |
| `split-notes-head-not-shortened` | `split_notes` 头不缩短（两半重叠） | 32 |
| `split-notes-tail-not-appended` | `split_notes` 建了尾音却不加进组（音符凭空消失） | 32 |
| `split-notes-loses-lyrics` | `split_notes` 不把歌词复制到尾音 | 32 |
| `split-notes-no-integer` | `split_notes` 去掉**整数检查**（`getNote(1.5)` 递给宿主） | 32 |
| `split-notes-ascending` | `split_notes` 改回**正序**处理（0.5.9 回归：第二个拆分点打到被挤过来的邻居上） | 32 |
| `select-notes-no-bounds` | `select_notes` 去掉下标越界检查（静默选错/什么都没选） | 30 |
| `select-notes-no-clear` | `select_notes` 的 `all`/`indices` 跳过 `clearAll()`（新选区并进旧选区） | 30 |
| `select-notes-group-no-clear` | `select_notes {action:"group"}` 跳过 `clearAll()` | 30 |
| `select-notes-no-integer` | `select_notes` 去掉**整数检查**（`getNote(1.5)` 递给宿主） | 30 |
| `select-notes-clear-before-validate` | `select_notes` 在校验之前就 `clearAll()`（被拒的请求把用户选区清空了） | 30 |
| `select-notes-undo-before-validate` | `select_notes` 在校验之前就 `newUndoRecord()`（撤销栈多一条空步） | 30 |
| `note-attrs-fill-defaults` | `get_note_attrs` 自己填默认属性值（而不是只报写过的键） | 31 |
| `get-note-attrs-no-limit` | `get_note_attrs` 忽略 `args.limit`（不截断也不上报） | 31 |
| `get-layout-ignores-overlaps` | `get_layout` 不再比较"音符末尾 vs 下一个起点"（任何重叠都报成干净） | 33 |
| `apply-lyrics-storage-order` | `apply_lyrics` 信 `getNote(i)` 的存储顺序、不按 onset 排（歌词落到错的音符上） | 34 |
| `align-lyrics-writes-on-dryrun` | `align_lyrics` 在 `apply:false` 时照写（"dry-run" 改动了工程） | 35 |
| `align-audio-no-measure-minus-one` | `align_audio` 把 1 起的小节号直接递给 `getMeasureMarkAt`（漏掉 1 起→0 起 转换） | 37 |
| `note-attrs-accept-unknown-key` | `set_note_attrs` 把不认识的 attributes 键**直接递给宿主**（真机上弹模态框冻住主线程） | 38 |
| `group-move-remove-before-add` | `group_ops move` 在目标挂载成功**之前**就删源引用（add 失败即丢组） | 40 |
| `group-move-wrong-index` | `group_ops move` 用**源轨的工程下标**当"引用在轨内的下标"去删（0.6.6 真机事故：组重复挂两条轨 + **主组被删**） | 40 |
| `track-list-reuses-index` | `track_ops list` 把存储下标当 `displayOrder` 上报（"最上面那条轨"认错） | 39 |
| `track-list-notecount-is-groupcount` | `track_ops list` 把**组数**当 `noteCount` 上报（"最上面那条轨空不空"答错） | 39 |

> ⚠️ `delete-notes-no-groupfp` 的 find 串**必须带上 `delete_notes` 独有的前一行**：v0.5.7 加进来的
> `split_notes` 里有一段**逐字相同**的 STALE 检查，只写那段会命中两次 —— 生成器会直接报错退出 1
> （这正是"一个什么都没改的变异证明不了任何事"那条纪律在起作用：它先抓到了自己的失效）。
>
> ⚠️ `group-delete-main` 的 find 串**必须带上那句 `error("主组不能删…")`**：v0.6.1 加进来的
> `group_ops move` 里有一句逐字相同的 `if call(ref, "isMain") == true then`（只是 error 文案不同），
> 只写条件同样会命中两次。**这一条从 0.6.1 起一直是红的**（`node make-mutants.mjs` 退出 1，
> 只写出 51 个变异）—— 也就是说在补上这次的新测试之前，那条命令并不满足"一条命令跑通"。
> 修法是补上 error 那一行，让 find 串唯一。
>
> ⚠️ `tempo-mark-reads-positionblick` 只把**读取顺序**换过来、保留 fallback 是**等价变异**
> （真机给 nil ⇒ 回落到 `position` ⇒ 结果一模一样），跑出来 51/52 —— 一个什么都没改的变异。
> 必须把 fallback 一起去掉，复现的才是 0.5.8 之前那个"两种标记共用一个读取顺序"的形状。

几个变异值得单独看：

* `note-attrs-no-integer` 的失败详情正是设计要防的那一条 ——
  不只是「没报错」，而是**音高真的被改成了 60.5**，说明「无副作用」这条断言确实有牙：

  ```
  13  FAIL  set_note_attrs rejects non-integers (W1)
      (a) fractional pitch rejected (ok) (got true / want false) |
      (a) NO note was mutated (got "60.5,63,65" / want "64,63,65") | ...
  ```

* `note-attrs-fill-defaults` 让 31 号测试从**假宿主自己的 attributes 表**上看到桥凭空造出来的
  `{"detune":0,"phonemes":""}` —— 这正是"agent 以为某个值被钉住了、其实没有"的来源：

  ```
  31  FAIL  get_note_attrs: scope / limit / raw attributes
      (b) a note with nothing written has an EMPTY attributes table (no invented defaults)
      (got "[{\"detune\":0,\"phonemes\":\"\"},...]" / want ...)
  ```

* `split-notes-ascending`（0.5.9 那个真机 bug）是**静默数据损坏**的样板：第二个拆分点打到被挤过来的
  邻居上，于是**造出两个 onset 都是 2 拍的音符**，而 `ok:true`、`split:2`、`remaining:5` 全都"对"：

  ```
  32  FAIL  split_notes: fingerprint, bounds, head + tail
      (g) both notes were split at the RIGHT place (no tail landed on a neighbour)
      (got "[0,0.5,2,2,2.5]" / want "[0,0.5,1,2,2.5]") |
      (g) durations (got "[0.5,0.5,0.5,1,0.5]" / want "[0.5,0.5,1,0.5,0.5]") | ...
  ```

* `select-notes-no-integer` 是"只有调用账才看得见"的样板：假宿主对 `getNote(1.5)` 只是返回 nil，
  所以 `ok:true` 而且选区被清空 —— 三个断言同时红，其中一个正是**宿主调用账里的非整数下标**：

  ```
  30  FAIL  select_notes: all / indices / group / none
      (d6) a fractional index is rejected (got true / want false) |
      (d6) the error mentions "整数" |
      (d6) NO fractional index reached the host (got 1 / want 0) | ...
  ```

* `select-notes-clear-before-validate` 与 `select-notes-undo-before-validate` 是 0.6.0 修掉的两半：
  前者让"被拒的请求"把用户选区清空（`got count:0` / `want count:2`），后者在撤销栈里多留一步
  （`got 14 / want 8`）。
* `automation-ignore-closeshape` 同时打红 22 和 23：22 从假宿主的调用账本上看到"基线点根本没写"，
  23 从**行为**上看到形状值一直保持到整组末尾。
* `get-notes-unstable-fp` 打红 15：连读两次 `groupFp` 相同、但宿主侧改一个音高之后**也相同** ——
  指纹守卫变成空的，16 号测试随之失效。v0.5.7 之后它还额外打红 **32**：`split_notes` 的
  `expectGroupFp` 用的是同一个 `groupFingerprint`，只看个数的话"陈旧指纹"这条守卫同样是空的。
* `selectednotes-trust-len` 现在也打红 **31 / 33 / 38**：`get_note_attrs {scope:"selection"}`、
  `get_layout {scope:"selection"}` 与 `set_note_attrs` 走的都是同一个 `selectedNotes()`，
  信 `#` 就会把"选了 2 个音"误判成"没选中"（33/38 是本轮新增的两条）。
* `write-notes-no-mount` 现在也打红 **30 / 39 / 40**：这三条测试都用 `write_notes` 造第二个组，
  组没挂上轨就 `useGroupAt(2)` 失败（39/40 是本轮新增的两条）。
* `measure-mark-reads-position` 现在也打红 **37**：`align_audio` 用同一个 `measureMarkBlick`
  读小节标记，读错字段（拿到那个 ~1 blick 的垃圾值）会让音频首拍落在 1 blick 上。
* `cfg-poll-ms-300` / `buildpaths-rebind` 只让 4 号测试变红（5 号之后仍绿），
  验证了上面那条「一处回归不连带拖挂」的设计。

本轮新增的四个变异，失败详情各自说明一类"看起来成功、其实错了"：

* `note-attrs-accept-unknown-key`（38 号）—— 真机上把不认识的键递给 `setAttributes` 会**弹模态框
  冻住宿主**，离线只能验"桥不会递过去"。变异把键放过去之后，假宿主**老老实实存了下来**，
  于是"一个字节都没写"这条断言从快照里直接读出了 `bogusKey=1`：

  ```
  38  FAIL  set_note_attrs: the attributes layer
      (b) rejected (got true / want false) |
      (b) NOT ONE BYTE was written (got "differs at 212: ...\"bogusKey=1\"],[\"note\",...")
  ```

* `apply-lyrics-storage-order`（34 号）—— **静默把歌词写到错的音符上**：`ok:true`、
  `written:4`、`leftoverTokens:0` 全都"对"，只有按 onset 交叉验证的那条断言看得见：

  ```
  34  FAIL  apply_lyrics: CJK + words + onset order + filler
      (c) the lyrics follow TIME order, not storage order
      (got "0:乙,1:丁,2:甲,3:丙" / want "0:甲,1:乙,2:丙,3:丁")
  ```

* `align-lyrics-writes-on-dryrun`（35 号）—— "只算不写"的 dry-run **真的写了**，
  而且返回的 mapping 与正常路径一模一样，只有 `__T_snap()` 逐字节比较能抓住：

  ```
  35  FAIL  align_lyrics: LRC mapping + a pure dry-run
      (b) apply:false wrote NOT ONE BYTE (got "differs at 196: ...\"甲\"...")
  ```

* `group-move-remove-before-add`（40 号）—— 顺序反了之后，`addGroupReference` 一失败，
  **源引用已经被删掉**，组从编排里消失（40 号 (c) 的 `got 1 / want 2`）。
  注意这与下面"已知缺陷"里那个**真机未修的 bug** 是两件事：这条变异验的是"顺序"，
  那个 bug 是"删的时候用错了下标"。

---

## 已修复：`group_ops {action:"move"}` 删错了引用（0.6.6 修，静默数据丢失）

> **状态：已修（桥 0.6.6）**。完整记录留档 —— "一个变量担两个语义"这类 bug 值得留着看。
>
> **修法与验证：**
> * 轨下标只用于"源轨 == 目标轨"的比较（改名 `srcTrackIdx`）；删引用改用**引用自己的下标**
>   `ref:getIndexInParent()`（`refIdx`）。
> * 另加一道**删前自检**：删之前确认该下标指向的目标确实是本组，否则中止且**什么都不删**。
> * 40 号测试补了**源轨那一半**断言（源轨不再引用它、只剩主组一个引用）。
> * 新增变异 `group-move-wrong-index` 复现原始形态，被 40 号抓住：
>   `(d) the source track no longer references the moved group (0.6.6 regression) (got "GRP-0002" / want "GRP-0001")`。
> * `documentLimitations()` 里那条实时探针仍在，现在**不再报警** —— 继续当哨兵。

### 原始记录

### `group_ops {action:"move"}` 删错了引用（静默数据丢失）

* **症状**：把一条轨上**不是第一个**的组移到另一条轨，返回 `moved:true`，但是
  ① 被移动的组**仍然留在源轨上**（于是它同时挂在两条轨上，重复发声），
  ② 源轨上的**第 N 个**引用被删掉了（N = 源轨的 1 起工程下标）—— 常常就是**主组**，
  主组于是从编排里彻底消失（库里的数据还在，工程不再渲染它）。
* **根因**：`DSHBridge.lua:2333` 用 `src:getIndexInParent()` 取值（`src` 是**轨**，
  所以拿到的是"轨在工程里的 1 起下标"），却在 `:2351` 把它当成"引用在轨内的下标"
  递给了 `src:removeGroupReference(...)`。同一个变量还被用于"源轨 == 目标轨"的比较
  （`:2335`），**那个用法是对的** —— 一个变量担了两个语义，删引用那一半用错了。
* **为什么**任何**合法移动都会中招**：只有"被移动的组正好是**第 1 条轨的第 1 个引用**"时才碰巧正确，
  而那个位置永远是**主组**，主组又明确禁止移动（`:2324`）。
* **最小复现**（离线测试台，`__T_resetWorld()` 之后）：

  ```
  track_ops {action:"add", name:"Target"}                 → 2 条轨
  write_notes {notes:[{onset:0,duration:1,pitch:72}]}     → 新组挂在轨 0 的第 2 个引用上
  __T_useGroupAt(2)                                       → 把它设为当前组
  group_ops {action:"move", targetTrackIndex:1}
  ```

  实测（探针每次运行都会打印这一段）：

  ```
  BEFORE  track0: GRP-0001,GRP-0002 | track1: (空)
  move   : ok=true moved=true fromTrackIndex=0 toTrackIndex=1
  AFTER   track0: GRP-0002         | track1: GRP-0002
  ```

  即 **GRP-0001（主组）从编排里消失了**，而 GRP-0002 被挂了两遍。
* **建议的修法**（本次**没有改桥** —— 按"优先报告、不擅自修改"处理）：
  删引用时改用**引用自己的下标** `call(ref, "getIndexInParent")`，轨下标只留给 `:2335` 那条比较。
  ⚠️ 动手之前先要在真机确认 `Track:getIndexInParent()` 到底是 **1 起还是 0 起** ——
  `:2335` 的 `srcIdx == dstTi + 1` 与 `group_ops info` 的 `i - 1` **都**假设 1 起，
  而这两处都没有在真机上验证过（假宿主按 1 起建模）。
* **测试台怎么处理**：40 号测试只断言"目标轨拿到的确实是同一个组、音符一个不少"这一半，
  源轨那一半由探针报出。桥修好之后，把探针升级成 40 号测试里的断言即可。

---

## 离线验不了、必须在真机确认的

* 模态框本身：绑定错误穿透 `pcall` 的行为在 fengari 里不存在，假宿主只会抛普通 Lua 错误。
  所以「非整数实参会不会真弹框」只能由宿主回答 —— 测试台只能保证桥**不会把非整数发出去**。
* 面板中继：假宿主提供了 `getScriptData`/`setScriptData`（`panel:true`，面板代码路径确实跑起来了），
  但没有覆盖 `SidePanelSection` 与「面板脚本连 `io.open` 都返回 nil」这个沙箱差异。
* 真实工程规模（例如 462 个音）下的性能与 `MAX_DONE=64` 缓存淘汰行为。
* `SV.setTimeout` 的真实节拍精度，以及宿主对脚本错误的实际处理。
* **任何 ≥ 2^31 的 blick 位置**（长工程；`write_notes` 写到第 4 拍以后；
  `ATTR_WHITELIST` 里 `705600000*64` 这个 duration 上限）—— fengari 的整数会回绕（见上）。
* **`Automation` 的真机语义**：假宿主按"同 blick 覆盖 + 两端外推 + 中间线性插值"建模
  （`closeShape` 的整条推理都建立在这个模型上，既有实现的 `dynPlan`
  也是靠"锚点/收尾点不与形状点同 blick"来闭合的，与该模型自洽），但**真机上没有实测过插值方式**。
  如果真机其实是别的形状（例如阶梯保持），23 号测试的结论要重新核对。
* **非整数音符下标**：假宿主对 `getNote(1.5)` / `removeNote(1.5)` 静默返回 nil（Lua 表用小数键查不到），
  所以离线只能看到"静默什么都没做"。真机是静默忽略还是**弹模态框**，只能由宿主回答 ——
  测试台能保证的只有"桥**不会把非整数发出去**"（17/30/32 号测试用宿主调用账压着这一点）。
* **`NoteGroup:addNote()` 是按 onset 插入还是追加**：假宿主按 0.5.9 的真机实测记录建模成
  **按 onset 插入**（`split_notes` 的倒序处理、`delete_notes` 的从后往前删都建立在这条上）。
  这一条**没有在本次离线环境里独立复验** —— 如果真机其实是追加，那 32 号测试 (e)/(g) 的
  顺序断言（"尾段紧跟头段"、"后面的音符下标 +1"）就要反过来写，而且 0.5.9 的倒序改动本身
  也就失去了理由。**这是整套离线测试里唯一一条"模型本身来自被测方的实测结论"的假设**，
  值得在真机上再确认一次。
* **两种时间标记的位置字段**：同样来自桥自己的真机实测（速度标记 `position`、拍号标记
  `positionBlick` + 垃圾 `position`）。假宿主按此建模，所以 24/25 号测试能抓住"读错字段"；
  字段名本身没有独立复验。
* **`TimeAxis:addTempoMark` "同位置不更新"** 是照抄参考项目的真机实测结论，本次没有在真机复验；
  24 号测试压的是"桥必须自己先删"这条纪律，与真机行为是否一致无关。
* `SV:getComputedPitchForGroup` / `getPhonemesForGroup` 返回的**数值内容**是假宿主合成的，
  离线只能验证"桥怎么用它"（帧数、单位、是否加 timeOffset），验不了宿主的计算结果本身。
* **`SelectionState` 的真机语义**：假宿主把 `selectNote()` / `selectGroup()` 建模成**追加**、
  只有 `clearAll()` 清空（见 `newSelection()` 的注释）。真机上 `selectGroup()` 到底是"选中整组"
  还是"把整组并进当前选区"**没有实测过**；桥先 `clearAll()` 再选，所以在两种语义下结果都一样 ——
  但 30 号测试的"旧选区被替换而不是合并"这条断言**依赖假宿主的追加模型**，真机若本来就是替换语义，
  那条断言仍然会绿（只是不再有区分力）。
* **`Note:getAttributes()` 的键名与范围**：假宿主只记"setter 显式写过的键"，键名取
  `pitch`/`lyrics`/`onset`/`duration`/`phonemes`/`detune`/`languageOverride`/`rapAccent`。
  真机到底回哪些键、用什么名字（参考项目 SV-007 只确认了"没写过的是 nil，不是默认值"）
  **没有实测过**。31 号测试压的是"桥**不要自己填默认值**"这条纪律，与具体键名无关。
* **`Note:setAttributes()` 的属性名 / 类型 / 范围**：`ATTRIBUTE_WHITELIST` 里那 9 个键
  （`muted` / `evenSyllableDuration` / `dF0VbrMod` / `rTone` / `rIntonation` / `expValueX` / `expValueY` /
  `phonesetOverride` / `phonemes`）与 `PHONEME_ITEM_WHITELIST` 里那 4 个逐音素键的**名字、单位、
  取值范围**都是照官方示例与直觉保守取的（注释里写着"取窄了最多是误拒，取宽了才可能弹框"），
  **没有在真机上逐个试过**。38 号测试压的是"**不认识的键一律拒**、类型/范围错一律拒、
  整批失败即不写"这套纪律，与具体键名/边界无关。
* **`TimeAxis:getSecondsFromBlick()` / `getBlickFromSeconds()` 的换算**：假宿主按自己的速度标记
  **分段积分**（`秒 = (blick/QUARTER) * (60/bpm)`），整套测试只跑过 **120 bpm** 这一种速度，
  即 1 拍 = 0.5 秒。真机在**变速工程**里怎么换算（是否真的按段积分、变速点处是否连续）**没有实测过**；
  35/37 号测试里所有秒数都建立在这个模型上。`documentLimitations()` 里的 `__T_secondsRoundTrip`
  探针每次运行会核对假宿主模型是否自洽，但它核不了真机。
* **`NoteGroupReference:isInstrumental()`**：假宿主按"只有控制面 `M.addInstrumentalRef()` 打开它、
  而且这类引用的 `getTarget()` 是 nil"建模。真机上音频引用的 `getTarget()` 到底回 nil 还是回一个
  空组、`isInstrumental()` 是否还有别的取值形态，**都没有实测过**；36/37 号测试压的是
  "桥只用它筛音频引用、并在找不到时如实报错"。
* **`Track:getDisplayOrder()` 的基准**：假宿主在没显式设过时回落到 `getIndexInParent()`（1 起）。
  真机的 `getDisplayOrder()` 是 0 起还是 1 起、和存储下标的关系**没有实测过**；
  39 号测试压的是"桥**上报宿主给的值**、不要拿自己的循环下标冒充"。
* **`TimeAxis:getMeasureMarkAt(measure)` 的参数基准**：假宿主按桥自己的真机实测记录建模成
  **0 起**，并且对任意小节号**合成**一个标记。真机上"没有显式拍号标记的小节"是否也会返回一个标记
  **没有复验**；37 号测试压的是"桥做了 1 起→0 起 转换"这一半（`align-audio-no-measure-minus-one` 变异）。
