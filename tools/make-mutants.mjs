// make-mutants.mjs — write deliberately-broken COPIES of DSHBridge.lua.
//
//   node make-mutants.mjs                 # from ../plugin/sv/DSHBridge.lua
//   node make-mutants.mjs --bridge <file> # from another copy
//
// A test suite that has never been seen to fail is not evidence. Each entry in
// MUTANTS below is a real bug that has either shipped or nearly shipped; the
// generator writes it into .mutants/<name>.lua, and the README records which
// test each one turns red:
//
//   node harness.mjs --bridge .mutants/delete-notes-no-groupfp.lua
//
// Every substitution must match EXACTLY once, so a bridge edit that moves the
// code makes this fail loudly instead of silently producing a no-op mutant
// (a mutant that changes nothing proves nothing).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_BRIDGE = path.resolve(HERE, '..', 'plugin', 'sv', 'DSHBridge.lua')
const OUT_DIR = path.join(HERE, '.mutants')

const argv = process.argv.slice(2)
const bi = argv.indexOf('--bridge')
const BRIDGE = bi !== -1 && argv[bi + 1] ? path.resolve(argv[bi + 1]) : DEFAULT_BRIDGE

/** [name, why, [[find, replace], ...]] */
const MUTANTS = [
  ['delete-notes-no-groupfp',
    'delete_notes: drop the expectGroupFp / STALE_SELECTION check (deletes the wrong notes)',
    // ⚠️ 这个 find 必须**带上 delete_notes 独有的前一行**:split_notes 里有一段
    //    逐字相同的 STALE 检查(v0.5.7 加的),只写那段会命中两次 ⇒ 生成器直接报错。
    [[`  local n = num(call(grp, "getNumNotes")) or 0
  local expect = args.expectGroupFp
  if type(expect) ~= "string" or #expect == 0 then
    error("expectGroupFp is required: call get_notes first and pass its groupFp back unchanged")
  end
  local now = groupFingerprint(grp)
  if now ~= expect then
    error("STALE_SELECTION: group changed since it was read (expected " .. expect ..
          ", actual " .. now .. "). Re-read with get_notes and retry.")
  end`,
      '  local n = num(call(grp, "getNumNotes")) or 0\n  -- MUTANT: fingerprint check dropped entirely']]],

  // ---- the 0.5.7 batch: select_notes / get_note_attrs / split_notes ---------

  ['split-notes-no-groupfp',
    'split_notes: drop the expectGroupFp / STALE_SELECTION check (splits the wrong note)',
    [[`  local now = groupFingerprint(grp)
  if now ~= expect then
    error("STALE_SELECTION: group changed since it was read (expected " .. expect ..
          ", actual " .. now .. "). Re-read with get_notes and retry.")
  end

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local MIN_Q = 0.125`,
      `  -- MUTANT: fingerprint check dropped entirely

  local QUARTER = tonumber(SV and SV.QUARTER) or 705600000
  local MIN_Q = 0.125`]]],

  ['split-notes-no-inner-bounds',
    'split_notes: allow a split point at/outside the note edges (zero-length or negative halves)',
    [['    if at <= onsetQ + MIN_Q - 1e-9 or at >= endQ - MIN_Q + 1e-9 then',
      '    if false then   -- MUTANT: split-point bounds dropped']]],

  ['split-notes-head-not-shortened',
    'split_notes: leave the head at its full duration (the two halves overlap)',
    [['    call(nt, "setTimeRange", p.onsetQ * QUARTER, (p.at - p.onsetQ) * QUARTER)',
      '    call(nt, "setTimeRange", p.onsetQ * QUARTER, (p.endQ - p.onsetQ) * QUARTER)   -- MUTANT: head not shortened']]],

  ['split-notes-tail-not-appended',
    'split_notes: build the tail but never add it to the group (the note just disappears)',
    [['    call(grp, "addNote", tail)',
      '    -- MUTANT: tail never added to the group']]],

  ['split-notes-loses-lyrics',
    'split_notes: do not copy the lyrics onto the tail',
    [['    if type(lyrics) == "string" and #lyrics > 0 then call(tail, "setLyrics", lyrics) end',
      '    -- MUTANT: tail lyrics not copied']]],

  ['select-notes-no-bounds',
    'select_notes: drop the index bounds check (selects nothing / the wrong notes, silently)',
    [[`      if ix < 0 or ix >= n then
        error("indices[" .. i .. "] = " .. tostring(ix) .. " 越界(本组 " .. n .. " 个音符)")
      end`,
      '      -- MUTANT: index bounds check dropped']]],

  ['select-notes-no-clear',
    'select_notes: skip clearAll() for all/indices (the new selection merges into the old one)',
    [['  call(sel, "clearAll")\n  local selected = 0',
      '  -- MUTANT: clearAll dropped (merged instead of replaced)\n  local selected = 0']]],

  ['select-notes-group-no-clear',
    'select_notes {action:"group"}: skip clearAll() (the group is added to the old selection)',
    [['    call(sel, "clearAll")\n    call(sel, "selectGroup", ref)',
      '    -- MUTANT: clearAll dropped before selectGroup\n    call(sel, "selectGroup", ref)']]],

  ['note-attrs-fill-defaults',
    'get_note_attrs: invent default attribute values instead of reporting only what was written',
    [['    info.musicalType = call(nt, "getMusicalType")\n    info.pitchAutoMode = call(nt, "getPitchAutoMode")',
      '    info.musicalType = call(nt, "getMusicalType") or "default"   -- MUTANT\n    info.pitchAutoMode = call(nt, "getPitchAutoMode") or false   -- MUTANT'],
     ['    local raw = call(nt, "getAttributes")\n    if type(raw) == "table" then info.attributes = raw end',
      '    local raw = call(nt, "getAttributes")\n    if type(raw) ~= "table" then raw = {} end\n    if raw.detune == nil then raw.detune = 0 end\n    if raw.phonemes == nil then raw.phonemes = "" end\n    info.attributes = raw   -- MUTANT: invented defaults']]],

  ['get-note-attrs-no-limit',
    'get_note_attrs: ignore args.limit (never truncates, never says so)',
    [['    if i > limit then truncated = true break end\n    local nt = notes[i]',
      '    -- MUTANT: limit ignored\n    local nt = notes[i]']]],

  // ---- index validation: the 0.6.0 fix (a non-integer index handed to a host
  //      binding is the input class that pops a modal dialog and freezes SV2) ---

  ['select-notes-no-integer',
    'select_notes: drop the integer check on indices (getNote(1.5) reaches the host)',
    [[`      if ix ~= math.floor(ix) then
        error("indices[" .. i .. "] = " .. tostring(ix) .. " 必须是整数(音符下标不能是小数)")
      end`,
      '      -- MUTANT: integer check dropped']]],

  ['delete-notes-no-integer',
    'delete_notes: drop the integer check on indices (removeNote(1.5) reaches the host)',
    [[`    if ix ~= math.floor(ix) then
      error("indices[" .. i .. "] = " .. tostring(ix) .. " 必须是整数(音符下标不能是小数)")
    end`,
      '    -- MUTANT: integer check dropped']]],

  ['split-notes-no-integer',
    'split_notes: drop the integer check on index (getNote(1.5) reaches the host)',
    [[`    if ix ~= math.floor(ix) then
      error("splits[" .. i .. "].index = " .. tostring(ix) .. " 必须是整数(音符下标不能是小数)")
    end`,
      '    -- MUTANT: integer check dropped']]],

  ['select-notes-clear-before-validate',
    'select_notes: clearAll() before validating (a REJECTED request wipes the user\'s selection)',
    [['  local n = num(call(grp, "getNumNotes")) or 0\n  local targets = {}\n  if action == "all" then',
      '  call(sel, "clearAll")   -- MUTANT: clears the selection BEFORE validating\n  local n = num(call(grp, "getNumNotes")) or 0\n  local targets = {}\n  if action == "all" then']]],

  ['select-notes-undo-before-validate',
    'select_notes: newUndoRecord() before validating (a rejected request pushes an empty undo step)',
    [['  local n = num(call(grp, "getNumNotes")) or 0\n  local targets = {}\n  if action == "all" then',
      '  call(project(), "newUndoRecord")   -- MUTANT: undo step BEFORE validating\n  local n = num(call(grp, "getNumNotes")) or 0\n  local targets = {}\n  if action == "all" then']]],

  // ---- time-mark position fields: the 0.5.8 fix (the two mark kinds expose
  //      DIFFERENT fields, so one shared reader order breaks one of them) ------

  ['tempo-mark-reads-positionblick',
    'get_tempo: read a tempo mark position from positionBlick with NO fallback (the pre-0.5.8 shape ⇒ every tempo lands on beat 0)',
    // ⚠️ 只把顺序换过来、保留 fallback 是**等价变异**(真机给 nil ⇒ 回落到 position ⇒ 结果不变),
    //    什么都证明不了。必须把 fallback 一起去掉,复现的才是 0.5.8 之前那个"统一顺序"的形状。
    [[`local function tempoMarkBlick(mk)
  local pos = prop(mk, "position")
  if type(pos) ~= "number" then pos = prop(mk, "positionBlick") end
  if type(pos) ~= "number" then return nil end
  return pos
end`,
      `local function tempoMarkBlick(mk)
  local pos = prop(mk, "positionBlick")   -- MUTANT: 0.5.8 regression, no fallback
  if type(pos) ~= "number" then return nil end
  return pos
end`]]],

  ['measure-mark-reads-position',
    'get_tempo: read a measure mark position from `position` (the real host returns a ~1 blick garbage value there)',
    [['  local pos = prop(mk, "positionBlick")\n  if type(pos) ~= "number" then pos = prop(mk, "position") end',
      '  local pos = prop(mk, "position")   -- MUTANT: 0.5.8 regression (garbage field first)\n  if type(pos) ~= "number" then pos = prop(mk, "positionBlick") end']]],

  // ---- split ordering: the 0.5.9 fix (addNote INSERTS by onset, so an
  //      ascending plan makes the second split land on a shifted neighbour) ----

  ['split-notes-ascending',
    'split_notes: process the plan in ASCENDING index order (0.5.9 regression: the 2nd split hits a neighbour)',
    [['  table.sort(plan, function(a, b) return a.ix > b.ix end)',
      '  table.sort(plan, function(a, b) return a.ix < b.ix end)   -- MUTANT: 0.5.9 regression']]],

  ['delete-notes-forward',
    'delete_notes: delete front-to-back so every index shifts mid-batch',
    [['  for i = #targets, 1, -1 do',
      '  for i = 1, #targets do   -- MUTANT: forward delete, indices shift']]],

  ['automation-ignore-closeshape',
    'set_automation: ignore closeShape (the shaped value then holds across the whole group)',
    [['  if args.closeShape ~= false then',
      '  if false then   -- MUTANT: closeShape ignored']]],

  ['dynamics-not-rejected',
    'set_automation: let "dynamics" reach getParameter (the fake object that corrupts host memory)',
    [['  if t == "dynamics" then',
      '  if false then   -- MUTANT: dynamics hard reject disabled'],
     ['  toneShift   = { min = -800, max = 800 },',
      '  toneShift   = { min = -800, max = 800 },\n  dynamics    = { min = -1, max = 1 },   -- MUTANT']]],

  ['set-tempo-no-pre-remove',
    'set_tempo: skip the removeTempoMark that compensates for addTempoMark not updating',
    [['    call(ta, "removeTempoMark", b)      -- \u26a0\ufe0f \u5148\u5220\u540c\u4f4d\u7f6e,\u5426\u5219\u4e0d\u4f1a\u66f4\u65b0',
      '    -- MUTANT: pre-removeTempoMark skipped']]],

  ['write-pit-relative-pitch',
    'write_pit: forget that the host stores a pitch OFFSET from the anchor',
    [['    pts[i] = { (plan[i].at - anchorQ) * QUARTER, plan[i].pitch - anchorPitch }',
      '    pts[i] = { (plan[i].at - anchorQ) * QUARTER, plan[i].pitch }   -- MUTANT: offset not applied']]],

  ['write-notes-no-mount',
    'write_notes: skip step 3 (mount the reference on the track) — renders nothing, silently',
    [['  call(track, "addGroupReference", ref)             -- \u2462 \u6302\u8f68',
      '  -- MUTANT: step 3 (mount on the track) skipped']]],

  ['get-computed-no-offset',
    'get_computed: forget to add the group reference timeOffset to blickStart',
    [['    local list = SC("getComputedPitchForGroup", ref, startQ * QUARTER + offset, step * QUARTER, frames)',
      '    local list = SC("getComputedPitchForGroup", ref, startQ * QUARTER, step * QUARTER, frames)   -- MUTANT: offset dropped']]],

  ['get-notes-unstable-fp',
    'groupFingerprint: hash only the note COUNT, not the note contents',
    [['    if nt ~= nil then parts[#parts + 1] = noteFp(nt) end',
      '    if nt ~= nil then parts[#parts + 1] = tostring(i) end   -- MUTANT: content ignored']]],

  ['set-meter-no-pow2',
    'set_meter: drop the power-of-two denominator check',
    [['  if denom ~= 1 and denom ~= 2 and denom ~= 4 and denom ~= 8 and denom ~= 16 and denom ~= 32 then',
      '  if false then   -- MUTANT: power-of-two check dropped']]],

  ['set-mixer-no-range',
    'track_ops setMixer: drop the gain / pan range checks',
    [['      if g == nil or g < -24 or g > 24 then error("gainDecibel \u5fc5\u987b\u5728 -24..24(\u5b98\u65b9\u8303\u56f4)") end',
      '      if g == nil then error("gainDecibel must be a number") end   -- MUTANT: range check dropped'],
     ['      if p == nil or p < -1 or p > 1 then error("pan \u5fc5\u987b\u5728 -1..1") end',
      '      if p == nil then error("pan must be a number") end   -- MUTANT: range check dropped']]],

  ['group-delete-main',
    'group_ops delete: drop the "the main group cannot be deleted" guard',
    // ⚠️ 这个 find 必须**带上那句 error**:0.6.1 加进来的 `group_ops move` 里有一句
    //    逐字相同的 `if call(ref, "isMain") == true then`(只是 error 文案不同),
    //    只写条件会命中两次 ⇒ 生成器直接报错退出 1。这正是"恰好命中一次"那条
    //    纪律在起作用:它先抓到了自己的失效(v0.6.1 之后就一直是红的)。
    [['    if call(ref, "isMain") == true then\n      error("主组不能删(它是宿主自带的)")',
      '    if false then   -- MUTANT: main-group guard dropped']]],

  ['track-remove-last',
    'track_ops remove: drop the "cannot delete the last track" guard',
    [['    if n <= 1 then error("\u4e0d\u80fd\u5220\u6389\u6700\u540e\u4e00\u6761\u8f68") end',
      '    -- MUTANT: last-track guard dropped']]],

  ['note-attrs-no-maxlen',
    'set_note_attrs: drop the maxLen cap on text fields (phonemes / language)',
    [['          if spec.maxLen ~= nil and #value > spec.maxLen then',
      '          if false then   -- MUTANT: maxLen cap dropped']]],

  ['note-attrs-no-language-pattern',
    'set_note_attrs: drop the language-code pattern check',
    [['          if spec.pattern ~= nil and not value:match(spec.pattern) then',
      '          if false then   -- MUTANT: pattern check dropped']]],

  // ---- the original batch (still reproducible from this same script) -------

  ['jenc-pct14g',
    'jenc: encode integral floats with %.14g (the classic 16-digit id bug)',
    [['      return string.format("%.0f", v)',
      '      return string.format("%.14g", v)   -- MUTANT: loses the last digits']]],

  ['jenc-pct6g',
    'jenc: encode non-integral numbers with %.6g (W2 regression)',
    [['    return string.format("%.10g", v)',
      '    return string.format("%.6g", v)   -- MUTANT: W2 regression']]],

  ['selectednotes-trust-len',
    'selectedNotes(): trust `#` and drop the getNumSelectedNotes() fallback',
    [['    local cnt = num(call(sel, "getNumSelectedNotes"))\n    if cnt ~= nil then n = cnt end',
      '    -- MUTANT: no fallback to getNumSelectedNotes()']]],

  ['require-expectfp',
    'requireFreshSelection(): stop requiring expectFp',
    [['  local expect = args and args.expectFp\n  if type(expect) ~= "string" or #expect == 0 then',
      '  local expect = args and args.expectFp\n  if false then   -- MUTANT: expectFp not required']]],

  ['note-attrs-no-range',
    'set_note_attrs: drop the numeric range check',
    [['          if n < spec.min or n > spec.max then',
      '          if false then   -- MUTANT: range check dropped']]],

  ['note-attrs-no-integer',
    'set_note_attrs: drop the integer check (W1 regression)',
    [['          if spec.integer ~= false and n ~= math.floor(n) then',
      '          if false then   -- MUTANT: integer check dropped']]],

  ['pollonce-no-id-dedup',
    'pollOnce: ignore the response cache (no id de-duplication)',
    [['  if ST.done[idKey] ~= nil then',
      '  if false then   -- MUTANT: response cache ignored']]],

  ['pollonce-keep-bad-json',
    'pollOnce: leave a malformed request file in place (re-read every tick)',
    [['    consumeReq(text)\n    return false\n  end\n\n  local idKey = tostring(req.id)',
      '    -- MUTANT: bad JSON left in place\n    return false\n  end\n\n  local idKey = tostring(req.id)']]],

  ['writeatomic-refuse-overwrite',
    'writeAtomic: refuse to overwrite an existing target',
    [['  local tmp = path .. ".tmp"\n  if not writeFile(tmp, s) then return false end',
      '  local tmp = path .. ".tmp"\n  if io.open(path, "r") ~= nil then pcall(function() os.remove(tmp) end) return false end   -- MUTANT\n  if not writeFile(tmp, s) then return false end']]],

  ['cfg-poll-ms-300',
    'CFG: POLL_MS back to 300 (W3 regression: HB_MS is no longer a multiple)',
    [['  POLL_MS   = 250,',
      '  POLL_MS   = 300,   -- MUTANT: W3 regression']]],

  ['buildpaths-rebind',
    'buildPaths: re-bind PATH instead of filling it field by field (W4 regression)',
    [['  PATH.dir        = dir',
      '  PATH = { dir = dir }   -- MUTANT: rebind (the test hook holds the old table)']]],

  // ---- the 0.6.1–0.6.4 batch (tests 33-40) ---------------------------------

  ['get-layout-ignores-overlaps',
    'get_layout: stop comparing a note\'s end with the next onset (every overlap reports as clean)',
    // ⚠️ quantize 里有一句形近的 `if aEnd > plan[i + 1].newOnset + 1e-9 then`,所以这里
    //    必须带上 `b.onset` 这个只有 get_layout 才有的写法,否则会命中两次。
    [['    if aEnd > b.onset then',
      '    if false then   -- MUTANT: overlaps ignored (always "OK")']]],

  ['apply-lyrics-storage-order',
    'apply_lyrics: trust getNote(i) storage order instead of sorting by onset (lyrics land on the wrong notes)',
    [['    table.sort(notes, function(a, b)\n' +
      '      local ao = num(call(a, "getOnset")) or 0\n' +
      '      local bo = num(call(b, "getOnset")) or 0\n' +
      '      if ao == bo then return (num(call(a, "getPitch")) or 0) < (num(call(b, "getPitch")) or 0) end\n' +
      '      return ao < bo\n' +
      '    end)',
      '    -- MUTANT: notes left in getNote(i) storage order (no sort by onset)']]],

  ['align-lyrics-writes-on-dryrun',
    'align_lyrics: write even when apply:false (the "dry run" mutates the project)',
    [['  if apply then\n    call(proj, "newUndoRecord")',
      '  if true then   -- MUTANT: the dry-run writes\n    call(proj, "newUndoRecord")']]],

  ['align-audio-no-measure-minus-one',
    'align_audio: pass the 1-based measure straight to getMeasureMarkAt (skips the 1-based → 0-based conversion)',
    [['    local mark = call(ta, "getMeasureMarkAt", measure - 1)',
      '    local mark = call(ta, "getMeasureMarkAt", measure)   -- MUTANT: 1-based/0-based conversion skipped']]],

  ['note-attrs-accept-unknown-key',
    'set_note_attrs: pass an unknown attributes key straight to Note:setAttributes (pops a modal dialog on the real host)',
    // 真机后果是**模态错误框冻住宿主**(参考项目在 SV1 上踩过),离线只能验
    // "桥不会把不认识的键递过去" —— 递过去之后假宿主会老老实实存下来,
    // 于是 38 号测试的"一个字节都没写"断言立刻变红。
    [['    local spec = ATTRIBUTE_WHITELIST[key]\n' +
      '    if spec == nil then\n' +
      '      error(where .. ".attributes 里有不允许的键 \'" .. tostring(key) ..\n' +
      '            "\'(允许:" .. ATTRIBUTE_NAMES .. ")")\n' +
      '    end',
      '    local spec = ATTRIBUTE_WHITELIST[key]\n' +
      '    if spec == nil then\n' +
      '      out[key] = value   -- MUTANT: unknown key handed to the host\n' +
      '      spec = { kind = "passthrough" }\n' +
      '    end']]],

  ['group-move-remove-before-add',
    'group_ops move: remove the source reference BEFORE the destination add succeeded (a failed add loses the group)',
    [['    local added = call(dst, "addGroupReference", newRef)\n' +
      '    if added == nil then error("addGroupReference 失败,已中止(源引用没动,数据没丢)") end\n' +
      '\n' +
      '    -- 删之前再确认一次:这个下标现在指向的**确实是我们刚挂上去的那个组的同一个目标**。\n' +
      '    -- 宿主每次返回新包装对象,所以只能比目标组,不能比引用对象本身。\n' +
      '    local checkRef = call(src, "getGroupReference", refIdx)\n' +
      '    local checkTarget = checkRef and call(checkRef, "getTarget")\n' +
      '    if checkTarget == nil or num(call(checkTarget, "getNumNotes")) ~= num(call(grp, "getNumNotes")) then\n' +
      '      error("删旧引用前的自检没过(源轨第 " .. refIdx .. " 个引用不像是本组)—— " ..\n' +
      '            "已中止,**没有删任何东西**。新引用可能已挂到目标轨,请检查后手工收拾。")\n' +
      '    end\n' +
      '    call(src, "removeGroupReference", refIdx)',
      '    -- MUTANT: 先删源引用再挂目标,而且不带自检 —— add 失败就会丢组\n' +
      '    call(src, "removeGroupReference", refIdx)\n' +
      '    local added = call(dst, "addGroupReference", newRef)\n' +
      '    if added == nil then error("addGroupReference 失败,已中止(源引用没动,数据没丢)") end']]],

  // ⚠️ 这条复现的是 0.6.6 那个**真机上会毁数据**的 bug:用**源轨的工程下标**去删引用。
  //    它必须同时把"删前自检"一起去掉,否则自检会拦住它、变成一次干净的报错,
  //    就测不出"静默删错 + 组重复挂两条轨"这个原始形态了。
  ['group-move-wrong-index',
    'group_ops move: remove the source reference by the SOURCE TRACK index instead of the reference index (0.6.6: duplicates the group and deletes the Main group)',
    [['    -- 删之前再确认一次:这个下标现在指向的**确实是我们刚挂上去的那个组的同一个目标**。\n' +
      '    -- 宿主每次返回新包装对象,所以只能比目标组,不能比引用对象本身。\n' +
      '    local checkRef = call(src, "getGroupReference", refIdx)\n' +
      '    local checkTarget = checkRef and call(checkRef, "getTarget")\n' +
      '    if checkTarget == nil or num(call(checkTarget, "getNumNotes")) ~= num(call(grp, "getNumNotes")) then\n' +
      '      error("删旧引用前的自检没过(源轨第 " .. refIdx .. " 个引用不像是本组)—— " ..\n' +
      '            "已中止,**没有删任何东西**。新引用可能已挂到目标轨,请检查后手工收拾。")\n' +
      '    end\n' +
      '    call(src, "removeGroupReference", refIdx)',
      '    -- MUTANT: 轨下标当引用下标(0.6.6 的原始 bug),自检也一起去掉\n' +
      '    call(src, "removeGroupReference", srcTrackIdx)']]],

  ['track-list-reuses-index',
    'track_ops list: report the storage index as displayOrder (the topmost track is then misidentified)',
    [['          displayOrder = num(call(tr, "getDisplayOrder")),',
      '          displayOrder = i - 1,   -- MUTANT: storage index reused as display order']]],

  ['track-list-notecount-is-groupcount',
    'track_ops list: report the group COUNT as noteCount (the "is the topmost track empty?" answer becomes wrong)',
    [['          noteCount = notes,',
      '          noteCount = gcount,   -- MUTANT: group count reported as note count']]],

  // ⚠️ 这条复现的是 0.7.1 修掉的**静默写错地方**那个 bug,而且它在两个平台上都
  //    会被抓到(不依赖 package.config 的取值):POSIX 上路径会变成"名字里带反斜杠
  //    的文件",windows 上 joinPath("/a/b", …) 也会拼出带反斜杠的怪路径。
  ['path-sep-hardcoded-windows',
    'joinPath: hardcode the "\\\\" separator (POSIX: every path becomes a FILE whose name contains a backslash, so the bridge silently writes into the wrong place)',
    [['local function joinPath(dir, name) return dir .. sepFor(dir) .. name end',
      'local function joinPath(dir, name) return dir .. "\\\\" .. name end   -- MUTANT: separator hardcoded to Windows']]],

  // ---- 0.8.0:目录候选 / 快照 / 回滚 -----------------------------------------

  // 桥原来只认 Windows 的目录变量。macOS 上三个都不存在 ⇒ 候选为空 ⇒ 桥直接起不来,
  // 而 DSH 插件用 os.homedir() / os.tmpdir() 已经把目录建好了。test 41 在任何平台都守它。
  ['dir-candidates-windows-only',
    'dirCandidates: go back to USERPROFILE / TEMP / TMP only (macOS then has ZERO candidates ⇒ the bridge dies with "no writable channel dir")',
    [['local home = getenv("USERPROFILE") or getenv("HOME")',
      'local home = getenv("USERPROFILE")   -- MUTANT: HOME ignored'],
     ['local tmp = getenv("TEMP") or getenv("TMP") or getenv("TMPDIR")',
      'local tmp = getenv("TEMP") or getenv("TMP")   -- MUTANT: TMPDIR ignored']]],

  // 快照没落盘却报成功 = "以为能回滚,其实没有依据" —— 静默失败里最坏的一种。
  ['snapshot-not-persisted',
    'snapshot: build the snapshot but never write it to disk (the caller believes it can roll back)',
    [['  if not snapSave(store) then',
      '  if false then   -- MUTANT: snapshot never persisted']]],

  // 回滚按"当前组"而不是快照里的 UUID ⇒ 用户切到别的组之后,回滚会写进**错的组**。
  ['restore-ignores-group-uuid',
    'restore: locate the group by "current group" instead of the snapshot UUID (rolling back after the user switched groups writes into the WRONG group)',
    [['  local ref, grp = findGroupByUuid(item.groupUuid)',
      '  local ref, grp = nil, nil   -- MUTANT: UUID lookup skipped']]],

  // 删多余音符时从头部删:下标漂移 ⇒ 删掉不该删的音符(与 delete_notes 那条同源)。
  ['restore-remove-ascending',
    'restore: remove the surplus notes front-to-back instead of back-to-front (indices shift mid-loop ⇒ the wrong notes are deleted)',
    [['  for i = beforeCount, #target + 1, -1 do\n    call(grp, "removeNote", i)',
      '  for i = #target + 1, beforeCount do   -- MUTANT: ascending removal\n    call(grp, "removeNote", i)']]],

  // ---- 0.8.3:编排布局(组级回滚)-------------------------------------------

  // 快照不带布局 ⇒ 组的增删/移动又回滚不掉了(返回里却还声称能覆盖)。
  ['snapshot-drops-layout',
    'snapshot: stop recording the track layout (group create / delete / move become unrecoverable again)',
    [['  local layout = captureLayout()\n', '  local layout = nil   -- MUTANT: 不记布局\n']]],

  // 只按"UUID 在不在快照里"判多余/缺失 ⇒ **挪到别的轨的组没人管**
  // (它在快照里,所以不算多余;它在当前轨上,所以也不算缺失)。写测试时正是这么发现的。
  ['restore-layout-ignores-misplaced',
    'restoreLayout: treat a group that moved to another track as "fine" (it is neither extra nor missing, so nobody puts it back)',
    [['          local misplaced = (w ~= nil and w.track ~= now[ti].index)',
      '          local misplaced = false   -- MUTANT: 挪到别的轨不管']]],

  // 删了却挂不回去 ⇒ 撤销 group_ops delete 失效(而且报告里会说"没有找不回来的")。
  ['restore-layout-skips-readd',
    'restoreLayout: never re-mount a reference that the snapshot had (undoing group_ops delete silently does nothing)',
    [['          local grp = findLibraryGroupByUuid(w.uuid)\n          if grp ~= nil then',
      '          local grp = findLibraryGroupByUuid(w.uuid)\n          if false then   -- MUTANT: 不挂回去']]],

  // 几何只修一半:时间偏移不还原 ⇒ 组回到轨上了,但位置还是错的。
  ['restore-layout-drops-timeoffset',
    'restoreLayout: restore the time range but not the time offset (the group comes back to the right track at the wrong place)',
    [['            if math.floor(num(call(ref, "getTimeOffset")) or 0) ~= w.timeOffset then',
      '            if false then   -- MUTANT: 不还原时间偏移']]],

  // ---- 0.8.4:声音属性层(clearModes / resetModes)--------------------------

  // 整体回写时只带 args 里的模式 ⇒ 没提到的模式被顺手清掉("读—改—写"的核心保证没了)。
  ['set-voice-drops-untouched-modes',
    'set_voice: build vocalModeParams from the args only (every mode not mentioned in this call is silently wiped)',
    [['  local modes = {}\n  if type(cur.vocalModeParams) == "table" then',
      '  local modes = {}\n  if false then   -- MUTANT: 不带上已有的模式']]],

  // 不回读就报"清掉了" ⇒ 宿主其实是逐字段合并时,用户以为清干净了、实际还在。
  ['set-voice-clear-ignores-readback',
    'set_voice clearModes: report "cleared" without checking the read-back (a host that merges silently keeps the mode while we claim it is gone)',
    [['    if clearExisted[n] then\n      if backModes[n] == nil then',
      '    if clearExisted[n] then\n      if true then   -- MUTANT: 不查回读']]],

  // 把"本来就没有"的名字也算成"清掉了" ⇒ 报告里的 cleared 不再可信。
  ['set-voice-cleared-counts-notfound',
    'set_voice clearModes: count a name that never existed as "cleared" (it is absent from the read-back for a different reason)',
    [['    if clearExisted[n] then\n      if backModes[n] == nil then',
      '    if true then   -- MUTANT: 本来就没有的也算清掉了\n      if backModes[n] == nil then']]],

  // 中性值写错 ⇒ "拨回默认"变成"拨到 0",听感完全不是一回事。
  ['set-voice-reset-wrong-neutral',
    'VOCAL_MODE_NEUTRAL: reset vocal modes to 0 instead of the default 100 (audibly a different place entirely)',
    [['local VOCAL_MODE_NEUTRAL = 100', 'local VOCAL_MODE_NEUTRAL = 0   -- MUTANT: 中性值写错']]],

  // ---- 0.9.3:属性层也进快照 --------------------------------------------------

  // 快照不存属性层 ⇒ 回滚时"音符层一致"照样通过,属性却没回去(最坏的静默)。
  ['snapshot-drops-attrs',
    'snapshot: stop capturing the attribute layer (set_note_attrs becomes un-rollbackable while restore still reports success)',
    [['        attrs = captureAttrs(nt),\n', '        -- MUTANT: 不存属性层\n']]],

  // 存了但写不回去 —— 同样会出现"报成功、其实没回去"。
  ['restore-skips-attrs',
    'restore: capture the attribute layer but never write it back (the read-back then reports a mismatch, or worse, is not compared at all)',
    [['    if want.attrs ~= nil and nt ~= nil then applyAttrs(nt, want.attrs) end',
      '    if false then applyAttrs(nt, want.attrs) end   -- MUTANT: 不写回属性']]],

  // ---- 0.9.4:auto_pitch(音高微表情)------------------------------------------

  // 句尾不下滑 ⇒ 唱出来是"硬收",人味没了。
  ['auto-pitch-no-fall',
    'auto_pitch: 句尾不下滑(每个乐句都硬收,听起来不像人唱的)',
    [['        push(endQ - lead, 0)      -- 先回 0,形状才成立(不是从上一个音一路滑下来)\n        push(endQ - 0.03, -fallMax)',
      '        push(endQ - lead, 0)\n        push(endQ - 0.03, 0)   -- MUTANT: 句尾不落']]],

  // 滑入方向反了 ⇒ 往上跳时从上方"砸"下来,听感立刻不对。
  ['auto-pitch-wrong-slide-side',
    'auto_pitch: 大跳滑入的方向搞反(往上跳反而从上方滑入)',
    [['        local dir = (leap > 0) and -1 or 1',
      '        local dir = (leap > 0) and 1 or -1   -- MUTANT: 方向反了']]],
]

