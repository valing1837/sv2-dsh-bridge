--[[
DSH ⇄ SV2 桥(常驻 Lua / 文件通道)  v0.1.0
================================================================================
在 Synthesizer V Studio 2 与 DeepSeek Harness 的插件之间搬东西。

  DSH 插件 ──写 req──►  <dir>\svdsh-req-sv.json
  桥(本文件) 轮询 ──► 执行 op ──► 原子写 res ──► DSH 插件
  桥 每 5s 写心跳 svdsh-hb-sv.json(存活 + 宿主版本 + 能力清单 + 实际目录)
  SV2 面板 ──project scriptData──► 桥 ──追加──► svdsh-chat-in.jsonl ──► DSH
  DSH ──写 svdsh-chat-out.json──► 桥 ──scriptData──► 面板显示

为什么是这个形状(全部是实测结论,不是设计偏好):
  · 官方脚本 API **没有任何文件/网络能力**;只有 Lua 绑定有 io/os。
  · Lua 没有 socket、**不能列目录、不能 mkdir** ⇒ 固定文件名 + 轮询,
    目录由 DSH 插件预先创建,桥只挑「已存在且可写」的。
  · **面板脚本(连 Lua 面板)连 io.open 都返回 nil** ⇒ 面板只能走 project scriptData。
  · SidePanelSection 用 getSidePanelSectionState() 取代 main() ⇒ 桥与面板必须是两个脚本。

三条铁律(违反的代价是弹模态框冻住宿主,或静默出错):
  1. **绝不试探**。Lua 绑定的错误**穿透 pcall**、直接弹模态脚本错误框并冻住主线程,
     `getTrack(0)` 这种"试一下"就弹过框。成员存在性只读字段判断,不调用。
  2. **一律冒号调用**。点调用会把对象自己当第 1 个实参 ⇒ 弹框;而且"冒号合法返回 nil 时回退"
     会让**写操作执行两次**。
  3. **轮询与心跳共用同一条 setTimeout 链**。拆开后出现过「心跳照常跳、轮询已经死」的
     静默故障 —— 客户端以为桥活着,实际每笔都超时,而桥日志一行错误都没有。

⚠️ 常驻脚本**不会热更**:改了源码再点"运行"不会替换旧实例(实测)。
   改完必须先在宿主里跑一次本脚本的 `stop`(或关掉宿主)再重新运行。
   心跳里的 `bridge` 字段就是用来确认"跑的是哪一版"的。
================================================================================
]]

