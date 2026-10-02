# sv-dsh-standalone —— 独立分发包说明

> 这份文件是**打包模板**。`tools/make-package.ps1` 会把它复制到包根目录,改名 `PACKAGE-README.md`。

---

## 包里有什么

| 目录 / 文件 | 说明 |
|---|---|
| `plugin/` | **插件本体**。`index.js` = DSH 宿主侧(9 个 `sv_*` 工具 + 常驻提示词);`sv/DSHBridge.lua` = SV2 侧(43 个 op);`sv/DSHPanel.js` = 侧栏面板 |
| `tools/` | **离线测试与校验**。`harness.mjs`(fengari 跑 Lua,41 条测试)· `check-lua.mjs` / `check-file.mjs`(守卫)· `analyze-audio.py` / `analyze-chords.py` / `import-musicxml.py` |
| `docs/` | `全参流程.md`(**调参标准作业程序**·必读)· `音频转音符.md` · `研究与方案.md` |
| `py-deps/` | Python 依赖(numpy / soundfile / cffi),让 `tools/*.py` 免安装即可跑 |
| `probe/` | 真机探针脚本 |
| `install-sv-scripts.ps1` | 把 SV2 侧脚本部署到宿主目录 |
| `README.md` | 完整技术说明(op 清单 · 宿主行为记录 · 踩坑) |

---

## 部署

```powershell
# 1. 部署 SV2 侧脚本
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-sv-scripts.ps1
#    → 复制到 %APPDATA%\Dreamtonics\Synthesizer V Studio 2\scripts\DSH\

# 2. 在 SV2 里启动桥
#    [脚本] > [重新扫描] → [脚本] > [DSH] > [DSH Bridge]
#    侧栏面板:[脚本] > [DSH] > [DSH Panel]

# 3. DSH 侧:把 plugin/ 装进 profile
#    ⚠️ index.js 改动需要**重启 DSH**(ESM 模块缓存);SV2 侧脚本只需重跑

# 4. 自检
cd tools
node harness.mjs                                # 41 条 Lua 行为测试
node check-lua.mjs ..\plugin\sv\DSHBridge.lua   # 语法 + 守卫
node check-plugin.mjs                           # 9 个工具定义
```

---

## 核心能力(43 个 op)

```
工程    group_ops list · track_ops · get_context · get_summary
音符    get_notes · get_selected_notes · get_layout · write_notes
        set_note_attrs · split_notes · delete_notes · transpose_selected
歌词    set_lyrics · apply_lyrics · align_lyrics · check_lyrics
布局    quantize(fail-closed,撞车整批不写)
音域    auto_tone_shift(按音高收窄,不是整曲移调)
表情    auto_expression(逐音符按旋律走向生成气声/张力/颤音)
曲线    get_automation · set_automation
声库    get_voice · set_voice · list_voice_presets · list_voices
音频    get_audio_tracks · align_audio
宿主    get_computed · transport · panel_ask · sv_say
```

**5 个 op 支持 `trackIndex` / `groupIndex`**(多轨工程必需 —— 脚本切不了"当前组"):

```
auto_tone_shift · set_automation · get_automation · get_voice · set_voice
```

---

## 动手前先读 `docs/全参流程.md`

八步流程 + 六条纪律。**每一条都是真机上踩过的坑**:

- 只看当前组就开工 ⇒ 漏掉 76% 的音符
- 唱法叠加总和 300+ ⇒ "大烟嗓"
- `io.popen` 列目录 ⇒ **把 SV2 冻住**

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 没有 `setCurrentGroup` | 官方 API 只有 getter ⇒ 只能用 `groupIndex` 定位 |
| `getVoice()` 只读显式值 | 继承来的唱法读不出来 ⇒ 请用户在面板点一下 |
| **没有保存接口** | 26 个类全查过 ⇒ 助手**没法**替你保存工程 |
| `io.popen` 已永久封锁 | 它冻过宿主 ⇒ 声库名只能问用户 |
| `pitchDelta` 不要碰 | 它是手画音高线,写它会覆盖转录的演唱 |
| `mouthOpening` 本机不支持 | 文档列了但宿主没有 —— **文档 ≠ 本机能力** |
