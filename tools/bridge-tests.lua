--[[
bridge-tests.lua — the Lua half of the offline test harness.
================================================================================
Loaded AFTER DSHBridge.lua. Uses the bridge's own SVDSH_TEST hooks plus the
fake host's control surface (FAKE).

Tests 1-3 are self-contained and report through __report().
Tests 4-12 are driven from harness.mjs (which reads the real files off disk and
feeds request files in) and call the __T_* wrappers defined below.
]]

local T = SVDSH_TEST
local H = FAKE

local function rep(id, name, ok, detail) __report(id, name, ok and true or false, detail or "") end

-- ===========================================================================
-- T1 — JSON codec round-trip
-- ===========================================================================
local function T1()
  local jenc, jdec = T.jenc, T.jdec
  local fails, n = {}, 0
  local function eq(label, got, want)
    n = n + 1
    if got ~= want then
      fails[#fails + 1] = string.format("%s (got %s / want %s)", label, tostring(got), tostring(want))
    end
  end
  local function truthy(label, v)
    n = n + 1
    if not v then fails[#fails + 1] = label .. " (got " .. tostring(v) .. ")" end
  end

  -- (a) 16-digit integer: %.14g turns this into 1.78917538422e+15 and loses the
  --     last digits, so the client can never match the seq again.
  local BIG = 1789175384220009
  local enc = jenc(BIG)
  eq("bigint encoded text", enc, "1789175384220009")
  local dec = jdec(enc)
  eq("bigint decoded type", type(dec), "number")
  eq("bigint decoded value", dec, BIG)
  eq("bigint re-encoded", string.format("%.0f", dec), "1789175384220009")
  -- negative control: if this ever stops holding, the test above is vacuous
  truthy("negative control (%.14g must lose the value)",
         tonumber(string.format("%.14g", BIG)) ~= BIG)

  -- (b) strings
  local strs = {
    'quote " and backslash \\',
    "new\nline\ttab\r\nend",
    "中文歌词 · 你好，世界",
    "ctl\1\2\0end",
  }
  for i = 1, #strs do
    local r = jdec(jenc(strs[i]))
    eq("string[" .. i .. "] type", type(r), "string")
    eq("string[" .. i .. "] round-trip", r, strs[i])
    eq("string[" .. i .. "] byte length", #r, #strs[i])
  end
  eq("quote is escaped", jenc('a"b'), '"a\\"b"')
  eq("backslash is escaped", jenc("a\\b"), '"a\\\\b"')

  -- (c) nested objects / arrays
  local nested = { a = { b = { c = { 1, 2, 3 } } }, d = { { x = 1 }, { x = 2 } }, e = true, f = false, g = "s" }
  local rt = jdec(jenc(nested))
  eq("nested a.b.c[2]", rt.a.b.c[2], 2)
  eq("nested a.b.c len", #rt.a.b.c, 3)
  eq("nested #d", #rt.d, 2)
  eq("nested d[2].x", rt.d[2].x, 2)
  eq("nested e", rt.e, true)
  eq("nested f", rt.f, false)
  eq("nested g", rt.g, "s")
  eq("array encoded text", jenc({ 1, 2, 3 }), "[1,2,3]")
  eq("object encoded text", jenc({ a = 1 }), '{"a":1}')

  -- (d) booleans
  eq("encode true", jenc(true), "true")
  eq("encode false", jenc(false), "false")
  eq("decode true", jdec("true"), true)
  eq("decode false", jdec("false"), false)
  eq("decode bool type", type(jdec("false")), "boolean")

  -- (e) empty object / empty array
  --     Lua cannot tell {} from {}, so both encode as []; what matters is that
  --     both decode to an empty table and survive a round-trip.
  eq("empty encodes as []", jenc({}), "[]")
  truthy("decode [] is empty", next(jdec("[]")) == nil)
  truthy("decode {} is empty", next(jdec("{}")) == nil)
  truthy("round-trip {} is empty", next(jdec(jenc({}))) == nil)
  eq("nested empty encodes as []", jenc({ a = {} }), '{"a":[]}')
  truthy("nested empty round-trip", next(jdec(jenc({ a = {} })).a) == nil)

  -- (f) floats
  eq("encode 0.5", jenc(0.5), "0.5")
  eq("decode 0.5", jdec("0.5"), 0.5)
  eq("round-trip 0.5", jdec(jenc(0.5)), 0.5)
  eq("encode 2.0", jenc(2.0), "2")           -- integral floats take the %.0f branch
  eq("decode 2", jdec("2"), 2)
  eq("decode negative", jdec("-17"), -17)
  eq("decode 1.5", jdec("1.5"), 1.5)

  -- Non-integral numbers go through %.10g. W2 regression guard: the old %.6g
  -- turned 1234.5678 into 1234.57 (6 significant digits).
  eq("encode 1234.5678 with 10 significant digits", jenc(1234.5678), "1234.5678")
  eq("round-trip 1234.5678", jdec(jenc(1234.5678)), 1234.5678)
  truthy("1234.5678 is not truncated to 6 digits", jenc(1234.5678) ~= "1234.57")
  -- a real blick -> quarter report value (1000000 / 705600000):
  -- %.10g keeps ~1e-11 relative error, %.6g was ~2.5e-6
  local x = 1000000 / 705600000
  local ex = jenc(x)
  truthy("blick->quarter keeps <=1e-9 relative error (old %.6g was ~2.5e-6)",
         math.abs(jdec(ex) - x) <= math.abs(x) * 1e-9)

  if #fails == 0 then
    rep("1", "JSON codec round-trip", true, n .. " assertions")
  else
    rep("1", "JSON codec round-trip", false, table.concat(fails, " | "))
  end
end

-- ===========================================================================
-- T2 — hash32
-- ===========================================================================
local function T2()
  local h = T.hash32
  local fails, n = {}, 0
  local function eq(label, got, want)
    n = n + 1
    if got ~= want then
      fails[#fails + 1] = string.format("%s (got %s / want %s)", label, tostring(got), tostring(want))
    end
  end
  local function truthy(label, v)
    n = n + 1
    if not v then fails[#fails + 1] = label .. " (got " .. tostring(v) .. ")" end
  end

  local a1, a2 = h("hello"), h("hello")
  eq("deterministic across calls", a1, a2)
  eq("length", #a1, 8)
  truthy("lowercase hex shape", a1:match("^%x%x%x%x%x%x%x%x$") ~= nil)
  -- djb2 vectors (independently computed): prove the hash is not garbage AND
  -- that the harness's 64-bit-integer shim does not corrupt the arithmetic
  eq("djb2('hello')", a1, "0f923099")
  eq("djb2('')", h(""), "00001505")
  truthy("differs for different input", h("hello") ~= h("hellp"))
  truthy("differs for long input", h(string.rep("ab", 100)) ~= h(string.rep("ab", 99)))
  truthy("differs for selection shapes",
         h("n=3|a|b|c") ~= h("n=4|a|b|c|d"))
  truthy("result is a string", type(a1) == "string")

  if #fails == 0 then
    rep("2", "hash32 deterministic + distinct", true, n .. " assertions")
  else
    rep("2", "hash32 deterministic + distinct", false, table.concat(fails, " | "))
  end
end

-- ===========================================================================
-- T3 — selectedNotes() falls back to getNumSelectedNotes()
-- ===========================================================================
local function T3()
  local fails, n = {}, 0
  local function truthy(label, v)
    n = n + 1
    if not v then fails[#fails + 1] = label end
  end

  local ed = SV:getMainEditor()
  local sel = ed:getSelection()
  local raw = sel:getSelectedNotes()
  local rawLen = #raw
  local rawCount = sel:getNumSelectedNotes()
  local picked = T.selectedNotes()

  truthy("quirk is active: #getSelectedNotes() == 0 (got " .. tostring(rawLen) .. ")", rawLen == 0)
  truthy("quirk is faithful: raw[1] is the first note", raw[1] == H.notes[1])
  truthy("getNumSelectedNotes() == 3 (got " .. tostring(rawCount) .. ")", rawCount == 3)
  truthy("#selectedNotes() == 3 (got " .. tostring(#picked) .. ")", #picked == 3)
  truthy("selectedNotes() returns note 1", picked[1] == H.notes[1])
  truthy("selectedNotes() returns note 3", picked[3] == H.notes[3])

  if #fails == 0 then
    rep("3", "selectedNotes() #-quirk fallback", true, n .. " assertions (3 notes selected, #raw = 0)")
  else
    rep("3", "selectedNotes() #-quirk fallback", false, table.concat(fails, " | "))
  end
end

-- ===========================================================================
-- wrappers used by harness.mjs (tests 4-12)
-- ===========================================================================

function __T1() T1() end
function __T2() T2() end
function __T3() T3() end

function __T_boot() T.main() end
function __T_tick() return H.tick() end
function __T_pending() return H.pendingCount() end

-- Integral values print without a trailing ".0" (Lua 5.3 tostring(63.0) == "63.0"),
-- but a genuinely fractional value (e.g. the 60.5 probe) still shows its fraction.
local function num2s(v)
  if type(v) == "number" and v == math.floor(v) then return string.format("%d", v) end
  return tostring(v)
end

function __T_pitches()
  local out = {}
  for i = 1, #H.notes do out[i] = num2s(H.notes[i]:getPitch()) end
  return table.concat(out, ",")
end

function __T_pitch(i) return H.notes[i]:getPitch() end
function __T_mutatePitch(i, delta) H.notes[i]:setPitch(H.notes[i]:getPitch() + delta) end
function __T_setPitch(i, v) H.notes[i]:setPitch(v) end

function __T_opsrun() return T.ST.opsRun end
function __T_reqseen() return T.ST.reqSeen end
function __T_pollerrors() return T.ST.pollErrors end
function __T_ticks() return T.ST.ticks end
function __T_stopping() return T.ST.stopping == true end
function __T_dir() return T.ST.dir end

-- SVDSH_TEST.PATH is populated by buildPaths(); test 4 asserts it matches the
-- directory the harness created, and tests 5-12 adopt these paths from here.
function __T_path(k) return T.PATH[k] end

-- Path separators. The bridge used to hardcode "\\", which is a legal FILENAME
-- character on POSIX: the paths then became files whose name contains a
-- backslash, so the bridge silently wrote into the wrong place (the ubuntu CI
-- job died on exactly that). These two wrappers let test 4 pin the rule on any
-- platform.
function __T_sep(dir) return T.sepFor(dir) end
function __T_join(dir, name) return T.joinPath(dir, name) end

-- force a heartbeat now (bypasses the 16-tick cadence)
function __T_hb() T.writeHeartbeat() end

-- T11: two atomic writes to the SAME path with DIFFERENT contents.
-- writeAtomic() is not exported by the bridge's test hook, so it is driven
-- through writeHeartbeat(), which is the bridge's own writeAtomic() caller.
function __T_atomic()
  T.ST.ticks = 111111
  T.writeHeartbeat()
  T.ST.ticks = 222222
  T.writeHeartbeat()
end

function __T_writeHeartbeatWith(ticks)
  T.ST.ticks = ticks
  T.writeHeartbeat()
end

function __T_version() return T.BRIDGE_VERSION end
function __T_opnames()
  local names = {}
  for i = 1, #T.OP_NAMES do names[i] = T.OP_NAMES[i] end
  return table.concat(names, ",")
end

-- 属性的确定性序列化。
-- ⚠️ 不能对表用 tostring:那给的是**内存地址**,同一个值两次快照可能不一样,
--    "一个字节都没写"这条断言就会变成偶发红。逐音素属性数组正是个表
--    (attributes.phonemes = { {leftOffset=..., position=...}, ... })。
local function attrValue(v)
  if type(v) ~= "table" then return tostring(v) end
  local parts = {}
  for i = 1, #v do
    local item = v[i]
    if type(item) == "table" then
      local ks = {}
      for k in pairs(item) do ks[#ks + 1] = k end
      table.sort(ks)
      local kv = {}
      for x = 1, #ks do kv[x] = ks[x] .. "=" .. tostring(item[ks[x]]) end
      parts[i] = "{" .. table.concat(kv, ",") .. "}"
    else
      parts[i] = tostring(item)
    end
  end
  return "[" .. table.concat(parts, ",") .. "]"
end

-- ===========================================================================
-- 快照:整个假宿主里"数据"的确定性序列化(JSON)。
--
-- 用途是"没写坏东西"这条断言:测试在请求前 __T_snap() 一次、请求后再一次,
-- 逐字节比较。所以:
--   * 全部用**数组**(jenc 对对象走 pairs ⇒ 键序不定 ⇒ 无法逐字节比较);
--   * **不含** _undo / paramCalls / autoLog —— 那三个是记账,不是工程数据;
--   * 空自动化(只有 getParameter 建了对象、一个点都没有)不算数据 ⇒ 不出现,
--     否则"读一次参数"也会让快照变样。
-- ===========================================================================
local function snapshot()
  local proj = H.project
  local out = {}

  -- ⚠️ 面板中继的键**不算数据**:panelFlush 会按节拍往 project scriptData 写
  --    `svdsh.panel.in`(对端取走前一直占着槽位)。那是桥的设计行为,不是被测 op 写的,
  --    而且它落在哪一拍取决于 tick 奇偶 ⇒ 算进来会让"一个字节都没写"变成偶发红。
  --    其它 scriptData 键仍然计入。
  local keys, relayKeys = proj:getScriptDataKeys(), 0
  for i = 1, #keys do
    if type(keys[i]) == "string" and keys[i]:sub(1, 12) == "svdsh.panel." then
      relayKeys = relayKeys + 1
    end
  end
  out[#out + 1] = { "project", proj:getNumTracks(), proj:getDuration(), #keys - relayKeys }
  out[#out + 1] = { "editor", H.editor._currentRef and H.editor._currentRef:getIndexInParent() or -1 }

  -- tracks: { name, color, bounced, gain, pan, muted, solo, groupCount, displayOrder }
  --   ⚠️ 新字段一律**追加在末尾** —— 上面的下标被 harness.mjs 里的 tracksOf() 按位置取
  --      (tracksOf()[0][3] = gain、[4] = pan、[7] = groupCount)。
  local tracks = {}
  for i = 1, proj:getNumTracks() do
    local t = proj:getTrack(i)
    local mx = t:getMixer()
    tracks[i] = {
      t:getName(), t:getDisplayColor(), t:isBounced() and 1 or 0,
      mx:getGainDecibel(), mx:getPan(),
      mx:isMuted() and 1 or 0, mx:isSolo() and 1 or 0, t:getNumGroups(),
      t:getDisplayOrder(),
    }
  end
  out[#out + 1] = { "tracks", tracks }

  -- refs: { track, refIndex, targetUUID, onset, dur, timeOffset, pitchOffset, isMain, isMuted,
  --         isInstrumental }
  --   ⚠️ isInstrumental 追加在末尾:前面的 [5]/[6] 被 27 号测试按位置取。
  local refs = {}
  for i = 1, proj:getNumTracks() do
    local t = proj:getTrack(i)
    for j = 1, t:getNumGroups() do
      local r = t:getGroupReference(j)
      local g = r:getTarget()
      refs[#refs + 1] = {
        i, j, g and g:getUUID() or "", r:getOnset(), r:getDuration(),
        r:getTimeOffset(), r:getPitchOffset(), r:isMain() and 1 or 0, r:isMuted() and 1 or 0,
        r:isInstrumental() and 1 or 0,
      }
    end
  end
  out[#out + 1] = { "refs", refs }

  -- groups (库): { name, uuid, noteCount, pcCount, <notes...>, <curves...>, <autos...> }
  --   note  = { "note", onset, dur, pitch, lyrics, phonemes, detune, lang, rap }
  --   curve = { "curve", position, anchorPitch, { {dt, dv}, ... } }
  --   auto  = { "auto", type, { {blick, value}, ... } }
  local lib = {}
  for i = 1, proj:getNumNoteGroups() do
    local g = proj:getNoteGroup(i)
    local item = { g:getName(), g:getUUID(), g:getNumNotes(), g:getNumPitchControls() }
    for j = 1, g:getNumNotes() do
      local n = g:getNote(j)
      item[#item + 1] = {
        "note", n:getOnset(), n:getDuration(), n:getPitch(), n:getLyrics(),
        n:getPhonemes(), n:getDetune(), n:getLanguageOverride(), n:getRapAccent(),
        -- [9] getAttributes():只含**写过的键**。按名字排序拼成字符串,
        --     既确定性,又让"属性被偷偷写过"也能被 __T_snap() 抓到。
        --     ⚠️ 必须留在**最后一个**下标上:上面的 [3]..[8] 是 harness.mjs 里
        --     notesOf() 依赖的固定位置。
        (function()
          local a = n:getAttributes()
          local ks = {}
          for k in pairs(a) do ks[#ks + 1] = k end
          table.sort(ks)
          local parts = {}
          for k = 1, #ks do parts[k] = ks[k] .. "=" .. attrValue(a[ks[k]]) end
          return table.concat(parts, "|")
        end)(),
      }
    end
    for j = 1, g:getNumPitchControls() do
      local c = g:getPitchControl(j)
      local pts, got = {}, c:getPoints()
      for k = 1, #got do pts[k] = { got[k][1], got[k][2] } end
      item[#item + 1] = { "curve", c:getPosition(), c:getPitch(), pts }
    end
    local names = {}
    for k in pairs(g._automation) do
      if #g._automation[k]._order > 0 then names[#names + 1] = k end
    end
    table.sort(names)
    for x = 1, #names do
      local a = g._automation[names[x]]
      local pts = {}
      for y = 1, #a._order do pts[y] = { a._order[y], a._points[a._order[y]] } end
      item[#item + 1] = { "auto", names[x], pts }
    end
    lib[i] = item
  end
  out[#out + 1] = { "groups", lib }

  -- time axis: { tempos = { {position, bpm} }, meters = { {positionBlick, measure, nomin, denom} } }
  --   ⚠️ 两种标记的位置字段名**不同**(真机实测,桥 0.5.8 的修复):速度标记是
  --      `position`,拍号标记是 `positionBlick`。这里按各自真实的字段读,别统一。
  local tempo = {}
  local tm = H.timeAxis:getAllTempoMarks()
  for i = 1, #tm do tempo[i] = { tm[i].position, tm[i].bpm } end
  local meter = {}
  local mm = H.timeAxis:getAllMeasureMarks()
  for i = 1, #mm do meter[i] = { mm[i].positionBlick, mm[i].measure, mm[i].numerator, mm[i].denominator } end
  out[#out + 1] = { "timeaxis", tempo, meter }

  out[#out + 1] = { "playback", H.playback:getStatus(), H.playback:getPlayhead() }

  return out
end

-- 整个假宿主的确定性快照(JSON 文本)。逐字节比较 ⇒ "一个字节都没写"。
function __T_snap() return T.jenc(snapshot()) end

-- 记账面(刻意不进快照)
function __T_undo() return H.project._undo end
function __T_paramCalls() return T.jenc(H.paramCalls) end
function __T_autoLog() return T.jenc(H.autoLog) end
-- 宿主调用账:NoteGroup#getNote / #removeNote。用来断言"被拒的请求没有把**小数下标**
-- 递给宿主绑定" —— 真机上非整数实参是会弹模态框的那一类输入,而假宿主只会静默返回 nil。
function __T_callCount() return #H.groupCalls end
function __T_calls(from)
  local out = {}
  for i = (tonumber(from) or 0) + 1, #H.groupCalls do out[#out + 1] = H.groupCalls[i] end
  return T.jenc(out)
end
function __T_lastComputedPitch() return T.jenc(H.lastComputedPitch or {}) end
-- 当前组(不是写死的 Main)的曲线数 / 音符数
local function currentGroupOf()
  local r = H.editor._currentRef
  return r and r:getTarget() or nil
end
function __T_pitCount()
  local g = currentGroupOf()
  return g and #g._pitchControls or -1
end
function __T_noteCount()
  local g = currentGroupOf()
  return g and #g._notes or -1
end

-- ===========================================================================
-- 选区(30 号测试 select_notes 用)
--
-- ⚠️ 选区**刻意不进 __T_snap()**:快照是"工程数据",而选区是 UI 状态 ——
--    而且 select_notes 的全部意义就是改它。所以这里给一个单独的确定性描述,
--    测试在每次请求前后各取一次逐字比较,效果与 sameSnap 相同。
-- ===========================================================================
function __T_selection()
  local sel = H.selection
  local n = sel:getNumSelectedNotes()
  local arr = sel:getSelectedNotes()          -- ⚠️ # 恒为 0,只能按下标取
  local idx, uuids = {}, {}
  for i = 1, n do
    local nt = arr[i]
    if nt ~= nil then
      idx[#idx + 1] = nt:getIndexInParent()
      local p = nt:getParent()
      uuids[#uuids + 1] = (p ~= nil and p:getUUID()) or ""
    end
  end
  table.sort(idx)                             -- 选区是集合,顺序不该被断言
  local gu = uuids[1] or ""
  for i = 1, #uuids do if uuids[i] ~= gu then gu = "(mixed)" end end
  return T.jenc({
    count = n,
    has = sel:hasSelectedNotes() and true or false,
    indices = idx,
    groupUUID = gu,
  })
end

function __T_selectAll() H.select(nil) end
function __T_selectNone() H.select({}) end
-- 只选**当前组**里的这几个音符(1 起下标,逗号分隔)
function __T_selectOnly(list)
  local g = currentGroupOf()
  local out = {}
  if g ~= nil then
    for s in tostring(list):gmatch("[^,]+") do
      local i = tonumber(s)
      if i ~= nil then out[#out + 1] = g:getNote(i) end
    end
  end
  H.select(out)
end

-- 31 号测试:假宿主里"写过哪些属性"的账(与 __T_snap() 里那个字段同源)
function __T_attributes(i)
  return T.jenc(H.notes[i]:getAttributes())
end

-- 破坏性测试之间的复位(重建一个干净工程)
function __T_resetWorld() return H.resetWorld() end
function __T_useGroupAt(i) return H.useGroupAt(i) end
function __T_setRefTimeOffset(b) return H.setRefTimeOffset(b) end
function __T_setComputedReady(b) H.computedReady = (b == true) end
function __T_tempoMarks() return T.jenc(H.timeAxis:getAllTempoMarks()) end
function __T_measureMarks() return T.jenc(H.timeAxis:getAllMeasureMarks()) end

-- ===========================================================================
-- 33–40 号测试的控制面
-- ===========================================================================

-- 往 Main 组加一个音符(onset/duration 以四分音符为单位);返回新的音符数。
function __T_addNoteToMainGroup(onsetQ, durQ, pitch, lyrics)
  return H.addNoteToMainGroup(tonumber(onsetQ), tonumber(durQ),
    pitch ~= nil and tonumber(pitch) or nil, lyrics)
end

-- 直接改一个音符的 onset/duration(以四分音符为单位)
function __T_setNoteRangeQuarter(i, onsetQ, durQ)
  return H.setNoteRangeQuarter(tonumber(i), tonumber(onsetQ), tonumber(durQ))
end

-- 把 Main 组的存储顺序改成给定的排列(1 起下标,逗号分隔)
function __T_reorderNotes(list)
  local perm = {}
  for s in tostring(list):gmatch("[^,]+") do perm[#perm + 1] = tonumber(s) end
  return H.reorderNotes(perm)
end

function __T_setTrackDisplayOrder(ti, order)
  return H.setTrackDisplayOrder(tonumber(ti), tonumber(order))
end

-- 给某条轨追加一个 isInstrumental 的引用;返回它的 0 起组下标
function __T_addInstrumentalRef(ti, onsetBlick, durBlick, offsetBlick)
  return H.addInstrumentalRef(tonumber(ti), tonumber(onsetBlick), tonumber(durBlick),
    offsetBlick ~= nil and tonumber(offsetBlick) or nil)
end

-- 让 Track:addGroupReference 按需失败(40 号测试压 group_ops move 的"先挂后删")
function __T_failAddGroupReference(b) H.failAddGroupReference = (b == true) end

-- 某条轨上有几个组引用(-1 = 轨不存在)
function __T_trackRefCount(ti)
  local tr = H.project:getTrack((tonumber(ti) or 0) + 1)
  return tr and tr:getNumGroups() or -1
end

-- 某条轨上每个组引用指向的组 UUID(音频引用没有目标 ⇒ "audio"),逗号分隔。
-- 用来断言"移动之后目标轨上挂的确实是**同一个**组",而不是一个新建的空组。
function __T_refTargets(ti)
  local tr = H.project:getTrack((tonumber(ti) or 0) + 1)
  if tr == nil then return "" end
  local out = {}
  for i = 1, tr:getNumGroups() do
    local r = tr:getGroupReference(i)
    local g = r:getTarget()
    out[i] = (g ~= nil and g:getUUID()) or "audio"
  end
  return table.concat(out, ",")
end

-- 按 **onset** 顺序报 Main 组的歌词("onset拍:歌词",逗号分隔)。
-- ⚠️ 刻意**不经过桥**:apply_lyrics / align_lyrics 的全部意义就是"按时间对位",
--    用桥自己的输出验证桥会把循环论证。这里直接读假宿主。
function __T_lyricsByOnset()
  local ns = {}
  for i = 1, #H.group._notes do ns[#ns + 1] = H.group._notes[i] end
  table.sort(ns, function(a, b)
    local ao, bo = a:getOnset(), b:getOnset()
    if ao == bo then return a:getPitch() < b:getPitch() end
    return ao < bo
  end)
  local out = {}
  for i = 1, #ns do
    out[i] = num2s(ns[i]:getOnset() / H.QUARTER) .. ":" .. ns[i]:getLyrics()
  end
  return table.concat(out, ",")
end

-- 秒 ↔ blick 的往返探针(documentLimitations 用):证明假宿主的速度模型自洽。
-- 传一个 blick,回来 { sec = getSecondsFromBlick(b), blick = getBlickFromSeconds(sec) }。
function __T_secondsRoundTrip(b)
  local ta = H.project:getTimeAxis()
  local sec = ta:getSecondsFromBlick(tonumber(b))
  return T.jenc({ sec = sec, blick = ta:getBlickFromSeconds(sec) })
end

-- fengari 的整数是 32 位(见 luaenv.mjs):这个探针把"整数会回绕"这件事
-- 变成一条每次运行都重新计算的 NOTE,而不是一句会过期的注释。
function __T_overflowProbe() return string.format("%d", 705600000 * 4) end

function __T_selectionFp() return T.selectionFp(T.selectedNotes()) end

-- helpers used by the beyond-spec probes in harness.mjs
function __T_jencNum(v) return T.jenc(v) end
function __T_jdecNum(s) return T.jdec(s) end
function __T_cfg()
  local every = math.max(1, math.floor(T.CFG.HB_MS / T.CFG.POLL_MS))
  return table.concat({ tostring(T.CFG.POLL_MS), tostring(T.CFG.HB_MS), tostring(every) }, ",")
end