-- ⚠️ 改了桥就**必须**升这个版本号 —— 常驻脚本不会热更,用户在宿主里重跑一次之后,
--    只能靠这个数字(心跳/面板状态里的 `bridge`)确认跑的是哪一版。
--    0.7.0 = ① **面板直连 op**(白名单):`svdsh.panel.out` 里 `kind="op"` 的事件由桥
--               **直接执行**并把结果回给面板,不经过 DSH。调参滑条要"松手就生效",
--               绕一趟 DSH 既慢又会把聊天记录刷满。白名单只放"只读 + 改本组声音属性"
--               (`get_context`/`get_voice`/`set_voice`/`list_voice_presets`/`list_voices`),
--               其余一切仍走 DSH。整段包 pcall —— 面板直连也不能把宿主搞崩。
--            ② 新增 `list_voices` —— 列**用户实际拥有的声库名**。
--               ⚠️ 三条常规路全堵死:脚本 API 没有 Voice 类;本地 `databases\<uuid>\`
--               是安装 UUID、和 `databases\meta\` 的产品 ID 对不上(实测 20 个一个没命中);
--               名字还加密在 `m` 文件里。但 **`.svp` 是明文 JSON**,每组都有
--               `"database": {"name": "Yamine Renri", ...}` ⇒ 借 `io.popen` 跑一次 dir
--               扫工程文件,拿到的就是 SV2 自己用的准确名字(还带语种)。
--    0.6.9 = 修 `set_meter {clearOthers}` —— 第一版用了 `getMeasureMarkAtBlick` 反查小节号,
--            而**这台宿主上没有这个方法** ⇒ `removedOthers` 恒为 0、一个标都没删掉(真机实测)。
--            改成按**小节号**逐个查 `getMeasureMarkAt(m)`,位置 > 0 的就按号删;
--            计数以"删前删后的标记条数差"为准(`removeMeasureMark` 对不存在的标是空操作,
--            自己数循环次数会虚高)。
--    0.6.8 = **声库/风格**,走脚本 API 而不是改声库文件:
--            ① `get_voice` / `set_voice` —— 读写当前**组**的默认声音属性
--               (响度 / 张力 / 气声 / 性别 / 音区偏移 + 每个 vocal mode 的 pitch/timbre/pronunciation)。
--            ② `list_voice_presets` —— 读 SV2 自己的 `voice-presets.json`,列出"哪个声库有哪些预设";
--               `set_voice {preset="<声库名>/<预设名>"}` 直接套用。
--            ⚠️ 为什么不去做参考项目那套"声库风格移植":那是对**声库文件**做手术
--               (nofs 里的 32 个 float32 向量),只对 flat(非加密)版有效,而且是在改用户
--               装好的声库 —— 风险与许可都不明朗。`getVoice/setVoice` 能达到同样目的,
--               且**一个字都不碰声库文件**。
--            ⚠️ `set_voice` 实现成**读—改—写整个对象**:官方没说 setVoice 收不收局部对象,
--               写回残缺对象有可能把没提到的属性清掉。
--    0.6.7 = ① 新增 `apply_ornaments` —— **装饰音**六种(前倚音 / 后倚音 / 向上尖尖 /
--               波音 / 回音 / 音尾音阶行进),建在 split_notes 的同一套做法上。
--               **默认 dryRun**(与参考项目一致:先出计划)。新音符默认自动音高,`manual:true` 才设手动。
--               ⚠️ 参考项目还有"反向预备 / 滑音"两种,但只写 **SV1 专有**属性(tF0Offset 那一族),
--               SV2 上不存在 ⇒ **不提供**,免得写坏。
--               写后自动跑一次 get_layout 体检(理论上不会重叠,但查一遍)。
--            ② `set_meter` 新增 `clearOthers` —— 清掉除第 1 小节以外的所有拍号标。
--               工程里被塞进 5/4、3/4 之类的标会让小节线全乱,想恢复"一个拍号到底"就靠它。
--    0.6.6 = **修一个严重 bug**:`group_ops {action:"move"}` 删错了引用。
--            原来用 `src:getIndexInParent()`(src 是**轨**,拿到的是轨在工程里的下标)去调
--            `removeGroupReference` —— 而它要的是**引用在轨内的下标**。一个变量担了两个语义。
--            后果:被移动的组**同时挂在两条轨上**(重复发声),源轨上第 N 个引用被误删,
--            N 恰好是源轨的工程下标 ⇒ **常常把主组删掉,主组从编排里消失**。
--            而且任何合法 move 都中招(唯一碰巧正确的位置是轨 0 的第 1 个引用,那永远是主组,
--            主组禁止移动)。由离线测试台的实时探针抓到。
--            现在:轨下标只用于"源轨==目标轨"的比较,删引用用 `ref:getIndexInParent()`,
--            并加了一道**删前自检**(下标指向的目标必须确实是本组,否则中止且什么都不删)。
--    0.6.5 = 新增 `quantize` —— 把音符起点(可选时长)**吸附到网格**。
--            为什么高频:SV2 自带转录出来的起点是按音频算的,往往不齐,量化是最常见的清理动作。
--            ⚠️ 量化**可能造出重叠**(两个音被吸到同一网格点),而 SV2 同组内不允许重叠 ⇒
--            跟 write_notes 一样**先算完整批、检查重叠,有一处就整批不写**,并把冲突报出来。
--            支持 `strength`(0~1 量化强度)与 `dryRun`(只算不写)。
--    0.6.4 = 一批增强,全部来自参考项目的 42 个工具清单:
--            ① `set_note_attrs` 支持 **`attributes`**(SV2 2.1.1+ 的属性层)——
--               muted / evenSyllableDuration / dF0VbrMod / rTone / rIntonation / expValueX·Y /
--               phonesetOverride / **逐音素属性数组 phonemes**(leftOffset·position·activity·strength)。
--               逐音素属性是修"短音符的辅音吃掉前一个音符"的唯一手段。
--               ⚠️ 逐键白名单 + 类型/范围校验:参考项目在 SV1 上踩过 —— 键不存在时
--               `setAttributes` 会**直接弹模态错误框**,所以不认识的键一律拒。
--            ② `set_note_attrs` 支持 `musicalType`(sing/rap)与 `pitchAutoMode`。
--               ⚠️ **rapAccent 只对 rap 音符有效**,想用说唱声调标得先设 musicalType="rap"。
--            ③ 新增 `apply_lyrics` —— 歌词按音符顺序分配(CJK 按单字、拉丁按词,UTF-8 用 Lua 自带 utf8 库切)。
--            ④ 新增 `align_lyrics` —— 按 **LRC 时间戳**对位,支持 dry-run(apply=false 只算不写)。
--    0.6.3 = 新增 `get_layout`(组的布局体检,只读)。参考项目把它单列一个工具并写明
--            "重叠 = 违规,必须报给用户" —— **SV2 同组内音符重叠是违规的**,会导致发音异常。
--            `write_notes` 本来就有写前重叠检查(防自己写坏);`get_layout` 补的是另一半:
--            **体检别人建的组**(手画的、SV2 自带转录出来的)。
--    0.6.2 = 新增 `align_audio` 与 `get_audio_tracks` —— **音频对齐**。
--            链路:你把伴奏/干声扔进 SV2 → get_audio_tracks 看它在哪 → (SV2 之外用
--            analyze-audio.py 测出 BPM 与第一拍秒数) → align_audio 把音频挪到锚点、写速度标。
--            移植自参考项目的 OPS.align_audio,关键 API 是 `NoteGroupReference:isInstrumental()`
--            (这样才找得到音频轨)和 `TimeAxis:getBlickFromSeconds()`(秒→blick 必须走宿主换算,
--            不能自己乘,因为宿主才知道当前速度)。
--    0.6.1 = 为「SV2 自带转录 → 桥接管」这条链路补两块:
--            ① `track_ops list` 增加 `displayOrder` 与 `noteCount` —— 官方原文明确
--               "轨的显示顺序可以和存储下标不同,编曲视图永远按显示顺序排",所以找
--               "视觉上最上面那条轨"必须用 min(displayOrder);noteCount 用来回答
--               "转录前那条轨是不是空的"(SV2 的音频转音符会把结果落到最上面的轨)。
--            ② `group_ops` 新增 `move` —— 把组移到另一条轨。API **没有**调整轨序的能力
--               (Track 只有 getDisplayOrder,没有 setter;Project 没有 moveTrack),
--               所以"新建一条空轨放最上面"做不到;能达成同样效果的是**把最上面那条轨腾空**。
--               move 刻意**先挂新引用、成功后再删旧引用** —— 反序一旦 addGroupReference 失败,
--               这个组就从编排里彻底消失了。
--    0.6.0 = **安全修复:音符下标必须整数**。离线测试台报出:`select_notes {indices:[0.5]}` 与
--            `delete_notes {indices:[0.5]}` **都没被拒** —— 前者在 `clearAll()` 之后才失败
--            (用户的选区已被清空),后者报告 `removed:1` 但组里音符数没变(静默删错)。
--            非整数实参递给宿主绑定正是**会弹模态错误框**的那一类输入(框一弹宿主主线程就停)。
--            ⇒ 三个带下标的 op 全部补上 `ix ~= math.floor(ix)` 检查,而且**放在任何宿主调用之前**。
--            同时把 `select_notes` 的 `newUndoRecord` 挪到校验之后(被拒的请求不该往撤销栈塞空步)。
--    0.5.9 = `split_notes` 多拆时会拆错音符。真机实测:`addNote` 会**按 onset 把新音符插进组里**
--            (不是追加到末尾 —— 拆 6..8 的音符,尾段落在 index 9 而不是末尾),
--            所以拆完一个之后它后面所有下标都 +1;正序处理会让第二个拆分点打到隔壁音符上。
--            改成**倒序**处理(前面已处理的下标不受影响)。
--    0.5.8 = 拍号标记的位置读错。**两种标记的位置字段不同**,不能用一个统一顺序的 helper:
--            速度标记 → `position`(读 `positionBlick` 得 nil);
--            拍号标记 → `positionBlick`(读 `position`/`getPosition()` 得一个 ~1 blick 的垃圾值,
--            显示成 1.4e-9 拍)。现在按类型各给一个函数(参考项目对两种也正是分别用这两个字段)。
--            真机复现:set_meter 写成功后,get_tempo 读回的拍号位置是 2.8e-9 而不是 8 拍。
--    0.5.7 = 补两件高频但还缺的能力:① `get_note_attrs` —— 读音符的**完整属性**
--               (detune / phonemes / 语种覆盖 / 说唱重音 / 音乐类型 / 手动音高 + 原始 attributes 表),
--               agent 改之前得先知道哪些属性已经设过;② `split_notes` —— 在指定位置把音符拆成两个
--               (官方脚本 Utilities/SplitSelectedNotes 的同类能力),整批先校验再动手。
--    0.5.6 = ① 新增 `select_notes` —— **程序化设置选区**。没有它,set_note_attrs /
--               set_lyrics / transpose_selected 全都只能作用在"用户手点的选区"上,
--               agent 每做一步都得先求用户点一下(真机验证时发现的硬伤);
--            ② `track_ops add` 不再透传宿主返回值 —— 真机实测它是 1 起/计数(加完返回 2,
--               而新轨的 0 起下标是 1),现在一律报"最后一轨的 0 起下标"。
--    0.5.5 = 速度/拍号的两个**真机发现**的约定错误:
--            ① 速度标记的位置字段是 `position`,**不是** `positionBlick` —— 只读后者会拿到
--               nil 并当成 0,于是所有速度标记都显示在第 0 拍(真机复现)。现在先读 `position`。
--            ② `addMeasureMark` 的小节号是 **0 起**,而对外的 `measure` 是 1 起(和 DAW 界面一致)
--               —— 真机实测:传 measure=1 落在第 4 拍 @4/4。现在对外 1 起、内部 -1。
--    0.5.4 = get_computed(kind="phonemes") 在返回空数组时给出**可操作的诊断** ——
--            空音素最常见的不是"没算完",而是"语种与声库不兼容"(参考项目 SV-006):
--            宿主算不出音素 ⇒ 整组不渲染,而且不报错。现在把判断依据(逐音符的语种覆盖 +
--            歌词)一起返回,并说明这是 SV 的设计如此。**不动用户的语种**(那是用户的决定)。
--    0.5.3 = ① group_ops offset 改成"先校验再建撤销点"(被拒的请求不该往用户撤销栈里塞空步,
--            离线测试的实时探针抓到);② write_notes 复制当前组的时间偏移,让新组落在
--            用户正在看的位置(参考项目的 create_harmony_group 同做法),可用 timeOffsetQuarter 覆盖。
--    0.5.2 = 五处正确性修复(全部由离线测试或自查发现,还没上过真机):
--            ① set_automation 的闭合点移到形状**外沿** —— 原来首尾同位置,只给一个点时
--               会被用户的点覆盖 ⇒ 等于没闭合,正好是参考项目警告的"一个点让整组变那个值";
--            ② set_automation 改成**先校验后碰宿主** —— 值越界不该先去调 getParameter
--               (参数对象正是崩溃清单里那一类);
--            ③ group_ops 的 clone 改成参考项目验证过的三步顺序(先入组库 → 建引用 → 挂轨);
--            ④ 音素**不再限制字符集**(自编白名单会拒掉合法的 X-SAMPA 记号),
--               改成"写进去 → 回读比对 → 不一致如实报",与参考项目同策略;
--            ⑤ 语种码格式收紧(zh-cn 这种),因为它有明确格式。
--    0.5.1 = track_ops 加 mixer/setMixer(音量/声像/静音/独奏)。
--    0.5.0 = 第三批 op:get_tempo / set_tempo / set_meter / transport /
--            group_ops / track_ops;set_note_attrs 扩到 phonemes/language/rapAccent/detune。
--    0.4.0 = 第二批 op:get_notes / get_pit / write_pit / clear_pit /
--            get_automation / set_automation / delete_notes / get_computed。
--    0.3.0 = 新增 write_notes(在新组里创建音符 + 歌词,三步挂轨)。
--    0.2.0 = 面板改内存态 + 换工程自动清空 + 去掉周期性写工程数据。
local BRIDGE_VERSION = "0.7.0"
local PROTOCOL = 1

local CFG = {
  -- ⚠️ HB_MS 必须是 POLL_MS 的整数倍:心跳是插在同一条轮询链上的
  --    (every = HB_MS / POLL_MS 拍写一次)。取 5000/300 会让实际间隔变成 4800ms。
  POLL_MS   = 250,      -- 请求轮询间隔
  HB_MS     = 5000,     -- 心跳间隔 = 20 拍
  MAX_DONE  = 64,       -- 响应缓存条数(id 去重)
  LOG_MAX   = 65536,    -- 日志文件上限(超过就重建)
  CHAT_MAX  = 262144,   -- 人话通道文件上限
  RELAY_EVERY = 2,      -- 面板中继隔几拍跑一次
}

-- ============================================================================
-- 0. 状态
-- ============================================================================

local ST = {
  dir = nil, host = "sv", hostName = "?", hostVer = "?", hostVerNum = 0,
  isSV2 = false, indexBase = 1, lua = _VERSION, session = 0,
  timerWhere = nil, timerFn = nil,
  ticks = 0, reqSeen = 0, opsRun = 0, pollErrors = 0,
  done = {}, order = {},
  lastId = nil,
  lastChatOutRev = nil,
  projFp = nil,            -- 启动时看到的工程指纹(用于检测换工程)
  projIdentityOk = false,  -- 指纹判据是否可用(见 projectFingerprintReliable)
}

local PATH = {}

local function buildPaths(dir)
  local function p(name) return dir .. "\\" .. name end
  -- ⚠️ 逐字段赋值,不要 `PATH = { ... }` 重新绑定:测试钩子按引用持有这张表,
  --    重新绑定会让它永远看到空表(离线测试台实测过)。
  PATH.dir        = dir
  PATH.req        = p("svdsh-req-sv.json")
  PATH.res        = p("svdsh-res-sv.json")
  PATH.hb         = p("svdsh-hb-sv.json")
  PATH.boot       = p("svdsh-boot-sv.json")
  PATH.log        = p("svdsh-log-sv.txt")
  PATH.chatIn     = p("svdsh-chat-in.jsonl")
  PATH.chatOut    = p("svdsh-chat-out.json")
end

-- ============================================================================
-- 1. JSON(自己写:Lua 标准库没有)
--    ⚠️ 大整数必须走 %d / %.0f:用 %.14g 会把 16 位 id 写成科学计数法丢末位,
--       对端按字符串/数字匹配就**永远匹配不上**,而两侧日志看起来都正常。
-- ============================================================================

local function jenc(v)
  local tv = type(v)
  if v == nil then return "null" end
  if tv == "boolean" then return v and "true" or "false" end
  if tv == "number" then
    if math.type and math.type(v) == "integer" then return string.format("%d", v) end
    if v == math.floor(v) and math.abs(v) < 9007199254740992 then
      return string.format("%.0f", v)
    end
    -- 非整数:%.6g 只有 6 位有效数字,会把 blick→拍 的换算值截掉一截。
    -- 10 位足够表示这些报告字段,又不会像 %.17g 那样漏出二进制浮点的尾巴。
    return string.format("%.10g", v)
  end
  if tv == "string" then
    local s = v:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n")
    s = s:gsub("\r", "\\r"):gsub("\t", "\\t")
    s = s:gsub("([%z\1-\31])", function(c) return string.format("\\u%04x", c:byte()) end)
    return '"' .. s .. '"'
  end
  if tv == "table" then
    local count, isArray = 0, true
    for k in pairs(v) do
      count = count + 1
      if type(k) ~= "number" then isArray = false end
    end
    local parts = {}
    if isArray and count == #v then
      for i = 1, #v do parts[i] = jenc(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, val in pairs(v) do
      parts[#parts + 1] = jenc(tostring(k)) .. ":" .. jenc(val)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return jenc(tostring(v))
end

local jdec

do
  local pos, src

  local function skip()
    while true do
      local c = src:sub(pos, pos)
      if c == " " or c == "\t" or c == "\n" or c == "\r" then pos = pos + 1 else break end
    end
  end

  local parseValue

  local function parseString()
    pos = pos + 1
    local out = {}
    while true do
      local c = src:sub(pos, pos)
      if c == "" then error("unterminated string") end
      if c == '"' then pos = pos + 1 break end
      if c == "\\" then
        local e = src:sub(pos + 1, pos + 1)
        if e == "n" then out[#out + 1] = "\n"; pos = pos + 2
        elseif e == "t" then out[#out + 1] = "\t"; pos = pos + 2
        elseif e == "r" then out[#out + 1] = "\r"; pos = pos + 2
        elseif e == "b" then out[#out + 1] = "\b"; pos = pos + 2
        elseif e == "f" then out[#out + 1] = "\f"; pos = pos + 2
        elseif e == '"' then out[#out + 1] = '"'; pos = pos + 2
        elseif e == "\\" then out[#out + 1] = "\\"; pos = pos + 2
        elseif e == "/" then out[#out + 1] = "/"; pos = pos + 2
        elseif e == "u" then
          local hex = src:sub(pos + 2, pos + 5)
          local n = tonumber(hex, 16)
          if n == nil then error("bad \\u escape") end
          -- BMP 之内用 utf8.char(Lua 5.3+);代理对极少见,遇到就落个占位
          if n >= 0xD800 and n <= 0xDFFF then
            out[#out + 1] = "?"
          elseif utf8 and utf8.char then
            out[#out + 1] = utf8.char(n)
          else
            out[#out + 1] = string.char(n % 256)
          end
          pos = pos + 6
        else
          error("bad escape: \\" .. tostring(e))
        end
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
    return table.concat(out)
  end

  local function parseNumber()
    local s = pos
    while true do
      local c = src:sub(pos, pos)
      if c:match("[%d%.eE%+%-]") then pos = pos + 1 else break end
    end
    local n = tonumber(src:sub(s, pos - 1))
    if n == nil then error("bad number at " .. tostring(s)) end
    return n
  end

  local function parseArray()
    pos = pos + 1
    local arr = {}
    skip()
    if src:sub(pos, pos) == "]" then pos = pos + 1 return arr end
    while true do
      arr[#arr + 1] = parseValue()
      skip()
      local c = src:sub(pos, pos)
      if c == "," then pos = pos + 1 skip()
      elseif c == "]" then pos = pos + 1 break
      else error("expected , or ] in array") end
    end
    return arr
  end

  local function parseObject()
    pos = pos + 1
    local obj = {}
    skip()
    if src:sub(pos, pos) == "}" then pos = pos + 1 return obj end
    while true do
      skip()
      if src:sub(pos, pos) ~= '"' then error("expected string key") end
      local key = parseString()
      skip()
      if src:sub(pos, pos) ~= ":" then error("expected :") end
      pos = pos + 1
      obj[key] = parseValue()
      skip()
      local c = src:sub(pos, pos)
      if c == "," then pos = pos + 1
      elseif c == "}" then pos = pos + 1 break
      else error("expected , or } in object") end
    end
    return obj
  end

  parseValue = function()
    skip()
    local c = src:sub(pos, pos)
    if c == "{" then return parseObject() end
    if c == "[" then return parseArray() end
    if c == '"' then return parseString() end
    if c == "t" then pos = pos + 4 return true end
    if c == "f" then pos = pos + 5 return false end
    if c == "n" then pos = pos + 4 return nil end
    return parseNumber()
  end

  jdec = function(text)
    src, pos = text, 1
    local v = parseValue()
    return v
  end
end

-- ============================================================================
-- 2. 文件(全部走 pcall:桥里任何未捕获的错误都会弹框)
-- ============================================================================

local function readFile(path)
  if path == nil then return nil end
  local f = io.open(path, "r")
  if not f then return nil end
  local s = f:read("*a")
  f:close()
  return s
end

local function writeFile(path, s)
  local f = io.open(path, "w")
  if not f then return false end
  f:write(s)
  f:close()
  return true
end

-- 原子替换:先写 .tmp 再改名。
-- ⚠️ Windows 上 C 的 rename 在**目标已存在**时会失败(Node 的 rename 不会) ⇒ 必须先删目标。
local function writeAtomic(path, s)
  local tmp = path .. ".tmp"
  if not writeFile(tmp, s) then return false end
  if os.rename and os.rename(tmp, path) then return true end
  pcall(function() os.remove(path) end)
  if os.rename and os.rename(tmp, path) then return true end
  pcall(function() os.remove(tmp) end)
  return writeFile(path, s)
end

-- 追加:先试 "a"(快);不行就整文件重写
local function appendLine(path, line, cap)
  local f = io.open(path, "a")
  if f then
    f:write(line .. "\n")
    f:close()
    local size = 0
    local g = io.open(path, "r")
    if g then
      local all = g:read("*a")
      g:close()
      size = #all
    end
    if size > cap then
      -- 超过上限就只留最后一半,避免无限增长
      local g2 = io.open(path, "r")
      if g2 then
        local all = g2:read("*a")
        g2:close()
        writeFile(path, all:sub(math.floor(#all / 2)))
      end
    end
    return true
  end
  return false
end

local function log(msg)
  if PATH.log == nil then return end
  pcall(function()
    local line = os.date("%H:%M:%S") .. "  " .. tostring(msg)
    local cur = readFile(PATH.log)
    if cur ~= nil and #cur > CFG.LOG_MAX then cur = "" end
    writeFile(PATH.log, (cur or "") .. line .. "\n")
  end)
end

-- 目录发现:与 DSH 插件**同一套顺序**。Lua 不能 mkdir,所以只挑"已存在且可写"的。
-- 顺序:① %USERPROFILE%\.dsh\sv-bridge(插件建) ② %TEMP%\dsh-sv-bridge(插件建)
local function pickDir()
  local cands = {}
  local up = os.getenv and os.getenv("USERPROFILE")
  if up and #up > 0 then cands[#cands + 1] = up .. "\\.dsh\\sv-bridge" end
  local tp = os.getenv and (os.getenv("TEMP") or os.getenv("TMP"))
  if tp and #tp > 0 then cands[#cands + 1] = tp .. "\\dsh-sv-bridge" end
  for _, d in ipairs(cands) do
    local probe = d .. "\\svdsh-wtest.tmp"
    local f = io.open(probe, "w")
    if f then
      f:close()
      pcall(function() os.remove(probe) end)
      return d
    end
  end
  return nil
end

-- ============================================================================
-- 3. SV API 小工具(全部 pcall 保护,绝不试探)
-- ============================================================================

local function has(obj, name)
  if obj == nil then return false end
  local ok, t = pcall(function() return obj[name] end)
  if not ok then return false end
  -- ⚠️ SV 的 Lua 绑定把**所有可调用成员暴露成 userdata**(靠 __call),不是 function。
  --    只认 function 会让 has() 对每一个 SV 函数都返回 false。
  return type(t) == "function" or type(t) == "userdata"
end

-- ⚠️ 必须声明在 call() 之前:否则 call() 里的 unpack 会解析成全局(5.4 里是 nil),
--    每次调用都会静默失败。
local unpack = table.unpack or unpack

-- 对象方法一律**冒号**调用(显式传 self);不做点调用回退。
local function call(obj, name, ...)
  if not has(obj, name) then return nil end
  local args = { ... }
  local ok, res = pcall(function()
    return obj[name](obj, unpack(args))
  end)
  if not ok then return nil end
  return res
end

local function SC(name, ...)
  return call(SV, name, ...)
end

local function project() return SC("getProject") end
local function editor() return SC("getMainEditor") end

local function num(v)
  if type(v) == "number" then return v end
  return tonumber(v)
end

-- 当前组(NoteGroupReference)与目标 NoteGroup
local function currentGroup()
  local ed = editor()
  if ed == nil then return nil, nil end
  local ref = call(ed, "getCurrentGroup")
  if ref == nil then return nil, nil end
  return ref, call(ref, "getTarget")
end

-- 按**位置**解析一个组(而不是依赖"当前组")。
--
-- ⚠️ 为什么必须有它:官方 API 里 `MainEditorView` **只有 `getCurrentGroup()`,没有
--    `setCurrentGroup()`** —— 脚本**无法程序化切换当前组**。而 SV2 自带的「音频转音符」
--    会把结果盖到**最上面的音轨**上,那个组不一定是"当前组" ⇒ 不按位置定位就读不到它。
--    绕法:Project → Track → GroupReference → Target。
--
-- 返回 ref, grp;若该引用指向的是**外部音频**(instrumental),grp 为 nil。
local function groupAt(trackIndex, groupIndex)
  local proj = project()
  if proj == nil then error("no project") end
  local ti = tonumber(trackIndex)
  local gi = tonumber(groupIndex)
  if ti == nil or gi == nil then error("trackIndex / groupIndex 都是必需的(0 起)") end
  if ti ~= math.floor(ti) or gi ~= math.floor(gi) then
    error("trackIndex / groupIndex 必须是整数")
  end
  local track = call(proj, "getTrack", ti + 1)
  if track == nil then error("track " .. ti .. " 不存在") end
  local n = num(call(track, "getNumGroups")) or 0
  if gi < 0 or gi >= n then
    error("groupIndex " .. gi .. " 越界(轨 " .. ti .. " 上共 " .. n .. " 个组)")
  end
  local ref = call(track, "getGroupReference", gi + 1)
  if ref == nil then error("Track:getGroupReference(" .. (gi + 1) .. ") 返回 nil") end
  local grp = call(ref, "getTarget")
  if grp == nil then
    error("轨 " .. ti .. " 的第 " .. gi .. " 个组指向的是**外部音频**(instrumental),没有可编辑的音符")
  end
  return ref, grp
end

-- 给支持"按位置定位"的 op 用:给了 trackIndex+groupIndex 就按位置取,否则退回当前组。
local function resolveGroup(args)
  if args ~= nil and (args.trackIndex ~= nil or args.groupIndex ~= nil) then
    return groupAt(args.trackIndex, args.groupIndex)
  end
  return currentGroup()
end

-- ⚠️ 本机 SV2 上 `getSelectedNotes()` 的返回值**不是数组**(`#` 恒 0)。
--    只看 `#` 会把"选了 14 个音"误判成"没选中",调用方随即退化成整个组 —— 曾因此在
--    462 音的真轨上把整条当目标。⇒ 条数必须回落到 `getNumSelectedNotes()`。
local function selectedNotes()
  local ed = editor()
  if ed == nil then return {} end
  local sel = call(ed, "getSelection")
  if sel == nil then return {} end
  local arr = call(sel, "getSelectedNotes")
  if arr == nil then return {} end
  local n = 0
  local okLen, len = pcall(function() return #arr end)
  if okLen and type(len) == "number" then n = len end
  if n == 0 then
    local cnt = num(call(sel, "getNumSelectedNotes"))
    if cnt ~= nil then n = cnt end
  end
  local out = {}
  for i = 1, n do
    local note = arr[i]
    if note ~= nil then out[#out + 1] = note end
  end
  return out
end

-- ============================================================================
-- 4. 指纹(参考项目点名缺失的那一环:防"写错对象")
-- ============================================================================

-- 无位运算的多项式散列(djb2),避免依赖 Lua 5.3+ 的位运算符
local function hash32(s)
  local h = 5381
  for i = 1, #s do
    h = (h * 33 + s:byte(i)) % 4294967296
  end
  return string.format("%08x", h)
end

-- 单个音符的指纹:组 UUID + 组内下标 + onset/dur/pitch/lyrics
local function noteFp(note)
  local onset = math.floor(num(call(note, "getOnset")) or -1)
  local dur = math.floor(num(call(note, "getDuration")) or -1)
  local pitch = math.floor(num(call(note, "getPitch")) or -1)
  local idx = math.floor(num(call(note, "getIndexInParent")) or -1)
  local lyrics = call(note, "getLyrics") or ""
  local grp = call(note, "getParent")
  local uuid = (grp ~= nil and call(grp, "getUUID")) or "?"
  return string.format("%s:%d:%d:%d:%d:%s", tostring(uuid), idx, onset, dur, pitch, tostring(lyrics))
end

-- 整个选区的指纹:条数 + 每个音符的指纹
local function selectionFp(notes)
  local parts = { "n=" .. tostring(#notes) }
  for i = 1, #notes do parts[#parts + 1] = noteFp(notes[i]) end
  return hash32(table.concat(parts, "|"))
end

-- 整个**组**的指纹(不只是选区)。给 get_notes / delete_notes 用:
-- 删音符前必须先确认"我读到的还是不是现在这个组"。
local function groupFingerprint(grp)
  if grp == nil then return nil end
  local n = num(call(grp, "getNumNotes")) or 0
  local parts = { "g=" .. tostring(call(grp, "getUUID") or "?"), "n=" .. tostring(n) }
  for i = 1, n do
    local nt = call(grp, "getNote", i)
    if nt ~= nil then parts[#parts + 1] = noteFp(nt) end
  end
  return hash32(table.concat(parts, "|"))
end

-- ============================================================================
-- 5. op 实现
-- ============================================================================

local OPS = {}
local OP_NAMES = {}

local function blickToQuarter(b)
  local q = tonumber(SV and SV.QUARTER) or 705600000
  if q == 0 then return 0 end
  return b / q
end

-- 属性/方法**兼容读取**。
-- SV 的 JS 绑定里 `mark.positionBlick` 是属性,但 Lua 绑定到底暴露成
-- `mark:getPositionBlick()` 还是 `mark.positionBlick` 字段,**两种都可能**(各宿主版本不同)。
-- ⇒ 先按 getter 取(`call` 内部先 has() 判断,不会误调不存在的成员),取不到再读字段。
-- 两种都**只读**,而且都走守卫 —— 这就是"不做试错式探测"与"兼容两种暴露方式"的折中。
local function prop(obj, name)
  if obj == nil then return nil end
  local getter = "get" .. string.upper(string.sub(name, 1, 1)) .. string.sub(name, 2)
  local v = call(obj, getter)
  if v ~= nil then return v end
  local ok, f = pcall(function() return obj[name] end)
  if ok then return f end
  return nil
end

local function noteInfo(note)
  return {
    index = num(call(note, "getIndexInParent")),
    onset = num(call(note, "getOnset")),
    duration = num(call(note, "getDuration")),
    endBlick = num(call(note, "getEnd")),
    pitch = num(call(note, "getPitch")),
    lyrics = call(note, "getLyrics"),
    fp = noteFp(note),
  }
end

-- ⛔⛔ **2026-10-02 事故:绝不在宿主回调里起子进程。**
--
-- 事故经过:`get_group_voice` / `list_voices` 里用 `io.popen` 跑 `dir` 列目录。
-- 桥的 op 是在宿主的**定时器回调**里执行的 —— **系统调用会阻塞 UI 线程**,
-- 结果把 SV2 整个冻住(用户原话:"怎么把我 sv2 干挂了")。
--
-- 参考项目的警告是"绑定错误会冻宿主",而**起子进程更狠**:绑定错误最多弹框,
-- 子进程会**无限期阻塞**。
--
-- ⇒ 纪律:**宿主回调里只做纯计算和 API 调用。绝不做 IO / 进程操作。**
--    需要文件信息就:① 用 io.open 读已知路径(打不开就如实报错);
--                  ② 或者**问用户**(panel_ask)。
--
-- 这个桩把所有 popen 调用点变成"立刻报错",宁可功能不可用,也不能再冻宿主。
local function POPEN_BLOCKED(...)
  error("io.popen 已被永久停用:起子进程会阻塞宿主 UI 线程,实测把 SV2 冻住。" ..
        "需要文件信息请改用 io.open(已知路径)或 panel_ask(问用户)。")
end

-- ---- ping ----------------------------------------------------------------
function OPS.ping()
  -- 诊断:工程里还剩哪些本插件的 scriptData 键。
  -- 存在的意义是让「面板不往 .svp 里留东西」这条**可被验证**,而不是只能嘴上保证。
  -- 正常情况下这个数组必须是空的。
  local leftover = {}
  local proj = project()
  if proj ~= nil and has(proj, "getScriptDataKeys") then
    local keys = call(proj, "getScriptDataKeys")
    if type(keys) == "table" then
      local n = 0
      local okLen, len = pcall(function() return #keys end)
      if okLen and type(len) == "number" then n = len end
      for i = 1, n do
        local k = keys[i]
        if type(k) == "string" and k:sub(1, 6) == "svdsh." then
          leftover[#leftover + 1] = k
        end
      end
    end
  end

  return {
    pong = true,
    bridge = BRIDGE_VERSION,
    protocol = PROTOCOL,
    host = ST.host,
    hostName = ST.hostName,
    hostVersion = ST.hostVer,
    isSV2 = ST.isSV2,
    indexBase = ST.indexBase,
    dir = ST.dir,
    lua = ST.lua,
    -- 空数组 = 工程里没有任何本插件残留(期望值)
    leftoverScriptDataKeys = leftover,
    -- 换工程检测是否可用(指纹自检结果)+ 当前指纹(换工程后应当变化)
    projectIdentityOk = ST.projIdentityOk,
    projectFingerprint = ST.projFp,
    ts = os.time(),
  }
end

-- ---- get_context ---------------------------------------------------------
function OPS.get_context()
  local proj = project()
  local ed = editor()
  local ref, grp = currentGroup()
  local track = ed and call(ed, "getCurrentTrack") or nil
  local sel = ed and call(ed, "getSelection") or nil
  local notes = selectedNotes()

  local ctx = {
    fileName = proj and call(proj, "getFileName") or nil,
    numTracks = proj and num(call(proj, "getNumTracks")) or nil,
    projectDurationBlick = proj and num(call(proj, "getDuration")) or nil,
    trackIndex = track and num(call(track, "getIndexInParent")) or nil,
    trackName = track and call(track, "getName") or nil,
    groupIndex = ref and num(call(ref, "getIndexInParent")) or nil,
    groupName = grp and call(grp, "getName") or nil,
    groupIsMain = ref and call(ref, "isMain") or nil,
    groupNumNotes = grp and num(call(grp, "getNumNotes")) or nil,
    selectionCount = #notes,
    hasSelectedNotes = sel and call(sel, "hasSelectedNotes") or nil,
  }

  if proj then
    local ta = call(proj, "getTimeAxis")
    if ta then
      local marks = call(ta, "getAllTempoMarks")
      if type(marks) == "table" and #marks > 0 then
        ctx.tempoCount = #marks
        ctx.tempoBpm = num(marks[1].bpm)
      end
    end
  end
  return ctx
end

-- ---- get_selected_notes --------------------------------------------------
-- 返回 { count, fp, notes = [...] }。fp 是**写操作的通行证**:
-- 写之前把 fp 原样带回来,桥会重新算一遍;不一致说明用户在宿主里动过 ⇒ 拒绝。
function OPS.get_selected_notes(args)
  args = args or {}
  local limit = tonumber(args.limit) or 512
  local notes = selectedNotes()
  local out = {}
  local truncated = false
  for i = 1, #notes do
    if i > limit then truncated = true break end
    local info = noteInfo(notes[i])
    info.onsetQuarter = blickToQuarter(info.onset or 0)
    info.durationQuarter = blickToQuarter(info.duration or 0)
    out[i] = info
  end
  return {
    count = #notes,
    returned = #out,
    truncated = truncated,
    fp = selectionFp(notes),
    notes = out,
  }
end

-- ---- 写操作共用:校验指纹 ------------------------------------------------
local function requireFreshSelection(args, notes)
  local expect = args and args.expectFp
  if type(expect) ~= "string" or #expect == 0 then
    error("expectFp is required: read with get_selected_notes first, then pass its fp back unchanged")
  end
  local now = selectionFp(notes)
  if now ~= expect then
    error("STALE_SELECTION: selection changed since it was read (expected " .. expect ..
          ", actual " .. now .. "). Re-read with get_selected_notes and retry.")
  end
  return now
end

-- ---- transpose_selected --------------------------------------------------
function OPS.transpose_selected(args)
  args = args or {}
  local semitones = tonumber(args.semitones)
  if semitones == nil then error("args.semitones must be a number") end
  if semitones ~= math.floor(semitones) then error("args.semitones must be an integer") end
  if math.abs(semitones) > 48 then error("args.semitones out of range (-48..48)") end

  local notes = selectedNotes()
  if #notes == 0 then error("no notes selected") end
  requireFreshSelection(args, notes)

  local proj = project()
  if proj == nil then error("no project") end
  call(proj, "newUndoRecord")   -- ⚠️ 无参

  local changed, skipped = 0, 0
  local after = {}
  for i = 1, #notes do
    local p = num(call(notes[i], "getPitch"))
    if p == nil then
      skipped = skipped + 1
    else
      local np = p + semitones
      if np < 0 or np > 127 then
        skipped = skipped + 1
      else
        call(notes[i], "setPitch", np)
        changed = changed + 1
      end
    end
  end
  -- 写后回读:只有回读才算数
  local reread = selectedNotes()
  return {
    changed = changed,
    skipped = skipped,
    semitones = semitones,
    readBackCount = #reread,
    readBackFp = selectionFp(reread),
    readBackPitches = (function()
      local t = {}
      for i = 1, math.min(#reread, 64) do t[i] = num(call(reread[i], "getPitch")) end
      return t
    end)(),
  }
end

-- ---- set_lyrics ----------------------------------------------------------
-- 两种用法:整段同一个字(args.lyrics),或逐个对应(args.lyricsList)
function OPS.set_lyrics(args)
  args = args or {}
  local notes = selectedNotes()
  if #notes == 0 then error("no notes selected") end
  requireFreshSelection(args, notes)

  local list = args.lyricsList
  local single = args.lyrics
  if type(list) ~= "table" and type(single) ~= "string" then
    error("provide args.lyrics (one string for all) or args.lyricsList (one per selected note)")
  end
  if type(list) == "table" and #list ~= #notes then
    error(string.format("args.lyricsList has %d entries but %d notes are selected", #list, #notes))
  end

  local proj = project()
  if proj == nil then error("no project") end
  call(proj, "newUndoRecord")

  local changed = 0
  for i = 1, #notes do
    local text = (type(list) == "table") and list[i] or single
    text = tostring(text)
    call(notes[i], "setLyrics", text)
    changed = changed + 1
  end

  local reread = selectedNotes()
  local back = {}
  for i = 1, math.min(#reread, 64) do back[i] = call(reread[i], "getLyrics") end
  return {
    changed = changed,
    readBackCount = #reread,
    readBackFp = selectionFp(reread),
    readBackLyrics = back,
  }
end

-- ---- set_note_attrs ------------------------------------------------------
-- 只允许白名单里的字段;越界/非法一律**在写之前**拒绝(写坏量纲会让宿主闪退)。
-- ⚠️ 整数检查不是洁癖:SV 绑定对非整数实参的反应未知,而**绑定在实参转换阶段抛的错
--    穿透 pcall、直接弹模态框冻住宿主** —— 越界能挡住、非整数挡不住就白挡了。
--    数值字段**默认要求整数**(要小数得显式写 integer = false),免得将来加字段时
--    忘了这个标志就静默退回旧行为。
local ATTR_WHITELIST = {
  pitch = { min = 0, max = 127, setter = "setPitch" },
  duration = { min = 1, max = 705600000 * 64, setter = "setDuration" },
  lyrics = { text = true, setter = "setLyrics" },
  -- 音素(SV2 2.1.1+)。⚠️ **不限制字符集,只限长度** ——
  --    SV 的音素是 X-SAMPA 类记号(含 @ ! { } ~ | 等),自己编白名单只会把合法音素拒掉。
  --    参考项目的做法是"写进去 → **回读比对** → 不一致就如实报'宿主可能不接受该音素串'",
  --    我们的 set_note_attrs 本来就回读,所以靠回读兜底即可。
  phonemes = { text = true, maxLen = 256, setter = "setPhonemes" },
  -- 语种覆盖。语种码格式是**明确的**(zh-cn / en / ja …),所以这里可以收紧。
  -- ⚠️ 改语种会让这个音符的**全部音素重算** —— 想只改一个音素又跨语种时,
  --    应当先把该音符拆成两个(参考项目的提醒)。
  language = { text = true, maxLen = 32, pattern = "^[%a][%a%d_%-]*$", setter = "setLanguageOverride" },
  -- 说唱重音:五个声调 1 阴平 · 2 阳平 · 3 上声 · 4 去声 · 5 轻声。
  -- ⚠️ 值类型是**字符串**("1".."5"),不是数字 —— 参考项目用户实测订正过。
  rapAccent = { text = true, oneOf = { "1", "2", "3", "4", "5" }, setter = "setRapAccent" },
  -- 音高微调(音分)
  detune = { min = -1200, max = 1200, integer = false, setter = "setDetune" },
  -- 演唱类型:sing(唱) / rap(说唱)。
  -- ⚠️ **rapAccent 只对 rap 音符有效** —— 想用说唱声调标,得先把音符设成 rap。
  musicalType = { text = true, oneOf = { "sing", "rap" }, setter = "setMusicalType" },
  -- 音高自动模式(true = 让宿主自己算音高,false = 手动音高)
  pitchAutoMode = { bool = true, setter = "setPitchAutoMode" },
}
local ATTR_NAMES = (function()
  local names = {}
  for k in pairs(ATTR_WHITELIST) do names[#names + 1] = k end
  table.sort(names)
  return table.concat(names, ", ")
end)()

-- ---- Note:setAttributes 的属性白名单(SV2 2.1.1+) -------------------------
-- 官方 Note#getAttributes 的属性表里,**除了音高/时长/歌词**,还有一层"属性"。
-- 其中最有价值的是 `phonemes`:**逐音素**的 leftOffset / position / activity / strength,
-- 修"短音符的辅音吃掉前一个音符"靠的就是把 leftOffset 往 0 收。
--
-- ⚠️ 为什么必须白名单:参考项目在 SV1 上踩过 —— 键不存在时 `setAttributes` 会
--    **直接弹模态错误框**("setAttributes: 无效的输入类型。"),框一弹宿主主线程就停。
--    所以这里逐键校验类型与范围,不认识的键一律拒。
-- ⚠️ 数值键的"默认值"是 NaN —— 只写给定的键即可(官方说明:不必给全,只更新给到的)。
local ATTRIBUTE_WHITELIST = {
  -- 布尔
  muted                = { kind = "bool" },
  evenSyllableDuration = { kind = "bool" },
  -- 数值(范围按官方示例与直觉保守取;取窄了最多是误拒,取宽了才可能弹框)
  dF0VbrMod  = { kind = "num", min = -100, max = 100 },
  rTone      = { kind = "num", min = -100, max = 100 },
  rIntonation= { kind = "num", min = -100, max = 100 },
  expValueX  = { kind = "num", min = -100, max = 100 },
  expValueY  = { kind = "num", min = -100, max = 100 },
  -- 字符串
  phonesetOverride = { kind = "str", maxLen = 64, pattern = "^[%a%d_%-]*$" },
  -- 逐音素属性数组(整数组替换语义)。每项只允许这四个键。
  phonemes = { kind = "phonemeArray" },
}
local PHONEME_ITEM_WHITELIST = {
  leftOffset = { min = -2, max = 2 },      -- 秒;0 = 提前量归零(⚠️ 辅音会消失)
  position   = { min = 0, max = 1 },
  activity   = { min = 0, max = 1 },
  strength   = { min = 0, max = 1 },
}
local ATTRIBUTE_NAMES = (function()
  local names = {}
  for k in pairs(ATTRIBUTE_WHITELIST) do names[#names + 1] = k end
  table.sort(names)
  return table.concat(names, ", ")
end)()

-- 校验并构造一个**干净的**属性表(只含白名单键)。任何一项非法就整批不写。
local function sanitizeAttributes(raw, where)
  if type(raw) ~= "table" then
    error(where .. ".attributes 必须是对象")
  end
  local out = {}
  local any = false
  for key, value in pairs(raw) do
    local spec = ATTRIBUTE_WHITELIST[key]
    if spec == nil then
      error(where .. ".attributes 里有不允许的键 '" .. tostring(key) ..
            "'(允许:" .. ATTRIBUTE_NAMES .. ")")
    end
    if spec.kind == "bool" then
      if type(value) ~= "boolean" then
        error(where .. ".attributes." .. key .. " 必须是 true/false")
      end
      out[key] = value
    elseif spec.kind == "num" then
      local n = tonumber(value)
      if n == nil then error(where .. ".attributes." .. key .. " 必须是数字") end
      if n < spec.min or n > spec.max then
        error(string.format("%s.attributes.%s = %s 超出范围(%s..%s)",
          where, key, tostring(n), tostring(spec.min), tostring(spec.max)))
      end
      out[key] = n
    elseif spec.kind == "str" then
      if type(value) ~= "string" then error(where .. ".attributes." .. key .. " 必须是字符串") end
      if #value > spec.maxLen then error(where .. ".attributes." .. key .. " 太长") end
      if spec.pattern ~= nil and not value:match(spec.pattern) then
        error(where .. ".attributes." .. key .. " 含不允许的字符")
      end
      out[key] = value
    elseif spec.kind == "phonemeArray" then
      if type(value) ~= "table" then
        error(where .. ".attributes.phonemes 必须是数组")
      end
      local arr = {}
      for i = 1, #value do
        local item = value[i]
        if type(item) ~= "table" then
          error(where .. ".attributes.phonemes[" .. i .. "] 必须是对象")
        end
        local clean = {}
        for k2, v2 in pairs(item) do
          local s2 = PHONEME_ITEM_WHITELIST[k2]
          if s2 == nil then
            error(where .. ".attributes.phonemes[" .. i .. "] 里有不允许的键 '" .. tostring(k2) ..
                  "'(允许:leftOffset / position / activity / strength)")
          end
          local n2 = tonumber(v2)
          if n2 == nil then
            error(where .. ".attributes.phonemes[" .. i .. "]." .. k2 .. " 必须是数字")
          end
          if n2 < s2.min or n2 > s2.max then
            error(string.format("%s.attributes.phonemes[%d].%s = %s 超出范围(%s..%s)",
              where, i, k2, tostring(n2), tostring(s2.min), tostring(s2.max)))
          end
          clean[k2] = n2
        end
        arr[i] = clean
      end
      out.phonemes = arr
    end
    any = true
  end
  if not any then error(where .. ".attributes 是空的") end
  return out
end

function OPS.set_note_attrs(args)
  args = args or {}
  local updates = args.updates
  if type(updates) ~= "table" or #updates == 0 then
    error("args.updates must be a non-empty array of { index, " .. ATTR_NAMES .. " }")
  end

  local notes = selectedNotes()
  if #notes == 0 then error("no notes selected") end
  requireFreshSelection(args, notes)

  -- 先把整批校验完再动手:任何一条非法就整批不写
  for i = 1, #updates do
    local u = updates[i]
    if type(u) ~= "table" then error("updates[" .. i .. "] must be an object") end
    local index = tonumber(u.index)
    if index == nil then error("updates[" .. i .. "].index is required (0-based index into the selection)") end
    local target = notes[index + 1]     -- 对外 0 起,对内 1 起
    if target == nil then error("updates[" .. i .. "].index out of range") end
    local touched = false
    for key, value in pairs(u) do
      if key == "attributes" then
        -- SV2 2.1.1+ 的属性层(muted / evenSyllableDuration / dF0VbrMod / 逐音素属性 …)
        sanitizeAttributes(value, "updates[" .. i .. "]")
        touched = true
      elseif key ~= "index" then
        local spec = ATTR_WHITELIST[key]
        if spec == nil then
          error("field '" .. tostring(key) .. "' is not allowed (allowed: " .. ATTR_NAMES ..
                ", attributes)")
        end
        if spec.text then
          if type(value) ~= "string" then
            error("updates[" .. i .. "]." .. key .. " must be a string")
          end
          if spec.maxLen ~= nil and #value > spec.maxLen then
            error(string.format("updates[%d].%s 太长(%d > %d)", i, key, #value, spec.maxLen))
          end
          if spec.oneOf ~= nil then
            local allowed = false
            for _, v in ipairs(spec.oneOf) do if value == v then allowed = true end end
            if not allowed then
              error(string.format("updates[%d].%s = %q 必须是 %s 之一",
                i, key, value, table.concat(spec.oneOf, " / ")))
            end
          end
          if spec.pattern ~= nil and not value:match(spec.pattern) then
            error(string.format("updates[%d].%s = %q 含不允许的字符", i, key, value))
          end
          if spec.printable then
            for ci = 1, #value do
              local b = value:byte(ci)
              if b < 32 or b > 126 then
                error(string.format("updates[%d].%s 第 %d 字节不是可打印 ASCII(%d)",
                  i, key, ci, b))
              end
            end
          end
        elseif spec.bool then
          if type(value) ~= "boolean" then
            error("updates[" .. i .. "]." .. key .. " must be true/false")
          end
        else
          local n = tonumber(value)
          if n == nil then error("updates[" .. i .. "]." .. key .. " must be a number") end
          -- 默认要求整数;只有显式 integer = false 的字段才放行小数
          if spec.integer ~= false and n ~= math.floor(n) then
            error(string.format("updates[%d].%s = %s must be an integer", i, key, tostring(n)))
          end
          if n < spec.min or n > spec.max then
            error(string.format("updates[%d].%s = %s is out of range (%s..%s)",
              i, key, tostring(n), tostring(spec.min), tostring(spec.max)))
          end
        end
        touched = true
      end
    end
    if not touched then error("updates[" .. i .. "] has no writable field") end
  end

  local proj = project()
  if proj == nil then error("no project") end
  call(proj, "newUndoRecord")

  local changed = 0
  for i = 1, #updates do
    local u = updates[i]
    local target = notes[tonumber(u.index) + 1]
    for key, value in pairs(u) do
      if key == "attributes" then
        -- 校验已经在上面那一趟做过了;这里再 sanitize 一次拿到干净的表
        -- (setAttributes 只更新给到的键,所以局部传是安全的)
        call(target, "setAttributes", sanitizeAttributes(value, "updates[" .. i .. "]"))
        changed = changed + 1
      elseif key ~= "index" then
        local spec = ATTR_WHITELIST[key]
        local v
        if spec.text or spec.bool then v = value else v = tonumber(value) end
        call(target, spec.setter, v)
        changed = changed + 1
      end
    end
  end

  local reread = selectedNotes()
  local out = {}
  for i = 1, math.min(#reread, 64) do
    -- ⚠️ 原始 attributes 一并回读 —— 宿主只返回**写过的键**(没写过的是 nil 不是默认值),
    --    所以回读里出现什么键,就说明确实写进去了什么键。
    local attrs = call(reread[i], "getAttributes")
    out[i] = {
      pitch = num(call(reread[i], "getPitch")),
      duration = num(call(reread[i], "getDuration")),
      lyrics = call(reread[i], "getLyrics"),
      phonemes = call(reread[i], "getPhonemes"),
      detune = num(call(reread[i], "getDetune")),
      attributes = (type(attrs) == "table") and attrs or nil,
    }
  end
  return { changed = changed, readBackCount = #reread, readBackFp = selectionFp(reread), readBack = out }
end

-- ---- chat_send -----------------------------------------------------------
-- 面板/宿主主动往 DSH 丢一条人话(备用通道;面板平时走 scriptData 中继)
function OPS.chat_send(args)
  args = args or {}
  local text = tostring(args.text or "")
  if #text == 0 then error("args.text is required") end
  local ev = { v = 1, id = "sv-" .. tostring(os.time()) .. "-" .. tostring(ST.ticks),
               ts = os.time(), kind = "user", source = "host", text = text }
  appendLine(PATH.chatIn, jenc(ev), CFG.CHAT_MAX)
  return { queued = true }
end

-- ---- write_notes ---------------------------------------------------------
-- 在**新组**里创建音符并可选写入歌词。
--
-- ⚠️ 为什么不写"当前组":SV2 的主组**不可编辑**(参考项目 SV-005 实测)。
--    必须新建 NoteGroup,而且三步缺一不可:
--      ① proj:addNoteGroup(grp)                建组(此时只是"库里的数据",不渲染)
--      ② 建 NoteGroupReference,setTarget(grp) + setTimeRange(盖住全部内容)
--      ③ track:addGroupReference(ref)          挂到轨上
--    缺引用、或引用窗口没盖住内容 ⇒ 计算类接口**全部返回 null 且不报错**,极难查。
--
-- ⚠️ SV 发声组内音符**不得重叠**(重叠 = 违规)。这里**整批先校验再动手**,
--    任何一条不合法就一条都不写。
--
-- 单位:`onset` / `duration` 一律是**四分音符数(拍)**,不是 blick ——
--       写旋律时按拍思考最自然;blick 换算在桥内部做(1 拍 = SV.QUARTER = 705600000)。
function OPS.write_notes(args)
  args = args or {}
  local notes = args.notes
  if type(notes) ~= "table" or #notes == 0 then
    error("args.notes must be a non-empty array of { onset, duration, pitch, lyrics? } " ..
          "(onset/duration in quarter notes)")
  end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  -- 2.1.2 起最短音符 = 吸附单位的一半,官方没给 blick 数字 ⇒ 自己守一个保守下限。
  local MIN_Q = 0.125

  -- ---- ① 整批校验(先全部验完,再动手) ----
  local plan = {}
  for i = 1, #notes do
    local raw = notes[i]
    if type(raw) ~= "table" then error("notes[" .. i .. "] must be an object") end

    local onset = tonumber(raw.onset)
    local duration = tonumber(raw.duration)
    local pitch = tonumber(raw.pitch)
    if onset == nil then error("notes[" .. i .. "].onset is required (quarter notes)") end
    if duration == nil then error("notes[" .. i .. "].duration is required (quarter notes)") end
    if pitch == nil then error("notes[" .. i .. "].pitch is required (MIDI number)") end
    if onset < 0 then error("notes[" .. i .. "].onset must be >= 0") end
    if duration < MIN_Q then
      error(string.format("notes[%d].duration = %s 拍太短(下限 %.3f 拍)", i, tostring(duration), MIN_Q))
    end
    if pitch ~= math.floor(pitch) then
      error(string.format("notes[%d].pitch = %s must be an integer", i, tostring(pitch)))
    end
    if pitch < 0 or pitch > 127 then
      error(string.format("notes[%d].pitch = %d is out of range (0..127)", i, pitch))
    end

    plan[#plan + 1] = {
      onsetQ = onset,
      durationQ = duration,
      pitch = pitch,
      lyrics = type(raw.lyrics) == "string" and raw.lyrics or "",
    }
  end

  table.sort(plan, function(a, b) return a.onsetQ < b.onsetQ end)

  -- 重叠检查(同 onset 不算重叠 —— 那是和弦/齐奏)
  for i = 1, #plan - 1 do
    local endQ = plan[i].onsetQ + plan[i].durationQ
    if endQ > plan[i + 1].onsetQ + 1e-9 then
      error(string.format(
        "notes[%d] 与 notes[%d] 重叠(前者 %.3f..%.3f,后者从 %.3f 开始)—— SV 发声组内不得重叠",
        i, i + 1, plan[i].onsetQ, endQ, plan[i + 1].onsetQ))
    end
  end

  -- ---- ② 建组、加音符 ----
  local proj = project()
  if proj == nil then error("no project") end

  local grp = SC("create", "NoteGroup")
  if grp == nil then error("SV:create(\"NoteGroup\") 返回 nil") end
  if type(args.groupName) == "string" and #args.groupName > 0 then
    call(grp, "setName", args.groupName)
  end

  for i = 1, #plan do
    local n = SC("create", "Note")
    if n == nil then error("SV:create(\"Note\") 返回 nil") end
    call(n, "setTimeRange", plan[i].onsetQ * QUARTER, plan[i].durationQ * QUARTER)
    call(n, "setPitch", plan[i].pitch)
    if #plan[i].lyrics > 0 then call(n, "setLyrics", plan[i].lyrics) end
    call(grp, "addNote", n)
  end

  -- ---- ③ 挂到轨上(三步缺一不可) ----
  local trackIndex = 1
  if args.trackIndex ~= nil then trackIndex = (tonumber(args.trackIndex) or 0) + 1 end
  local track = call(proj, "getTrack", trackIndex)
  if track == nil then error("track " .. tostring(args.trackIndex or 0) .. " 不存在") end

  call(proj, "newUndoRecord")            -- ⚠️ 无参

  local added = call(proj, "addNoteGroup", grp)     -- ① 建组
  local ref = SC("create", "NoteGroupReference")
  if ref == nil then error("SV:create(\"NoteGroupReference\") 返回 nil") end
  call(ref, "setTarget", grp)                       -- ② 引用 + 窗口
  -- 时间偏移:默认**复制当前组**的偏移 —— 新组应当落在用户正在看的地方,
  -- 而不是永远回到工程开头(参考项目的 create_harmony_group 也是这么做的)。
  -- 可以显式用 args.timeOffsetQuarter 覆盖。
  local curRef = select(1, currentGroup())
  local offsetQ = num(call(curRef, "getTimeOffset")) or 0
  if args.timeOffsetQuarter ~= nil then
    local q = tonumber(args.timeOffsetQuarter)
    if q == nil then error("timeOffsetQuarter 必须是数字") end
    offsetQ = q * QUARTER
  end
  if offsetQ ~= 0 then call(ref, "setTimeOffset", offsetQ) end
  local startB = plan[1].onsetQ * QUARTER
  local endB = (plan[#plan].onsetQ + plan[#plan].durationQ) * QUARTER
  call(ref, "setTimeRange", startB, endB - startB)
  call(track, "addGroupReference", ref)             -- ③ 挂轨

  -- ---- ④ 写后回读(只有回读才算数) ----
  local back = call(ref, "getTarget")
  local count = num(call(back, "getNumNotes")) or 0
  local out = {}
  for i = 1, math.min(count, 64) do
    local nt = call(back, "getNote", i)
    if nt ~= nil then
      out[i] = {
        pitch = num(call(nt, "getPitch")),
        lyrics = call(nt, "getLyrics"),
        onsetQuarter = (num(call(nt, "getOnset")) or 0) / QUARTER,
        durationQuarter = (num(call(nt, "getDuration")) or 0) / QUARTER,
      }
    end
  end

  return {
    requested = #notes,
    written = count,
    groupName = call(back, "getName"),
    groupUUID = call(back, "getUUID"),
    groupLibraryIndex = added,
    spanQuarter = plan[#plan].onsetQ + plan[#plan].durationQ,
    readBack = out,
  }
end

-- ============================================================================
-- 5b. 第二批 op:音高线 / 参数自动化 / 音符增删 / 计算数据
--
-- 坐标约定(从参考项目实测里抄来的,别自己发明):
--   · 音符的 onset/duration 是**相对本组**的 blick。
--   · PitchControlCurve 的 position 也是**相对本组**的 blick(锚点);
--     锚点音高 = 这条曲线挂在哪个音高上;点值 = **相对锚点音高**的半音偏移。
--     对外一律用**绝对 MIDI 音高**,换算在桥内做 —— 写旋律的人不该自己算偏移。
-- ============================================================================

-- ---- get_notes -----------------------------------------------------------
-- 读**当前组**的全部音符(不只是选中的)。写之前先看清整组,是高频动作。
function OPS.get_notes(args)
  args = args or {}
  local limit = tonumber(args.limit) or 1024
  local _, grp = currentGroup()
  if grp == nil then error("no current group") end

  local n = num(call(grp, "getNumNotes")) or 0
  local out = {}
  local truncated = false
  for i = 1, n do
    if i > limit then truncated = true break end
    local nt = call(grp, "getNote", i)
    if nt ~= nil then
      local info = noteInfo(nt)
      info.onsetQuarter = blickToQuarter(info.onset or 0)
      info.durationQuarter = blickToQuarter(info.duration or 0)
      out[#out + 1] = info
    end
  end

  return {
    groupName = call(grp, "getName"),
    groupUUID = call(grp, "getUUID"),
    count = n,
    returned = #out,
    truncated = truncated,
    groupFp = groupFingerprint(grp),
    notes = out,
  }
end

-- ---- 音高线 --------------------------------------------------------------

-- 读当前组的音高线(曲线 + 离散点)
function OPS.get_pit()
  local _, grp = currentGroup()
  if grp == nil then error("no current group") end
  if not has(grp, "getNumPitchControls") then
    error("本宿主没有 PitchControl API(getNumPitchControls)")
  end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local n = num(call(grp, "getNumPitchControls")) or 0
  local out = {}
  for i = 1, n do
    local pc = call(grp, "getPitchControl", i)
    if pc ~= nil then
      local pos = num(call(pc, "getPosition")) or 0
      local anchor = num(call(pc, "getPitch")) or 0
      local item = {
        index = i - 1, -- 对外 0 起
        kind = has(pc, "getPoints") and "curve" or "point",
        positionQuarter = pos / QUARTER,
        anchorPitch = anchor,
      }
      if has(pc, "getPoints") then
        local pts = call(pc, "getPoints")
        local list = {}
        if type(pts) == "table" then
          for k = 1, #pts do
            local pair = pts[k]
            if type(pair) == "table" then
              list[#list + 1] = {
                atQuarter = pos / QUARTER + (tonumber(pair[1]) or 0) / QUARTER,
                pitch = anchor + (tonumber(pair[2]) or 0),
              }
            end
          end
        end
        item.points = list
        item.pointCount = #list
      else
        item.pitch = anchor
      end
      out[#out + 1] = item
    end
  end
  return { count = n, curves = out }
end

-- 写一条音高线。
-- args: { points = [{ at = <拍>, pitch = <MIDI> }], clear = true|false }
-- 所有点合成**一条** PitchControlCurve(锚点 = 第一个点)。
function OPS.write_pit(args)
  args = args or {}
  local points = args.points
  if type(points) ~= "table" or #points == 0 then
    error("args.points must be a non-empty array of { at, pitch } (at in quarter notes, pitch = MIDI)")
  end

  local _, grp = currentGroup()
  if grp == nil then error("no current group") end
  if not (has(grp, "getNumPitchControls") and has(grp, "addPitchControl")) then
    error("本宿主没有 PitchControl API(addPitchControl 系 SV2 2.1.0+)")
  end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local plan = {}
  for i = 1, #points do
    local p = points[i]
    if type(p) ~= "table" then error("points[" .. i .. "] must be an object") end
    local at = tonumber(p.at)
    local pitch = tonumber(p.pitch)
    if at == nil then error("points[" .. i .. "].at is required (quarter notes)") end
    if pitch == nil then error("points[" .. i .. "].pitch is required (MIDI number)") end
    if at < 0 then error("points[" .. i .. "].at must be >= 0") end
    plan[#plan + 1] = { at = at, pitch = pitch }
  end
  table.sort(plan, function(a, b) return a.at < b.at end)

  local proj = project()
  call(proj, "newUndoRecord")

  -- clear=true(默认):先清掉本组已有的音高线,避免叠加
  local cleared = 0
  if args.clear ~= false and has(grp, "removePitchControl") then
    local existing = num(call(grp, "getNumPitchControls")) or 0
    for i = existing, 1, -1 do -- 从后往前删,索引才不会错位
      call(grp, "removePitchControl", i)
      cleared = cleared + 1
    end
  end

  -- 锚点 = 第一个点;点值 = 相对锚点音高的半音偏移
  local anchorQ = plan[1].at
  local anchorPitch = plan[1].pitch
  local pts = {}
  for i = 1, #plan do
    pts[i] = { (plan[i].at - anchorQ) * QUARTER, plan[i].pitch - anchorPitch }
  end

  local curve = SC("create", "PitchControlCurve")
  if curve == nil then error("SV:create(\"PitchControlCurve\") 返回 nil") end
  call(curve, "setPosition", anchorQ * QUARTER)
  call(curve, "setPitch", anchorPitch)
  call(curve, "setPoints", pts)
  call(grp, "addPitchControl", curve)

  -- 写后回读
  local total = num(call(grp, "getNumPitchControls")) or 1
  local back = call(grp, "getPitchControl", total)
  local readPoints = {}
  if back ~= nil and has(back, "getPoints") then
    local got = call(back, "getPoints")
    local bpos = num(call(back, "getPosition")) or 0
    local banchor = num(call(back, "getPitch")) or 0
    if type(got) == "table" then
      for k = 1, math.min(#got, 64) do
        local pair = got[k]
        if type(pair) == "table" then
          readPoints[k] = {
            atQuarter = (bpos + (tonumber(pair[1]) or 0)) / QUARTER,
            pitch = banchor + (tonumber(pair[2]) or 0),
          }
        end
      end
    end
  end

  return {
    clearedExisting = cleared,
    pointsWritten = #pts,
    anchorQuarter = anchorQ,
    anchorPitch = anchorPitch,
    readBack = readPoints,
  }
end

-- 清掉当前组的全部音高线
function OPS.clear_pit()
  local _, grp = currentGroup()
  if grp == nil then error("no current group") end
  if not has(grp, "removePitchControl") then error("本宿主没有 removePitchControl") end
  local proj = project()
  call(proj, "newUndoRecord")
  local n = num(call(grp, "getNumPitchControls")) or 0
  local removed = 0
  for i = n, 1, -1 do
    call(grp, "removePitchControl", i)
    removed = removed + 1
  end
  return { removed = removed, remaining = num(call(grp, "getNumPitchControls")) or 0 }
end

-- ---- select_notes --------------------------------------------------------
-- 程序化设置**选区**。
--
-- ⚠️ 没有这个 op 是个硬伤:set_note_attrs / set_lyrics / transpose_selected 全都作用于
--    "当前选区",而选区此前**只能由用户在 SV2 里手点** ⇒ agent 每做一步都得先求用户点一下。
--    有了它,agent 才能"选中这一组全部音符 → 批量改"。
--
-- ⚠️ 这是**用户可见的副作用**(会替换掉用户当前的选区)—— 这是它存在的意义,不是缺陷。
-- args: { action = "all"|"indices"|"group"|"none", indices? }
function OPS.select_notes(args)
  args = args or {}
  local action = tostring(args.action or "all")
  local ed = editor()
  if ed == nil then error("no editor") end
  local sel = call(ed, "getSelection")
  if sel == nil then error("getSelection 返回 nil") end
  local ref, grp = currentGroup()
  if grp == nil then error("no current group") end

  -- ⚠️ 先把下标**全部验完**再碰任何东西。两个理由:
  --   ① 被拒的请求不该往用户的撤销栈里塞空步;
  --   ② 更严重的:如果先 `clearAll()` 再发现下标非法,用户的选区**已经被清掉了** ——
  --      一个本该被拒的请求造成了可见的破坏。
  local n = num(call(grp, "getNumNotes")) or 0
  local targets = {}
  if action == "all" then
    for i = 0, n - 1 do targets[#targets + 1] = i end
  elseif action == "indices" then
    local idx = args.indices
    if type(idx) ~= "table" or #idx == 0 then
      error("indices 需要非空数组(0 起组内下标)")
    end
    for i = 1, #idx do
      local ix = tonumber(idx[i])
      if ix == nil then
        error("indices[" .. i .. "] = " .. tostring(idx[i]) .. " 不是数字")
      end
      -- ⚠️ 整数检查**不能省**:非整数实参递给宿主绑定正是会弹模态错误框的那一类东西
      --    (真机模态框一弹,宿主主线程就停、桥随之死)。
      if ix ~= math.floor(ix) then
        error("indices[" .. i .. "] = " .. tostring(ix) .. " 必须是整数(音符下标不能是小数)")
      end
      if ix < 0 or ix >= n then
        error("indices[" .. i .. "] = " .. tostring(ix) .. " 越界(本组 " .. n .. " 个音符)")
      end
      targets[#targets + 1] = ix
    end
  elseif action ~= "none" and action ~= "group" then
    error("args.action must be all/indices/group/none")
  end

  local proj = project()
  call(proj, "newUndoRecord")

  if action == "none" then
    call(sel, "clearAll")
    return { action = action, selected = 0 }
  end

  if action == "group" then
    call(sel, "clearAll")
    call(sel, "selectGroup", ref)
    return { action = action, selectedGroup = call(grp, "getName") }
  end

  call(sel, "clearAll")
  local selected = 0
  for i = 1, #targets do
    local nt = call(grp, "getNote", targets[i] + 1)
    if nt ~= nil then
      call(sel, "selectNote", nt)
      selected = selected + 1
    end
  end
  return { action = action, selected = selected, groupFp = groupFingerprint(grp) }
end

-- ---- 参数自动化 ----------------------------------------------------------

-- ⚠️ 白名单。两条硬理由:
--   ① `dynamics` **不是组级 automation**(IX 里它是音符级力度包络)。宿主的
--      getParameter("dynamics") 不报错,而是返回一个**像真的假对象**;在它上面读点/写点
--      会把宿主内存写坏,几秒后在无关位置崩(参考项目实测两次,空工程也复现)。
--      ⇒ 这里**连 getParameter 都不调**,直接拒。
--   ② 范围按官方手册 getDefinition 的表**硬编码** —— 不调 getDefinition(),
--      因为它在旧宿主上属于"调用即冻桥"的崩溃清单。
local AUTOMATION_WHITELIST = {
  pitchDelta  = { min = -1200, max = 1200 },
  vibratoEnv  = { min = 0, max = 2 },
  loudness    = { min = -48, max = 12 },
  tension     = { min = -1, max = 1 },
  breathiness = { min = -1, max = 1 },
  voicing     = { min = 0, max = 1 },
  gender      = { min = -1, max = 1 },
  toneShift   = { min = -800, max = 800 },
}
local VOCAL_MODE_RANGE = { min = 0, max = 150 }

-- 只解析「类型 + 取值范围」,**完全不碰宿主**。
-- ⚠️ 拆出来是有原因的:值越界这类错误必须在调用 `getParameter` **之前**就拒掉 ——
--    否则一个本来无效的请求也会去动宿主的参数对象(而参数对象正是崩溃清单里那一类东西)。
local function resolveAutomationRange(args)
  local t = args and args.type
  if type(t) ~= "string" or #t == 0 then
    error("args.type is required (loudness / tension / breathiness / gender / voicing / " ..
          "pitchDelta / vibratoEnv / toneShift / vocalMode_<名字>)")
  end
  if t == "dynamics" then
    error("dynamics 不是组级 automation(IX 里它是音符级力度包络)。宿主的 getParameter(\"dynamics\") " ..
          "会返回一个**像真的假对象**,按 automation 读点写点会把宿主内存写坏、几秒后在无关位置崩。已硬拒。")
  end

  local range = AUTOMATION_WHITELIST[t]
  if range == nil then
    if t:sub(1, 10) == "vocalMode_" then
      range = VOCAL_MODE_RANGE
    else
      local names = {}
      for k in pairs(AUTOMATION_WHITELIST) do names[#names + 1] = k end
      table.sort(names)
      error("不认识的参数类型:" .. t .. "(可用:" .. table.concat(names, ", ") .. ", vocalMode_<名字>)")
    end
  end
  return t, range
end

-- 校验都过了才碰宿主
local function automationOf(grp, t)
  local auto = call(grp, "getParameter", t)
  if auto == nil then error("getParameter(\"" .. t .. "\") 返回 nil") end
  return auto
end

-- 读参数曲线(**单点采样**)。
-- args: { type, startQuarter?, endQuarter?, stepQuarter? }
-- ⚠️ 刻意用 Automation#get(b) 采样,不用 getPoints / getAllPoints / getLinear / getDefinition ——
--    后四个在旧宿主上属于"调用即冻桥"的崩溃清单。
function OPS.get_automation(args)
  args = args or {}
  local ref, grp
  if args.groupIndex ~= nil or args.trackIndex ~= nil then
    ref, grp = groupAt(args.trackIndex or 0, args.groupIndex or 0)
  else
    ref, grp = currentGroup()
  end
  if grp == nil then
    error("找不到目标组。给了 trackIndex/groupIndex 就检查这两个值(都是 0 起);" ..
          "没给就先在 SV2 里点选一个组。")
  end
  local t, range = resolveAutomationRange(args)
  local auto = automationOf(grp, t)

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local step = tonumber(args.stepQuarter) or 0.25
  if step <= 0 then error("args.stepQuarter must be > 0") end

  local startQ = tonumber(args.startQuarter) or 0
  local endQ = tonumber(args.endQuarter)
  if endQ == nil then
    endQ = startQ + blickToQuarter(num(call(ref, "getDuration")) or 0)
  end
  if endQ <= startQ then error("args.endQuarter must be > startQuarter") end

  local samples = {}
  local at = startQ
  local guard = 0
  while at <= endQ + 1e-9 and guard < 4096 do
    samples[#samples + 1] = { atQuarter = at, value = num(call(auto, "get", at * QUARTER)) }
    at = at + step
    guard = guard + 1
  end

  return {
    type = call(auto, "getType") or args.type,
    range = range,
    interpolation = call(auto, "getInterpolationMethod"),
    sampledFrom = startQ,
    sampledTo = endQ,
    step = step,
    samples = samples,
  }
end

-- 写参数曲线。
-- args: { type, points = [{ at = <拍>, value = <数> }], closeShape = true(默认) }
--
-- ⚠️ `closeShape` 不是美化,是**正确性**:参考项目实测,只写一个点会让该参数在**整组**
--    都变成那个值(在 3.75 拍写 voicing=0.3 ⇒ 3.75/4.0/6.0 三处读回全是 0.3,原来都是默认 1)。
--    ⇒ 做"局部形状"必须**首尾回基线**,而且基线要**先读后写**。
function OPS.set_automation(args)
  args = args or {}
  local points = args.points
  if type(points) ~= "table" or #points == 0 then
    error("args.points must be a non-empty array of { at, value } (at in quarter notes)")
  end

  -- ⚠️ 支持按位置定位目标组(同 auto_tone_shift —— 多轨工程必需,
  --    因为脚本切不了"当前组")。不给就退回当前组。
  local grp
  if args.groupIndex ~= nil or args.trackIndex ~= nil then
    local _, g2 = groupAt(args.trackIndex or 0, args.groupIndex or 0)
    grp = g2
  else
    local _, g1 = currentGroup()
    grp = g1
  end
  if grp == nil then
    error("找不到目标组。给了 trackIndex/groupIndex 就检查这两个值(都是 0 起);" ..
          "没给就先在 SV2 里点选一个组。")
  end
  -- ⚠️ 顺序:先解析类型+范围(不碰宿主)→ 校验全部点(不碰宿主)→ 最后才 getParameter。
  --    这样"值越界"这类错误不会先去动宿主的参数对象。
  local autoType, range = resolveAutomationRange(args)

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local plan = {}
  for i = 1, #points do
    local p = points[i]
    if type(p) ~= "table" then error("points[" .. i .. "] must be an object") end
    local at = tonumber(p.at)
    local v = tonumber(p.value)
    if at == nil then error("points[" .. i .. "].at is required (quarter notes)") end
    if v == nil then error("points[" .. i .. "].value is required") end
    if at < 0 then error("points[" .. i .. "].at must be >= 0") end
    if v < range.min or v > range.max then
      error(string.format("points[%d].value = %s 超出 %s 的范围(%s..%s)",
        i, tostring(v), tostring(args.type), tostring(range.min), tostring(range.max)))
    end
    plan[#plan + 1] = { at = at, value = v }
  end
  table.sort(plan, function(a, b) return a.at < b.at end)

  local auto = automationOf(grp, autoType)
  local proj = project()
  call(proj, "newUndoRecord")

  -- 闭合:先在形状**外沿**读基线,再把它写回去(顺序不能反 —— 先写就把基线污染了)。
  --
  -- ⚠️ 两个细节都是必须的:
  --   ① 闭合点要落在形状的**外沿**(首点之前、末点之后),不能和首/末点同位置。
  --      同位置会被用户的点直接覆盖 ⇒ 等于没闭合;只给一个点时尤其致命 ——
  --      那正是"一个点让整组变成那个值"的原始事故形态。
  --   ② 基线必须**先读后写**:先 add 就把待读的基线改掉了。
  local closed = false
  if args.closeShape ~= false then
    local guard = tonumber(args.guardQuarter) or 0.0625   -- 默认 1/16 拍
    if guard <= 0 then guard = 0.0625 end
    local beforeQ = plan[1].at - guard
    if beforeQ < 0 then beforeQ = 0 end
    local afterQ = plan[#plan].at + guard

    local baseBefore = num(call(auto, "get", beforeQ * QUARTER))
    local baseAfter = num(call(auto, "get", afterQ * QUARTER))
    if baseBefore ~= nil then call(auto, "add", beforeQ * QUARTER, baseBefore) end
    if baseAfter ~= nil then call(auto, "add", afterQ * QUARTER, baseAfter) end
    -- 只有当"外沿点确实和用户点错开"时,才算真的闭合上了
    closed = (baseBefore ~= nil) and (baseAfter ~= nil) and (beforeQ < plan[1].at or afterQ > plan[#plan].at)
  end

  local written = 0
  for i = 1, #plan do
    call(auto, "add", plan[i].at * QUARTER, plan[i].value)
    written = written + 1
  end

  local back = {}
  for i = 1, math.min(#plan, 32) do
    back[i] = { atQuarter = plan[i].at, value = num(call(auto, "get", plan[i].at * QUARTER)) }
  end

  return {
    type = call(auto, "getType") or args.type,
    range = range,
    written = written,
    closedShape = closed,
    readBack = back,
  }
end

-- ---- delete_notes --------------------------------------------------------
-- 按**组内下标(0 起)**删音符。必须先给 groupFp(get_notes 会给),防删错。
function OPS.delete_notes(args)
  args = args or {}
  local indices = args.indices
  if type(indices) ~= "table" or #indices == 0 then
    error("args.indices must be a non-empty array of 0-based note indices within the current group")
  end

  local _, grp = currentGroup()
  if grp == nil then error("no current group") end

  local n = num(call(grp, "getNumNotes")) or 0
  local expect = args.expectGroupFp
  if type(expect) ~= "string" or #expect == 0 then
    error("expectGroupFp is required: call get_notes first and pass its groupFp back unchanged")
  end
  local now = groupFingerprint(grp)
  if now ~= expect then
    error("STALE_SELECTION: group changed since it was read (expected " .. expect ..
          ", actual " .. now .. "). Re-read with get_notes and retry.")
  end

  local targets = {}
  for i = 1, #indices do
    local ix = tonumber(indices[i])
    if ix == nil then
      error("indices[" .. i .. "] = " .. tostring(indices[i]) .. " 不是数字")
    end
    -- ⚠️ 整数检查不能省:小数下标递给 `NoteGroup:removeNote` 是模态错误框的高危输入,
    --    而且在某些宿主上它会**静默删错东西**(报告删了、实际音符数没变)。
    if ix ~= math.floor(ix) then
      error("indices[" .. i .. "] = " .. tostring(ix) .. " 必须是整数(音符下标不能是小数)")
    end
    if ix < 0 or ix >= n then
      error("indices[" .. i .. "] = " .. tostring(ix) .. " 越界(本组共 " .. n ..
            " 个音符,下标 0.." .. (n - 1) .. ")")
    end
    targets[#targets + 1] = ix
  end
  table.sort(targets)
  for i = 2, #targets do
    if targets[i] == targets[i - 1] then error("indices 有重复:" .. targets[i]) end
  end

  local proj = project()
  call(proj, "newUndoRecord")

  -- 从后往前删,索引才不会错位
  local removed = 0
  for i = #targets, 1, -1 do
    call(grp, "removeNote", targets[i] + 1)
    removed = removed + 1
  end

  return {
    removed = removed,
    remaining = num(call(grp, "getNumNotes")) or 0,
    groupFp = groupFingerprint(grp),
  }
end

-- ---- get_note_attrs ------------------------------------------------------
-- 读音符的**完整属性**(不只是音高/时长/歌词)。
-- 为什么需要:agent 改之前得先知道"哪些属性已经设过" —— 比如这个音是不是手动音高、
-- 有没有改过音素、语种覆盖是什么。只看 pitch/lyrics 会误判。
-- args: { scope = "group"|"selection", limit? }
function OPS.get_note_attrs(args)
  args = args or {}
  local scope = tostring(args.scope or "group")
  local limit = tonumber(args.limit) or 256

  local notes = {}
  local groupName = nil
  if scope == "selection" then
    notes = selectedNotes()
  else
    local _, grp = currentGroup()
    if grp == nil then error("no current group") end
    groupName = call(grp, "getName")
    local n = num(call(grp, "getNumNotes")) or 0
    for i = 1, n do
      local nt = call(grp, "getNote", i)
      if nt ~= nil then notes[#notes + 1] = nt end
    end
  end

  local out = {}
  local truncated = false
  for i = 1, #notes do
    if i > limit then truncated = true break end
    local nt = notes[i]
    local info = noteInfo(nt)
    info.onsetQuarter = blickToQuarter(info.onset or 0)
    info.durationQuarter = blickToQuarter(info.duration or 0)
    info.detune = num(call(nt, "getDetune"))
    info.phonemes = call(nt, "getPhonemes")
    info.languageOverride = call(nt, "getLanguageOverride")
    info.rapAccent = call(nt, "getRapAccent")
    info.musicalType = call(nt, "getMusicalType")
    info.pitchAutoMode = call(nt, "getPitchAutoMode")
    -- 原始属性表:⚠️ 宿主只返回"写过的键",没写过的是 nil 而不是默认值
    --    (参考项目 SV-007)。所以这里如实返回,别自己填默认值。
    local raw = call(nt, "getAttributes")
    if type(raw) == "table" then info.attributes = raw end
    out[#out + 1] = info
  end

  return {
    scope = scope,
    groupName = groupName,
    count = #notes,
    returned = #out,
    truncated = truncated,
    notes = out,
    note = "attributes 里只包含**曾经写过的键**;没出现过的键是 nil(不是默认值)。",
  }
end

-- ---- split_notes ---------------------------------------------------------
-- 把一个音符在指定位置拆成两个(官方脚本 Utilities/SplitSelectedNotes 的同类能力)。
-- args: { splits = [{ index = <0 起组内下标>, atQuarter = <拍> }], expectGroupFp }
--
-- ⚠️ 拆分点必须**严格落在音符内部**(留出两边都不短于下限的余量),
--    否则会造出零长音符或直接失败。整批先校验再动手。
function OPS.split_notes(args)
  args = args or {}
  local splits = args.splits
  if type(splits) ~= "table" or #splits == 0 then
    error("args.splits must be a non-empty array of { index, atQuarter }")
  end

  local _, grp = currentGroup()
  if grp == nil then error("no current group") end

  local expect = args.expectGroupFp
  if type(expect) ~= "string" or #expect == 0 then
    error("expectGroupFp is required: call get_notes first and pass its groupFp back unchanged")
  end
  local now = groupFingerprint(grp)
  if now ~= expect then
    error("STALE_SELECTION: group changed since it was read (expected " .. expect ..
          ", actual " .. now .. "). Re-read with get_notes and retry.")
  end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local MIN_Q = 0.125

  local n = num(call(grp, "getNumNotes")) or 0
  local plan = {}
  for i = 1, #splits do
    local s = splits[i]
    if type(s) ~= "table" then error("splits[" .. i .. "] must be an object") end
    local ix = tonumber(s.index)
    local at = tonumber(s.atQuarter)
    if ix == nil then error("splits[" .. i .. "].index is required (0-based)") end
    if at == nil then error("splits[" .. i .. "].atQuarter is required (quarter notes)") end
    -- ⚠️ 整数检查必须在**任何宿主调用之前** —— 否则 getNote(1.5) 这种非整数实参
    --    就已经递进宿主绑定了,那正是弹模态框的高危输入。
    if ix ~= math.floor(ix) then
      error("splits[" .. i .. "].index = " .. tostring(ix) .. " 必须是整数(音符下标不能是小数)")
    end
    if ix < 0 or ix >= n then
      error("splits[" .. i .. "].index = " .. tostring(ix) .. " 越界(本组 " .. n .. " 个音符)")
    end

    local nt = call(grp, "getNote", ix + 1)
    if nt == nil then error("splits[" .. i .. "]: getNote 返回 nil") end
    local onsetQ = blickToQuarter(num(call(nt, "getOnset")) or 0)
    local durQ = blickToQuarter(num(call(nt, "getDuration")) or 0)
    local endQ = onsetQ + durQ
    if at <= onsetQ + MIN_Q - 1e-9 or at >= endQ - MIN_Q + 1e-9 then
      error(string.format(
        "splits[%d]: 拆分点 %.4f 拍必须落在音符内部并留出余量" ..
        "(音符 %.4f..%.4f,两边都不短于 %.3f 拍)", i, at, onsetQ, endQ, MIN_Q))
    end
    plan[#plan + 1] = { ix = ix, at = at, onsetQ = onsetQ, endQ = endQ }
  end

  -- 同一下标拆多次没有意义,直接拒(避免调用方以为能连拆)
  --
  -- ⚠️ **必须从大到小处理**。真机实测:`addNote` 会按 onset 把新音符**插进组里**
  --    (不是追加到末尾 —— 拆 6..8 的音符,尾段会落在 index 9 而不是末尾)。
  --    也就是说拆完一个之后,**它后面所有音符的下标都会 +1**。
  --    正序处理会让第二个拆分点打到隔壁音符上;倒序处理则前面的下标不受影响。
  table.sort(plan, function(a, b) return a.ix > b.ix end)
  for i = 2, #plan do
    if plan[i].ix == plan[i - 1].ix then
      error("同一个音符被拆了多次(index " .. plan[i].ix .. ")")
    end
  end

  local proj = project()
  call(proj, "newUndoRecord")

  local created = 0
  for i = 1, #plan do
    local p = plan[i]
    local nt = call(grp, "getNote", p.ix + 1)
    local pitch = num(call(nt, "getPitch"))
    local lyrics = call(nt, "getLyrics")
    -- 前半段:缩短到拆分点
    call(nt, "setTimeRange", p.onsetQ * QUARTER, (p.at - p.onsetQ) * QUARTER)
    -- 后半段:新音符
    local tail = SC("create", "Note")
    if tail == nil then error("SV:create(\"Note\") 返回 nil") end
    call(tail, "setTimeRange", p.at * QUARTER, (p.endQ - p.at) * QUARTER)
    if pitch ~= nil then call(tail, "setPitch", pitch) end
    if type(lyrics) == "string" and #lyrics > 0 then call(tail, "setLyrics", lyrics) end
    call(grp, "addNote", tail)
    created = created + 1
  end

  return {
    split = created,
    remaining = num(call(grp, "getNumNotes")) or 0,
    groupFp = groupFingerprint(grp),
    note = "后半段是**新音符**,宿主按 onset 插在组内 ⇒ 组内下标会变,想接着操作请重新 get_notes。",
  }
end

-- ---- get_computed --------------------------------------------------------
-- 读宿主**算出来**的数据。这些接口**不阻塞**,没算完会返回空数组 ——
-- 空数组 ≠ 没有数据,要如实告诉调用方,别让它以为"没内容"。
-- args: { kind = "pitch"|"phonemes"|"attributes", startQuarter?, stepQuarter?, frames? }
function OPS.get_computed(args)
  args = args or {}
  local kind = tostring(args.kind or "phonemes")
  local ref, grp = currentGroup()
  if ref == nil or grp == nil then error("no current group") end

  if kind == "phonemes" then
    local list = SC("getPhonemesForGroup", ref)
    local out = {}
    if type(list) == "table" then
      for i = 1, #list do out[i] = tostring(list[i]) end
    end

    -- 空音素最常见的**不是**"没算完",而是"语种与声库不兼容"(参考项目 SV-006):
    -- 语言链是 音符 > 音符组 > 轨道 > 声库,任何一级定死语言;都不定就取声库的录制语言。
    -- 英文声库 + 中文歌词 ⇒ 拿不到音素 ⇒ **整组不渲染**,而且计算类接口全 null、**不报错**。
    -- 光回一个空数组会让人以为是接口没数据,所以这里把"判断依据"一起给出去。
    local langs, lyrics = {}, {}
    local n = num(call(grp, "getNumNotes")) or 0
    for i = 1, math.min(n, 64) do
      local nt = call(grp, "getNote", i)
      if nt ~= nil then
        langs[i] = call(nt, "getLanguageOverride")
        lyrics[i] = call(nt, "getLyrics")
      end
    end

    local note = nil
    if #out == 0 then
      note = "返回空数组。两种可能,按可能性排序:" ..
             "① **这组词的语种和当前声库不兼容**(语言链:音符 > 组 > 轨 > 声库;" ..
             "英文声库唱中文歌词就属于这种)⇒ 宿主算不出音素 ⇒ **整组不渲染**,而且不报错。" ..
             "这是 SV 的设计如此,不是接口没数据 —— 请确认这条轨用的声库语种与歌词语言匹配;" ..
             "② 宿主还没算完(该接口不阻塞),稍后再读一次。" ..
             "本组音符的语种覆盖与歌词已一并返回,可据此判断。"
    end

    return {
      kind = kind,
      count = #out,
      phonemes = out,
      languageOverrides = langs,
      lyrics = lyrics,
      note = note,
    }
  end

  if kind == "attributes" then
    local list = SC("getComputedAttributesForGroup", ref)
    local ok = type(list) == "table"
    return {
      kind = kind,
      count = ok and #list or 0,
      attributes = ok and list or {},
      note = (not ok or #list == 0) and "返回空:可能还没算完(该接口不阻塞)。" or nil,
    }
  end

  if kind == "pitch" then
    local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
    local startQ = tonumber(args.startQuarter) or 0
    local step = tonumber(args.stepQuarter) or 0.25
    local frames = tonumber(args.frames) or 64
    if step <= 0 then error("args.stepQuarter must be > 0") end
    if frames < 2 or frames > 4096 then error("args.frames must be 2..4096") end

    -- ⚠️ blickStart 要**加上本组引用的时间偏移**(官方文档明确要求)
    local offset = num(call(ref, "getTimeOffset")) or 0
    local list = SC("getComputedPitchForGroup", ref, startQ * QUARTER + offset, step * QUARTER, frames)
    local out = {}
    if type(list) == "table" then
      for i = 1, #list do
        local v = list[i]
        out[i] = (v == nil) and "null" or tonumber(v)
      end
    end
    return {
      kind = kind,
      frames = #out,
      startQuarter = startQ,
      stepQuarter = step,
      pitches = out,
      note = (#out == 0) and "返回空数组:该组的音高还没算完(接口不阻塞),稍后再读。" or nil,
    }
  end

  error("args.kind must be one of: phonemes, attributes, pitch")
end

-- ============================================================================
-- 5c. 第三批 op:速度/拍号 · 组/轨操作 · 播放控制
-- ============================================================================

-- 标记对象的位置 —— ⚠️ **两种标记的字段名不同**,不能用一个统一顺序的 helper:
--   · 速度标记 → `position`(真机实测:读 `positionBlick` 拿到 nil,于是全被当成第 0 拍)
--   · 拍号标记 → `positionBlick`(真机实测:读 `position`/`getPosition()` 会拿到
--                一个 ~1 blick 的垃圾值,显示成 1.4e-9 拍)
-- 既有实现对两种标记也正是分别用这两个字段。
local function tempoMarkBlick(mk)
  local pos = prop(mk, "position")
  if type(pos) ~= "number" then pos = prop(mk, "positionBlick") end
  if type(pos) ~= "number" then return nil end
  return pos
end

local function measureMarkBlick(mk)
  local pos = prop(mk, "positionBlick")
  if type(pos) ~= "number" then pos = prop(mk, "position") end
  if type(pos) ~= "number" then return nil end
  return pos
end

-- ---- get_tempo -----------------------------------------------------------
-- 读全部速度标记与拍号标记。
function OPS.get_tempo()
  local proj = project()
  if proj == nil then error("no project") end
  local ta = call(proj, "getTimeAxis")
  if ta == nil then error("no time axis") end

  local tempos = {}
  local marks = call(ta, "getAllTempoMarks")
  if type(marks) == "table" then
    for i = 1, #marks do
      local mk = marks[i]
      tempos[#tempos + 1] = {
        atQuarter = blickToQuarter(tempoMarkBlick(mk) or 0),
        bpm = tonumber(prop(mk, "bpm")),
      }
    end
  end

  local meters = {}
  local mm = call(ta, "getAllMeasureMarks")
  if type(mm) == "table" then
    for i = 1, #mm do
      local mk = mm[i]
      local b = measureMarkBlick(mk)
      meters[#meters + 1] = {
        atQuarter = blickToQuarter(b or 0),
        numerator = tonumber(prop(mk, "numerator")),
        denominator = tonumber(prop(mk, "denominator")),
      }
    end
  end

  return {
    tempos = tempos,
    meters = meters,
    durationQuarter = blickToQuarter(num(call(proj, "getDuration")) or 0),
  }
end

-- ---- set_tempo -----------------------------------------------------------
-- args: { marks = [{ atQuarter, bpm }], clearExisting = false }
-- ⚠️ `addTempoMark` **不会更新同位置的已有标记**(文档说会更新,实测不会)
--    ⇒ 每次写之前先 `removeTempoMark(同位置)`。
function OPS.set_tempo(args)
  args = args or {}
  local marks = args.marks
  if type(marks) ~= "table" or #marks == 0 then
    error("args.marks must be a non-empty array of { atQuarter, bpm }")
  end

  local proj = project()
  local ta = call(proj, "getTimeAxis")
  if ta == nil then error("no time axis") end
  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000

  local plan = {}
  for i = 1, #marks do
    local m = marks[i]
    if type(m) ~= "table" then error("marks[" .. i .. "] must be an object") end
    local at = tonumber(m.atQuarter)
    local bpm = tonumber(m.bpm)
    if at == nil then error("marks[" .. i .. "].atQuarter is required") end
    if bpm == nil then error("marks[" .. i .. "].bpm is required") end
    if at < 0 then error("marks[" .. i .. "].atQuarter must be >= 0") end
    if bpm <= 0 or bpm > 1000 then
      error(string.format("marks[%d].bpm = %s 不合理(0..1000)", i, tostring(bpm)))
    end
    plan[#plan + 1] = { at = at, bpm = bpm }
  end
  table.sort(plan, function(a, b) return a.at < b.at end)

  call(proj, "newUndoRecord")

  if args.clearExisting == true and has(ta, "getAllTempoMarks") and has(ta, "removeTempoMark") then
    local existing = call(ta, "getAllTempoMarks")
    if type(existing) == "table" then
      for i = #existing, 1, -1 do
        local b = tempoMarkBlick(existing[i])
        if b ~= nil then call(ta, "removeTempoMark", b) end
      end
    end
  end

  local written = 0
  for i = 1, #plan do
    local b = plan[i].at * QUARTER
    call(ta, "removeTempoMark", b)      -- ⚠️ 先删同位置,否则不会更新
    call(ta, "addTempoMark", b, plan[i].bpm)
    written = written + 1
  end

  return { written = written, marks = plan }
end

-- ---- set_meter -----------------------------------------------------------
-- args: { measure (1 起的小节号), numerator, denominator }
function OPS.set_meter(args)
  args = args or {}
  local measure = tonumber(args.measure)
  local nomin = tonumber(args.numerator)
  local denom = tonumber(args.denominator)
  if measure == nil or measure < 1 then error("args.measure is required (1-based measure number)") end
  if nomin == nil or nomin < 1 or nomin > 64 then error("args.numerator must be 1..64") end
  if denom == nil or denom < 1 or denom > 64 then error("args.denominator must be 1..64") end
  if denom ~= 1 and denom ~= 2 and denom ~= 4 and denom ~= 8 and denom ~= 16 and denom ~= 32 then
    error("args.denominator must be a power of two (1/2/4/8/16/32)")
  end

  local proj = project()
  local ta = call(proj, "getTimeAxis")
  if ta == nil then error("no time axis") end
  if not has(ta, "addMeasureMark") then error("本宿主没有 addMeasureMark") end

  -- ⚠️ 宿主的小节号是 **0 起**的,而对外的 `measure` 是 **1 起**(和 DAW 界面一致)。
  --    真机实测:传 measure=5 会落在第 6 小节(20 拍 @4/4)⇒ 必须在这里 -1。
  local index = measure - 1

  call(proj, "newUndoRecord")

  -- `clearOthers`:先把**除第 1 小节以外**的拍号标全删掉,再写新的。
  -- 用途:工程里被别的东西(或之前的测试)塞进了 5/4、3/4 之类的标,小节线会全乱;
  -- 想恢复"从头到尾一个拍号"就靠这个。
  -- ⚠️ 第 1 小节的标**不删** —— 工程总得有一个拍号,全删掉不是好状态。
  --
  -- ⚠️ 实现上**不依赖 `getMeasureMarkAtBlick`**:真机实测这台宿主上没有它
  --    (第一版用了它,结果 `removedOthers` 恒为 0、什么都没删掉)。
  --    改成按**小节号**逐个查 `getMeasureMarkAt(m)`,拿到位置 > 0 的就按号删。
  --    计数以"删前删后的标记条数差"为准 —— `removeMeasureMark` 对不存在的标是空操作,
  --    自己数循环次数会虚高。
  local removed = 0
  if args.clearOthers == true and has(ta, "getAllMeasureMarks")
     and has(ta, "removeMeasureMark") and has(ta, "getMeasureMarkAt") then
    local function markCount()
      local all = call(ta, "getAllMeasureMarks")
      return (type(all) == "table") and #all or 0
    end
    local before = markCount()
    local projDur = num(call(proj, "getDuration")) or 0
    local m = 1
    while m <= 4096 do
      local mk = call(ta, "getMeasureMarkAt", m)
      if mk == nil then break end
      local b = measureMarkBlick(mk)
      if type(b) ~= "number" then break end
      if b > projDur then break end        -- 已经走过工程末尾,停
      if b > 0 then call(ta, "removeMeasureMark", m) end
      m = m + 1
    end
    removed = before - markCount()
    if removed < 0 then removed = 0 end
  end

  -- 同位置已有标记先删(与速度标记同样的理由:addMeasureMark 也不更新已有标)
  if has(ta, "removeMeasureMark") then call(ta, "removeMeasureMark", index) end
  call(ta, "addMeasureMark", index, nomin, denom)

  local back = call(ta, "getMeasureMarkAt", index)
  local b = back and measureMarkBlick(back) or nil
  return {
    measure = measure,
    numerator = nomin,
    denominator = denom,
    removedOthers = removed,
    atQuarter = b and blickToQuarter(b) or nil,
    readBackNumerator = back and tonumber(prop(back, "numerator")) or nil,
    readBackDenominator = back and tonumber(prop(back, "denominator")) or nil,
  }
end

-- ---- transport -----------------------------------------------------------
-- args: { action = "status"|"play"|"pause"|"stop"|"seek"|"loop", seconds?, loopBegin?, loopEnd? }
function OPS.transport(args)
  args = args or {}
  local pb = SC("getPlayback")
  if pb == nil then error("getPlayback 返回 nil") end
  local action = tostring(args.action or "status")

  if action == "play" then
    call(pb, "play")
  elseif action == "pause" then
    call(pb, "pause")
  elseif action == "stop" then
    call(pb, "stop")
  elseif action == "seek" then
    local sec = tonumber(args.seconds)
    if sec == nil or sec < 0 then error("seek 需要 args.seconds(秒,>=0)") end
    call(pb, "seek", sec)
  elseif action == "loop" then
    local a, b = tonumber(args.loopBegin), tonumber(args.loopEnd)
    if a == nil or b == nil or b <= a then error("loop 需要 loopBegin < loopEnd(秒)") end
    call(pb, "loop", a, b)
  elseif action ~= "status" then
    error("args.action must be status/play/pause/stop/seek/loop")
  end

  return {
    action = action,
    status = call(pb, "getStatus"),
    playheadSeconds = num(call(pb, "getPlayhead")),
  }
end

-- ---- group_ops -----------------------------------------------------------
-- args: { action = "info"|"rename"|"delete"|"clone"|"offset"|"mute",
--         name?, timeOffsetQuarter?, pitchOffset?, muted? }
function OPS.group_ops(args)
  args = args or {}
  local action = tostring(args.action or "info")

  -- ---- list:列出**全部轨与全部组** ----------------------------------------
  -- ⚠️ 用户 2026-10-02 反馈:这歌主歌/副歌/和声分轨,共 5 条人声轨、约 10 个组、
  --    约 1296 个音符 —— 而我只看到"当前组"(317 个,占 24%)就开工了。
  --    根因:`MainEditorView` **只有 getCurrentGroup,没有 setCurrentGroup**
  --    ⇒ 脚本改不了"当前组",所以**必须先能列清单**,才知道工程里有什么。
  -- ⚠️ 这段必须在 `currentGroup()` **之前** —— 列清单不需要当前组,
  --    而且恰恰是"当前组看不到全局"才需要它。
  if action == "list" then
    local proj0 = project()
    if proj0 == nil then error("no project") end
    local nTracks = num(call(proj0, "getNumTracks")) or 0
    local out = {}
    for ti = 1, nTracks do
      local trk = call(proj0, "getTrack", ti)
      if trk ~= nil then
        local tname = call(trk, "getName")
        local nGrp = num(call(trk, "getNumGroups")) or 0
        for gi = 1, nGrp do
          local gref = call(trk, "getGroupReference", gi)
          if gref ~= nil then
            local tgt = call(gref, "getTarget")
            local gname = "?"
            local nNotes = 0
            if tgt ~= nil then
              gname = call(tgt, "getName") or "?"
              nNotes = num(call(tgt, "getNumNotes")) or 0
            end
            out[#out + 1] = {
              trackIndex = ti - 1,   -- 对外统一 0 起
              trackName = tname,
              groupIndex = gi - 1,
              groupName = gname,
              noteCount = nNotes,
              isInstrumental = call(gref, "isInstrumental"),
              isMain = call(gref, "isMain"),
            }
          end
        end
      end
    end
    return {
      action = "list", count = #out, groups = out,
      note = "trackIndex / groupIndex 都是 **0 起**。" ..
             "⚠️ 脚本 API **没有 setCurrentGroup** ⇒ 要操作某个组," ..
             "得请用户在 SV2 里点选它,或者用带 groupIndex 参数的 op。",
    }
  end

  local ref, grp = currentGroup()
  if ref == nil or grp == nil then error("no current group") end
  local proj = project()

  if action == "info" then
    return {
      action = action,
      groupName = call(grp, "getName"),
      groupUUID = call(grp, "getUUID"),
      noteCount = num(call(grp, "getNumNotes")),
      isMain = call(ref, "isMain"),
      isMuted = call(ref, "isMuted"),
      timeOffsetQuarter = blickToQuarter(num(call(ref, "getTimeOffset")) or 0),
      pitchOffset = num(call(ref, "getPitchOffset")),
      onsetQuarter = blickToQuarter(num(call(ref, "getOnset")) or 0),
      durationQuarter = blickToQuarter(num(call(ref, "getDuration")) or 0),
      trackIndex = (function()
        local tr = call(ref, "getParent")
        local i = tr and num(call(tr, "getIndexInParent"))
        return i and (i - 1) or nil
      end)(),
    }
  end

  if action == "rename" then
    local name = args.name
    if type(name) ~= "string" or #name == 0 then error("rename 需要 args.name") end
    call(proj, "newUndoRecord")
    call(grp, "setName", name)
    return { action = action, groupName = call(grp, "getName") }
  end

  if action == "mute" then
    call(proj, "newUndoRecord")
    call(ref, "setMuted", args.muted == true)
    return { action = action, isMuted = call(ref, "isMuted") }
  end

  if action == "offset" then
    -- ⚠️ 先全部校验,**再**建撤销点。被拒的请求不该往用户的撤销栈里塞一条空步
    --    (工程数据一个字节都没写,却在撤销栈里留了痕)。其余 op 也都是这个次序。
    local q, p
    if args.timeOffsetQuarter ~= nil then
      q = tonumber(args.timeOffsetQuarter)
      if q == nil then error("timeOffsetQuarter 必须是数字") end
    end
    if args.pitchOffset ~= nil then
      p = tonumber(args.pitchOffset)
      if p == nil or p < -48 or p > 48 then error("pitchOffset 必须在 -48..48") end
    end
    if q == nil and p == nil then
      error("offset 至少要给 timeOffsetQuarter 或 pitchOffset 之一")
    end

    call(proj, "newUndoRecord")
    local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
    if q ~= nil then call(ref, "setTimeOffset", q * QUARTER) end
    if p ~= nil then call(ref, "setPitchOffset", p) end
    return {
      action = action,
      timeOffsetQuarter = blickToQuarter(num(call(ref, "getTimeOffset")) or 0),
      pitchOffset = num(call(ref, "getPitchOffset")),
    }
  end

  if action == "delete" then
    -- 只从**编排**里摘掉(删轨上的引用)。库里的组数据保留 —— 删库是不可逆的,不该默认做。
    local track = call(ref, "getParent")
    if track == nil then error("找不到本组所在的轨") end
    local idx = num(call(ref, "getIndexInParent"))
    if idx == nil then error("拿不到本组在轨上的下标") end
    if call(ref, "isMain") == true then
      error("主组不能删(它是宿主自带的)")
    end
    call(proj, "newUndoRecord")
    call(track, "removeGroupReference", idx)
    return { action = action, removedFromTrack = true, trackIndex = (num(call(track, "getIndexInParent")) or 1) - 1 }
  end

  if action == "clone" then
    local copy = call(grp, "clone")
    if copy == nil then error("NoteGroup:clone() 返回 nil") end
    call(proj, "newUndoRecord")
    -- ⚠️ 三步顺序与 write_notes 一致(参考项目实测):先入组库 → 再建引用并设窗口 → 最后挂轨
    call(proj, "addNoteGroup", copy)
    local newRef = SC("create", "NoteGroupReference")
    if newRef == nil then error("SV:create(\"NoteGroupReference\") 返回 nil") end
    call(newRef, "setTarget", copy)
    call(newRef, "setTimeRange", num(call(ref, "getOnset")) or 0, num(call(ref, "getDuration")) or 0)
    local track = call(ref, "getParent")
    if track == nil then error("找不到本组所在的轨") end
    call(track, "addGroupReference", newRef)
    return {
      action = action,
      newGroupUUID = call(copy, "getUUID"),
      noteCount = num(call(copy, "getNumNotes")),
    }
  end

  if action == "move" then
    -- 把本组移到另一条轨。用途:SV2 自带的「音频转音符」会把结果落到**最上面**那条轨,
    -- 转录前先把那条轨腾空,转录结果就落得干净。
    local dstTi = tonumber(args.targetTrackIndex)
    if dstTi == nil then error("move 需要 args.targetTrackIndex(0 起)") end
    if dstTi ~= math.floor(dstTi) then error("targetTrackIndex 必须是整数") end
    if call(ref, "isMain") == true then
      error("主组不能移动(它是宿主自带的)")
    end
    local dst = call(proj, "getTrack", dstTi + 1)
    if dst == nil then error("track " .. dstTi .. " 不存在") end
    local src = call(ref, "getParent")
    if src == nil then error("找不到本组所在的轨") end
    -- ⚠️ 用下标比较,不要用 `src == dst`:宿主每次调用返回的是**新的包装对象**,
    --    同一对象 `==` 也会是 false(工程引用上已实测过 rawequal 不可用)。
    local srcTrackIdx = num(call(src, "getIndexInParent"))   -- **轨**在工程里的下标(1 起)
    if srcTrackIdx == nil then error("拿不到源轨的工程下标") end
    if srcTrackIdx == dstTi + 1 then
      return { action = action, moved = false, note = "源轨与目标轨相同,未做改动" }
    end
    -- ⚠️⚠️ 删引用要用**引用自己在轨上的下标**,不是轨的下标!
    --    这里原来错用了 `srcTrackIdx`(轨的工程下标),后果很严重:
    --    被移动的组**同时挂在两条轨上**(重复发声),而源轨上第 N 个引用被误删 ——
    --    N 恰好是源轨的工程下标,常常就是**主组**,主组从编排里消失。
    --    离线测试台的实时探针抓到过:track0 的 GRP-0001(主组)被删掉。
    local refIdx = num(call(ref, "getIndexInParent"))        -- **引用**在源轨内的下标(1 起)
    if refIdx == nil then error("拿不到本组在源轨内的下标") end

    call(proj, "newUndoRecord")

    -- ⚠️ 顺序很关键:**先建新引用挂到目标轨,成功了再删旧引用**。
    --    反过来的话,一旦 addGroupReference 失败,这个组就从编排里彻底消失了。
    local newRef = SC("create", "NoteGroupReference")
    if newRef == nil then error("SV:create(\"NoteGroupReference\") 返回 nil") end
    call(newRef, "setTarget", grp)
    call(newRef, "setTimeRange", num(call(ref, "getOnset")) or 0, num(call(ref, "getDuration")) or 0)
    local off = num(call(ref, "getTimeOffset"))
    if off ~= nil and off ~= 0 then call(newRef, "setTimeOffset", off) end
    local added = call(dst, "addGroupReference", newRef)
    if added == nil then error("addGroupReference 失败,已中止(源引用没动,数据没丢)") end

    -- 删之前再确认一次:这个下标现在指向的**确实是我们刚挂上去的那个组的同一个目标**。
    -- 宿主每次返回新包装对象,所以只能比目标组,不能比引用对象本身。
    local checkRef = call(src, "getGroupReference", refIdx)
    local checkTarget = checkRef and call(checkRef, "getTarget")
    if checkTarget == nil or num(call(checkTarget, "getNumNotes")) ~= num(call(grp, "getNumNotes")) then
      error("删旧引用前的自检没过(源轨第 " .. refIdx .. " 个引用不像是本组)—— " ..
            "已中止,**没有删任何东西**。新引用可能已挂到目标轨,请检查后手工收拾。")
    end
    call(src, "removeGroupReference", refIdx)

    return {
      action = action,
      moved = true,
      fromTrackIndex = srcTrackIdx - 1,
      toTrackIndex = dstTi,
      removedRefIndex = refIdx - 1,
      groupName = call(grp, "getName"),
      noteCount = num(call(grp, "getNumNotes")),
      dstGroupCount = num(call(dst, "getNumGroups")),
      srcGroupCount = num(call(src, "getNumGroups")),
    }
  end

  error("args.action must be list/info/rename/mute/offset/delete/clone/move")
end

-- ---- track_ops -----------------------------------------------------------
-- args: { action = "list"|"add"|"remove"|"rename"|"color"|"mixer"|"setMixer",
--         trackIndex?, name?, color?, gainDecibel?, pan?, muted?, solo? }
function OPS.track_ops(args)
  args = args or {}
  local action = tostring(args.action or "list")
  local proj = project()
  if proj == nil then error("no project") end

  if action == "list" then
    local n = num(call(proj, "getNumTracks")) or 0
    local out = {}
    for i = 1, n do
      local tr = call(proj, "getTrack", i)
      if tr ~= nil then
        local gcount = num(call(tr, "getNumGroups")) or 0
        -- 这条轨上一共多少音符(跨它的所有组)。
        -- 用途:SV2 自带的「音频转音符」会把结果落到**最上面**那条轨 ⇒ 转录前先问
        -- "最上面那条轨是不是空的",就是看这个 noteCount。
        local notes = 0
        for g = 1, gcount do
          local gref = call(tr, "getGroupReference", g)
          local tgt = gref and call(gref, "getTarget")
          if tgt ~= nil then notes = notes + (num(call(tgt, "getNumNotes")) or 0) end
        end
        out[#out + 1] = {
          index = i - 1, -- 存储下标(0 起)
          name = call(tr, "getName"),
          -- ⚠️ 显示顺序**可以和存储下标不同**,编曲视图里按它排。
          --    找"视觉上最上面那条轨"必须用 min(displayOrder),不能用 index 0。
          displayOrder = num(call(tr, "getDisplayOrder")),
          groupCount = gcount,
          noteCount = notes,
          displayColor = call(tr, "getDisplayColor"),
          isBounced = call(tr, "isBounced"),
        }
      end
    end
    return { action = action, count = n, tracks = out }
  end

  if action == "add" then
    local track = SC("create", "Track")
    if track == nil then error("SV:create(\"Track\") 返回 nil") end
    if type(args.name) == "string" and #args.name > 0 then call(track, "setName", args.name) end
    call(proj, "newUndoRecord")
    call(proj, "addTrack", track)
    -- ⚠️ 不要直接回传宿主 `addTrack` 的返回值:真机实测它给的是 **1 起/计数**(新轨加完返回 2,
    --    而新轨的 0 起下标其实是 1)。对外一律 0 起 ⇒ 用"最后一轨的下标"来报,与返回值无关。
    local total = num(call(proj, "getNumTracks")) or 1
    return { action = action, addedIndex = total - 1, numTracks = total }
  end

  local ti = tonumber(args.trackIndex) or 0
  local track = call(proj, "getTrack", ti + 1)
  if track == nil then error("track " .. tostring(ti) .. " 不存在") end

  if action == "rename" then
    if type(args.name) ~= "string" or #args.name == 0 then error("rename 需要 args.name") end
    call(proj, "newUndoRecord")
    call(track, "setName", args.name)
    return { action = action, trackIndex = ti, name = call(track, "getName") }
  end

  if action == "color" then
    if type(args.color) ~= "string" or #args.color == 0 then error("color 需要 args.color(如 \"#4A90D9\")") end
    call(proj, "newUndoRecord")
    call(track, "setDisplayColor", args.color)
    return { action = action, trackIndex = ti, displayColor = call(track, "getDisplayColor") }
  end

  if action == "remove" then
    local n = num(call(proj, "getNumTracks")) or 0
    if n <= 1 then error("不能删掉最后一条轨") end
    call(proj, "newUndoRecord")
    call(proj, "removeTrack", ti + 1)
    return { action = action, removedIndex = ti, numTracks = num(call(proj, "getNumTracks")) }
  end

  if action == "mixer" then
    local mx = call(track, "getMixer")
    if mx == nil then error("Track:getMixer() 返回 nil") end
    return {
      action = action,
      trackIndex = ti,
      gainDecibel = num(call(mx, "getGainDecibel")),
      pan = num(call(mx, "getPan")),
      muted = call(mx, "isMuted"),
      solo = call(mx, "isSolo"),
    }
  end

  if action == "setMixer" then
    -- 先全部校验,再动手(整批失败即不写)
    local g, p
    if args.gainDecibel ~= nil then
      g = tonumber(args.gainDecibel)
      if g == nil or g < -24 or g > 24 then error("gainDecibel 必须在 -24..24(官方范围)") end
    end
    if args.pan ~= nil then
      p = tonumber(args.pan)
      if p == nil or p < -1 or p > 1 then error("pan 必须在 -1..1") end
    end
    if g == nil and p == nil and args.muted == nil and args.solo == nil then
      error("setMixer 至少要给 gainDecibel / pan / muted / solo 之一")
    end

    local mx = call(track, "getMixer")
    if mx == nil then error("Track:getMixer() 返回 nil") end
    call(proj, "newUndoRecord")

    if g ~= nil then call(mx, "setGainDecibel", g) end
    if p ~= nil then call(mx, "setPan", p) end
    if args.muted ~= nil then call(mx, "setMuted", args.muted == true) end
    if args.solo ~= nil then call(mx, "setSolo", args.solo == true) end

    return {
      action = action,
      trackIndex = ti,
      gainDecibel = num(call(mx, "getGainDecibel")),
      pan = num(call(mx, "getPan")),
      muted = call(mx, "isMuted"),
      solo = call(mx, "isSolo"),
    }
  end

  error("args.action must be list/add/remove/rename/color/mixer/setMixer")
end

-- ---- get_audio_tracks ----------------------------------------------------
-- 列出工程里所有**外部音频**引用(instrumental)。
-- 用途:你把伴奏/干声扔进 SV2 之后,我得先知道它们在哪、多长、当前起点在哪。
function OPS.get_audio_tracks()
  local proj = project()
  if proj == nil then error("no project") end
  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local n = num(call(proj, "getNumTracks")) or 0
  local out = {}
  for t = 1, n do
    local track = call(proj, "getTrack", t)
    local ng = track and (num(call(track, "getNumGroups")) or 0) or 0
    for g = 1, ng do
      local ref = call(track, "getGroupReference", g)
      if ref ~= nil and call(ref, "isInstrumental") == true then
        local onset = num(call(ref, "getOnset")) or 0
        local dur = num(call(ref, "getDuration")) or 0
        out[#out + 1] = {
          trackIndex = t - 1,
          groupIndex = g - 1,
          trackName = call(track, "getName"),
          onsetQuarter = blickToQuarter(onset),
          durationQuarter = blickToQuarter(dur),
          endQuarter = blickToQuarter(onset + dur),
          timeOffsetQuarter = blickToQuarter(num(call(ref, "getTimeOffset")) or 0),
        }
      end
    end
  end
  return {
    count = #out,
    audio = out,
    note = (#out == 0) and "工程里没有外部音频引用。先把伴奏/干声拖进 SV2 的编排视图。" or nil,
  }
end

-- ---- align_audio ---------------------------------------------------------
-- 把工程里的**音频轨**挪到锚点上,使音频内的「第一拍」正好落在锚点。
--
-- args: { firstBeatSec(必填,音频内第一拍的秒数),
--         anchor = "measure"(默认)|"note", measure?, shiftBeats?,
--         introBeats?/introSec?(anchor="note" 时给前奏留位置),
--         bpm?(给了就同时在锚点写一条速度标), audioTrackIndex? }
--
-- 秒 → blick 的换算必须走宿主自己的 TimeAxis(它知道当前速度),不能自己乘。
function OPS.align_audio(args)
  args = args or {}
  local firstBeatSec = tonumber(args.firstBeatSec)
  if firstBeatSec == nil then
    error("args.firstBeatSec is required(音频内第一拍在多少秒)")
  end
  local proj = project()
  if proj == nil then error("no project") end
  local ta = call(proj, "getTimeAxis")
  if ta == nil then error("no time axis") end
  if not has(ta, "getBlickFromSeconds") then error("本宿主没有 TimeAxis:getBlickFromSeconds") end

  local anchor = tostring(args.anchor or "measure")
  local targetBlick, anchorDesc

  if anchor == "note" then
    local ref0, grp0 = currentGroup()
    if ref0 == nil or grp0 == nil then error("没有当前组(anchor='note' 需要有音符)") end
    local cnt = num(call(grp0, "getNumNotes")) or 0
    if cnt < 1 then error("当前组没有音符(anchor='note')") end
    local n1 = call(grp0, "getNote", 1)
    local anchorOnset = (num(call(n1, "getOnset")) or 0) + (num(call(ref0, "getTimeOffset")) or 0)
    local introBeats = tonumber(args.introBeats)
    local introSec = tonumber(args.introSec)
    local introBlick = 0
    if introBeats ~= nil and introBeats > 0 then
      local bpmForIntro = tonumber(args.bpm) or 120
      introBlick = math.floor(introBeats * (num(call(ta, "getBlickFromSeconds", 60 / bpmForIntro)) or 0) + 0.5)
    elseif introSec ~= nil and introSec > 0 then
      introBlick = math.floor((num(call(ta, "getBlickFromSeconds", introSec)) or 0) + 0.5)
    end
    targetBlick = anchorOnset - introBlick
    anchorDesc = { anchor = "note", anchorNoteOnsetQuarter = blickToQuarter(anchorOnset),
                   introQuarter = blickToQuarter(introBlick), noteCount = cnt }
  else
    local measure = tonumber(args.measure) or 1
    if measure < 1 then error("args.measure 必须 >= 1(对外 1 起)") end
    -- ⚠️ getMeasureMarkAt 收的是**宿主的小节号(0 起)** ⇒ 这里要 -1
    local mark = call(ta, "getMeasureMarkAt", measure - 1)
    if mark == nil then error("找不到第 " .. measure .. " 小节") end
    local markBlick = measureMarkBlick(mark)
    if type(markBlick) ~= "number" then error("拍号标记缺位置字段") end
    targetBlick = markBlick
    local shiftBeats = tonumber(args.shiftBeats)
    if shiftBeats ~= nil and shiftBeats ~= 0 then
      local bpmShift = tonumber(args.bpm) or 120
      targetBlick = targetBlick + math.floor(
        shiftBeats * (num(call(ta, "getBlickFromSeconds", 60 / bpmShift)) or 0) + 0.5)
    end
    anchorDesc = { anchor = "measure", measure = measure,
                   measureStartQuarter = blickToQuarter(markBlick), shiftBeats = shiftBeats }
  end

  -- 找音频轨:遍历轨/组,取 isInstrumental 的那个引用
  local foundRef, foundTrack, foundGroup = nil, -1, -1
  local ntracks = num(call(proj, "getNumTracks")) or 0
  local wantAudio = tonumber(args.audioTrackIndex)
  for t = 1, ntracks do
    local track = call(proj, "getTrack", t)
    local ng = track and (num(call(track, "getNumGroups")) or 0) or 0
    for g = 1, ng do
      local ref = call(track, "getGroupReference", g)
      if ref ~= nil and call(ref, "isInstrumental") == true then
        if wantAudio == nil or (t - 1) == wantAudio then
          foundRef, foundTrack, foundGroup = ref, t - 1, g - 1
          break
        end
      end
    end
    if foundRef ~= nil then break end
  end
  if foundRef == nil then
    error("工程里找不到音频轨(没有 isInstrumental 的组引用)。先把伴奏拖进 SV2。")
  end

  call(proj, "newUndoRecord")

  local firstBeatBlick = math.floor((num(call(ta, "getBlickFromSeconds", firstBeatSec)) or 0) + 0.5)
  local absoluteOnset = targetBlick - firstBeatBlick
  local audioDuration = num(call(foundRef, "getDuration")) or 0

  -- 支持 setTimeRange(2.1.0+)就写绝对起点;否则退回 setTimeOffset
  local useOnset = has(foundRef, "setTimeRange")
  if useOnset then
    call(foundRef, "setTimeRange", absoluteOnset, audioDuration)
  else
    call(foundRef, "setTimeOffset", absoluteOnset)
  end

  local bpmArg = tonumber(args.bpm)
  local tempoWritten = false
  if bpmArg ~= nil and bpmArg > 0 then
    call(ta, "removeTempoMark", targetBlick)   -- addTempoMark 不更新同位置已有标
    call(ta, "addTempoMark", targetBlick, bpmArg)
    tempoWritten = true
  end

  -- 写后回读:音频的第一拍现在落在哪?
  local backOnset = num(call(foundRef, "getOnset")) or 0
  local res = {
    ok = true,
    trackIndex = foundTrack,
    groupIndex = foundGroup,
    firstBeatSec = firstBeatSec,
    firstBeatQuarter = blickToQuarter(firstBeatBlick),
    audioOnsetQuarter = blickToQuarter(absoluteOnset),
    audioOnsetReadBackQuarter = blickToQuarter(backOnset),
    firstBeatLandsAtQuarter = blickToQuarter(backOnset + firstBeatBlick),
    anchorQuarter = blickToQuarter(targetBlick),
    durationQuarter = blickToQuarter(audioDuration),
    useOnset = useOnset,
    tempoBpm = tempoWritten and bpmArg or nil,
  }
  for k, v in pairs(anchorDesc) do res[k] = v end
  return res
end

-- ---- apply_lyrics --------------------------------------------------------
-- 把一段歌词按**音符顺序**分配到当前组(或选区)。
--
-- 切分规则(与参考项目一致):
--   · CJK(汉字 / 假名 / 谚文 / 全角)按**单字**切
--   · 拉丁字母与数字连成一个**词**
--   · 空白(含全角空格)是分隔符
-- 音符多于字词 ⇒ 余下的填 `filler`(默认 "-",SV 里表示延续上一个音)。
--
-- args: { lyrics, scope = "group"|"selection", filler?, startIndex? }
function OPS.apply_lyrics(args)
  args = args or {}
  local text = args.lyrics
  if type(text) ~= "string" or #text == 0 then error("args.lyrics is required") end
  local scope = tostring(args.scope or "group")
  local filler = args.filler
  if filler == nil then filler = "-" end
  if type(filler) ~= "string" then error("args.filler 必须是字符串") end

  -- ---- 切分 ----
  local tokens = {}
  do
    local ok, err = pcall(function()
      local cur = nil
      local function flush()
        if cur ~= nil and #cur > 0 then tokens[#tokens + 1] = cur end
        cur = nil
      end
      for _, cp in utf8.codes(text) do
        local isSpace = (cp == 0x20 or cp == 0x09 or cp == 0x0A or cp == 0x0D or cp == 0x3000)
        local isCJK = (cp >= 0x2E80 and cp <= 0x9FFF)     -- 部首补充 + 汉字
                   or (cp >= 0xF900 and cp <= 0xFAFF)     -- 兼容汉字
                   or (cp >= 0x3040 and cp <= 0x30FF)     -- 平假名 / 片假名
                   or (cp >= 0xAC00 and cp <= 0xD7AF)     -- 谚文
                   or (cp >= 0xFF00 and cp <= 0xFFEF)     -- 全角
        if isSpace then
          flush()
        elseif isCJK then
          flush()
          tokens[#tokens + 1] = utf8.char(cp)
        else
          cur = (cur or "") .. utf8.char(cp)
        end
      end
      flush()
    end)
    if not ok then
      error("歌词不是合法 UTF-8,无法切分:" .. tostring(err))
    end
  end
  if #tokens == 0 then error("歌词里没有可用的字/词") end

  -- ---- 取目标音符,并按 onset 排序 ----
  local notes = {}
  if scope == "selection" then
    notes = selectedNotes()
  else
    local _, grp = currentGroup()
    if grp == nil then error("no current group") end
    local n = num(call(grp, "getNumNotes")) or 0
    for i = 1, n do
      local nt = call(grp, "getNote", i)
      if nt ~= nil then notes[#notes + 1] = nt end
    end
    -- ⚠️ `getNote(i)` 的顺序**不保证**是时间序,必须自己按 onset 排。
    table.sort(notes, function(a, b)
      local ao = num(call(a, "getOnset")) or 0
      local bo = num(call(b, "getOnset")) or 0
      if ao == bo then return (num(call(a, "getPitch")) or 0) < (num(call(b, "getPitch")) or 0) end
      return ao < bo
    end)
  end
  if #notes == 0 then error("没有音符可写") end

  local startIdx = tonumber(args.startIndex) or 0
  if startIdx < 0 or startIdx ~= math.floor(startIdx) then
    error("startIndex 必须是非负整数")
  end

  local proj = project()
  call(proj, "newUndoRecord")

  local mapping, written = {}, 0
  for i = 1, #notes do
    local tok = tokens[startIdx + i]
    if tok == nil then
      if #filler == 0 then break end
      tok = filler
    end
    call(notes[i], "setLyrics", tok)
    mapping[#mapping + 1] = tok
    written = written + 1
  end

  local leftover = #tokens - (#notes - startIdx)
  return {
    scope = scope,
    tokenCount = #tokens,
    noteCount = #notes,
    written = written,
    leftoverTokens = (leftover > 0) and leftover or 0,
    filler = filler,
    lyricsWritten = mapping,
    note = (leftover > 0)
      and ("有 " .. leftover .. " 个字/词**没地方放**(音符不够)—— 多余的已忽略,"
           .. "要么加音符,要么少给点词") or nil,
  }
end

-- ---- align_lyrics --------------------------------------------------------
-- 按 **LRC 时间戳**把歌词对位到音符(歌词有准确时间轴时用这个,比顺序分配准)。
--
-- LRC 格式:每行 `[mm:ss.xx]词`,同一行可有多个时间戳(表示重复)。
-- 对位规则:把每段的时间戳当作"这一段从第几秒开始",音符 onset(换算成秒)落在
--   [本段开始, 下一段开始) 里 ⇒ 从这个段落的字/词里按到达顺序取下一个。
--
-- args: { lrc, scope = "group"|"selection", filler? = "-", apply? = true(默认) }
--   apply=false 时**只算不写**(dry-run),用来先看对位结果。
function OPS.align_lyrics(args)
  args = args or {}
  local lrc = args.lrc
  if type(lrc) ~= "string" or #lrc == 0 then error("args.lrc is required") end
  local scope = tostring(args.scope or "group")
  local filler = args.filler
  if filler == nil then filler = "-" end
  local apply = args.apply ~= false

  local proj = project()
  if proj == nil then error("no project") end
  local ta = call(proj, "getTimeAxis")
  if ta == nil then error("no time axis") end
  if not has(ta, "getSecondsFromBlick") then error("本宿主没有 TimeAxis:getSecondsFromBlick") end

  -- ---- 解析 LRC ----
  local segs = {}
  for line in lrc:gmatch("[^\r\n]+") do
    local stamps = {}
    local rest = line
    while true do
      local mm, ss, frac, tail = rest:match("^%s*%[(%d+):(%d+)%.?(%d*)%]%s*(.*)$")
      if mm == nil then
        -- 也允许 [mm:ss] 形式
        local m2, s2, t2 = rest:match("^%s*%[(%d+):(%d+)%]%s*(.*)$")
        if m2 == nil then break end
        stamps[#stamps + 1] = tonumber(m2) * 60 + tonumber(s2)
        rest = t2
      else
        local f = (frac ~= "" and #frac > 0) and tonumber(frac) / (10 ^ #frac) or 0
        stamps[#stamps + 1] = tonumber(mm) * 60 + tonumber(ss) + f
        rest = tail
      end
    end
    if #stamps > 0 and #rest > 0 then
      for i = 1, #stamps do
        segs[#segs + 1] = { sec = stamps[i], text = rest }
      end
    end
  end
  if #segs == 0 then error("LRC 里没解析出任何 [mm:ss.xx]词 行") end
  table.sort(segs, function(a, b) return a.sec < b.sec end)

  -- ---- 取音符并按 onset 排序 ----
  local notes, timeOffset = {}, 0
  if scope == "selection" then
    notes = selectedNotes()
  else
    local ref, grp = currentGroup()
    if grp == nil then error("no current group") end
    timeOffset = num(call(ref, "getTimeOffset")) or 0
    local n = num(call(grp, "getNumNotes")) or 0
    for i = 1, n do
      local nt = call(grp, "getNote", i)
      if nt ~= nil then notes[#notes + 1] = nt end
    end
  end
  if #notes == 0 then error("没有音符可写") end
  table.sort(notes, function(a, b)
    return (num(call(a, "getOnset")) or 0) < (num(call(b, "getOnset")) or 0)
  end)

  -- ---- 每段切词 ----
  local segTokens = {}
  for i = 1, #segs do
    local tk = {}
    local ok = pcall(function()
      local cur = nil
      local function flush()
        if cur ~= nil and #cur > 0 then tk[#tk + 1] = cur end
        cur = nil
      end
      for _, cp in utf8.codes(segs[i].text) do
        local isSpace = (cp == 0x20 or cp == 0x09 or cp == 0x3000)
        local isCJK = (cp >= 0x2E80 and cp <= 0x9FFF) or (cp >= 0xF900 and cp <= 0xFAFF)
                   or (cp >= 0x3040 and cp <= 0x30FF) or (cp >= 0xAC00 and cp <= 0xD7AF)
                   or (cp >= 0xFF00 and cp <= 0xFFEF)
        if isSpace then flush()
        elseif isCJK then flush(); tk[#tk + 1] = utf8.char(cp)
        else cur = (cur or "") .. utf8.char(cp) end
      end
      flush()
    end)
    if not ok then error("LRC 第 " .. i .. " 段不是合法 UTF-8") end
    segTokens[i] = tk
  end

  -- ---- 对位 ----
  local cursor = {}
  for i = 1, #segs do cursor[i] = 0 end
  local plan, mapping = {}, {}
  for i = 1, #notes do
    local onsetB = num(call(notes[i], "getOnset")) or 0
    local sec = num(call(ta, "getSecondsFromBlick", onsetB + timeOffset)) or 0
    -- 找最后一个 sec <= 音符时间 的段
    local pick = 0
    for s = 1, #segs do
      if segs[s].sec <= sec + 1e-6 then pick = s else break end
    end
    local tok = nil
    if pick > 0 then
      cursor[pick] = cursor[pick] + 1
      tok = segTokens[pick][cursor[pick]]
    end
    if tok == nil then
      if #filler == 0 then break end
      tok = filler
    end
    plan[#plan + 1] = { note = notes[i], lyrics = tok, sec = sec }
    mapping[#mapping + 1] = { atSec = math.floor(sec * 1000 + 0.5) / 1000, lyrics = tok }
  end

  if apply then
    call(proj, "newUndoRecord")
    for i = 1, #plan do call(plan[i].note, "setLyrics", plan[i].lyrics) end
  end

  -- 哪些段完全没被用到(通常是歌词比音符多)
  local unused = {}
  for s = 1, #segs do
    if cursor[s] < #segTokens[s] then
      unused[#unused + 1] = { sec = segs[s].sec, left = #segTokens[s] - cursor[s] }
    end
  end

  return {
    applied = apply,
    segmentCount = #segs,
    noteCount = #notes,
    written = #plan,
    mapping = mapping,
    unusedSegments = unused,
    note = (not apply) and "dry-run:只算没写。要真写请把 apply 设为 true(默认就是 true)。" or nil,
  }
end

-- ---- quantize ------------------------------------------------------------
-- 把音符的起点(可选时长)**吸附到网格**上。
--
-- 为什么高频:SV2 自带转录出来的音符起点是按音频算的,往往不齐 —— 量化是最常见的清理动作。
--
-- args: { grid = 0.25(以四分音符为单位,0.25 = 十六分音符),
--         scope = "group"(默认)|"selection",
--         mode = "onset"(默认,只动起点)|"onset+duration"(时长也吸),
--         strength = 1.0(0~1,量化强度;0.5 = 只走一半),
--         dryRun = false(只算不写), expectGroupFp? }
--
-- ⚠️ 量化**可能造出重叠**(两个音被吸到同一个网格点)—— 而 SV2 同组内不允许重叠。
--    所以这里跟 write_notes 一样**先算完整批、检查重叠,有任何一处就整批不写**,
--    并把冲突报出来(调用方可以减小 strength 或换更细的网格再试)。
function OPS.quantize(args)
  args = args or {}
  local grid = tonumber(args.grid)
  if grid == nil then error("args.grid is required(以四分音符为单位,如 0.25 = 十六分音符)") end
  if grid <= 0 then error("args.grid 必须 > 0") end
  local strength = tonumber(args.strength) or 1.0
  if strength < 0 or strength > 1 then error("args.strength 必须在 0..1") end
  local mode = tostring(args.mode or "onset")
  if mode ~= "onset" and mode ~= "onset+duration" then
    error("args.mode 必须是 onset 或 onset+duration")
  end
  local scope = tostring(args.scope or "group")
  local dryRun = args.dryRun == true

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local notes, grp, expect = {}, nil, nil

  if scope == "selection" then
    notes = selectedNotes()
    if #notes == 0 then error("no notes selected") end
  else
    local _, g = currentGroup()
    if g == nil then error("no current group") end
    grp = g
    local n = num(call(g, "getNumNotes")) or 0
    for i = 1, n do
      local nt = call(g, "getNote", i)
      if nt ~= nil then notes[#notes + 1] = nt end
    end
    if #notes == 0 then error("当前组没有音符") end
    -- 整组指纹:给了就必须对得上(防"读到的是旧状态")
    expect = args.expectGroupFp
    if type(expect) == "string" and #expect > 0 then
      local now = groupFingerprint(g)
      if now ~= expect then
        error("STALE_SELECTION: group changed since it was read (expected " .. expect ..
              ", actual " .. now .. "). Re-read with get_notes and retry.")
      end
    end
  end

  local function snap(b)
    local q = b / QUARTER
    local target = math.floor(q / grid + 0.5) * grid
    return (q + (target - q) * strength) * QUARTER
  end

  local plan = {}
  for i = 1, #notes do
    local nt = notes[i]
    local o = num(call(nt, "getOnset")) or 0
    local d = num(call(nt, "getDuration")) or 0
    local no = math.floor(snap(o) + 0.5)
    local nd = d
    if mode == "onset+duration" then
      nd = math.floor(snap(d) + 0.5)
      if nd < 1 then nd = 1 end
    end
    if no < 0 then no = 0 end
    plan[#plan + 1] = { note = nt, oldOnset = o, oldDur = d, newOnset = no, newDur = nd,
                        pitch = num(call(nt, "getPitch")), lyrics = call(nt, "getLyrics") }
  end

  -- 重叠检查(按新起点排序;同起点不算重叠 —— 那是和弦)
  table.sort(plan, function(a, b)
    if a.newOnset == b.newOnset then return a.oldOnset < b.oldOnset end
    return a.newOnset < b.newOnset
  end)
  local conflicts = {}
  for i = 1, #plan - 1 do
    local aEnd = plan[i].newOnset + plan[i].newDur
    if aEnd > plan[i + 1].newOnset + 1e-9 then
      conflicts[#conflicts + 1] = {
        aPitch = plan[i].pitch, bPitch = plan[i + 1].pitch,
        overlapQuarter = (aEnd - plan[i + 1].newOnset) / QUARTER,
      }
    end
  end
  if #conflicts > 0 then
    local parts = {}
    for i = 1, math.min(#conflicts, 8) do
      parts[#parts + 1] = string.format("(%s→%s 重叠 %.3f 拍)",
        tostring(conflicts[i].aPitch), tostring(conflicts[i].bPitch), conflicts[i].overlapQuarter)
    end
    error("量化会造成 " .. #conflicts .. " 处音符重叠,已整批不写:" ..
          table.concat(parts, " ") ..
          " —— 减小 strength、换更细的网格,或先手动腾开位置。")
  end

  local moved = {}
  for i = 1, #plan do
    moved[#moved + 1] = {
      pitch = plan[i].pitch, lyrics = plan[i].lyrics,
      fromQuarter = plan[i].oldOnset / QUARTER,
      toQuarter = plan[i].newOnset / QUARTER,
      deltaQuarter = (plan[i].newOnset - plan[i].oldOnset) / QUARTER,
      durationQuarter = plan[i].newDur / QUARTER,
    }
  end

  if dryRun then
    return { dryRun = true, grid = grid, strength = strength, mode = mode,
             noteCount = #plan, moved = moved,
             note = "只算没写。要真写请把 dryRun 设为 false(默认)。" }
  end

  local proj = project()
  call(proj, "newUndoRecord")
  for i = 1, #plan do
    call(plan[i].note, "setTimeRange", plan[i].newOnset, plan[i].newDur)
  end

  -- 写后回读
  local back = {}
  local maxDelta = 0
  for i = 1, #plan do
    local o = num(call(plan[i].note, "getOnset")) or 0
    local dq = math.abs(o - plan[i].newOnset) / QUARTER
    if dq > maxDelta then maxDelta = dq end
    if i <= 32 then
      back[#back + 1] = { pitch = plan[i].pitch, onsetQuarter = o / QUARTER }
    end
  end

  return {
    dryRun = false, grid = grid, strength = strength, mode = mode,
    noteCount = #plan, movedCount = #plan, moved = moved,
    readBack = back, maxOnsetErrorQuarter = maxDelta,
    groupFp = grp and groupFingerprint(grp) or nil,
  }
end

-- ---- apply_ornaments -----------------------------------------------------
-- 给音符加**装饰音**。六种靠**拆音符**实现(建在 split_notes 的同一套做法上):
--
--   grace_before 前倚音      从音头切一小段,音高 ±interval
--   grace_after  后倚音      从音尾切一小段,音高 ±interval
--   spike        向上尖尖    音头切**极短**一段冲到 +interval(比前倚音更尖)
--   mordent      波音        主 → 上方邻音 → 主(三等分)
--   turn         回音        上方邻音 → 主 → 下方邻音 → 主(四等分)
--   tail_run     音尾音阶行进 音尾按 steps 级进(每级 ±interval)
--
-- ⚠️ 参考项目还有"反向预备 / 滑音"两种,但那两种只写 **SV1 专有**的音符属性
--    (tF0Offset 那一族),SV2 上不存在 —— 所以这里**不提供**,免得写坏。
--
-- args: { ornament, indices?(0 起组内下标,省略=整组), interval?=2, dir?=+1|-1,
--         len?=0.18(装饰段占原音符的比例), steps?=3, runFrac?=0.35,
--         manual?=false(新音符默认自动音高;true 才设手动),
--         dryRun?=**true**(与参考项目一致:默认只出计划),
--         expectGroupFp? }
function OPS.apply_ornaments(args)
  args = args or {}
  local kind = tostring(args.ornament or "")
  local dryRun = args.dryRun ~= false

  local interval = tonumber(args.interval) or 2
  if interval <= 0 or interval > 24 then error("interval 必须在 1..24 半音") end
  local dir = tonumber(args.dir) or 1
  if dir ~= 1 and dir ~= -1 then error("dir 只能是 +1(向上)或 -1(向下)") end
  local len = tonumber(args.len) or 0.18
  if len <= 0.02 or len >= 0.5 then error("len 必须在 0.02..0.5(占原音符的比例)") end
  local steps = tonumber(args.steps) or 3
  if steps < 2 or steps > 8 or steps ~= math.floor(steps) then
    error("steps 必须是 2..8 的整数")
  end
  local runFrac = tonumber(args.runFrac) or 0.35
  if runFrac <= 0.05 or runFrac >= 0.9 then error("runFrac 必须在 0.05..0.9") end
  local manual = args.manual == true

  -- 每种装饰音的"分段计划":{ {fromFrac, toFrac, dPitch}, ... } + 哪一段保留原歌词
  local iv = dir * interval
  local parts, lyricPart
  if kind == "grace_before" then
    parts, lyricPart = { { 0, len, iv }, { len, 1, 0 } }, 2
  elseif kind == "grace_after" then
    parts, lyricPart = { { 0, 1 - len, 0 }, { 1 - len, 1, iv } }, 1
  elseif kind == "spike" then
    local h = len * 0.5
    parts, lyricPart = { { 0, h, iv }, { h, 1, 0 } }, 2
  elseif kind == "mordent" then
    parts, lyricPart = { { 0, 1 / 3, 0 }, { 1 / 3, 2 / 3, iv }, { 2 / 3, 1, 0 } }, 1
  elseif kind == "turn" then
    parts, lyricPart = { { 0, 0.25, iv }, { 0.25, 0.5, 0 }, { 0.5, 0.75, -iv }, { 0.75, 1, 0 } }, 2
  elseif kind == "tail_run" then
    local head = 1 - runFrac
    parts = { { 0, head, 0 } }
    for i = 1, steps do
      parts[#parts + 1] = { head + runFrac * (i - 1) / steps, head + runFrac * i / steps, iv * i }
    end
    lyricPart = 1
  else
    error("不认识的装饰音 '" .. kind .. "'。可用:grace_before / grace_after / spike / " ..
          "mordent / turn / tail_run")
  end

  local ref, grp = currentGroup()
  if grp == nil then error("no current group") end
  local expect = args.expectGroupFp
  if type(expect) == "string" and #expect > 0 then
    local now = groupFingerprint(grp)
    if now ~= expect then
      error("STALE_SELECTION: group changed since it was read (expected " .. expect ..
            ", actual " .. now .. "). Re-read with get_notes and retry.")
    end
  end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local n = num(call(grp, "getNumNotes")) or 0
  local targets = {}
  if args.indices ~= nil then
    if type(args.indices) ~= "table" or #args.indices == 0 then
      error("indices 需要非空数组(0 起组内下标)")
    end
    for i = 1, #args.indices do
      local ix = tonumber(args.indices[i])
      if ix == nil then error("indices[" .. i .. "] 不是数字") end
      if ix ~= math.floor(ix) then error("indices[" .. i .. "] 必须是整数") end
      if ix < 0 or ix >= n then
        error("indices[" .. i .. "] = " .. ix .. " 越界(本组 " .. n .. " 个音符)")
      end
      targets[#targets + 1] = call(grp, "getNote", ix + 1)
    end
  else
    for i = 1, n do
      local nt = call(grp, "getNote", i)
      if nt ~= nil then targets[#targets + 1] = nt end
    end
  end
  if #targets == 0 then error("没有音符可以加装饰音") end

  -- 先算完整批计划(不碰宿主)
  local plan, minDur = {}, nil
  for i = 1, #targets do
    local nt = targets[i]
    local onset = num(call(nt, "getOnset")) or 0
    local dur = num(call(nt, "getDuration")) or 0
    local pitch = num(call(nt, "getPitch"))
    local lyrics = call(nt, "getLyrics")
    if pitch == nil then error("第 " .. i .. " 个音符拿不到音高") end
    local pieces = {}
    for k = 1, #parts do
      local a = onset + math.floor(dur * parts[k][1] + 0.5)
      local b = onset + math.floor(dur * parts[k][2] + 0.5)
      local d = b - a
      if d < 1 then
        error("音符 " .. (i - 1) .. " 太短(时长 " .. (dur / QUARTER) ..
              " 拍),按当前 len/steps 切出来的第 " .. k .. " 段不足 1 blick。" ..
              "请减小 len / steps,或先把这个音拉长。")
      end
      local p = pitch + parts[k][3]
      if p < 0 or p > 127 then
        error("音符 " .. (i - 1) .. " 的第 " .. k .. " 段音高 " .. p .. " 越界(0..127)")
      end
      pieces[#pieces + 1] = { onset = a, dur = d, pitch = p,
                              lyrics = (k == lyricPart) and lyrics or "-" }
      if minDur == nil or d < minDur then minDur = d end
    end
    plan[#plan + 1] = { note = nt, pieces = pieces, oldOnset = onset, oldDur = dur, oldPitch = pitch }
  end

  local summary = {}
  for i = 1, #plan do
    local names = {}
    for k = 1, #plan[i].pieces do names[#names + 1] = tostring(plan[i].pieces[k].pitch) end
    summary[#summary + 1] = { fromPitch = plan[i].oldPitch,
                              pieces = #plan[i].pieces,
                              pitches = table.concat(names, ","),
                              shortestQuarter = math.floor(minDur / QUARTER * 1000 + 0.5) / 1000 }
  end

  if dryRun then
    return { dryRun = true, ornament = kind, interval = interval, dir = dir,
             len = len, steps = steps, noteCount = #plan,
             plan = summary, newNotes = #plan * (#parts - 1),
             note = "只出计划,没改工程。要真写请把 dryRun 设为 false。" }
  end

  local proj = project()
  call(proj, "newUndoRecord")

  local created = 0
  for i = 1, #plan do
    local pc = plan[i].pieces
    -- 第一段:改写原音符
    call(plan[i].note, "setTimeRange", pc[1].onset, pc[1].dur)
    call(plan[i].note, "setPitch", pc[1].pitch)
    if type(pc[1].lyrics) == "string" then call(plan[i].note, "setLyrics", pc[1].lyrics) end
    -- 其余段:新音符
    for k = 2, #pc do
      local nt = SC("create", "Note")
      if nt == nil then error("SV:create(\"Note\") 返回 nil") end
      call(nt, "setTimeRange", pc[k].onset, pc[k].dur)
      call(nt, "setPitch", pc[k].pitch)
      if type(pc[k].lyrics) == "string" then call(nt, "setLyrics", pc[k].lyrics) end
      if manual then call(nt, "setPitchAutoMode", false) end
      call(grp, "addNote", nt)
      created = created + 1
    end
  end

  -- 写后体检:装饰音是在原音符内部切的,理论上不会重叠,但还是查一遍
  local layout = OPS.get_layout({})
  return {
    dryRun = false, ornament = kind, interval = interval, dir = dir,
    len = len, steps = steps,
    notesDecorated = #plan, newNotes = created,
    remaining = num(call(grp, "getNumNotes")) or 0,
    overlapCount = layout.overlapCount,
    verdict = layout.verdict,
    groupFp = groupFingerprint(grp),
    note = "新音符按 onset 插在组内 ⇒ 下标会变,想接着操作请重新 get_notes。",
  }
end

-- ============================================================================
-- 5d. 声库 / 风格
--
-- ⚠️ 关于"风格移植"这条路的选择:
--    参考项目那套是对**声库文件**做手术(nofs 里的 32 个 float32 向量),
--    只对 flat(非加密)版声库有效,而且是在改用户装好的声库 —— 风险与许可都不明朗。
--    这里走**脚本 API 本来就有**的那条:`NoteGroupReference:getVoice()/setVoice()`。
--    它管的是**这一组**的默认声音属性(响度 / 张力 / 气声 / 性别 / 音区偏移,
--    外加每个 vocal mode 的 pitch / timbre / pronunciation)。
--    "把某个风格套到这一组上"这个目的完全能达到,而**一个字都不碰声库文件**。
--    另外还能读 SV2 自己的 `voice-presets.json`(用户存好的预设),按名字直接套。
-- ============================================================================

local VOICE_RANGES = {
  paramLoudness    = { min = -48, max = 12 },
  paramTension     = { min = -1, max = 1 },
  paramBreathiness = { min = -1, max = 1 },
  paramGender      = { min = -1, max = 1 },
  paramToneShift   = { min = -800, max = 800 },
}
local VOCAL_MODE_KEYS = { "pitch", "timbre", "pronunciation" }
local VOCAL_MODE_RANGE = { min = 0, max = 150 }

-- voice-presets.json 的位置(官方文档没说,是实测的路径;找不到就如实报)
local function voicePresetsPath()
  local appdata = os.getenv("APPDATA")
  if appdata == nil or #appdata == 0 then return nil end
  return appdata .. "\\Dreamtonics\\Synthesizer V Studio 2\\settings\\voice-presets.json"
end

local function readVoicePresets()
  local path = voicePresetsPath()
  if path == nil then return nil, "拿不到 %APPDATA%" end
  local f = io.open(path, "rb")
  if f == nil then return nil, "读不到 " .. path end
  local text = f:read("*a")
  f:close()
  if text == nil or #text == 0 then return nil, "文件是空的" end
  local ok, data = pcall(jdec, text)
  if not ok or type(data) ~= "table" then return nil, "解析 JSON 失败" end
  return data, nil
end

-- ---- get_voice -----------------------------------------------------------
-- 读当前组的**默认声音属性**(不是单个音符的属性)。
function OPS.get_voice(args)
  args = args or {}
  -- ⚠️ 支持按位置定位(多轨工程必需 —— 脚本切不了"当前组",见 groupAt 的说明)
  local ref, grp
  if args.groupIndex ~= nil or args.trackIndex ~= nil then
    ref, grp = groupAt(args.trackIndex or 0, args.groupIndex or 0)
  else
    ref, grp = currentGroup()
  end
  if ref == nil or grp == nil then
    error("找不到目标组。给了 trackIndex/groupIndex 就检查这两个值(都是 0 起);" ..
          "没给就先在 SV2 里点选一个组。")
  end
  local v = call(ref, "getVoice")
  if type(v) ~= "table" then
    error("NoteGroupReference:getVoice() 返回的不是表 —— 本宿主可能不支持这一层")
  end
  local modes = {}
  if type(v.vocalModeParams) == "table" then
    for name, m in pairs(v.vocalModeParams) do
      if type(m) == "table" then
        modes[name] = { pitch = tonumber(m.pitch), timbre = tonumber(m.timbre),
                        pronunciation = tonumber(m.pronunciation) }
      end
    end
  end
  return {
    groupName = call(grp, "getName"),
    loudness = tonumber(v.paramLoudness),
    tension = tonumber(v.paramTension),
    breathiness = tonumber(v.paramBreathiness),
    gender = tonumber(v.paramGender),
    toneShift = tonumber(v.paramToneShift),
    vocalModes = modes,
    note = "这是**组**的默认声音属性;单个音符若有自己的覆盖,会盖过它。",
  }
end

-- ---- set_voice -----------------------------------------------------------
-- 改当前组的默认声音属性。
--
-- args: { loudness?, tension?, breathiness?, gender?, toneShift?,
--         vocalModes = { <模式名> = { pitch?, timbre?, pronunciation? } },
--         preset = "<声库名>/<预设名>"(从 voice-presets.json 套用;给了它就忽略上面那些) }
--
-- ⚠️ 实现上**读—改—写整个对象**:官方没说 setVoice 收不收"局部"对象,
--    而写回一个残缺的对象有可能把没提到的属性清掉。所以先把当前值读全、合并、再整体写回。
function OPS.set_voice(args)
  args = args or {}
  -- ⚠️ 支持按位置定位(同 get_voice / auto_tone_shift —— 多轨工程必需)
  local ref, grp
  if args.groupIndex ~= nil or args.trackIndex ~= nil then
    ref, grp = groupAt(args.trackIndex or 0, args.groupIndex or 0)
  else
    ref, grp = currentGroup()
  end
  if ref == nil or grp == nil then
    error("找不到目标组。给了 trackIndex/groupIndex 就检查这两个值(都是 0 起);" ..
          "没给就先在 SV2 里点选一个组。")
  end
  local cur = call(ref, "getVoice")
  if type(cur) ~= "table" then error("getVoice() 返回的不是表,无法安全改写") end

  -- 先构造出"要写回去的完整对象"
  local out = {}
  for k in pairs(VOICE_RANGES) do out[k] = tonumber(cur[k]) end
  local modes = {}
  if type(cur.vocalModeParams) == "table" then
    for name, m in pairs(cur.vocalModeParams) do
      if type(m) == "table" then
        modes[name] = { pitch = tonumber(m.pitch), timbre = tonumber(m.timbre),
                        pronunciation = tonumber(m.pronunciation) }
      end
    end
  end

  local source = "args"

  -- ① preset:从 SV2 自己的预设文件里取
  if args.preset ~= nil then
    local want = tostring(args.preset)
    local voiceName, presetName = want:match("^(.-)/(.*)$")
    if voiceName == nil then
      error("preset 要写成 \"<声库名>/<预设名>\",例如 \"POPY AI/1\"")
    end
    local data, err = readVoicePresets()
    if data == nil then error("读不到预设文件:" .. tostring(err)) end
    local found = nil
    if type(data.voiceList) == "table" then
      for i = 1, #data.voiceList do
        local v = data.voiceList[i]
        if type(v) == "table" and tostring(v.voiceName or v.name or "") == voiceName
           and type(v.presetList) == "table" then
          for j = 1, #v.presetList do
            local p = v.presetList[j]
            if type(p) == "table" and tostring(p.presetName) == presetName then
              found = p.presetData
              break
            end
          end
        end
      end
    end
    if found == nil then
      error("预设文件里找不到 \"" .. want .. "\"。先用 list_voice_presets 看有哪些。")
    end
    local d = found
    if d.paramLoudness ~= nil then out.paramLoudness = tonumber(d.paramLoudness) end
    if d.paramTension ~= nil then out.paramTension = tonumber(d.paramTension) end
    if d.paramBreathiness ~= nil then out.paramBreathiness = tonumber(d.paramBreathiness) end
    if d.paramGender ~= nil then out.paramGender = tonumber(d.paramGender) end
    if d.paramToneShift ~= nil then out.paramToneShift = tonumber(d.paramToneShift) end
    if type(d.vocalModeParams) == "table" then
      for name, m in pairs(d.vocalModeParams) do
        if type(m) == "table" then
          modes[name] = { pitch = tonumber(m.pitch), timbre = tonumber(m.timbre),
                          pronunciation = tonumber(m.pronunciation) }
        end
      end
    end
    source = "preset:" .. want
  end

  -- ② 直接给的数值(逐项校验范围;任何一项非法就整批不写)
  local direct = {
    paramLoudness = args.loudness,
    paramTension = args.tension,
    paramBreathiness = args.breathiness,
    paramGender = args.gender,
    paramToneShift = args.toneShift,
  }
  local touched = false
  for k, v in pairs(direct) do
    if v ~= nil then
      local n = tonumber(v)
      if n == nil then error(k .. " 必须是数字") end
      local r = VOICE_RANGES[k]
      if n < r.min or n > r.max then
        error(string.format("%s = %s 超出范围(%s..%s)", k, tostring(n),
          tostring(r.min), tostring(r.max)))
      end
      out[k] = n
      touched = true
    end
  end

  -- ③ vocal modes(逐项校验;未知模式名先记下,最后一次性拒)
  if type(args.vocalModes) == "table" then
    for name, m in pairs(args.vocalModes) do
      if type(m) ~= "table" then error("vocalModes." .. tostring(name) .. " 必须是对象") end
      modes[name] = modes[name] or {}
      for _, mk in ipairs(VOCAL_MODE_KEYS) do
        if m[mk] ~= nil then
          local n = tonumber(m[mk])
          if n == nil then error("vocalModes." .. name .. "." .. mk .. " 必须是数字") end
          if n < VOCAL_MODE_RANGE.min or n > VOCAL_MODE_RANGE.max then
            error(string.format("vocalModes.%s.%s = %s 超出范围(%d..%d)",
              name, mk, tostring(n), VOCAL_MODE_RANGE.min, VOCAL_MODE_RANGE.max))
          end
          modes[name][mk] = n
        end
      end
      touched = true
    end
  end

  if not touched and source == "args" then
    error("set_voice 至少要给 loudness / tension / breathiness / gender / toneShift / " ..
          "vocalModes / preset 之一")
  end
  out.vocalModeParams = modes

  local proj = project()
  call(proj, "newUndoRecord")
  call(ref, "setVoice", out)

  -- 写后回读
  local back = call(ref, "getVoice")
  local backModes = {}
  if type(back) == "table" and type(back.vocalModeParams) == "table" then
    for name, m in pairs(back.vocalModeParams) do
      if type(m) == "table" then
        backModes[name] = { pitch = tonumber(m.pitch), timbre = tonumber(m.timbre),
                            pronunciation = tonumber(m.pronunciation) }
      end
    end
  end
  return {
    groupName = call(grp, "getName"),
    source = source,
    readBack = {
      loudness = type(back) == "table" and tonumber(back.paramLoudness) or nil,
      tension = type(back) == "table" and tonumber(back.paramTension) or nil,
      breathiness = type(back) == "table" and tonumber(back.paramBreathiness) or nil,
      gender = type(back) == "table" and tonumber(back.paramGender) or nil,
      toneShift = type(back) == "table" and tonumber(back.paramToneShift) or nil,
      vocalModes = backModes,
    },
  }
end

-- ---- list_voice_presets --------------------------------------------------
-- 读 SV2 自己的 `voice-presets.json`,列出"哪个声库有哪些预设"。
-- 只读,不改任何东西。拿到名字就能用 set_voice {preset="声库名/预设名"} 套用。
function OPS.list_voice_presets(args)
  args = args or {}
  local data, err = readVoicePresets()
  if data == nil then
    return { count = 0, voices = {}, path = voicePresetsPath(), error = err }
  end
  local out = {}
  if type(data.voiceList) == "table" then
    for i = 1, #data.voiceList do
      local v = data.voiceList[i]
      if type(v) == "table" then
        local name = tostring(v.voiceName or v.name or ("(第 " .. i .. " 个)"))
        local presets = {}
        if type(v.presetList) == "table" then
          for j = 1, #v.presetList do
            local p = v.presetList[j]
            if type(p) == "table" then
              local modes = {}
              local d = p.presetData
              if type(d) == "table" and type(d.vocalModeParams) == "table" then
                for mn, m in pairs(d.vocalModeParams) do
                  if type(m) == "table" then modes[#modes + 1] = mn end
                end
                table.sort(modes)
              end
              presets[#presets + 1] = {
                name = tostring(p.presetName),
                vocalModes = modes,
                hasLoudness = type(d) == "table" and d.paramLoudness ~= nil or false,
              }
            end
          end
        end
        out[#out + 1] = { voice = name, presetCount = #presets, presets = presets }
      end
    end
  end
  return {
    count = #out,
    path = voicePresetsPath(),
    voices = out,
    note = "用 set_voice {preset=\"<声库名>/<预设名>\"} 把它套到当前组上。",
  }
end

-- ---- list_voices ---------------------------------------------------------
-- 列出**用户实际拥有的声库名**(不是"存过预设的那些")。
--
-- ⚠️ 为什么这么绕 —— 三条常规路全堵死:
--    ① 脚本 API 里**没有 Voice/Singer 类**(官方 26 个类翻遍),声库名根本拿不到;
--    ② 本地 `databases\<uuid>\` 的目录名是**安装 UUID**,和 `databases\meta\` 的产品
--       目录 ID **对不上**(实测 20 个已安装目录,一个都没命中);
--    ③ 名字加密在目录里的 `m` 文件(168 字节,不可读)。
--
--    但 **`.svp` 工程文件是明文 JSON**,每个组里都有:
--        "database": {"name": "Yamine Renri", "language": "japanese", ...}
--    ⇒ 扫工程文件就能拿到 SV2 自己用的**准确名字**,还附带语种。
--
-- args: { root?(默认 Desktop\工程), maxFiles?=60 }
function OPS.list_voices(args)
  args = args or {}

  -- ⚠️ **先读用户自己维护的清单**。
  --    为什么它优先:扫 .svp 会捞到"别人工程里引用过、但用户根本没买"的声库 ——
  --    用户实测反馈:"里面还有我没有买的声库,根本用不了"。
  --    而"拥有哪些"在本地文件里查不到(API 无 Voice 类;`databases\<uuid>\` 是安装 UUID,
  --    和 `databases\meta\` 的产品 ID 对不上;名字加密在 `m` 里),只能由用户维护一份。
  local cfg = args.configPath
  if cfg == nil then
    local h = os.getenv("USERPROFILE")
    if h ~= nil then cfg = h .. "\\.dsh\\sv-bridge\\voices.json" end
  end
  if cfg ~= nil then
    local f = io.open(cfg, "rb")
    if f ~= nil then
      local text = f:read("*a")
      f:close()
      if text ~= nil then
        local okC, data = pcall(jdec, text)
        if okC and type(data) == "table" and type(data.voices) == "table" then
          local owned = {}
          for i = 1, #data.voices do
            local v = data.voices[i]
            if type(v) == "table" and type(v.name) == "string" and #v.name > 0 then
              owned[#owned + 1] = { name = v.name, gen = v.gen, cn = v.cn }
            end
          end
          if #owned > 0 then
            return {
              count = #owned,
              voices = owned,
              source = "voices.json(用户维护的清单)",
              path = cfg,
              note = "这是**用户拥有**的声库。买了新的往那个文件里加一行即可。",
            }
          end
        end
      end
    end
  end

  local root = args.root
  if root == nil then
    local home = os.getenv("USERPROFILE")
    if home == nil then
      return { count = 0, voices = {}, error = "拿不到 %USERPROFILE%,请显式给 root" }
    end
    root = home .. "\\Desktop\\工程"
  end
  local maxFiles = tonumber(args.maxFiles) or 60
  if maxFiles < 1 or maxFiles > 500 then maxFiles = 60 end

  local files, scanErr = {}, nil
  -- ⚠️ Lua **没有列目录**的能力,只能借 io.popen 跑一次 dir。
  --    拿不到就如实报,绝不假装"用户没有声库"。
  local ok = pcall(function()
  -- ⛔ **2026-10-02:目录扫描停用。**
  --    这里原本用 io.popen 跑 dir 扫 .svp —— 和 get_group_voice 是同一个危险模式。
  --    桥的 op 跑在宿主定时器回调里,**起子进程会阻塞 UI 线程**,实测把 SV2 冻住。
  --    ⇒ 宿主回调里只做纯计算和 API 调用。声库清单改由 voices.json 提供(见上面的早退分支)。
  error("list_voices 的目录扫描已停用:io.popen 会阻塞宿主 UI 线程(实测冻住 SV2)。" ..
        "请用 voices.json 提供声库清单。")

  -- 下面这段是停用前的旧实现,保留待改成安全版本
  local p = POPEN_BLOCKED('dir /b /s "' .. root .. '\\*.svp" 2>nul')
    if p == nil then error("io.popen 返回 nil") end
    for line in p:lines() do
      if #line > 0 then files[#files + 1] = line end
    end
    p:close()
  end)
  if not ok then scanErr = "io.popen 不可用(本宿主不允许起子进程)" end
  if #files == 0 and scanErr == nil then scanErr = "在 " .. root .. " 下没找到 .svp" end

  local counts, langs, order = {}, {}, {}
  local scanned = 0
  for i = 1, math.min(#files, maxFiles) do
    local f = io.open(files[i], "rb")
    if f ~= nil then
      local text = f:read("*a")
      f:close()
      if text ~= nil then
        scanned = scanned + 1
        for block in text:gmatch('"database"%s*:%s*({[^}]*})') do
          local n = block:match('"name"%s*:%s*"([^"]*)"')
          if n ~= nil and #n > 0 then
            -- JSON 里 \u00b7 是间隔号「·」,还原一下(否则显示成 MEDIUM5\u00b7Stardust)
            n = n:gsub("\\u00b7", "\194\183")
            if counts[n] == nil then
              counts[n] = 0
              order[#order + 1] = n
            end
            counts[n] = counts[n] + 1
            local lg = block:match('"language"%s*:%s*"([^"]*)"')
            if lg ~= nil and #lg > 0 and langs[n] == nil then langs[n] = lg end
          end
        end
      end
    end
  end

  local out = {}
  for i = 1, #order do
    out[#out + 1] = { name = order[i], uses = counts[order[i]], language = langs[order[i]] }
  end
  table.sort(out, function(a, b)
    if a.uses == b.uses then return a.name < b.name end
    return a.uses > b.uses
  end)

  return {
    count = #out,
    root = root,
    filesFound = #files,
    filesScanned = scanned,
    voices = out,
    note = scanErr,
    how = "声库名取自 .svp 里的 database.name —— 脚本 API 没有 Voice 类,本地目录名是安装 UUID、对不上",
  }
end

-- ---- get_group_voice -----------------------------------------------------
-- 读**当前组用的是哪套声库** —— 而且**优先读 SV2 自己的自动保存快照**。
--
-- ⚠️ 为什么不能只读用户手动保存的 .svp:
--    用户 2026-10-02 实测:他手动存的文件是 21:33 的,而当时已经 22:28 —— 我拿 55 分钟前的
--    快照当现状,还下了"你没装声库"的错误结论。
--    **SV2 脚本 API 里没有任何保存接口**(26 个类全查过),所以"让助手先保存一下"做不到。
--    但 **SV2 自己会把快照写进 `%APPDATA%\Dreamtonics\Synthesizer V Studio 2\recovery\`,
--    文件名是 `<工程名>_<日期>_<时间>.svp`** —— 最多几分钟旧,格式和正常 .svp 一样。
--    ⇒ 读那个最新的就行,不需要任何保存动作。
--
-- 为什么非要读文件:脚本 API 里**没有 Voice 类**,`getVoice()` 只给声音属性、不给声库名。
--
-- args: { name?(工程名,省略则从当前工程文件名推), maxAgeMinutes?(默认不限) }
function OPS.get_group_voice(args)
  -- ⛔⛔ **2026-10-02 事故后紧急停用。**
  --    第一版用 `io.popen` 跑 `dir` 列 recovery 目录 —— 而桥的 op 是在宿主的
  --    **定时器回调**里执行的,**系统调用会阻塞 UI 线程**,结果把 SV2 整个冻住。
  --    参考项目的警告是"绑定错误会冻宿主",而**起子进程更狠**。
  --    ⇒ 教训:**宿主回调里只做纯计算和 API 调用,绝不做 IO / 进程操作。**
  --    在改成安全的实现(纯 io.open,失败就请用户用 panel_ask 选)之前,这里直接拒绝。
  error("get_group_voice 已紧急停用:它用 io.popen 起子进程,会阻塞宿主 UI 线程(实测冻住 SV2)。请用 panel_ask 让用户点一下声库名。")
  args = args or {}
  local home = os.getenv("USERPROFILE")
  if home == nil then return { found = false, error = "拿不到 %USERPROFILE%" } end
  local recDir = home .. "\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2\\recovery"

  -- 工程名:优先用参数,否则从当前工程文件名里取(去掉目录与 .svp 后缀)
  local name = args.name
  if name == nil then
    local proj = project()
    local fn = proj and call(proj, "getFileName")
    if type(fn) == "string" and #fn > 0 then
      local base = fn:match("([^\\/]+)%.svp$")
      name = base
    end
  end
  if name == nil then
    return { found = false, error = "拿不到工程名(工程可能还没保存过)" }
  end

  -- 列 recovery 目录,挑最新的一版。
  -- ⚠️ Lua 没有列目录能力,只能借 io.popen 跑 dir;拿不到就如实报。
  local newest, newestTime = nil, nil
  local ok = pcall(function()
    local p = POPEN_BLOCKED('dir /b /o-d "' .. recDir .. '\\' .. name .. '_*.svp" 2>nul')
    if p == nil then error("io.popen 返回 nil") end
    for line in p:lines() do
      if #line > 0 and newest == nil then newest = line end   -- /o-d = 按时间倒序,第一条最新
    end
    p:close()
  end)
  if not ok then
    return { found = false, error = "io.popen 不可用,读不了 recovery 目录", projectName = name }
  end
  if newest == nil then
    -- ⚠️ recovery 里没有快照 ⇒ 说明**没有未保存的改动**(SV2 一保存就把快照清掉 ——
    --    实测:用户按 Ctrl+S 后 8 个快照只剩一个 session 文件)。
    --    那就退回读手动保存的 .svp,它此刻就是最新的。
    local proj = project()
    local fn = proj and call(proj, "getFileName")
    if type(fn) ~= "string" or #fn == 0 then
      return { found = false, projectName = name,
               error = "recovery 里没有快照,而且工程还没保存过(没有文件名可读)" }
    end
    -- ⚠️ **不能直接把 API 给的路径交给 cmd 或 io.open** ——
    --    API 返回的 `fileName` 是 **UTF-8**,而 Windows 的 fopen / cmd 要的是系统 ANSI(GBK)。
    --    实测:`type "C:\...\测试.svp"` 什么都没读出来(路径被按 GBK 解析,找不到文件)。
    --    ⇒ **路径也走 `dir`**:dir 返回的是 ANSI 字节,cmd 与 io.open 都认。
    --    做法:列出该目录下所有 .svp(按时间倒序),取最新的那个 —— 用户当前在做的工程
    --    通常就是最近保存的那个。返回里会写明用了哪份,方便核对。
    local dirPart = fn:match("^(.*)[\\/][^\\/]+$")
    if dirPart == nil then
      return { found = false, projectName = name, error = "解析不出目录:" .. fn }
    end
    local newestSaved = nil
    pcall(function()
      local p = POPEN_BLOCKED('dir /b /o-d "' .. dirPart .. '\\*.svp" 2>nul')
      if p == nil then error("io.popen 返回 nil") end
      for line in p:lines() do
        if #line > 0 and newestSaved == nil then newestSaved = line end
      end
      p:close()
    end)
    if newestSaved == nil then
      return { found = false, projectName = name,
               error = "列不出 " .. dirPart .. " 下的 .svp(dir 没返回东西)" }
    end
    local fullSaved = dirPart .. "\\" .. newestSaved
    local f2 = io.open(fullSaved, "rb")
    if f2 == nil then
      return { found = false, projectName = name,
               error = "打不开 " .. fullSaved .. "(dir 给的路径也打不开?)" }
    end
    local text2 = f2:read("*a")
    f2:close()
    if text2 == nil then return { found = false, error = "读不出内容" } end
    local c2, o2 = {}, {}
    for block in text2:gmatch('"database"%s*:%s*({[^}]*})') do
      local n = block:match('"name"%s*:%s*"([^"]*)"')
      if n ~= nil and #n > 0 then
        n = n:gsub("\\u00b7", "\194\183")
        if c2[n] == nil then c2[n] = 0; o2[#o2 + 1] = n end
        c2[n] = c2[n] + 1
      end
    end
    local vs = {}
    for i = 1, #o2 do vs[#vs + 1] = { name = o2[i], count = c2[o2[i]] } end
    return {
      found = true, projectName = name, snapshot = nil, savedFile = fullSaved,
      voices = vs, primaryVoice = o2[1],
      source = "手动保存的 .svp(recovery 里没有快照 ⇒ 没有未保存的改动;" ..
               "路径经 dir 取得,绕开 UTF-8 路径打不开的问题)",
    }
  end

  local path = recDir .. "\\" .. newest
  local f = io.open(path, "rb")
  if f == nil then return { found = false, error = "打不开 " .. path, projectName = name } end
  local text = f:read("*a")
  f:close()
  if text == nil then return { found = false, error = "读不出内容", projectName = name } end

  -- 挖所有 database 块里的 name(空的不算)
  local counts, order = {}, {}
  for block in text:gmatch('"database"%s*:%s*({[^}]*})') do
    local n = block:match('"name"%s*:%s*"([^"]*)"')
    if n ~= nil and #n > 0 then
      n = n:gsub("\\u00b7", "\194\183")
      if counts[n] == nil then counts[n] = 0; order[#order + 1] = n end
      counts[n] = counts[n] + 1
    end
  end
  local voices = {}
  for i = 1, #order do voices[#voices + 1] = { name = order[i], count = counts[order[i]] } end

  local lang = text:match('"database"%s*:%s*{[^}]*"name"%s*:%s*"' ..
                          (order[1] or "\1") .. '"[^}]*"language"%s*:%s*"([^"]*)"')

  return {
    found = true,
    projectName = name,
    snapshot = newest,           -- 用的是哪一份快照(让调用方知道新旧)
    voices = voices,
    primaryVoice = order[1],
    language = lang,
    note = "读的是 SV2 的**自动保存快照**,不是手动保存的 .svp —— 脚本 API 没有保存接口," ..
           "但 recovery 里的快照最多几分钟旧。",
  }
end

-- ---- auto_tone_shift -----------------------------------------------------
-- 按音高把超出声库舒适区的**两端往中间拉** —— 既有实现的「音区偏移自动策略」。
--
-- ⚠️ 为什么比"整曲升调"好:
--    升调会**整体移走**旋律(调性变了、伴奏对不上了);而 toneShift 是**按音符**的,
--    可以只把"太高/太低的那几个音"往中间收 —— **旋律走向保留,只收窄音域**。
--
-- ⚠️ 单位是**音分**(范围 −800 ~ 800)。参考项目特别提醒:
--    "它**不是** ±1 档 —— 写 ±1 等于没写"。半音 = 100 音分。
--
-- 写的是 **toneShift 自动化曲线**(不是组级参数 —— 组级只能给一个值,做不到按音高)。
--
-- args: { lowPitch, highPitch,        -- 声库舒适区(MIDI 音高)
--         centsPerSemitone?=100,      -- 每个超出的半音补多少音分
--         maxCents?=400,              -- 单点上限(留余量,别顶到 800)
--         softEdge?=2,                -- 边缘软过渡的半音数(避免硬拐点)
--         dryRun?=true }
function OPS.auto_tone_shift(args)
  args = args or {}
  local lo = tonumber(args.lowPitch)
  local hi = tonumber(args.highPitch)
  if lo == nil or hi == nil then error("需要 lowPitch / highPitch(声库舒适区的 MIDI 音高)") end
  if hi <= lo then error("highPitch 必须大于 lowPitch") end
  local perSemitone = tonumber(args.centsPerSemitone) or 100
  local maxCents = tonumber(args.maxCents) or 400
  if maxCents <= 0 or maxCents > 800 then error("maxCents 必须在 1..800") end
  local softEdge = tonumber(args.softEdge) or 2
  if softEdge < 0 or softEdge > 12 then error("softEdge 必须在 0..12") end
  local dryRun = args.dryRun ~= false

  -- ⚠️ **支持按位置定位目标组** —— 多轨工程必需。
  --    用户 2026-10-02 反馈:letter song 有 5 条人声轨、约 10 个组,
  --    而脚本**切不了"当前组"**(没有 setCurrentGroup)⇒ 不给 groupIndex
  --    就只能处理用户在 SV2 里点选的那一组,剩下 90% 碰不到。
  local grp
  if args.groupIndex ~= nil or args.trackIndex ~= nil then
    local _, g2 = groupAt(args.trackIndex or 0, args.groupIndex or 0)
    grp = g2
  else
    local _, g1 = currentGroup()
    grp = g1
  end
  if grp == nil then
    error("找不到目标组。给了 trackIndex/groupIndex 就检查这两个值(都是 0 起);" ..
          "没给就先在 SV2 里点选一个组。")
  end
  local n = num(call(grp, "getNumNotes")) or 0
  if n == 0 then error("当前组没有音符") end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local notes = {}
  for i = 1, n do
    local nt = call(grp, "getNote", i)
    if nt ~= nil then
      notes[#notes + 1] = {
        onset = num(call(nt, "getOnset")) or 0,
        dur = num(call(nt, "getDuration")) or 0,
        pitch = num(call(nt, "getPitch")),
      }
    end
  end
  table.sort(notes, function(a, b) return a.onset < b.onset end)

  -- 超出量(半音)。软边缘:在 [lo-softEdge, lo] 与 [hi, hi+softEdge] 内线性过渡,
  -- 免得旋律在边界上"一跳一跳"。
  local function excess(p)
    if p < lo then
      local d = lo - p
      if softEdge > 0 and d < softEdge then return -d * (d / softEdge) end
      return -d
    elseif p > hi then
      local d = p - hi
      if softEdge > 0 and d < softEdge then return d * (d / softEdge) end
      return d
    end
    return 0
  end

  local points, adjusted, maxAbs = {}, 0, 0
  for i = 1, #notes do
    local p = notes[i].pitch
    if p ~= nil then
      local ex = excess(p)
      local cents = -ex * perSemitone
      if cents > maxCents then cents = maxCents end
      if cents < -maxCents then cents = -maxCents end
      cents = math.floor(cents + 0.5)
      if cents ~= 0 then adjusted = adjusted + 1 end
      if math.abs(cents) > maxAbs then maxAbs = math.abs(cents) end
      points[#points + 1] = { at = notes[i].onset / QUARTER, value = cents }
    end
  end
  if #points == 0 then error("没有可处理的音符") end

  -- 同一位置可能重复(和弦/齐奏),保留最后一个
  local dedup, seen = {}, {}
  for i = #points, 1, -1 do
    local key = string.format("%.6f", points[i].at)
    if not seen[key] then
      seen[key] = true
      dedup[#dedup + 1] = points[i]
    end
  end
  table.sort(dedup, function(a, b) return a.at < b.at end)

  if dryRun then
    local sample = {}
    for i = 1, math.min(#dedup, 12) do
      sample[i] = { atQuarter = dedup[i].at, cents = dedup[i].value }
    end
    return {
      dryRun = true, range = { lo, hi }, centsPerSemitone = perSemitone,
      maxCents = maxCents, noteCount = #notes,
      adjustedNotes = adjusted, maxAbsCents = maxAbs,
      pointCount = #dedup, sample = sample,
      note = "只出计划。要真写请把 dryRun 设为 false。写的是 toneShift 自动化曲线。",
    }
  end

  local res = OPS.set_automation({ type = "toneShift", points = dedup, closeShape = true })
  return {
    dryRun = false, range = { lo, hi }, adjustedNotes = adjusted,
    maxAbsCents = maxAbs, pointCount = #dedup,
    written = res.written, closedShape = res.closedShape,
  }
end

-- ---- auto_expression -----------------------------------------------------
-- 按**旋律走向**逐音符生成表情曲线 —— 而不是按乐句给一个固定值。
--
-- ⚠️ 用户 2026-10-02:"全参应该是参数随歌曲进行,情感等参数随这些动态变化的,
--    哪有一个调调唱完一首歌的。" ⇒ 分段常量不够,要**逐音符**。
--
-- ⚠️ 为什么在桥里算:527 个音符的 onset/pitch/duration 传回助手那边要 ~20KB,
--    撑爆上下文;而曲线本来就该由数据算出来,不需要助手"看"。
--
-- 规则(音乐上的常识,不是拍脑袋):
--   气声  上行 + · 长音 + · 乐句末 +
--   张力  下行 + · 大跳 + · 乐句末 −(收尾要松)
--   颤音  只给长音(≥2 拍),按长度递增;短音保持中性 1.0
--
-- args: { groupIndex?, trackIndex?, scale?=1.0,
--         breathMax?=0.12, tensionMax?=0.10, vibratoMax?=1.35,
--         dryRun?=true }
function OPS.auto_expression(args)
  args = args or {}
  local grp
  if args.groupIndex ~= nil or args.trackIndex ~= nil then
    local _, g2 = groupAt(args.trackIndex or 0, args.groupIndex or 0)
    grp = g2
  else
    local _, g1 = currentGroup()
    grp = g1
  end
  if grp == nil then error("找不到目标组") end
  local n = num(call(grp, "getNumNotes")) or 0
  if n == 0 then error("当前组没有音符") end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local notes = {}
  for i = 1, n do
    local nt = call(grp, "getNote", i)
    if nt ~= nil then
      notes[#notes + 1] = {
        onset = num(call(nt, "getOnset")) or 0,
        dur = num(call(nt, "getDuration")) or 0,
        pitch = num(call(nt, "getPitch")),
      }
    end
  end
  table.sort(notes, function(a, b) return a.onset < b.onset end)

  local scale = tonumber(args.scale) or 1.0
  local bMax = tonumber(args.breathMax) or 0.12
  local tMax = tonumber(args.tensionMax) or 0.10
  local vMax = tonumber(args.vibratoMax) or 1.35

  local bPts, tPts, vPts = {}, {}, {}
  for i = 1, #notes do
    local c = notes[i]
    local at = c.onset / QUARTER
    local durQ = c.dur / QUARTER
    local prev = notes[i - 1]
    local nxt = notes[i + 1]
    local step = 0
    if prev ~= nil and prev.pitch ~= nil and c.pitch ~= nil then
      step = c.pitch - prev.pitch
    end
    local isLast = (nxt == nil)

    -- 气声
    local b = 0
    if step > 0 then b = b + step * 0.012 end
    if durQ >= 2 then b = b + 0.03 end
    if durQ >= 4 then b = b + 0.02 end
    if isLast then b = b + 0.03 end
    if b > bMax then b = bMax end
    if b < 0 then b = 0 end

    -- 张力
    local t = 0
    if step < 0 then t = t + (-step) * 0.010 end
    if step <= -4 then t = t + 0.03 end
    if isLast then t = t - 0.03 end
    if t > tMax then t = tMax end
    if t < -tMax then t = -tMax end

    -- 颤音
    local v = 1.0
    if durQ >= 2 then
      v = 1.0 + math.min(durQ, 6) * 0.05
      if v > vMax then v = vMax end
    end

    bPts[#bPts + 1] = { at = at, value = math.floor(b * scale * 1000 + 0.5) / 1000 }
    tPts[#tPts + 1] = { at = at, value = math.floor(t * scale * 1000 + 0.5) / 1000 }
    vPts[#vPts + 1] = { at = at, value = math.floor(v * 1000 + 0.5) / 1000 }
  end

  local function dedup(pts)
    local seen, out = {}, {}
    for i = #pts, 1, -1 do
      local k = string.format("%.6f", pts[i].at)
      if not seen[k] then seen[k] = true; out[#out + 1] = pts[i] end
    end
    table.sort(out, function(a, b) return a.at < b.at end)
    return out
  end

  local bD, tD, vD = dedup(bPts), dedup(tPts), dedup(vPts)

  -- ⚠️ dry-run 要回**分布**而不是第一个点 —— 第一个点永远是 0/0/1.0(没有前一个音可比),
  --    看不出曲线到底长什么样(实测踩过:只回 sample 等于没回)。
  local function stats(pts)
    if #pts == 0 then return nil end
    local mn, mx, sum = pts[1].value, pts[1].value, 0
    local nz = 0
    for i = 1, #pts do
      local v = pts[i].value
      if v < mn then mn = v end
      if v > mx then mx = v end
      sum = sum + v
      if v ~= 0 then nz = nz + 1 end
    end
    return { min = mn, max = mx, mean = math.floor(sum / #pts * 10000 + 0.5) / 10000,
             nonZero = nz }
  end

  if args.dryRun ~= false then
    return {
      dryRun = true, noteCount = #notes,
      points = { breathiness = #bD, tension = #tD, vibratoEnv = #vD },
      stats = { breathiness = stats(bD), tension = stats(tD), vibratoEnv = stats(vD) },
      note = "只出计划。要真写把 dryRun 设为 false。三条曲线都按**逐音符**生成。",
    }
  end

  local r1 = OPS.set_automation({ type = "breathiness", points = bD,
                                  trackIndex = args.trackIndex, groupIndex = args.groupIndex })
  local r2 = OPS.set_automation({ type = "tension", points = tD,
                                  trackIndex = args.trackIndex, groupIndex = args.groupIndex })
  local r3 = OPS.set_automation({ type = "vibratoEnv", points = vD,
                                  trackIndex = args.trackIndex, groupIndex = args.groupIndex })
  return {
    dryRun = false,
    breathiness = r1.written, tension = r2.written, vibratoEnv = r3.written,
    noteCount = #notes,
  }
end

-- ---- check_lyrics --------------------------------------------------------
-- 歌词体检:**只返回有问题的音符**,不返回全量。
--
-- ⚠️ 为什么做成 op:用户 2026-10-02 的 letter song / LOVE 2000 都是 300~530 个音符,
--    把歌词全读回助手那边会**撑爆上下文**,而真正有用的只有"哪几处不对"。
--    这和 auto_tone_shift 只回统计量是同一个思路。
--
-- 两类问题:
--   ① **无效音素串** —— SV2 认不出音节时把内部记号漏进歌词字段,形如 `.k h` `.cl m`。
--      判据:含 `.`、空格、或 `cl`/`br` 之外的奇怪组合。
--   ② **和期望序列不一致** —— 给了 args.expected 才做。
--
-- args: { expected? = "a i wa do ko ...",   -- 空格分隔的音节序列(跳过 `-`/`br` 后逐位比对)
--         groupIndex?, trackIndex?,
--         includeBr? = false }              -- br 呼吸记号要不要算进序列(默认不算)
function OPS.check_lyrics(args)
  args = args or {}
  local grp
  if args.groupIndex ~= nil or args.trackIndex ~= nil then
    local _, g2 = groupAt(args.trackIndex or 0, args.groupIndex or 0)
    grp = g2
  else
    local _, g1 = currentGroup()
    grp = g1
  end
  if grp == nil then error("找不到目标组") end

  local n = num(call(grp, "getNumNotes")) or 0
  if n == 0 then error("当前组没有音符") end

  -- 期望序列(可选)
  local want = nil
  if type(args.expected) == "string" and #args.expected > 0 then
    want = {}
    for tok in args.expected:gmatch("%S+") do want[#want + 1] = tok end
  end

  local includeBr = args.includeBr == true
  local seq = {}          -- 参与比对的音节序列(含音符号,便于报位置)
  local bad = {}          -- ① 无效音素串
  local notes = {}

  for i = 1, n do
    local nt = call(grp, "getNote", i)
    if nt ~= nil then
      local ly = call(nt, "getLyrics")
      local onset = num(call(nt, "getOnset")) or 0
      ly = (type(ly) == "string") and ly or ""
      notes[#notes + 1] = { i = i, ly = ly, onset = onset }

      -- ① 无效音素串:含 `.` 或空格 ⇒ 一定是宿主漏出来的内部记号
      if ly:find("%.") ~= nil or ly:find("%s") ~= nil then
        bad[#bad + 1] = { index = i - 1, lyrics = ly }
      end

      -- 参与序列比对:跳过 `-`(连音),按需跳过 `br`(呼吸)
      local skip = (ly == "-") or (ly == "") or ((not includeBr) and (ly == "br"))
      if not skip then
        seq[#seq + 1] = { index = i - 1, lyrics = ly }
      end
    end
  end

  local diff = {}
  if want ~= nil then
    local m = #seq
    local k = #want
    local lim = math.max(m, k)
    for i = 1, lim do
      local got = seq[i] and seq[i].lyrics or nil
      local exp = want[i]
      if got ~= exp then
        diff[#diff + 1] = {
          slot = i,
          index = seq[i] and seq[i].index or nil,
          actual = got,
          expected = exp,
        }
        if #diff >= 200 then break end   -- 上限,免得整首全错时刷屏
      end
    end
  end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  for i = 1, #bad do
    for j = 1, #notes do
      if notes[j].i == bad[i].index + 1 then
        bad[i].atQuarter = notes[j].onset / QUARTER
        break
      end
    end
  end

  -- ② 给每处无效串附上**上下文**(前后各 ctx 个音符的歌词)。
  --    ⚠️ 为什么要这个:300~530 个音符的组,把歌词全读回助手那边会撑爆上下文;
  --    而助手要"推断该填什么",只需要看**出问题那几处的邻居**。
  local ctx = tonumber(args.context) or 0
  if ctx > 0 and #bad > 0 then
    if ctx > 20 then ctx = 20 end
    for i = 1, #bad do
      local b = bad[i]
      local lo = b.index + 1 - ctx
      local hi = b.index + 1 + ctx
      if lo < 1 then lo = 1 end
      if hi > #notes then hi = #notes end
      local win = {}
      for j = lo, hi do
        win[#win + 1] = {
          index = j - 1,
          lyrics = notes[j].ly,
          isProblem = (j - 1 == b.index),
        }
      end
      b.context = win
    end
  end

  return {
    noteCount = n,
    syllableCount = #seq,          -- 参与比对的音节数(已跳过 `-`)
    invalidCount = #bad,           -- ① 无效音素串
    invalid = bad,
    expectedCount = want and #want or nil,
    diffCount = want and #diff or nil,
    diff = want and diff or nil,   -- ② 和期望序列的差异
    note = "invalid 是**客观错误**(宿主漏出的音素记号)。diff 需要给 args.expected 才算。",
  }
end

-- ---- get_summary ---------------------------------------------------------
-- **只回统计量,不回明细。**
--
-- ⚠️ 为什么必须有它:300~530 个音符的组,`get_layout` / `quantize dryRun` 的明细
--    有 20~50 KB,会**撑爆助手的上下文**。而这个会话里"读不回来"至少出现了 4 次:
--      重叠数拿不到 · 歌词读不了 · 音符数据太大 · 曲线看不见
--    ⇒ 凡是"只要结论"的场景,都用这个。
--
-- 返回:音符数 · 音高范围 · 时值分布 · **重叠数** · 间隙数 · 音节数 · 无效歌词数
--
-- args: { trackIndex?, groupIndex? }
function OPS.get_summary(args)
  args = args or {}
  local grp
  if args.groupIndex ~= nil or args.trackIndex ~= nil then
    local _, g2 = groupAt(args.trackIndex or 0, args.groupIndex or 0)
    grp = g2
  else
    local _, g1 = currentGroup()
    grp = g1
  end
  if grp == nil then error("找不到目标组") end

  local n = num(call(grp, "getNumNotes")) or 0
  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  if n == 0 then
    return { groupName = call(grp, "getName"), noteCount = 0, empty = true }
  end

  local notes = {}
  local pMin, pMax = nil, nil
  local syll, brCount, invalid = 0, 0, 0
  local totalDur = 0
  for i = 1, n do
    local nt = call(grp, "getNote", i)
    if nt ~= nil then
      local onset = num(call(nt, "getOnset")) or 0
      local dur = num(call(nt, "getDuration")) or 0
      local pitch = num(call(nt, "getPitch"))
      local ly = call(nt, "getLyrics")
      ly = (type(ly) == "string") and ly or ""
      notes[#notes + 1] = { onset = onset, dur = dur, pitch = pitch }
      totalDur = totalDur + dur
      if pitch ~= nil then
        if pMin == nil or pitch < pMin then pMin = pitch end
        if pMax == nil or pitch > pMax then pMax = pitch end
      end
      if ly == "br" then
        brCount = brCount + 1
      elseif ly ~= "-" and ly ~= "" then
        syll = syll + 1
      end
      if ly:find("%.") ~= nil or ly:find("%s") ~= nil then invalid = invalid + 1 end
    end
  end
  table.sort(notes, function(a, b) return a.onset < b.onset end)

  -- 重叠 / 间隙(按 onset 排序后逐对比较)
  local overlaps, gaps = 0, 0
  local worstOverlap = 0
  for i = 2, #notes do
    local prevEnd = notes[i - 1].onset + notes[i - 1].dur
    local gap = notes[i].onset - prevEnd
    if gap < 0 then
      overlaps = overlaps + 1
      local q = -gap / QUARTER
      if q > worstOverlap then worstOverlap = q end
    elseif gap > 0 then
      gaps = gaps + 1
    end
  end

  local spanStart = notes[1].onset / QUARTER
  local spanEnd = (notes[#notes].onset + notes[#notes].dur) / QUARTER

  return {
    groupName = call(grp, "getName"),
    noteCount = n,
    pitch = { min = pMin, max = pMax, span = (pMin and pMax) and (pMax - pMin) or nil },
    span = { startQuarter = spanStart, endQuarter = spanEnd,
             lengthQuarter = spanEnd - spanStart },
    duration = { totalQuarter = totalDur / QUARTER,
                 meanQuarter = totalDur / QUARTER / n },
    lyrics = { syllableCount = syll, breathCount = brCount, invalidCount = invalid },
    layout = { overlapCount = overlaps, worstOverlapQuarter = worstOverlap, gapCount = gaps },
    note = "只回统计量。要明细用 get_layout(⚠️ 大组会很大)。",
  }
end

-- ---- get_layout ----------------------------------------------------------
-- 读当前组的**布局体检报告**(只读,不改任何东西)。
--
-- ⚠️ 为什么必须有它:**SV2 里同一组内音符重叠是违规的** —— 会导致发音异常、
--    宿主行为不可预期。写音符(尤其 write_notes / split_notes)之后应当查一次。
--    参考项目把这个单独做成一个工具,并在描述里写明"重叠 = 违规,必须报给用户"。
-- args: { scope = "group"|"selection" }
function OPS.get_layout(args)
  args = args or {}
  local scope = tostring(args.scope or "group")
  local raw = {}
  local groupName = nil
  if scope == "selection" then
    raw = selectedNotes()
  else
    local _, grp = currentGroup()
    if grp == nil then error("no current group") end
    groupName = call(grp, "getName")
    local n = num(call(grp, "getNumNotes")) or 0
    for i = 1, n do
      local nt = call(grp, "getNote", i)
      if nt ~= nil then raw[#raw + 1] = nt end
    end
  end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local list = {}
  for i = 1, #raw do
    local nt = raw[i]
    list[#list + 1] = {
      index = i - 1,
      onset = num(call(nt, "getOnset")) or 0,
      duration = num(call(nt, "getDuration")) or 0,
      pitch = num(call(nt, "getPitch")),
      lyrics = call(nt, "getLyrics"),
    }
  end
  table.sort(list, function(a, b)
    if a.onset == b.onset then return a.index < b.index end
    return a.onset < b.onset
  end)

  local overlaps, gaps = {}, {}
  for i = 1, #list - 1 do
    local a, b = list[i], list[i + 1]
    local aEnd = a.onset + a.duration
    if aEnd > b.onset then
      overlaps[#overlaps + 1] = {
        aIndex = a.index, bIndex = b.index,
        overlapQuarter = (aEnd - b.onset) / QUARTER,
        aPitch = a.pitch, bPitch = b.pitch,
        aEndQuarter = aEnd / QUARTER, bOnsetQuarter = b.onset / QUARTER,
      }
    elseif b.onset > aEnd then
      gaps[#gaps + 1] = {
        aIndex = a.index, bIndex = b.index,
        gapQuarter = (b.onset - aEnd) / QUARTER,
      }
    end
  end

  local spanStart, spanEnd = 0, 0
  if #list > 0 then
    spanStart = list[1].onset
    spanEnd = list[1].onset + list[1].duration
    for i = 2, #list do
      local e = list[i].onset + list[i].duration
      if e > spanEnd then spanEnd = e end
    end
  end

  local layout = {}
  for i = 1, #list do
    layout[#layout + 1] = {
      index = list[i].index,
      onsetQuarter = list[i].onset / QUARTER,
      durationQuarter = list[i].duration / QUARTER,
      pitch = list[i].pitch,
      lyrics = list[i].lyrics,
    }
  end

  return {
    scope = scope,
    groupName = groupName,
    noteCount = #list,
    spanStartQuarter = spanStart / QUARTER,
    spanEndQuarter = spanEnd / QUARTER,
    overlapCount = #overlaps,
    overlaps = overlaps,
    gapCount = #gaps,
    gaps = gaps,
    layout = layout,
    verdict = (#overlaps == 0) and "OK:无重叠" or
      ("⚠️ 违规:有 " .. #overlaps .. " 处音符重叠。SV2 同组内不允许重叠,可能导致发音异常。"),
  }
end

-- ---- panel_ask -----------------------------------------------------------
-- 让面板弹出**可点的选项按钮**。
--
-- ⚠️ 用户 2026-10-02 的要求:"在 sv2 作业时,为了追求效率,大多数情况下应该给选项
--    让用户选择" —— 开放式提问(让用户在输入框里手打)在 SV2 里效率太低。
--    所以助手需要决策时,应当**推一组选项到面板上让用户点**。
--
-- args: { prompt, choices = ["...", ...], id? }
--
-- ⚠️ 面板推送函数定义在后面的"面板中继"一节,而 Lua 的局部变量必须先定义 ——
--    所以这里用一个**前置声明的引用** `PANEL_ASK_PUSH`,由中继那边赋值。
local PANEL_ASK_PUSH = nil

function OPS.panel_ask(args)
  args = args or {}
  local prompt = tostring(args.prompt or "请选择")
  local choices = args.choices
  if type(choices) ~= "table" or #choices == 0 then
    error("args.choices 必须是非空数组")
  end
  if #choices > 8 then error("最多 8 个选项(侧栏放不下)") end
  local clean = {}
  for i = 1, #choices do clean[i] = tostring(choices[i]) end
  if PANEL_ASK_PUSH == nil then
    error("面板推送通道不可用 —— 面板没启用,或者本宿主没有侧栏")
  end
  local id = tostring(args.id or ("q" .. tostring(os.time())))
  local msg = { ctl = "ask", id = id, prompt = prompt, choices = clean }
  local encOk, text = pcall(jenc, msg)
  if not encOk or type(text) ~= "string" then error("选项编码失败") end
  PANEL_ASK_PUSH(text)
  return { asked = true, id = id, prompt = prompt, choices = clean }
end

-- ---- stop ----------------------------------------------------------------
function OPS.stop()
  log("stop: 桥按请求退出(改完源码后需要重跑本脚本)")
  return { stopping = true, bridge = BRIDGE_VERSION }
end

for name in pairs(OPS) do OP_NAMES[#OP_NAMES + 1] = name end
table.sort(OP_NAMES)

-- ============================================================================
-- 6. 面板中继(面板没有文件能力,只能靠 project scriptData 说话)
--
-- ⚠️ 两条硬纪律(用户 2026-10-02 明确要求「面板一重载就清空,.svp 里不留任何东西」):
--   1. **所有中继键都是临时的**:写完 → 对端消费 → 立刻 removeScriptData。
--      静止状态下,工程里不残留本插件的任何键。
--   2. **绝不做周期性写入**。曾经的"状态镜像"每 ~1 秒写一次 scriptData ——
--      那等于一直在动用户的工程数据(而且会让工程长期处于"已修改"状态)。
--      现在状态改成**按需 ping**:面板加载时问一次,用户点「刷新」再问一次。
-- ============================================================================

local PANEL = {
  K = {
    out = "svdsh.panel.out",   -- 面板 → 桥(桥消费后**立即删除**)
    -- ⚠️ `in` 是 Lua 保留字,当表键必须加方括号
    ["in"] = "svdsh.panel.in", -- 桥 → 面板(面板消费后**立即删除**)
  },
  enabled = false,
  outQueue = {},   -- 待送给面板的文本,只存在内存里
}

local function sdGet(key)
  local proj = project()
  if proj == nil then return nil end
  local ok, v = pcall(function() return proj:getScriptData(key) end)
  if not ok then return nil end
  return v
end

local function sdSet(key, value)
  local proj = project()
  if proj == nil then return false end
  local ok = pcall(function() proj:setScriptData(key, value) end)
  return ok
end

-- 删键:这是"不残留"的关键。removeScriptData 不存在时退化成写空串。
local function sdRemove(key)
  local proj = project()
  if proj == nil then return false end
  if has(proj, "removeScriptData") then
    return pcall(function() proj:removeScriptData(key) end)
  end
  return pcall(function() proj:setScriptData(key, "") end)
end

local function panelDetect()
  local proj = project()
  if proj == nil then return false end
  return has(proj, "getScriptData") and has(proj, "setScriptData")
end

-- 工程切换检测
--
-- 面板日志只活在内存里,所以"换工程"**不会**自动清空 —— 面板脚本没有重新加载,
-- 它的内存还在。要让面板知道工程换了,只能由桥告诉它。
--
-- ⚠️ 第一版用 Project userdata 的**引用相等**(rawequal)。实测**不可用**:
--    本机 SV2 2.3.0tp1 的 Lua 绑定每次调用都新建包装,
--    `rawequal(SV:getProject(), SV:getProject()) == false`(自检抓到了,日志里有记录)。
--
-- 改用**内容指纹**:第一组的 UUID。它随机生成、跟着工程走、**编辑时不变**。
-- ⚠️ 千万别把 getDuration() / getNumTracks() 算进来 ——
--    用户每加一个音符时长就变,那会变成"一编辑就清空面板"。
local function projectFingerprint()
  local proj = project()
  if proj == nil then return nil end

  local track = call(proj, "getTrack", 1)
  if track ~= nil then
    local ref = call(track, "getGroupReference", 1)
    if ref ~= nil then
      local grp = call(ref, "getTarget")
      if grp ~= nil then
        local uuid = call(grp, "getUUID")
        if type(uuid) == "string" and #uuid > 0 then return "g:" .. uuid end
      end
    end
  end

  -- 没有任何组时退化到文件名(未保存的新工程文件名为空 ⇒ 这种情况检测不了,如实返回 nil)
  local name = call(proj, "getFileName")
  if type(name) == "string" and #name > 0 then return "f:" .. name end
  return nil
end

-- 自检:指纹必须同一时刻连取两次都一样,否则判据不可用
-- (宁可不自动清空,也不能反复误清)
local function projectFingerprintReliable()
  local a = projectFingerprint()
  local b = projectFingerprint()
  return a ~= nil and b ~= nil and a == b
end

-- 排一行给面板(**不落盘**:只在内存队列里等面板来取)
local function panelAppend(text)
  local t = tostring(text or "")
  if #t == 0 then return end
  PANEL.outQueue[#PANEL.outQueue + 1] = t
  -- 面板没开时别无限攒
  while #PANEL.outQueue > 200 do table.remove(PANEL.outQueue, 1) end
end

-- 把"推选项给面板"的通道接上。
-- ⚠️ `PANEL_ASK_PUSH` 是**前置声明**在 OPS.panel_ask 那一节的局部变量 ——
--    因为 Lua 的局部变量必须先定义,而 OPS 那一节在面板中继之前。
PANEL_ASK_PUSH = panelAppend

-- 告诉面板"工程换了,清空你的日志"
local function panelTellClear()
  PANEL.outQueue = {}          -- 旧工程排队中的内容丢掉,别串味
  panelAppend('{"ctl":"clear"}')
end

-- 面板可以**直连**调用的 op 白名单。
--
-- ⚠️ 为什么要有这条通路:调参滑条要"拖一下立刻生效",绕一趟 DSH(经过模型)既慢又
--    会把聊天记录刷满。但也不能让面板调任何 op —— 面板是个窄侧栏 UI,误触代价太大。
--    ⇒ 只放"只读 + 改本组声音属性"这一类,而且每个都自带撤销记录。
--    其余一切(对齐音频、量化、写音符…)仍然走 DSH,因为那些要么需要音频分析,
--    要么需要"先看计划再决定"。
local PANEL_OP_OK = {
  get_context = true,
  get_voice = true,
  set_voice = true,
  list_voice_presets = true,
  list_voices = true,
}

-- 把一次"面板直连 op"的结果回给面板(走同一条 inbox 通道,带 ctl 标记)
local function panelTellOp(reqId, ok, result, err)
  local msg = { ctl = "opResult", reqId = reqId, ok = ok and true or false }
  if ok then msg.result = result else msg.error = tostring(err or "unknown") end
  local encOk, text = pcall(jenc, msg)
  if encOk and type(text) == "string" then panelAppend(text) end
end

-- 把队列里的一行放进槽位(槽位空着才写)
local function panelFlush()
  if not PANEL.enabled then return 0 end
  if #PANEL.outQueue == 0 then return 0 end
  local slot = sdGet(PANEL.K["in"])
  if type(slot) == "string" and #slot > 0 then return 0 end   -- 上一条还没被面板取走
  local line = table.remove(PANEL.outQueue, 1)
  sdSet(PANEL.K["in"], line)
  return 1
end

-- 面板 → 文件:转发一条事件,然后**立刻删掉键**
local function panelDrainOutbox()
  if not PANEL.enabled then return 0 end
  local raw = sdGet(PANEL.K.out)
  if type(raw) ~= "string" or #raw == 0 then return 0 end
  -- 先取走再处理:无论解析成败,这个键都必须消失
  sdRemove(PANEL.K.out)
  local ok, ev = pcall(jdec, raw)
  if not ok or type(ev) ~= "table" then return 0 end

  if ev.kind == "status" then
    -- 面板按需问"桥在不在",回答排进队列(不落盘)
    panelAppend(string.format("· 桥 %s 已连接(SV %s)", BRIDGE_VERSION, tostring(ST.hostVer)))
    return 1
  end

  -- 面板 → 桥的**直连 op**(白名单,见 PANEL_OP_OK)
  if ev.kind == "op" then
    local name = tostring(ev.op or "")
    if not PANEL_OP_OK[name] then
      panelTellOp(ev.reqId, false, nil, "面板不允许直接调用 op:" .. name)
      return 1
    end
    local fn = OPS[name]
    if type(fn) ~= "function" then
      panelTellOp(ev.reqId, false, nil, "没有这个 op:" .. name)
      return 1
    end
    -- ⚠️ 整段包 pcall:面板直连也不能把宿主搞崩
    local ok2, res = pcall(fn, ev.args or {})
    if ok2 then
      panelTellOp(ev.reqId, true, res, nil)
    else
      panelTellOp(ev.reqId, false, nil, tostring(res))
    end
    return 1
  end

  if #raw > CFG.CHAT_MAX then return 0 end
  appendLine(PATH.chatIn, raw, CFG.CHAT_MAX)
  return 1
end

-- DSH → 面板:读 chat-out.json 的新内容,排进内存队列
local function panelDrainInbox()
  if not PANEL.enabled then return 0 end
  local raw = readFile(PATH.chatOut)
  if raw == nil or #raw == 0 then return 0 end
  local ok, msg = pcall(jdec, raw)
  if not ok or type(msg) ~= "table" then return 0 end
  local rev = tostring(msg.rev or "")
  if rev == ST.lastChatOutRev then return 0 end
  ST.lastChatOutRev = rev
  if type(msg.text) == "string" and #msg.text > 0 then
    panelAppend(msg.text)
    return 1
  end
  return 0
end

-- ============================================================================
-- 7. 请求/响应
-- ============================================================================

local function rememberResponse(key, text)
  if ST.done[key] == nil then ST.order[#ST.order + 1] = key end
  ST.done[key] = text
  while #ST.order > CFG.MAX_DONE do
    local oldest = table.remove(ST.order, 1)
    ST.done[oldest] = nil
  end
end

local function consumeReq(snapshot)
  -- ⚠️ 只在"文件内容仍等于读到的快照"时删:客户端是原子 rename 写入,避免误删新请求。
  local cur = readFile(PATH.req)
  if cur ~= nil and cur == snapshot then
    pcall(function() os.remove(PATH.req) end)
  end
end

local function respond(req, ok, payload)
  local res = {
    v = PROTOCOL,
    id = req.id,
    seq = req.seq,
    ok = ok and true or false,
    ts = os.time(),
    host = ST.host,
  }
  if ok then res.result = payload else res.error = tostring(payload) end
  local text = jenc(res)
  -- ⚠️ 先登记再写文件:即使写失败,重试同一个 id 也能命中缓存
  rememberResponse(tostring(req.id), text)
  writeAtomic(PATH.res, text)
end

-- 面包屑:被模态框冻住时,能看出是哪个 op 卡住的
local function writeLastOp(stage, req)
  pcall(function()
    writeAtomic(PATH.dir .. "\\svdsh-lastop-sv.json", jenc({
      stage = stage, id = req and req.id, op = req and req.op,
      session = ST.session, reqSeen = ST.reqSeen, opsRun = ST.opsRun, ts = os.time(),
    }))
  end)
end

local function pollOnce()
  local f = io.open(PATH.req, "r")
  if not f then return false end
  local text = f:read("*a")
  f:close()
  if text == nil or #text == 0 then return false end

  local okParse, req = pcall(jdec, text)
  if not okParse or type(req) ~= "table" or req.id == nil or req.op == nil then
    log("bad request JSON ⇒ 丢弃该请求文件(避免每拍重读)")
    -- 参考实现在这里**不消费**,于是一份坏 JSON 会被每拍重读、每拍记一行日志。
    -- 我们改成"快照相同才删",坏请求只处理一次。
    consumeReq(text)
    return false
  end

  local idKey = tostring(req.id)
  if ST.done[idKey] ~= nil then
    writeAtomic(PATH.res, ST.done[idKey])
    consumeReq(text)
    return false
  end

  if idKey == ST.lastId and ST.done[idKey] == nil then
    respond(req, false, "duplicate request id (response evicted from cache)")
    consumeReq(text)
    return false
  end

  local op = OPS[req.op]
  if op == nil then
    respond(req, false, "unknown op: " .. tostring(req.op) .. " (available: " .. table.concat(OP_NAMES, ", ") .. ")")
    consumeReq(text)
    return false
  end

  ST.reqSeen = ST.reqSeen + 1
  ST.lastId = idKey
  writeLastOp("running", req)
  -- ⚠️ pcall 拦不住宿主弹的模态框(那是 C 侧在实参转换阶段弹的)。
  --    这里的 pcall 只用来把**我们自己的** Lua 错误变成一条 ok:false 响应。
  local okRun, result = pcall(op, req.args or {})
  ST.opsRun = ST.opsRun + 1
  writeLastOp("done", req)

  if okRun then
    respond(req, true, result)
  else
    respond(req, false, tostring(result))
  end
  consumeReq(text)

  if req.op == "stop" then ST.stopping = true end
  return true
end

-- ============================================================================
-- 8. 心跳 / 主循环
-- ============================================================================

local function writeHeartbeat()
  writeAtomic(PATH.hb, jenc({
    host = ST.host,
    hostName = ST.hostName,
    version = ST.hostVer,            -- ⚠️ 这是**宿主**版本
    hostVersionNumber = ST.hostVerNum,
    isSV2 = ST.isSV2,
    indexBase = ST.indexBase,
    dir = ST.dir,
    bridge = BRIDGE_VERSION,         -- 桥自己的版本在这里
    protocol = PROTOCOL,
    lua = ST.lua,
    timer = ST.timerWhere,
    ops = OP_NAMES,
    panel = PANEL.enabled,
    session = ST.session,
    reqSeen = ST.reqSeen,
    opsRun = ST.opsRun,
    ticks = ST.ticks,                -- "轮询链还活着"的证据
    pollErrors = ST.pollErrors,
    ts = os.time(),
  }))
end

local function scheduleLoop()
  -- ⚠️ 轮询、面板中继、心跳**必须共用这一条链**。
  --    拆成多条会出「心跳照常跳、轮询已经死」的静默故障。
  pcall(function()
    local ok, err = pcall(pollOnce)
    if not ok then
      ST.pollErrors = ST.pollErrors + 1
      log("pollOnce error: " .. tostring(err))
    end

    ST.ticks = ST.ticks + 1

    if ST.ticks % CFG.RELAY_EVERY == 0 then
      pcall(panelDrainOutbox)
      pcall(panelDrainInbox)
      pcall(panelFlush)
    end

    -- 换工程检测:面板日志只在内存里,换工程不会重载面板脚本 ⇒ 由桥通知它清空。
    -- 只在自检通过时才做,否则会误判成"每两秒换一次工程"。
    if ST.projIdentityOk and ST.ticks % 8 == 0 then
      pcall(function()
        local fp = projectFingerprint()
        if fp ~= nil and ST.projFp ~= nil and fp ~= ST.projFp then
          ST.projFp = fp
          panelTellClear()
          log("检测到工程切换(" .. fp .. ")⇒ 已通知面板清空")
        end
      end)
    end
    -- ⚠️ 这里**曾经**每 4 拍写一次 scriptData 做"状态镜像"。已删除:
    --    周期性写工程数据会让工程长期处于"已修改"状态,而且和"不残留"直接冲突。
    --    状态改为面板按需 ping(见 panelDrainOutbox 的 kind == "status" 分支)。

    local every = math.max(1, math.floor(CFG.HB_MS / CFG.POLL_MS))
    if ST.ticks % every == 0 then pcall(writeHeartbeat) end

    if ST.stopping then
      pcall(function() os.remove(PATH.hb) end)   -- 主动删心跳,让对端立刻判离线
      log("桥已停止")
      if SV and has(SV, "finish") then pcall(function() SV:finish() end) end
      return
    end
  end)

  -- 重排自己:唯一会静默断链的地方,所以失败要留痕
  local ok = false
  if ST.timerWhere == "SV" then
    ok = pcall(function() ST.timerFn(SV, CFG.POLL_MS, scheduleLoop) end)
  else
    ok = pcall(function() ST.timerFn(CFG.POLL_MS, scheduleLoop) end)
  end
  if not ok then log("⚠️ 定时器重排失败 ⇒ 轮询链断了,对端会因心跳过期判离线") end
end

local function detectTimer()
  if has(SV, "setTimeout") then
    return "SV", SV.setTimeout
  end
  if type(setTimeout) == "function" then
    return "global", setTimeout
  end
  if has(SV, "setInterval") then
    return "SV", SV.setInterval
  end
  if type(setInterval) == "function" then
    return "global", setInterval
  end
  return nil, nil
end

-- ============================================================================
-- 9. 启动
-- ============================================================================

function getClientInfo()
  return {
    name = "DSH Bridge",
    category = "DSH",
    author = "dsh-sv-bridge",
    versionNumber = 1,
    -- 只用 SV2 侧栏(131330 = 2.1.2)才需要高版本;桥本身是菜单脚本,取低值更稳。
    minEditorVersion = 65540,
  }
end

local function fatal(reason, extra)
  local payload = {
    ok = false, reason = tostring(reason), bridge = BRIDGE_VERSION, lua = _VERSION,
    dir = ST.dir or (os.getenv and (os.getenv("TEMP") or "")) or "",
    timer = ST.timerWhere, ts = os.time(),
  }
  if type(extra) == "table" then
    for k, v in pairs(extra) do payload[k] = v end
  end
  -- ⚠️ 只写文件与日志,**绝不弹信息框**(弹框会冻住宿主,而且用户可能看不到)
  pcall(function()
    local dir = ST.dir or (os.getenv and os.getenv("TEMP"))
    if dir then writeAtomic(dir .. "\\svdsh-boot-sv.json", jenc(payload)) end
  end)
  log("FATAL: " .. tostring(reason))
end

function main()
  ST.session = os.time()

  if type(io) ~= "table" or type(io.open) ~= "function" then
    return fatal("io.open 不可用 —— 本脚本没有文件能力,文件通道不成立")
  end

  local dir = pickDir()
  if dir == nil then
    return fatal("找不到可写的通道目录。Lua 不能 mkdir,桥只能挑一个**已存在**的目录。" ..
                 "请任选其一:① 运行 sv-dsh\\install-sv-scripts.ps1(它会建目录);" ..
                 "② 在 DSH 里装好 dsh-sv-bridge 插件并让它激活一次(插件会建);" ..
                 "③ 手工建 %USERPROFILE%\\.dsh\\sv-bridge 或 %TEMP%\\dsh-sv-bridge")
  end
  ST.dir = dir
  buildPaths(dir)

  ST.timerWhere, ST.timerFn = detectTimer()
  if ST.timerFn == nil then
    return fatal("找不到任何定时器(SV.setTimeout / setTimeout),桥无法常驻")
  end

  -- 宿主信息(只读字段 + 一个已知安全的调用)
  local info = SC("getHostInfo")
  if type(info) == "table" then
    ST.hostName = tostring(info.hostName or "?")
    ST.hostVer = tostring(info.hostVersion or "?")
    ST.hostVerNum = tonumber(info.hostVersionNumber) or 0
    ST.host = (string.find(ST.hostName, "Instrument", 1, true) ~= nil) and "ix" or "sv"
    ST.isSV2 = (ST.hostVerNum >= 131072) or (ST.host == "ix")
  end

  PANEL.enabled = panelDetect()
  -- 换工程检测的初始化 + 自检(判据不可用就整个关掉,宁可不自动清空,也不能反复误清)
  ST.projFp = projectFingerprint()
  ST.projIdentityOk = projectFingerprintReliable()
  log("工程指纹 = " .. tostring(ST.projFp) .. "  判据可用 = " .. tostring(ST.projIdentityOk))
  -- ⚠️ 不恢复任何"落盘状态":面板日志只活在面板内存里,
  --    中继键在静止状态下必须是空的。这里只做一次**清理**,
  --    把旧版本(0.1.0 早期)可能留在工程里的键删掉。
  if PANEL.enabled then
    for _, legacy in ipairs({
      "svdsh.panel.log", "svdsh.panel.inRev", "svdsh.panel.outSeq",
      "svdsh.panel.ackSeq", "svdsh.panel.ready",
      "svdsh.panel.bridgeAt", "svdsh.panel.bridgeVer",
      PANEL.K.out, PANEL.K["in"],
    }) do
      pcall(sdRemove, legacy)
    end
  end

  -- 清残留:上一次运行留下的 res / req 会让本轮读到脏数据
  pcall(function()
    os.remove(PATH.res)
    os.remove(PATH.res .. ".tmp")
    os.remove(PATH.req)
  end)

  log("bridge " .. BRIDGE_VERSION .. " 启动 dir=" .. dir .. " host=" .. ST.hostName ..
      " " .. ST.hostVer .. " lua=" .. _VERSION .. " timer=" .. tostring(ST.timerWhere) ..
      " panel=" .. tostring(PANEL.enabled))

  writeAtomic(PATH.boot, jenc({
    ok = true, bridge = BRIDGE_VERSION, protocol = PROTOCOL, host = ST.host,
    hostName = ST.hostName, hostVersion = ST.hostVer, hostVersionNumber = ST.hostVerNum,
    isSV2 = ST.isSV2, indexBase = ST.indexBase, dir = dir, lua = _VERSION,
    timer = ST.timerWhere, panel = PANEL.enabled, ops = OP_NAMES, ts = os.time(),
  }))

  if PANEL.enabled then panelAppend("DSH 桥 " .. BRIDGE_VERSION .. " 已连接(" .. ST.hostVer .. ")") end

  writeHeartbeat()     -- 立刻写一次,别让对端等一个心跳周期
  scheduleLoop()
end

-- ============================================================================
-- 10. 离线测试钩子
--     真机没法"试错"(Lua 绑定的错误穿透 pcall、直接弹模态框冻住宿主),
--     所以能离线跑的部分必须先跑绿。用法:在跑测试前定义全局 `SVDSH_TEST = {}`,
--     加载本文件后即可拿到内部函数与状态。生产环境里这个块**不会执行**。
-- ============================================================================
if type(SVDSH_TEST) == "table" then
  SVDSH_TEST.jenc = jenc
  SVDSH_TEST.jdec = jdec
  SVDSH_TEST.hash32 = hash32
  SVDSH_TEST.noteFp = noteFp
  SVDSH_TEST.selectionFp = selectionFp
  SVDSH_TEST.selectedNotes = selectedNotes
  SVDSH_TEST.call = call
  SVDSH_TEST.has = has
  SVDSH_TEST.OPS = OPS
  SVDSH_TEST.OP_NAMES = OP_NAMES
  SVDSH_TEST.pollOnce = pollOnce
  SVDSH_TEST.writeHeartbeat = writeHeartbeat
  SVDSH_TEST.pickDir = pickDir
  SVDSH_TEST.buildPaths = buildPaths
  SVDSH_TEST.CFG = CFG
  SVDSH_TEST.ST = ST
  SVDSH_TEST.PATH = PATH
  SVDSH_TEST.main = main
  SVDSH_TEST.getClientInfo = getClientInfo
  SVDSH_TEST.BRIDGE_VERSION = BRIDGE_VERSION
end