function apply(src, subs, name) {
  let out = src
  for (const [find, repl] of subs) {
    const n = out.split(find).length - 1
    if (n !== 1) {
      throw new Error(`${name}: pattern matched ${n} times (want exactly 1): ${JSON.stringify(find.slice(0, 60))}`)
    }
    out = out.replace(find, repl)
  }
  return out
}

function main() {
  if (!fs.existsSync(BRIDGE)) {
    console.error(`bridge not found: ${BRIDGE}`)
    process.exit(2)
  }
  const src = fs.readFileSync(BRIDGE, 'utf8')

  // ⚠️ 本文件的替换串全都按 "\n" 写:工作树一旦是 CRLF(仓库里没有 .gitattributes
  //    时,Git for Windows 默认 core.autocrlf=true 就会这样),**每一条**都会
  //    "pattern matched 0 times",而报错只说"匹配 0 次",完全看不出真正的原因是换行。
  //    windows 的 CI job 就是这么红的。先判一次,把原因直接说出来。
  if (src.includes('\r\n')) {
    console.error('✗ 桥源码是 CRLF —— 工作树被 Git 的换行转换改过。')
    console.error('  本文件的替换串都按 "\\n" 写,CRLF 下会整片"匹配 0 次"(不是代码真的变了)。')
    console.error('  新 clone 不会这样:仓库根目录的 .gitattributes 强制 eol=lf。')
    console.error('  已有的工作树:`git config core.autocrlf false`,然后删掉文件重新 checkout。')
    process.exit(2)
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const rows = []
  let failed = 0
  for (const [name, why, subs] of MUTANTS) {
    let text
    try {
      text = apply(src, subs, name)
    } catch (e) {
      console.error(`✗ ${name}: ${e.message}`)
      failed += 1
      continue
    }
    const file = path.join(OUT_DIR, `${name}.lua`)
    fs.writeFileSync(file, text)
    rows.push([name, why, path.relative(HERE, file)])
  }

  console.log(`bridge: ${BRIDGE}`)
  console.log(`wrote ${rows.length} mutants to ${path.relative(HERE, OUT_DIR)}\\`)
  console.log('')
  for (const [name, why, file] of rows) {
    console.log(`${name.padEnd(30)}${why}`)
    console.log(`${''.padEnd(30)}node harness.mjs --bridge ${file}`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

main()
