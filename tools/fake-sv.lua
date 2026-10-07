--[[
fake-sv.lua — offline stand-in for the Synthesizer V Studio 2 Lua host.
================================================================================
Loaded by harness.mjs into a fengari (Lua 5.3) state, BEFORE DSHBridge.lua.

It supplies exactly the surface DSHBridge.lua touches, and nothing more:
  SV (colon-callable members), SV.setTimeout (recorder only — the harness drives
  ticks by hand), project / main editor / NoteGroupReference / NoteGroup / Note /
  Track / TrackMixer / TimeAxis / Automation / PitchControlCurve /
  PlaybackControl / SelectionState.

⚠️ 每一个成员都是**按桥里 call(obj, "name", ...) 的实际调用**补的。
   call() 先做 has() 判断,成员缺失只会静默变成 nil —— 那是 bug 来源,不是便利。

Deliberately faithful quirks (each one is load-bearing for some test):
  * getSelectedNotes() returns a table whose `#` is 0 even when notes ARE
    selected (metatable __len). The bridge must fall back to
    getNumSelectedNotes(); a script that trusts `#` would silently retarget the
    whole group.  → bridge-tests.lua T3
  * NoteGroup:getNote(i) is 1-based.
  * NoteGroup:addNote() INSERTS the note by onset instead of appending (real-host
    behaviour measured for bridge 0.5.9: splitting a 6..8 note puts the tail at
    index 9, not at the end). So every note AFTER the inserted one shifts its
    index — which is why delete_notes deletes back-to-front and split_notes
    processes its plan in DESCENDING index order.
  * Note:getIndexInParent() is the note's CURRENT position inside its group, so
    removeNote() really shifts the index of everything after it (delete_notes
    deletes from the back for exactly this reason).
  * The two TimeAxis mark kinds expose DIFFERENT position fields (real-host
    behaviour measured for bridge 0.5.8): a tempo mark has `position` and NO
    `positionBlick` (reading the latter gives nil), while a measure mark has a
    correct `positionBlick` and a garbage `position` (~1 blick ⇒ 1.4e-9 quarter).
    A single shared reader therefore breaks one of the two — tests 24/25 pin it.
  * TimeAxis:addTempoMark() does NOT update an existing mark at the same blick
    (the real host's documented-but-untrue behaviour) — it appends a SECOND
    mark. That is why set_tempo() has to removeTempoMark() first.
  * Automation:add() REPLACES the value at an existing blick, and
    Automation:get() holds the outermost point's value beyond the curve's ends
    (the "one point changes the whole group" behaviour that the bridge's
    closeShape exists for).
  * Note:getAttributes() returns ONLY the keys an explicit setter has written —
    a note built by the constructor has an empty attributes table, and unwritten
    keys are nil rather than defaults (reference project SV-007). The bridge must
    not invent defaults; the note-attrs-fill-defaults mutant pins that.
    Note:setAttributes() likewise updates ONLY the keys it is given (and stores
    them, so "the bridge handed an unknown key to the host" is visible in the
    snapshot — 38 test).
  * NoteGroupReference:isInstrumental() marks an EXTERNAL AUDIO reference
    (backing track / dry vocal). Its getTarget() is nil (there are no editable
    notes), which is exactly the shape get_audio_tracks / align_audio must cope
    with. Only M.addInstrumentalRef() turns it on.
  * Track:getDisplayOrder() can DIFFER from the storage index (official docs:
    the arrangement view always sorts by display order), so "the topmost track"
    is min(displayOrder), not index 0. Unset ⇒ falls back to the storage index.
  * Track:addGroupReference() can FAIL (return nil) on the real host; the control
    flag M.failAddGroupReference reproduces that on demand, which is what pins
    group_ops move's "add the new reference BEFORE removing the old one" rule
    (test 40) — the reverse order loses the group outright.
  * TimeAxis:getSecondsFromBlick() / getBlickFromSeconds() integrate PIECEWISE
    over this fake's own tempo marks (seconds ↔ blicks depends on the current
    tempo, so a script must never multiply by a constant). The harness keeps the
    world at 120 bpm, i.e. 1 quarter = 0.5 s. Integer arithmetic is avoided on
    purpose (fengari's 32-bit ints would wrap 705600000*120).
  * TimeAxis:getMeasureMarkAt(measure) SYNTHESISES a mark for any measure index
    (the real host's measure argument is 0-based: measure=1 lands on beat 4 @4/4),
    instead of only answering for measures that were explicitly added. Without
    that, "forgot the 1-based → 0-based conversion" would error out instead of
    silently landing on the wrong bar (test 37).
  * SelectionState:selectNote()/selectGroup() are ADDITIVE and clearAll() is the
    only thing that empties the selection, so the bridge has to clearAll() first
    (select_notes' 30 test pins it). The real host's exact semantics here have
    not been measured — see the comment on newSelection().
  * io/os are backed by the REAL filesystem (see luaenv.mjs), so the bridge's
    atomic-write / rename-overwrite path is exercised for real.

The global FAKE is the control surface used by bridge-tests.lua and by
harness.mjs (via the __T_* wrappers). M.resetWorld() rebuilds a pristine
project; destructive tests call it first so they cannot poison each other.
]]

local QUARTER = 705600000

-- ===========================================================================
-- 0. module table + forward declarations (the constructors are mutually
--    recursive, so every one of them must be a forward-declared local)
-- ===========================================================================

local M = { QUARTER = QUARTER, pending = nil, timerCalls = 0 }
-- setVoice 的语义开关(见 newGroupRef 里的说明):false = 整体替换,true = 逐字段合并
M.voiceMerge = false

-- 让 Track:addGroupReference 按需失败(返回 nil)。只有 40 号测试用它,用来压
-- group_ops move 的"先挂新引用、成功后再删旧引用"这条纪律。
M.failAddGroupReference = false

M.paramCalls = {}        -- every NoteGroup#getParameter(type) argument, in order
M.autoLog = {}           -- every Automation get/add: { op, type, blick, value }
-- every NoteGroup#getNote / #removeNote call: { op, index }
-- 用途:断言"被拒的请求**没有把小数下标递给宿主绑定**" —— 非整数实参正是真机上会弹
-- 模态框冻住主线程的那一类输入,而假宿主只会静默返回 nil,所以必须靠这本账才看得见。
M.groupCalls = {}
M.computedReady = true   -- false ⇒ the computed* APIs return empty arrays
M.lastComputedPitch = nil

local newNote, newGroup, newGroupRef, newTrack, newTimeAxis, newAutomation
local newProject, newEditor, newSelection, newPitchCurve, newMixer, newPlayback
local newUUID

local function indexOf(list, obj)
  for i = 1, #list do if list[i] == obj then return i end end
  return nil
end

local uuidSeq = 0
newUUID = function()
  uuidSeq = uuidSeq + 1
  return string.format("GRP-%04d", uuidSeq)
end

-- ===========================================================================
-- 1. model
-- ===========================================================================

-- ---- Note -----------------------------------------------------------------
newNote = function(onset, dur, pitch, lyrics)
  local n = {
    _onset = onset or 0, _dur = dur or QUARTER, _pitch = pitch or 60,
    _lyrics = lyrics or "", _phonemes = "", _detune = 0,
    _lang = "", _rap = "", _parent = nil,
    -- ⚠️ 真机语义(参考项目 SV-007):Note:getAttributes() **只返回写过的键** ——
    --    没写过的键是 nil,不是默认值。所以这里只记 setter 显式写过的属性,
    --    构造函数直接摆进去的初值**不算写过**(新建的音符 attributes 是空的)。
    --    桥要是自己往里填默认值,31 号测试的 note-attrs-fill-defaults 变异就会变红。
    _attrs = {},
  }
  function n:getOnset() return self._onset end
  function n:getDuration() return self._dur end
  function n:getEnd() return self._onset + self._dur end
  function n:getPitch() return self._pitch end
  function n:setPitch(v) self._pitch = v; self._attrs.pitch = v end
  function n:getLyrics() return self._lyrics end
  function n:setLyrics(v) self._lyrics = v; self._attrs.lyrics = v end
  function n:setDuration(v) self._dur = v; self._attrs.duration = v end
  function n:setTimeRange(onset, dur)
    self._onset = onset; self._dur = dur
    self._attrs.onset = onset; self._attrs.duration = dur
  end
  function n:getPhonemes() return self._phonemes end
  function n:setPhonemes(v) self._phonemes = v; self._attrs.phonemes = v end
  function n:getDetune() return self._detune end
  function n:setDetune(v) self._detune = v; self._attrs.detune = v end
  function n:getLanguageOverride() return self._lang end
  function n:setLanguageOverride(v) self._lang = v; self._attrs.languageOverride = v end
  function n:getRapAccent() return self._rap end
  function n:setRapAccent(v) self._rap = v; self._attrs.rapAccent = v end
  -- 只回**写过的**键(浅拷贝,别把内部表交出去)
  function n:getAttributes()
    local out = {}
    for k, v in pairs(self._attrs) do out[k] = v end
    return out
  end
  -- ⚠️ 真机语义(参考项目 SV-007):`setAttributes` **只更新给到的键**,其余键原样保留;
  --    而 getAttributes 只回**写过的键**(没写过的是 nil,不是默认值)。
  --    假宿主逐键存下来 —— 于是"桥把不认识的键递给宿主"这件事在 __T_snap() 里看得见。
  --    真机上那正是弹模态错误框(冻住主线程)的那一类输入,离线能验的只有
  --    "桥不会把它递过去"(38 号测试)。
  function n:setAttributes(t)
    if type(t) ~= "table" then return false end
    for k, v in pairs(t) do
      if type(v) == "table" then
        -- 逐音素属性数组:深拷一层,免得调用方之后改到宿主里的表
        local copy = {}
        for i = 1, #v do
          local item = v[i]
          if type(item) == "table" then
            local c2 = {}
            for k2, v2 in pairs(item) do c2[k2] = v2 end
            copy[i] = c2
          else
            copy[i] = item
          end
        end
        self._attrs[k] = copy
      else
        self._attrs[k] = v
      end
    end
    return true
  end
  function n:getParent() return self._parent end
  -- ⚠️ 动态下标(不是建的时候记住的 _idx):removeNote 之后后面的音必须整体前移,
  --    否则 delete_notes 的"从后往前删"和 groupFingerprint 都失去意义。
  function n:getIndexInParent()
    local p = self._parent
    if p ~= nil and p._notes ~= nil then
      local i = indexOf(p._notes, self)
      if i ~= nil then return i end
    end
    return 0
  end
  return n
end

-- ---- Automation -----------------------------------------------------------
-- 默认值按参数类型给(voicing 默认 1,其余 0)—— closeShape 的"基线"读的就是它。
local AUTO_DEFAULT = {
  pitchDelta = 0, vibratoEnv = 0, loudness = 0, tension = 0,
  breathiness = 0, voicing = 1, gender = 0, toneShift = 0,
}

newAutomation = function(typ)
  local a = { _type = typ, _points = {}, _order = {} }   -- _order 恒按 blick 升序

  function a:getType() return self._type end
  function a:getInterpolationMethod() return "linear" end

  -- ⚠️ 真机语义:同位置再 add 是**覆盖**(不是新增第二个点)。
  function a:add(b, v)
    M.autoLog[#M.autoLog + 1] = { op = "add", type = self._type, blick = b, value = v }
    if self._points[b] == nil then
      local i = 1
      while i <= #self._order and self._order[i] < b do i = i + 1 end
      table.insert(self._order, i, b)
    end
    self._points[b] = v
    return true
  end

  -- 曲线两端**外推**(保持最外侧点的值)—— 这就是"写一个点会把整组变成那个值"。
  function a:get(b)
    M.autoLog[#M.autoLog + 1] = { op = "get", type = self._type, blick = b }
    local n = #self._order
    if n == 0 then
      local d = AUTO_DEFAULT[self._type]
      if d == nil then d = 0 end
      return d
    end
    local first, last = self._order[1], self._order[n]
    if b <= first then return self._points[first] end
    if b >= last then return self._points[last] end
    for i = 1, n - 1 do
      local b0, b1 = self._order[i], self._order[i + 1]
      if b >= b0 and b <= b1 then
        local v0, v1 = self._points[b0], self._points[b1]
        if b1 == b0 then return v1 end
        return v0 + (v1 - v0) * ((b - b0) / (b1 - b0))
      end
    end
    return self._points[last]
  end
  return a
end

-- ---- NoteGroup ------------------------------------------------------------
newGroup = function(name, uuid)
  local g = {
    _name = name or "", _uuid = uuid or newUUID(), _notes = {},
    _pitchControls = {}, _automation = {},
  }
  function g:getName() return self._name end
  function g:setName(v) self._name = v end
  function g:getUUID() return self._uuid end
  function g:getNumNotes() return #self._notes end
  function g:getNote(i)
    M.groupCalls[#M.groupCalls + 1] = { op = "getNote", index = i }
    return self._notes[i]
  end
  -- ⚠️ 真机实测(桥 0.5.9 的更新日志):`addNote` **按 onset 把新音符插进组里**,
  --    **不是**追加到末尾 —— 拆 6..8 的音符,尾段落在 index 9 而不是末尾。
  --    ⇒ 往组里加一个音之后,它**后面所有音符的下标都会 +1**。
  --    桥里有两处纪律是为这条服务的:`delete_notes` 从后往前删、`split_notes` 倒序处理。
  --    (这一条只来自桥自己的真机实测记录,离线无法独立复验 —— 见 README 的"离线验不了"。)
  --    onset 相同的音符插在已有的后面(稳定),`write_notes` 那种已经按 onset 排好的批量
  --    因此退化成"追加",与旧模型完全一致。
  function g:addNote(n)
    local onset = n:getOnset()
    local at = #self._notes + 1
    if onset ~= nil then
      for i = 1, #self._notes do
        if self._notes[i]:getOnset() > onset then at = i break end
      end
    end
    table.insert(self._notes, at, n)
    n._parent = self
    return true
  end
  function g:removeNote(i)
    M.groupCalls[#M.groupCalls + 1] = { op = "removeNote", index = i }
    local n = self._notes[i]
    if n == nil then return false end
    table.remove(self._notes, i)
    n._parent = nil
    return true
  end
  function g:clone()
    local c = newGroup(self._name .. " copy")
    for i = 1, #self._notes do
      local s = self._notes[i]
      local n = newNote(s._onset, s._dur, s._pitch, s._lyrics)
      n._phonemes, n._detune, n._lang, n._rap = s._phonemes, s._detune, s._lang, s._rap
      for k, v in pairs(s._attrs) do n._attrs[k] = v end   -- 写过的属性也要跟着克隆
      c:addNote(n)
    end
    return c
  end
  -- 音高线(SV2 2.1.0+)
  function g:getNumPitchControls() return #self._pitchControls end
  function g:getPitchControl(i) return self._pitchControls[i] end
  function g:addPitchControl(pc)
    self._pitchControls[#self._pitchControls + 1] = pc
    pc._group = self
    return true
  end
  function g:removePitchControl(i)
    if self._pitchControls[i] == nil then return false end
    table.remove(self._pitchControls, i)
    return true
  end
  -- 参数自动化
  function g:getParameter(t)
    M.paramCalls[#M.paramCalls + 1] = tostring(t)
    local a = self._automation[t]
    if a == nil then
      a = newAutomation(t)
      self._automation[t] = a
    end
    return a
  end
  return g
end

-- ---- PitchControlCurve ----------------------------------------------------
newPitchCurve = function()
  local c = { _position = 0, _pitch = 60, _points = {} }
  function c:getPosition() return self._position end
  function c:setPosition(v) self._position = v end
  function c:getPitch() return self._pitch end
  function c:setPitch(v) self._pitch = v end
  function c:getPoints()
    local out = {}
    for i = 1, #self._points do out[i] = { self._points[i][1], self._points[i][2] } end
    return out
  end
  -- 点是 { timeRelativeToAnchor, valueRelativeToAnchorPitch }
  function c:setPoints(list)
    local out = {}
    for i = 1, #list do
      local p = list[i]
      out[i] = { tonumber(p[1]) or 0, tonumber(p[2]) or 0 }
    end
    self._points = out
    return true
  end
  return c
end

-- ---- NoteGroupReference ---------------------------------------------------
newGroupRef = function(group, index, main)
  local r = {
    _group = group, _index = index or 0, _main = main == true,
    _onset = 0, _dur = 0, _timeOffset = 0, _pitchOffset = 0, _muted = false,
    _instrumental = false, _parent = nil,
    -- 组级声音属性的初值(真机上是"没设过"的默认样子)
    _voice = {
      paramLoudness = 0, paramTension = 0, paramBreathiness = 0,
      paramGender = 0, paramToneShift = 0,
      vocalModeParams = {},
    },
  }
  function r:getTarget() return self._group end
  function r:setTarget(g) self._group = g end
  function r:getParent() return self._parent end
  function r:getIndexInParent()
    local p = self._parent
    if p ~= nil and p._refs ~= nil then
      local i = indexOf(p._refs, self)
      if i ~= nil then return i end
    end
    return self._index
  end
  function r:isMain() return self._main end
  -- ⚠️ 外部音频引用(伴奏/干声)。真机上这就是"音频轨"的判据 ——
  --    `NoteGroupReference:isInstrumental()`(桥 0.6.2 的 get_audio_tracks / align_audio 靠它)。
  --    音频引用的 getTarget() 是 nil(没有可编辑的音符),所以这里默认 false,
  --    由控制面 M.addInstrumentalRef() 显式打开。
  function r:isInstrumental() return self._instrumental end
  function r:setInstrumental(v) self._instrumental = v == true end
  function r:isMuted() return self._muted end
  function r:setMuted(v) self._muted = v == true end
  function r:getOnset() return self._onset end
  function r:getDuration() return self._dur end
  function r:setTimeRange(onset, dur) self._onset = onset; self._dur = dur end
  function r:getTimeOffset() return self._timeOffset end
  function r:setTimeOffset(v) self._timeOffset = v end
  function r:getPitchOffset() return self._pitchOffset end
  function r:setPitchOffset(v) self._pitchOffset = v end

  -- ---- 声音属性(getVoice / setVoice)--------------------------------------
  -- ⚠️ 真机的 `setVoice` 到底是"整体替换"还是"逐字段合并",**官方没说**。
  --    桥的实现是"读全 → 合并 → 整体写回",正是为了不依赖这个语义。
  --    这里用一个开关把**两种语义都造得出来**,好让测试钉住"两种情况下都不出错":
  --      M.voiceMerge = false(默认)= 整体替换:写什么就是什么
  --      M.voiceMerge = true       = 逐字段合并:没提到的字段保持原样
  --    真机若是后者,那么"把某个 vocal mode 从对象里去掉"就**清不掉**它 ——
  --    这正是 set_voice 的 clearModes 必须**回读并如实报告**的原因。
  function r:getVoice() return self._voice end
  function r:setVoice(v)
    if type(v) ~= "table" then return false end
    local function copyModes(src)
      local modes = {}
      if type(src) == "table" then
        for name, m in pairs(src) do
          if type(m) == "table" then
            modes[name] = { pitch = m.pitch, timbre = m.timbre, pronunciation = m.pronunciation }
          end
        end
      end
      return modes
    end
    local copy = {}
    for k, val in pairs(v) do
      if k == "vocalModeParams" then copy[k] = copyModes(val) else copy[k] = val end
    end
    if M.voiceMerge then
      local merged = {}
      for k, val in pairs(self._voice or {}) do merged[k] = val end
      for k, val in pairs(copy) do
        if k == "vocalModeParams" then
          local modes = {}
          for name, m in pairs(merged.vocalModeParams or {}) do modes[name] = m end
          for name, m in pairs(val) do modes[name] = m end
          merged.vocalModeParams = modes
        else
          merged[k] = val
        end
      end
      self._voice = merged
    else
      self._voice = copy
    end
    return true
  end
  return r
end

-- ---- TrackMixer -----------------------------------------------------------
newMixer = function()
  -- 取值范围(gain −24..24 / pan −1..1)由**桥**负责拦;假宿主原样记账,
  -- 这样"越界被拒 ⇒ 一个字节都没写"才是可断言的。
  local mx = { _gain = 0, _pan = 0, _muted = false, _solo = false }
  function mx:getGainDecibel() return self._gain end
  function mx:setGainDecibel(v) self._gain = v end
  function mx:getPan() return self._pan end
  function mx:setPan(v) self._pan = v end
  function mx:isMuted() return self._muted end
  function mx:setMuted(v) self._muted = v == true end
  function mx:isSolo() return self._solo end
  function mx:setSolo(v) self._solo = v == true end
  return mx
end

-- ---- Track ----------------------------------------------------------------
newTrack = function(name)
  local t = {
    _name = name or "", _refs = {}, _color = "#4A90D9", _parent = nil,
    _mixer = newMixer(), _bounced = false, _displayOrder = nil,
  }
  function t:getName() return self._name end
  function t:setName(v) self._name = v end
  function t:getParent() return self._parent end
  function t:getIndexInParent()
    local p = self._parent
    if p ~= nil and p._tracks ~= nil then
      local i = indexOf(p._tracks, self)
      if i ~= nil then return i end
    end
    return 1
  end
  -- ⚠️ 显示顺序**可以和存储下标不同**(官方原文:编曲视图永远按显示顺序排)⇒
  --    "视觉上最上面那条轨"要用 min(displayOrder),不能用 index 0。
  --    没显式设过时回落到存储下标(1 起,与 getIndexInParent 一致)。
  --    39 号测试把两者设成**相反**,这样"桥直接拿 index 当 displayOrder"就会变红。
  function t:getDisplayOrder()
    if self._displayOrder ~= nil then return self._displayOrder end
    return self:getIndexInParent()
  end
  function t:setDisplayOrder(v) self._displayOrder = v end
  function t:getNumGroups() return #self._refs end
  function t:getGroupReference(i) return self._refs[i] end
  function t:addGroupReference(r)
    -- ⚠️ 真机上 addGroupReference 可能失败(返回 nil)。控制面 M.failAddGroupReference
    --    能按需让它失败,用来压 group_ops move 那条"**先挂新引用、成功后再删旧引用**"的纪律:
    --    反序一旦 add 失败,这个组就从编排里彻底消失了(静默数据丢失)。
    if M.failAddGroupReference then return nil end
    self._refs[#self._refs + 1] = r
    r._parent = self
    return true
  end
  function t:removeGroupReference(i)
    local r = self._refs[i]
    if r == nil then return false end
    table.remove(self._refs, i)
    r._parent = nil
    return true
  end
  function t:getDisplayColor() return self._color end
  function t:setDisplayColor(v) self._color = v end
  function t:getMixer() return self._mixer end
  function t:isBounced() return self._bounced end
  return t
end

-- ---- TimeAxis -------------------------------------------------------------
newTimeAxis = function()
  local ta = { _tempo = {}, _measure = {} }

  local function meterAt(measure)
    local best = nil
    for i = 1, #ta._measure do
      local m = ta._measure[i]
      if m.measure <= measure and (best == nil or m.measure > best.measure) then best = m end
    end
    if best == nil then return 4, 4 end
    return best.numerator, best.denominator
  end

  local function blickOfMeasure(measure)
    -- ⚠️ 真机实测(2026-10-02):宿主的 `measure` 参数是 **0 起**的 ——
    --    传 measure=1 会落在第 4 拍(@4/4),不是 0 拍。
    --    所以这里从 0 累加到 measure-1;measure=0 就是第 1 小节、位置 0。
    local q = 0
    for m = 0, measure - 1 do
      local n, d = meterAt(m)
      q = q + n * (4 / d)
    end
    return q * QUARTER
  end

  function ta:getAllTempoMarks()
    local out = {}
    for i = 1, #self._tempo do out[i] = self._tempo[i] end
    table.sort(out, function(a, b) return a.position < b.position end)
    return out
  end

  -- ⚠️ 真机实测:同位置已有标记时**不更新**,而是再加一个。
  --    (文档说会更新 —— set_tempo 必须先 removeTempoMark 就是为这条。)
  --
  -- ⚠️ 位置字段:**速度标记是 `position`,而且没有 `positionBlick`**
  --    (真机实测:读 positionBlick 拿到 nil,于是所有速度标记都被当成第 0 拍)。
  --    0.5.8 之前桥用一个统一顺序的 helper 读两种标记 ⇒ 真机复现了这个 bug。
  function ta:addTempoMark(blick, bpm)
    self._tempo[#self._tempo + 1] = { position = blick, bpm = bpm }
    return true
  end

  function ta:removeTempoMark(blick)
    local removed = 0
    for i = #self._tempo, 1, -1 do
      if self._tempo[i].position == blick then
        table.remove(self._tempo, i)
        removed = removed + 1
      end
    end
    return removed > 0
  end

  -- 拍号按**小节号**存;位置由前面的小节累加算出。
  --
  -- ⚠️ 位置字段:拍号标记是 `positionBlick`;而读 `position` / `getPosition()`
  --    会拿到一个 **~1 blick 的垃圾值**(真机实测,显示成 1.4e-9 拍)。
  --    所以这里**故意同时给出两者**:`positionBlick` 是对的,`position` 恒为 1。
  --    桥必须按类型分别取字段(0.5.8 的修复);取错了,24/25 号测试会红。
  function ta:addMeasureMark(measure, nomin, denom)
    self._measure[#self._measure + 1] = { measure = measure, numerator = nomin, denominator = denom }
    return true
  end

  function ta:removeMeasureMark(measure)
    local removed = 0
    for i = #self._measure, 1, -1 do
      if self._measure[i].measure == measure then
        table.remove(self._measure, i)
        removed = removed + 1
      end
    end
    return removed > 0
  end

  -- ⚠️ 真机语义(桥 0.5.5 的真机实测):宿主的 `measure` 参数是 **0 起**的 ——
  --    传 measure=1 会落在第 4 拍(@4/4),也就是"第 2 小节的开头"。
  --    ⇒ 假宿主**按任意小节号合成**一个标记(位置由前面的小节累加得到,拍号取该处生效的),
  --    而不是"只有显式 addMeasureMark 过的小节才有标记"。
  --    这样"忘了做 1 起→0 起 转换"的变异才会**静默算错位置**(而不是碰巧报错),
  --    与真机上的失败形态一致(37 号测试压着)。
  function ta:getMeasureMarkAt(measure)
    if type(measure) ~= "number" then return nil end
    local n, d = meterAt(measure)
    for i = 1, #self._measure do
      if self._measure[i].measure == measure then
        n, d = self._measure[i].numerator, self._measure[i].denominator
      end
    end
    return {
      positionBlick = blickOfMeasure(measure), position = 1,
      measure = measure, numerator = n, denominator = d,
    }
  end

  function ta:getAllMeasureMarks()
    local out = {}
    for i = 1, #self._measure do
      local m = self._measure[i]
      out[i] = {
        positionBlick = blickOfMeasure(m.measure), position = 1,
        measure = m.measure, numerator = m.numerator, denominator = m.denominator,
      }
    end
    table.sort(out, function(a, b) return a.positionBlick < b.positionBlick end)
    return out
  end

  function ta:getMeasureMarkAtBlick(blick)
    local best = nil
    for i = 1, #self._measure do
      local m = self._measure[i]
      local pb = blickOfMeasure(m.measure)
      if pb <= blick and (best == nil or pb > best.pb) then best = { m = m, pb = pb } end
    end
    if best == nil then return nil end
    return {
      positionBlick = best.pb, measure = best.m.measure,
      numerator = best.m.numerator, denominator = best.m.denominator,
    }
  end

  -- ---- 秒 ↔ blick(桥 0.6.2 的 align_audio / 0.6.4 的 align_lyrics 靠它) ----------
  -- ⚠️ 真机上这两个成员**必须由宿主提供**:秒↔blick 取决于**当前速度**(工程里可以
  --    中途变速),自己乘一个常数在变速工程里就是静默算错。所以假宿主也照自己的
  --    速度标记**分段积分**,而不是写死 120 bpm。
  --    换算:1 拍 = 60/bpm 秒 ⇒ 秒 = (blick/QUARTER) * (60/bpm)。
  --    ⚠️ 刻意**用浮点除法**而不是 QUARTER*bpm 的整数乘法:fengari 的整数是 32 位,
  --       705600000*120 会回绕(见 luaenv.mjs / README 的整数位宽说明)。
  local function tempoMarksSorted()
    local out = {}
    for i = 1, #ta._tempo do out[i] = ta._tempo[i] end
    table.sort(out, function(a, b) return a.position < b.position end)
    return out
  end

  function ta:getSecondsFromBlick(b)
    if type(b) ~= "number" then return nil end
    local marks = tempoMarksSorted()
    local bpm = (#marks > 0) and marks[1].bpm or 120
    if #marks == 0 then return b / QUARTER * (60 / bpm) end
    local sec, prev = 0, 0
    for i = 1, #marks do
      local m = marks[i]
      if m.position >= b then break end
      sec = sec + (m.position - prev) / QUARTER * (60 / bpm)
      prev = m.position
      bpm = m.bpm
    end
    return sec + (b - prev) / QUARTER * (60 / bpm)
  end

  function ta:getBlickFromSeconds(s)
    if type(s) ~= "number" then return nil end
    local marks = tempoMarksSorted()
    local bpm = (#marks > 0) and marks[1].bpm or 120
    if #marks == 0 then return s / (60 / bpm) * QUARTER end
    local sec, prev = 0, 0
    for i = 1, #marks do
      local m = marks[i]
      local spanSec = (m.position - prev) / QUARTER * (60 / bpm)
      if sec + spanSec >= s then
        return prev + (s - sec) / (60 / bpm) * QUARTER
      end
      sec = sec + spanSec
      prev = m.position
      bpm = m.bpm
    end
    return prev + (s - sec) / (60 / bpm) * QUARTER
  end

  return ta
end

-- ---- PlaybackControl ------------------------------------------------------
newPlayback = function()
  local pb = { _status = "stopped", _playhead = 0, _loopA = nil, _loopB = nil }
  function pb:play() self._status = "playing"; return true end
  function pb:pause() self._status = "paused"; return true end
  function pb:stop() self._status = "stopped"; self._playhead = 0; return true end
  function pb:seek(t) self._playhead = t; return true end
  function pb:loop(a, b) self._loopA = a; self._loopB = b; return true end
  function pb:getStatus() return self._status end
  function pb:getPlayhead() return self._playhead end
  return pb
end

-- ---- Project --------------------------------------------------------------
newProject = function()
  local p = {
    _tracks = {}, _groupLibrary = {}, _scriptData = {}, _undo = 0,
    _timeAxis = nil, _fileName = "C:\\fake\\offline-harness.svp",
    -- ⚠️ 刻意不写 QUARTER*4:fengari 的整数是 32 位,4 拍 = 2822400000 会回绕成负数
    --    (真机 Lua 5.4 是 64 位)。3 拍与组内容同长,而且不越界。
    _duration = QUARTER * 3,
  }
  function p:newUndoRecord() self._undo = self._undo + 1; return true end
  function p:getFileName() return self._fileName end
  function p:getNumTracks() return #self._tracks end
  function p:getTrack(i) return self._tracks[i] end
  function p:getDuration() return self._duration end
  function p:getTimeAxis() return self._timeAxis end
  function p:addTrack(t)
    self._tracks[#self._tracks + 1] = t
    t._parent = self
    return #self._tracks
  end
  function p:removeTrack(i)
    local t = self._tracks[i]
    if t == nil then return false end
    table.remove(self._tracks, i)
    t._parent = nil
    return true
  end
  function p:addNoteGroup(g)
    self._groupLibrary[#self._groupLibrary + 1] = g
    return #self._groupLibrary
  end
  function p:getNumNoteGroups() return #self._groupLibrary end
  function p:getNoteGroup(i) return self._groupLibrary[i] end
  function p:getScriptData(k) return self._scriptData[k] end
  function p:setScriptData(k, v) self._scriptData[k] = v; return true end
  function p:removeScriptData(k) self._scriptData[k] = nil; return true end
  function p:getScriptDataKeys()
    local out = {}
    for k in pairs(self._scriptData) do out[#out + 1] = k end
    table.sort(out)
    return out
  end
  return p
end

-- ---- selection: the #-is-0 quirk lives here -------------------------------
newSelection = function()
  local sel = { _notes = {} }

  function sel:setNotes(list)
    self._notes = {}
    for i = 1, #list do self._notes[i] = list[i] end
  end

  function sel:getSelectedNotes()
    local arr = {}
    for i = 1, #self._notes do arr[i] = self._notes[i] end
    -- ⚠️ real SV2 build: `#result` is 0 even with notes selected, while
    -- result[i] still returns each note. Reproduced exactly.
    return setmetatable(arr, { __len = function() return 0 end })
  end

  function sel:getNumSelectedNotes() return #self._notes end
  function sel:hasSelectedNotes() return #self._notes > 0 end

  -- ---- 程序化设置选区(select_notes 用) ----------------------------------
  -- ⚠️ 这两条的**真机语义没有实测过**(桥的 0.5.6 只说了"用 getSelection() 然后
  --    clearAll()/selectNote()/selectGroup()"),所以按最保守的读法建模,并如实写在这里:
  --      · selectNote 是**追加**;同一个音符重复选不产生第二份(选区是集合);
  --      · selectGroup 也是**追加**,**不清空** —— 所以桥必须先 clearAll()。
  --        这一点是 30 号测试压着的:去掉 clearAll 的变异会让它变红。
  function sel:clearAll()
    self._notes = {}
    return true
  end

  function sel:selectNote(n)
    if n == nil then return false end
    if indexOf(self._notes, n) == nil then self._notes[#self._notes + 1] = n end
    return true
  end

  function sel:selectGroup(ref)
    if ref == nil then return false end
    local g = ref:getTarget()
    if g == nil then return false end
    for i = 1, g:getNumNotes() do self:selectNote(g:getNote(i)) end
    return true
  end

  return sel
end

-- ---- main editor ----------------------------------------------------------
newEditor = function(ref, track, sel)
  local ed = { _currentRef = ref, _currentTrack = track, _selection = sel }
  function ed:getCurrentGroup() return self._currentRef end
  function ed:getCurrentTrack() return self._currentTrack end
  function ed:getSelection() return self._selection end
  return ed
end

-- ===========================================================================
-- 2. the world (rebuildable)
-- ===========================================================================

function M.resetWorld()
  uuidSeq = 0
  local group = newGroup("Main")
  group:addNote(newNote(0, QUARTER, 60, "la"))
  group:addNote(newNote(QUARTER, QUARTER, 62, "li"))
  group:addNote(newNote(QUARTER * 2, QUARTER, 64, "lu"))

  local ref = newGroupRef(group, 1, true)
  ref:setTimeRange(0, QUARTER * 3)

  local track = newTrack("Lead")
  track:addGroupReference(ref)

  local ta = newTimeAxis()
  ta:addTempoMark(0, 120)
  ta:addMeasureMark(0, 4, 4)

  local project = newProject()
  project._timeAxis = ta
  project:addTrack(track)
  project:addNoteGroup(group)

  local selection = newSelection()
  selection:setNotes(group._notes)

  M.notes = group._notes          -- ⚠️ 必须是**同一个表**:removeNote 之后 __T_pitches 才看得到
  M.group, M.ref, M.track = group, ref, track
  M.timeAxis, M.project = ta, project
  M.selection = selection
  M.editor = newEditor(ref, track, selection)
  M.playback = newPlayback()
  M.paramCalls = {}
  M.autoLog = {}
  M.groupCalls = {}
  M.computedReady = true
  M.lastComputedPitch = nil
  M.failAddGroupReference = false
  M.voiceMerge = false
  return true
end

M.resetWorld()

-- ===========================================================================
-- 3. SV global
-- ===========================================================================

SV = {}
SV.QUARTER = QUARTER

function SV:getHostInfo()
  return {
    hostName = "Synthesizer V Studio 2 Pro",
    hostVersion = "2.3.0",
    hostVersionNumber = 131840,
    osType = "Windows",
    languageCode = "zh-cn",
  }
end

function SV:getProject() return M.project end
function SV:getMainEditor() return M.editor end
function SV:getPlayback() return M.playback end

-- 只认桥真正会要的几种;别的返回 nil(桥对 nil 有显式检查,不会静默错下去)。
function SV:create(kind)
  if kind == "Note" then return newNote(0, QUARTER, 60, "") end
  if kind == "NoteGroup" then return newGroup("") end
  if kind == "NoteGroupReference" then return newGroupRef(nil, 0, false) end
  if kind == "PitchControlCurve" then return newPitchCurve() end
  if kind == "Track" then return newTrack("") end
  return nil
end

-- 文本转音素(宿主算完才有内容;M.computedReady=false 复现"还没算完")
function SV:getPhonemesForGroup(ref)
  if not M.computedReady then return {} end
  local g = ref and ref:getTarget()
  if g == nil then return {} end
  local out = {}
  for i = 1, g:getNumNotes() do
    local n = g:getNote(i)
    local ph = n:getPhonemes()
    if ph == "" then ph = n:getLyrics() .. "-ph" end
    out[i] = ph
  end
  return out
end

-- 采样参数原样记下来:桥必须把本组引用的 timeOffset **加** 到 blickStart 上
-- (官方文档明确要求;不加就是"采样窗口整体错位"这种不报错的错)。
function SV:getComputedPitchForGroup(ref, blickStart, blickInterval, numFrames)
  M.lastComputedPitch = {
    blickStart = blickStart, blickInterval = blickInterval, frames = numFrames,
  }
  if not M.computedReady then return {} end
  local out = {}
  for i = 0, (tonumber(numFrames) or 0) - 1 do
    out[i + 1] = 60 + (i % 12) * 0.5
  end
  return out
end

function SV:getComputedAttributesForGroup(ref)
  if not M.computedReady then return {} end
  local g = ref and ref:getTarget()
  local out = {}
  if g == nil then return out end
  for i = 1, g:getNumNotes() do
    out[i] = { index = i - 1, pitch = g:getNote(i):getPitch() }
  end
  return out
end

-- The bridge calls the timer as ST.timerFn(SV, CFG.POLL_MS, scheduleLoop).
-- Record the callback and let the harness fire it by hand — never recurse.
function SV.setTimeout(a, b, c)
  local fn = c
  if type(fn) ~= "function" then fn = b end
  if type(fn) ~= "function" then fn = a end
  M.pending = fn
  M.timerCalls = M.timerCalls + 1
  return 1
end

-- ===========================================================================
-- 4. control surface (bridge-tests.lua / harness.mjs only)
-- ===========================================================================

function M.tick()
  local cb = M.pending
  M.pending = nil
  if cb == nil then return false end
  cb()
  return true
end

function M.pendingCount() return M.pending ~= nil end

function M.pitches()
  local out = {}
  for i = 1, #M.notes do out[i] = M.notes[i]:getPitch() end
  return out
end

function M.setPitchDirect(i, v) M.notes[i]:setPitch(v) end
-- setVoice 的语义开关:true = 逐字段合并(真机可能是这样),false = 整体替换
function M.setVoiceMerge(v) M.voiceMerge = (v == true) end
function M.pitch(i) return M.notes[i]:getPitch() end

-- select a subset (or all) of the notes
function M.select(list)
  if list == nil then
    M.selection:setNotes(M.notes)
  else
    M.selection:setNotes(list)
  end
end

-- make the Nth group reference of the first track the "current group"
function M.useGroupAt(refIndex)
  local tr = M.project:getTrack(1)
  local r = tr and tr:getGroupReference(refIndex)
  if r == nil then return false end
  M.editor._currentRef = r
  return true
end

function M.setRefTimeOffset(blick)
  local r = M.editor._currentRef
  if r == nil then return false end
  r:setTimeOffset(blick)
  return true
end

-- ===========================================================================
-- 5. 0.6.1–0.6.4 那批 op 需要的控制面
-- ===========================================================================

-- 给指定的轨追加一个**外部音频引用**(isInstrumental = true)。
-- 音频引用没有可编辑的音符 ⇒ getTarget() 是 nil,正好压住"音频轨没有组"这条。
-- 返回它的 **0 起** 组下标;轨不存在返回 -1。
function M.addInstrumentalRef(trackIndex0, onsetBlick, durBlick, timeOffsetBlick)
  local tr = M.project:getTrack((tonumber(trackIndex0) or 0) + 1)
  if tr == nil then return -1 end
  local r = newGroupRef(nil, 0, false)
  r:setInstrumental(true)
  r:setTimeRange(onsetBlick or 0, durBlick or QUARTER)
  if timeOffsetBlick ~= nil then r:setTimeOffset(timeOffsetBlick) end
  tr:addGroupReference(r)
  return tr:getNumGroups() - 1
end

-- 往 **Main 组**加一个音符(onset/duration 以四分音符为单位)。
-- 用途:apply_lyrics / align_lyrics 需要一个 4 个音符的组,而 write_notes 的 4 拍窗口
-- 会碰到 fengari 的 32 位整数回绕(4*QUARTER > 2^31)⇒ 直接改主组,避开那个坑。
-- ⚠️ M.notes 与 M.group._notes 是**同一个表**(resetWorld 里刻意如此),所以这里加的音
--    立刻出现在 __T_pitches 里。选区的副本不会自动跟着长 ⇒ 需要时测试自己 __T_selectAll()。
function M.addNoteToMainGroup(onsetQ, durQ, pitch, lyrics)
  local onset = math.floor((tonumber(onsetQ) or 0) * QUARTER + 0.5)
  local dur = math.floor((tonumber(durQ) or 1) * QUARTER + 0.5)
  M.group:addNote(newNote(onset, dur, pitch or 60, lyrics or ""))
  return #M.group._notes
end

-- 直接改一个音符的 onset/duration(以四分音符为单位)。
-- 用途:造"重叠"(get_layout 的违规样本)与"空隙"—— 真机上这两种布局都是手画出来的。
function M.setNoteRangeQuarter(i, onsetQ, durQ)
  local n = M.group._notes[tonumber(i) or 0]
  if n == nil then return false end
  n:setTimeRange(math.floor(onsetQ * QUARTER + 0.5), math.floor(durQ * QUARTER + 0.5))
  return true
end

-- 把 Main 组的 `_notes` **重新排列**成给定顺序(1 起下标的排列)。
-- 用途:apply_lyrics 的"按 onset 排,不是按 getNote(i) 的存储顺序"——
-- 只有让存储顺序 ≠ 时间顺序,那条断言才有区分力。
function M.reorderNotes(perm)
  local g = M.group
  local out = {}
  for i = 1, #perm do out[i] = g._notes[perm[i]] end
  for i = 1, #out do g._notes[i] = out[i] end
  return #out
end

-- 显式设置一条轨的 displayOrder(和存储下标不同时才有意义)
function M.setTrackDisplayOrder(trackIndex0, order)
  local tr = M.project:getTrack((tonumber(trackIndex0) or 0) + 1)
  if tr == nil then return false end
  tr:setDisplayOrder(order)
  return true
end

FAKE = M
return M
