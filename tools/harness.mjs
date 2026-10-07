// harness.mjs — offline test harness for DSHBridge.lua.
//
//   node harness.mjs
//
// Runs the resident SV2 bridge script under a fake Synthesizer V Studio host
// inside a fengari (Lua 5.3) VM, with io/os backed by the REAL filesystem.
// Nothing here touches Synthesizer V Studio; the point is that a bug that would
// pop a modal error dialog and freeze the user's DAW is found on this machine
// instead.
//
// Exit code: 0 when every test passes, 1 when any test fails, 2 on a harness
// setup error (e.g. the bridge file is missing).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import luaparse from 'luaparse'

import {
  createState, installEnvironment, installReporter, runChunk, callGlobal,
} from './luaenv.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_BRIDGE = path.resolve(HERE, '..', 'plugin', 'sv', 'DSHBridge.lua')
const PROBE = path.resolve(HERE, '..', 'probe', 'Probe.lua')
const PROBE_PANEL = path.resolve(HERE, '..', 'probe', 'ProbePanel.lua')
const FAKE_SV = path.join(HERE, 'fake-sv.lua')
const BRIDGE_TESTS = path.join(HERE, 'bridge-tests.lua')

// --bridge <file>  run a different (e.g. deliberately mutated) copy of the
//                  bridge — used to prove the harness actually catches bugs.
const argv = process.argv.slice(2)
const bridgeArg = argv.indexOf('--bridge')
const BRIDGE = bridgeArg !== -1 && argv[bridgeArg + 1]
  ? path.resolve(argv[bridgeArg + 1])
  : DEFAULT_BRIDGE

const RUN_ROOT = path.join(HERE, '.harness-run')
const USER_PROFILE = path.join(RUN_ROOT, 'userprofile')
const TEMP_DIR = path.join(RUN_ROOT, 'temp')
const BRIDGE_DIR = path.join(USER_PROFILE, '.dsh', 'sv-bridge')   // 1st candidate
const DECOY_DIR = path.join(TEMP_DIR, 'dsh-sv-bridge')            // 2nd candidate

// The harness's own expectation of where the bridge writes. Tests 4-12 do NOT
// use these directly: they read the live paths out of the bridge's own
// SVDSH_TEST.PATH (see bpath/resolvePaths), and test 4 asserts the two agree.
const EXPECTED = {
  dir: BRIDGE_DIR,
  req: path.join(BRIDGE_DIR, 'svdsh-req-sv.json'),
  res: path.join(BRIDGE_DIR, 'svdsh-res-sv.json'),
  hb: path.join(BRIDGE_DIR, 'svdsh-hb-sv.json'),
  boot: path.join(BRIDGE_DIR, 'svdsh-boot-sv.json'),
}

// Resolved from SVDSH_TEST.PATH once main() has run (test 4).
let REQ = EXPECTED.req
let RES = EXPECTED.res
let HB = EXPECTED.hb
let BOOT = EXPECTED.boot

// ⚠️ 不要在这里写死桥的版本号 —— 那会让“升版本号”这件事把测试弄红。
//    改从桥自己导出的 SVDSH_TEST.BRIDGE_VERSION 读(见 setupLua())。
let BRIDGE_VERSION = '(unread)'
const HOST_VERSION = '2.3.0'

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

const TESTS = [
  ['0', 'Lua 5.3 syntax check (bridge + probes)'],
  ['1', 'JSON codec round-trip'],
  ['2', 'hash32 deterministic + distinct'],
  ['3', 'selectedNotes() #-quirk fallback'],
  ['4', 'main() boot: boot + heartbeat files'],
  ['5', 'end-to-end read: get_selected_notes'],
  ['6', 'fingerprint guards the write (STALE_SELECTION)'],
  ['7', 'missing expectFp is rejected'],
  ['8', 'idempotency by request id'],
  ['9', 'unknown op'],
  ['10', 'malformed JSON request is consumed'],
  ['11', 'atomic overwrite (rename-over-existing)'],
  ['12', 'set_note_attrs fails closed'],
  ['13', 'set_note_attrs rejects non-integers (W1)'],
  ['14', 'write_notes mounts a real group on the track'],
  ['15', 'get_notes: whole group + stable groupFp'],
  ['16', 'delete_notes guards (missing/stale expectGroupFp)'],
  ['17', 'delete_notes batch: bounds + no index shift'],
  ['18', 'write_pit / clear_pit: absolute pitch semantics'],
  ['19', 'get_computed: phonemes / attributes / pitch'],
  ['20', 'get_automation: sampling + step validation'],
  ['21', 'set_automation: validation + dynamics hard reject'],
  ['22', 'set_automation: closeShape writes boundary points'],
  ['23', 'set_automation: closeShape restores the baseline'],
  ['24', 'set_tempo: replaces a mark at the same blick'],
  ['25', 'set_meter: rejects non-power-of-two denominator'],
  ['26', 'transport: seek/status/play/loop validation'],
  ['27', 'group_ops: rename/offset/delete guards'],
  ['28', 'track_ops: list/setMixer/remove guards'],
  ['29', 'set_note_attrs: phonemes/language/rap/detune'],
  ['30', 'select_notes: all / indices / group / none'],
  ['31', 'get_note_attrs: scope / limit / raw attributes'],
  ['32', 'split_notes: fingerprint, bounds, head + tail'],
  ['33', 'get_layout: overlaps / touching / gaps / scope'],
  ['34', 'apply_lyrics: CJK + words + onset order + filler'],
  ['35', 'align_lyrics: LRC mapping + a pure dry-run'],
  ['36', 'get_audio_tracks: instrumental refs, 0-based order'],
  ['37', 'align_audio: measure anchor / shiftBeats / bpm mark'],
  ['38', 'set_note_attrs: the attributes layer'],
  ['39', 'track_ops list: displayOrder + summed noteCount'],
  ['40', 'group_ops move: same-track / main / failed add'],
  ['41', 'dirCandidates: Windows / macOS / empty env'],
  ['42', 'snapshot + restore: edit / delete / split / UUID / corrupt'],
  ['43', 'selftest: the full-chain self check'],
  ['44', 'snapshot + restore: the group-level layout'],
]

const results = new Map()
const notes = []

function record(id, ok, detail) {
  const prev = results.get(id)
  if (prev && prev.ok === false) return // never overwrite a failure with a pass
  results.set(id, { ok: !!ok, detail: detail || '' })
}

function note(text) { notes.push(text) }

/** tiny assertion collector */
function checks() {
  const fails = []
  let n = 0
  const show = (v) => JSON.stringify(v) ?? String(v)
  return {
    ok(label, cond, got) {
      n += 1
      if (!cond) fails.push(got === undefined ? label : `${label} (got ${show(got)})`)
    },
    eq(label, got, want) {
      n += 1
      if (got !== want) fails.push(`${label} (got ${show(got)} / want ${show(want)})`)
    },
    get count() { return n },
    fails,
    done(id, name, extra) {
      record(id, fails.length === 0, fails.length === 0 ? (extra || `${n} assertions`) : fails.join(' | '))
    },
  }
}

// ---------------------------------------------------------------------------
// setup: run dirs + Lua state
// ---------------------------------------------------------------------------

function setupDirs() {
  fs.rmSync(RUN_ROOT, { recursive: true, force: true })
  for (const d of [USER_PROFILE, BRIDGE_DIR, TEMP_DIR, DECOY_DIR]) fs.mkdirSync(d, { recursive: true })
}

let L
let STATE

function setupLua() {
  L = createState()
  installReporter(L, (id, name, ok, detail) => record(id, ok, detail))
  installEnvironment(L, {
    USERPROFILE: USER_PROFILE,
    TEMP: TEMP_DIR,
    TMP: TEMP_DIR,
  })
  runChunk(L, 'fake-sv.lua', fs.readFileSync(FAKE_SV, 'utf8'))
  runChunk(L, 'test-hook', 'SVDSH_TEST = {}\n')
  runChunk(L, 'DSHBridge.lua', fs.readFileSync(BRIDGE, 'utf8'))
  // 版本号从桥自己导出的常量读 —— 升版本不该让测试变红
  runChunk(L, 'version-helper', 'function __bridgeVersion() return SVDSH_TEST.BRIDGE_VERSION end\n')
  BRIDGE_VERSION = String(callGlobal(L, '__bridgeVersion') ?? '(unread)')
  runChunk(L, 'bridge-tests.lua', fs.readFileSync(BRIDGE_TESTS, 'utf8'))
  STATE = {
    fp: null,
    seq: 1789175384220009,
  }
}

// ---------------------------------------------------------------------------
// helpers shared by the JS-driven tests
// ---------------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** SVDSH_TEST.PATH[key] as the bridge itself sees it ('' when not populated). */
function bpathSoft(key) {
  const v = callGlobal(L, '__T_path', [key])
  return typeof v === 'string' ? v : ''
}

/**
 * Adopt the bridge's own file paths (SVDSH_TEST.PATH) instead of assuming them.
 * Falls back to the harness's expectation only when PATH is empty, so a W4-style
 * regression fails test 4 loudly without cascading through tests 5-12.
 */
function resolvePaths() {
  REQ = bpathSoft('req') || EXPECTED.req
  RES = bpathSoft('res') || EXPECTED.res
  HB = bpathSoft('hb') || EXPECTED.hb
  BOOT = bpathSoft('boot') || EXPECTED.boot
}

/** write a request file, tick the bridge once, return the parsed response */
function roundTrip(id, op, args) {
  fs.rmSync(RES, { force: true })
  fs.writeFileSync(REQ, JSON.stringify({ v: 1, id, seq: STATE.seq, op, args: args || {} }))
  const ticked = callGlobal(L, '__T_tick')
  if (!ticked) throw new Error(`no pending timer callback while delivering ${id}`)
  if (fs.existsSync(REQ)) throw new Error(`request file was not consumed for ${id}`)
  if (!fs.existsSync(RES)) throw new Error(`no response file was written for ${id}`)
  return readJson(RES)
}

function pitches() { return callGlobal(L, '__T_pitches') }
function opsRun() { return callGlobal(L, '__T_opsrun') }

// ---- fake-host call ledger (NoteGroup#getNote / #removeNote) ---------------
// A non-integer note index handed to a host binding is exactly the input class
// that pops a modal dialog and freezes SV2, but the fake host just returns nil
// for it — so "no fractional index ever reached the host" is only observable
// through this ledger.
function callCount() { return callGlobal(L, '__T_callCount') }
function callsSince(n) { return JSON.parse(callGlobal(L, '__T_calls', [n])) }
function fractionalCalls(list) { return list.filter((e) => !Number.isInteger(e.index)) }

// ---------------------------------------------------------------------------
// test 0 — syntax
// ---------------------------------------------------------------------------

function testSyntax() {
  const c = checks()
  // the two harness-side Lua files are in here too: a syntax error in them would
  // otherwise abort setup with exit 2 instead of naming the file.
  for (const f of [BRIDGE, PROBE, PROBE_PANEL, FAKE_SV, BRIDGE_TESTS]) {
    const base = path.basename(f)
    if (!fs.existsSync(f)) { c.ok(`${base} exists`, false, f); continue }
    try {
      luaparse.parse(fs.readFileSync(f, 'utf8'), {
        luaVersion: '5.3', comments: false, scope: false, locations: true, extendedIdentifiers: false,
      })
    } catch (e) {
      c.ok(`${base} parses as Lua 5.3`, false, `line ${e.line ?? '?'}: ${e.message}`)
    }
  }
  c.done('0', TESTS[0][1], '5 files parse as Lua 5.3')
}

// ---------------------------------------------------------------------------
// test 4 — main() boot
// ---------------------------------------------------------------------------

function testBoot() {
  const c = checks()
  callGlobal(L, '__T_boot')

  c.eq('ST.dir picked the USERPROFILE candidate', callGlobal(L, '__T_dir'), BRIDGE_DIR)
  c.eq('timer was armed', callGlobal(L, '__T_pending'), true)

  // ---- W3 guard: the heartbeat cadence invariant -------------------------
  // scheduleLoop() derives every = floor(HB_MS / POLL_MS) and writes a
  // heartbeat every `every` ticks, so HB_MS must be an exact multiple of
  // POLL_MS or the real interval silently drifts (5000/300 gave 4800 ms).
  const cfg = callGlobal(L, '__T_cfg').split(',')
  const pollMs = Number(cfg[0])
  const hbMs = Number(cfg[1])
  const every = Number(cfg[2])
  c.ok('CFG.HB_MS % CFG.POLL_MS == 0 (W3)', hbMs % pollMs === 0,
    `${hbMs} % ${pollMs} = ${hbMs % pollMs}`)
  c.eq('heartbeat cadence is exactly HB_MS', every * pollMs, hbMs)
  c.eq('heartbeat cadence in ticks', every, hbMs / pollMs)

  // ---- W4 guard: SVDSH_TEST.PATH is populated after main() ---------------
  c.eq('SVDSH_TEST.PATH.dir == ST.dir (W4)', bpathSoft('dir'), BRIDGE_DIR)
  c.eq('SVDSH_TEST.PATH.req (W4)', bpathSoft('req'), EXPECTED.req)
  c.eq('SVDSH_TEST.PATH.res (W4)', bpathSoft('res'), EXPECTED.res)
  c.eq('SVDSH_TEST.PATH.hb (W4)', bpathSoft('hb'), EXPECTED.hb)
  c.eq('SVDSH_TEST.PATH.boot (W4)', bpathSoft('boot'), EXPECTED.boot)

  // ---- 分隔符回归:桥原来把分隔符写死成 "\\",而 POSIX 上反斜杠是**合法文件名
  //      字符**,不是分隔符 ⇒ 路径变成"名字里带反斜杠的文件",桥静默写错地方。
  //      CI 的 ubuntu job 就是死在这条上(实测:got ".../userprofile\.dsh\sv-bridge" /
  //      want ".../userprofile/.dsh/sv-bridge")。下面三条判据与平台无关,
  //      所以在 windows 的 CI job 上也能守住这个 POSIX 回归。
  c.eq('sepFor: Windows dir -> backslash', callGlobal(L, '__T_sep', ['C:\\a\\b']), '\\')
  c.eq('sepFor: POSIX dir -> slash', callGlobal(L, '__T_sep', ['/a/b']), '/')
  c.eq('sepFor: forward-slash Windows dir -> slash', callGlobal(L, '__T_sep', ['C:/a/b']), '/')
  c.eq('joinPath: POSIX stays POSIX', callGlobal(L, '__T_join', ['/a/b', 'x.json']), '/a/b/x.json')
  c.eq('joinPath: Windows stays Windows', callGlobal(L, '__T_join', ['C:\\a\\b', 'x.json']), 'C:\\a\\b\\x.json')

  // from here on, tests 5-12 use the bridge's own paths
  resolvePaths()

  c.ok('boot file exists', fs.existsSync(BOOT), BOOT)
  c.ok('heartbeat file exists', fs.existsSync(HB), HB)

  let boot = null
  let hb = null
  try { boot = readJson(BOOT) } catch (e) { c.ok('boot parses as JSON', false, e.message) }
  try { hb = readJson(HB) } catch (e) { c.ok('heartbeat parses as JSON', false, e.message) }

  if (boot) {
    c.eq('boot.ok', boot.ok, true)
    c.eq('boot.bridge', boot.bridge, BRIDGE_VERSION)
    c.eq('boot.hostVersion', boot.hostVersion, HOST_VERSION)
    c.eq('boot.hostVersionNumber', boot.hostVersionNumber, 131840)
    c.eq('boot.isSV2', boot.isSV2, true)
    c.eq('boot.dir', boot.dir, BRIDGE_DIR)
    c.ok('boot.ops contains get_selected_notes',
      Array.isArray(boot.ops) && boot.ops.includes('get_selected_notes'), boot.ops)
  }

  if (hb) {
    c.eq('hb.bridge (bridge version)', hb.bridge, BRIDGE_VERSION)
    c.eq('hb.version (HOST version)', hb.version, HOST_VERSION)
    c.eq('hb.hostName', hb.hostName, 'Synthesizer V Studio 2 Pro')
    c.eq('hb.isSV2', hb.isSV2, true)
    c.ok('hb.ops contains get_selected_notes',
      Array.isArray(hb.ops) && hb.ops.includes('get_selected_notes'), hb.ops)
    c.eq('hb.dir is the .dsh\\sv-bridge candidate', hb.dir, BRIDGE_DIR)
    c.ok('hb.dir is NOT the TEMP candidate', hb.dir !== DECOY_DIR, hb.dir)
    c.eq('hb.protocol', hb.protocol, 1)
    c.ok('hb.ticks is a number', typeof hb.ticks === 'number', hb.ticks)
    c.eq('hb.pollErrors', hb.pollErrors, 0)
    c.eq('hb.timer', hb.timer, 'SV')
  }

  c.done('4', TESTS[4][1])
}

// ---------------------------------------------------------------------------
// test 5 — end-to-end read
// ---------------------------------------------------------------------------

function testRead() {
  const c = checks()
  const res = roundTrip('t-1', 'get_selected_notes', {})

  c.eq('res.id', res.id, 't-1')
  c.eq('res.seq preserved exactly (16 digits)', res.seq, 1789175384220009)
  c.eq('res.ok', res.ok, true)
  c.eq('res.v', res.v, 1)
  c.eq('res.result.count', res.result && res.result.count, 3)
  c.eq('res.result.returned', res.result && res.result.returned, 3)
  c.eq('res.result.truncated', res.result && res.result.truncated, false)
  c.ok('res.result.fp is a non-empty string',
    res.result && typeof res.result.fp === 'string' && res.result.fp.length > 0, res.result && res.result.fp)

  const n0 = res.result && res.result.notes && res.result.notes[0]
  c.eq('notes[0].pitch', n0 && n0.pitch, 60)
  c.eq('notes[0].lyrics', n0 && n0.lyrics, 'la')
  c.eq('notes[0].index', n0 && n0.index, 1)
  c.eq('notes[0].onsetQuarter', n0 && n0.onsetQuarter, 0)
  c.eq('notes[2].pitch', res.result && res.result.notes[2] && res.result.notes[2].pitch, 64)
  c.ok('every note carries a fingerprint',
    Array.isArray(res.result && res.result.notes) && res.result.notes.every((x) => typeof x.fp === 'string' && x.fp.length > 0))

  STATE.fp = res.result && res.result.fp
  c.done('5', TESTS[5][1])
}

// ---------------------------------------------------------------------------
// test 6 — fingerprint guards the write
// ---------------------------------------------------------------------------

function testFingerprint() {
  const c = checks()
  const oldFp = STATE.fp
  c.ok('have the fp from test 5', typeof oldFp === 'string' && oldFp.length > 0, oldFp)

  const before = pitches()
  // the user edits note 1 in the host, behind the bridge's back
  callGlobal(L, '__T_mutatePitch', [1, 3])
  const afterEdit = pitches()
  c.eq('host-side edit applied', afterEdit, '63,62,64')

  const stale = roundTrip('t-6a', 'transpose_selected', { semitones: 1, expectFp: oldFp })
  c.eq('stale write refused (ok)', stale.ok, false)
  c.ok('stale error mentions STALE_SELECTION',
    typeof stale.error === 'string' && stale.error.includes('STALE_SELECTION'), stale.error)
  c.eq('nothing was written while stale', pitches(), afterEdit)

  const reread = roundTrip('t-6b', 'get_selected_notes', {})
  c.eq('re-read ok', reread.ok, true)
  const fresh = reread.result && reread.result.fp
  c.ok('fresh fp differs from the stale fp', typeof fresh === 'string' && fresh !== oldFp, `${oldFp} -> ${fresh}`)
  c.eq('re-read count', reread.result && reread.result.count, 3)

  const ok = roundTrip('t-6c', 'transpose_selected', { semitones: 1, expectFp: fresh })
  c.eq('fresh write accepted (ok)', ok.ok, true)
  c.eq('changed count', ok.result && ok.result.changed, 3)
  c.eq('skipped count', ok.result && ok.result.skipped, 0)
  c.eq('notes really moved in the fake host (pitch +1)', pitches(), '64,63,65')
  c.eq('op read-back pitches', JSON.stringify(ok.result && ok.result.readBackPitches), JSON.stringify([64, 63, 65]))
  c.ok('op read-back fp is the post-write fp',
    ok.result && typeof ok.result.readBackFp === 'string' && ok.result.readBackFp !== fresh)

  c.done('6', TESTS[6][1])
}

// ---------------------------------------------------------------------------
// test 7 — missing expectFp
// ---------------------------------------------------------------------------

function testMissingFp() {
  const c = checks()
  const before = pitches()
  const res = roundTrip('t-7', 'transpose_selected', { semitones: 1 })
  c.eq('ok', res.ok, false)
  c.ok('error mentions expectFp',
    typeof res.error === 'string' && res.error.includes('expectFp'), res.error)
  c.eq('nothing written', pitches(), before)

  // set_lyrics and set_note_attrs must fail the same way
  const l = roundTrip('t-7b', 'set_lyrics', { lyrics: 'x' })
  c.eq('set_lyrics ok', l.ok, false)
  c.ok('set_lyrics error mentions expectFp', typeof l.error === 'string' && l.error.includes('expectFp'), l.error)
  c.eq('nothing written by set_lyrics', pitches(), before)

  c.done('7', TESTS[7][1])
}

// ---------------------------------------------------------------------------
// test 8 — idempotency by id
// ---------------------------------------------------------------------------

function testIdempotency() {
  const c = checks()

  callGlobal(L, '__T_hb')
  const hb0 = readJson(HB)

  const first = roundTrip('t-8', 'ping', {})
  const opsAfterFirst = opsRun()

  const dup = roundTrip('t-8', 'ping', {})
  const opsAfterDup = opsRun()

  c.eq('first delivery ok', first.ok, true)
  c.eq('first delivery ran the op (opsRun +1)', opsAfterFirst - hb0.opsRun, 1)
  c.eq('duplicate id did NOT run the op (opsRun +0)', opsAfterDup - opsAfterFirst, 0)
  c.eq('duplicate still produced a response', dup.id, 't-8')
  c.eq('duplicate response is the cached one', JSON.stringify(dup), JSON.stringify(first))

  callGlobal(L, '__T_hb')
  const hb1 = readJson(HB)
  c.eq('heartbeat opsRun +1 only', hb1.opsRun - hb0.opsRun, 1)
  c.eq('heartbeat reqSeen +1 only', hb1.reqSeen - hb0.reqSeen, 1)

  c.done('8', TESTS[8][1])
}

// ---------------------------------------------------------------------------
// test 9 — unknown op
// ---------------------------------------------------------------------------

function testUnknownOp() {
  const c = checks()
  const res = roundTrip('t-9', 'definitely_not_an_op', {})
  c.eq('ok', res.ok, false)
  c.ok('error mentions "unknown op"',
    typeof res.error === 'string' && res.error.includes('unknown op'), res.error)
  c.ok('error names the offending op',
    typeof res.error === 'string' && res.error.includes('definitely_not_an_op'), res.error)
  c.ok('error lists the available ops',
    typeof res.error === 'string' && res.error.includes('get_selected_notes'), res.error)
  c.eq('no result payload', res.result, undefined)
  c.done('9', TESTS[9][1])
}

// ---------------------------------------------------------------------------
// test 10 — malformed JSON is consumed
// ---------------------------------------------------------------------------

function testMalformed() {
  const c = checks()
  const before = callGlobal(L, '__T_pollerrors')

  fs.writeFileSync(REQ, '{ this is not json')
  const ticked = callGlobal(L, '__T_tick')
  c.eq('tick ran', ticked, true)
  c.ok('malformed request file was removed', !fs.existsSync(REQ), REQ)

  const after = callGlobal(L, '__T_pollerrors')
  c.eq('pollErrors did not grow', after, before)

  // the point of consuming it: the next tick must not re-read it
  callGlobal(L, '__T_tick')
  callGlobal(L, '__T_tick')
  c.eq('pollErrors still flat after two more ticks', callGlobal(L, '__T_pollerrors'), before)
  c.ok('request file is still gone', !fs.existsSync(REQ))

  c.done('10', TESTS[10][1], `pollErrors stayed at ${before}`)
}

// ---------------------------------------------------------------------------
// test 11 — atomic overwrite
// ---------------------------------------------------------------------------

function testAtomic() {
  const c = checks()
  // Two writes of DIFFERENT content to the SAME path. writeAtomic() is not part
  // of the bridge's SVDSH_TEST export list, so it is driven through its own
  // caller writeHeartbeat(); the sequence under test is identical:
  // writeFile(path..".tmp") -> os.rename(tmp, path) with path already present.
  // HB is the bridge's own PATH.hb, adopted in test 4.
  callGlobal(L, '__T_atomic')
  const after = readJson(HB)
  c.eq('the SECOND write won', after.ticks, 222222)
  c.ok('no .tmp file left behind', !fs.existsSync(HB + '.tmp'), HB + '.tmp')

  // and it must keep working on an already-existing target
  callGlobal(L, '__T_writeHeartbeatWith', [333333])
  c.eq('a third overwrite also won', readJson(HB).ticks, 333333)
  c.ok('still no .tmp file', !fs.existsSync(HB + '.tmp'))

  // the response file goes through the same path
  c.ok('no res .tmp left behind', !fs.existsSync(RES + '.tmp'))

  c.done('11', TESTS[11][1], 'second/third content won, no .tmp residue')
}

// ---------------------------------------------------------------------------
// test 12 — set_note_attrs fails closed
// ---------------------------------------------------------------------------

function testFailsClosed() {
  const c = checks()
  const before = pitches()
  const fp = callGlobal(L, '__T_selectionFp')
  c.ok('have a fresh fp', typeof fp === 'string' && fp.length > 0, fp)

  // (a) non-whitelisted field
  const a = roundTrip('t-12a', 'set_note_attrs', { expectFp: fp, updates: [{ index: 0, gain: 3 }] })
  c.eq('(a) ok', a.ok, false)
  c.ok('(a) error names the field', typeof a.error === 'string' && a.error.includes('gain'), a.error)
  c.ok('(a) error lists the allowed fields',
    // ⚠️ 别写死整串文案:白名单会随版本增长(已从 3 个字段长到 8 个)。
    //    只断言“报错里确实点了几个已知的允许字段”,文案变化就不会误红。
    typeof a.error === 'string' &&
      ['pitch', 'duration', 'lyrics', 'phonemes'].every((f) => a.error.includes(f)), a.error)
  c.eq('(a) no note was mutated', pitches(), before)

  // (b) out-of-range pitch
  const b = roundTrip('t-12b', 'set_note_attrs', { expectFp: fp, updates: [{ index: 0, pitch: 999 }] })
  c.eq('(b) ok', b.ok, false)
  c.ok('(b) error mentions the range', typeof b.error === 'string' && b.error.includes('out of range'), b.error)
  c.eq('(b) no note was mutated', pitches(), before)

  // (c) out-of-range duration, and a negative one
  const c3 = roundTrip('t-12c', 'set_note_attrs', { expectFp: fp, updates: [{ index: 1, duration: -5 }] })
  c.eq('(c) ok', c3.ok, false)
  c.ok('(c) error mentions the range', typeof c3.error === 'string' && c3.error.includes('out of range'), c3.error)
  c.eq('(c) no note was mutated', pitches(), before)

  // (d) an out-of-range entry late in the batch must abort the WHOLE batch
  const d = roundTrip('t-12d', 'set_note_attrs', {
    expectFp: fp,
    updates: [{ index: 0, lyrics: 'ok' }, { index: 1, pitch: 5000 }],
  })
  c.eq('(d) ok', d.ok, false)
  c.eq('(d) no note was mutated (batch is all-or-nothing)', pitches(), before)

  // (e) a legal write still works
  const e = roundTrip('t-12e', 'set_note_attrs', { expectFp: fp, updates: [{ index: 0, lyrics: '改' }] })
  c.eq('(e) legal write accepted', e.ok, true)
  c.eq('(e) changed count', e.result && e.result.changed, 1)

  c.done('12', TESTS[12][1])
}

// ---------------------------------------------------------------------------
// test 13 — set_note_attrs rejects non-integers (W1 regression guard)
// ---------------------------------------------------------------------------
// pitch/duration are declared `integer = true` in ATTR_WHITELIST, so a value
// that passes the range check but is not an integer must be refused BEFORE any
// write. Asserting only the error is not enough: the failure mode this guards
// against is "the error is raised but the note was already mutated", so every
// case also compares the fake host's pitches before/after.

/** like roundTrip(), but with a hand-written request body (to control "61.0") */
function roundTripRaw(id, op, argsJson) {
  fs.rmSync(RES, { force: true })
  fs.writeFileSync(REQ, `{"v":1,"id":"${id}","seq":${STATE.seq},"op":"${op}","args":${argsJson}}`)
  const ticked = callGlobal(L, '__T_tick')
  if (!ticked) throw new Error(`no pending timer callback while delivering ${id}`)
  if (fs.existsSync(REQ)) throw new Error(`request file was not consumed for ${id}`)
  if (!fs.existsSync(RES)) throw new Error(`no response file was written for ${id}`)
  return readJson(RES)
}

function testNonIntegerAttrs() {
  const c = checks()
  const before = pitches()
  const fp = callGlobal(L, '__T_selectionFp')
  c.ok('have a fresh fp', typeof fp === 'string' && fp.length > 0, fp)

  // (a) fractional pitch — 60.5 is inside 0..127, so ONLY the integer check can reject it
  const a = roundTrip('t-13a', 'set_note_attrs', { expectFp: fp, updates: [{ index: 0, pitch: 60.5 }] })
  c.eq('(a) fractional pitch rejected (ok)', a.ok, false)
  c.ok('(a) error mentions "integer"', typeof a.error === 'string' && a.error.includes('integer'), a.error)
  c.ok('(a) error names the field and the value',
    typeof a.error === 'string' && a.error.includes('pitch') && a.error.includes('60.5'), a.error)
  c.eq('(a) NO note was mutated', pitches(), before)

  // (b) fractional duration — 1000.5 is inside 1..45158400000, same reasoning
  const b = roundTrip('t-13b', 'set_note_attrs', { expectFp: fp, updates: [{ index: 1, duration: 1000.5 }] })
  c.eq('(b) fractional duration rejected (ok)', b.ok, false)
  c.ok('(b) error mentions "integer"', typeof b.error === 'string' && b.error.includes('integer'), b.error)
  c.ok('(b) error names the field and the value',
    typeof b.error === 'string' && b.error.includes('duration') && b.error.includes('1000.5'), b.error)
  c.eq('(b) NO note was mutated', pitches(), before)

  // (c) a fractional entry late in the batch must abort the WHOLE batch
  const d = roundTrip('t-13c', 'set_note_attrs', {
    expectFp: fp,
    updates: [{ index: 0, lyrics: 'not written' }, { index: 2, pitch: 64.25 }],
  })
  c.eq('(c) batch rejected (ok)', d.ok, false)
  c.ok('(c) error mentions "integer"', typeof d.error === 'string' && d.error.includes('integer'), d.error)
  c.eq('(c) no note was mutated (all-or-nothing)', pitches(), before)

  // (d) no over-rejection: a value WRITTEN as an integral float ("61.0") is fine
  const e = roundTripRaw('t-13d', 'set_note_attrs',
    `{"expectFp":"${fp}","updates":[{"index":0,"pitch":61.0}]}`)
  c.eq('(d) integral float accepted', e.ok, true)
  c.eq('(d) pitch really changed to 61', pitches().split(',')[0], '61')

  // restore, so anything running after this test sees the original pitches
  callGlobal(L, '__T_setPitch', [1, Number(before.split(',')[0])])

  c.done('13', TESTS[13][1], 'pitch + duration + batch, all with no mutation')
}

// ---------------------------------------------------------------------------
// tests 14-29 — the second/third batch of ops
//
// House rules for everything below:
//   * a request id is used ONCE (the bridge caches responses by id), so `req()`
//     mints a fresh one;
//   * a rejected call must leave the fake host byte-identical — asserted with a
//     full __T_snap() before/after, not just "the error message looked right";
//   * a destructive test starts from a pristine world (__T_resetWorld) so tests
//     cannot poison each other.
// ---------------------------------------------------------------------------

const QUARTER = 705600000

let REQN = 0
/** roundTrip() with an auto-unique request id */
function req(op, args) {
  REQN += 1
  return roundTrip(`n-${REQN}`, op, args)
}

// ---- fake-host snapshot accessors -----------------------------------------
// The snapshot is an array of tagged arrays (see bridge-tests.lua snapshot()).
function snap() { return callGlobal(L, '__T_snap') }
function snapObj() { return JSON.parse(snap()) }
function S(key, s) { return (s || snapObj()).find((x) => x[0] === key) }
// tracks[i] = [name, color, bounced, gain, pan, muted, solo, groupCount]
function tracksOf(s) { return S('tracks', s)[1] }
// refs[i]   = [track, refIndex, targetUUID, onset, dur, timeOffset, pitchOffset, isMain, isMuted]
function refsOf(s) { return S('refs', s)[1] }
// groups[i] = [name, uuid, noteCount, pcCount, <"note"|"curve"|"auto" entries...>]
function groupsOf(s) { return S('groups', s)[1] }
function timeAxisOf(s) { return S('timeaxis', s) }
function playbackOf(s) { return S('playback', s) }
// note  = ["note", onset, dur, pitch, lyrics, phonemes, detune, lang, rap]
function notesOf(group) { return group.slice(4).filter((e) => e[0] === 'note') }
function autosOf(group) { return group.slice(4).filter((e) => e[0] === 'auto') }
function resetWorld() { callGlobal(L, '__T_resetWorld') }
/** index without crashing on a missing element (a mutant run must FAIL, not throw) */
function at(arr, i) { return (arr && arr[i]) || [] }

/** "nothing was written" — with a readable diff instead of a 2 KB dump */
function sameSnap(c, label, before) {
  const got = snap()
  if (got === before) { c.ok(label, true); return }
  let i = 0
  while (i < got.length && i < before.length && got[i] === before[i]) i += 1
  c.ok(label, false,
    `differs at ${i}: got ...${got.slice(Math.max(0, i - 50), i + 70)}... | want ...${before.slice(Math.max(0, i - 50), i + 70)}...`)
}

// ---------------------------------------------------------------------------
// test 14 — write_notes really mounts the new group (3-step mount)
// ---------------------------------------------------------------------------
// The whole point of write_notes is the mount: a NoteGroup that only lives in
// the library renders nothing, and every computed API silently returns null.
// So assert the three steps separately: library slot, reference + window, and
// the track's group count.
function testWriteNotesMount() {
  const c = checks()
  resetWorld()
  const before = snapObj()

  const res = req('write_notes', {
    notes: [
      { onset: 0, duration: 1, pitch: 60, lyrics: 'a' },
      { onset: 1, duration: 1, pitch: 64, lyrics: 'b' },
      { onset: 2, duration: 1, pitch: 67, lyrics: 'c' },
    ],
  })
  c.eq('ok', res.ok, true)
  const r = res.result || {}
  c.eq('requested', r.requested, 3)
  c.eq('written', r.written, 3)
  c.eq('spanQuarter', r.spanQuarter, 3)
  c.ok('groupUUID non-empty', typeof r.groupUUID === 'string' && r.groupUUID.length > 0, r.groupUUID)
  c.ok('groupLibraryIndex is a real library slot',
    typeof r.groupLibraryIndex === 'number' && r.groupLibraryIndex >= 2, r.groupLibraryIndex)
  c.eq('readBack pitches', JSON.stringify((r.readBack || []).map((x) => x.pitch)), JSON.stringify([60, 64, 67]))
  c.eq('readBack lyrics', JSON.stringify((r.readBack || []).map((x) => x.lyrics)), JSON.stringify(['a', 'b', 'c']))
  c.eq('readBack onsetQuarter', JSON.stringify((r.readBack || []).map((x) => x.onsetQuarter)), JSON.stringify([0, 1, 2]))

  const after = snapObj()
  const refsB = refsOf(before)
  const refsA = refsOf(after)
  c.eq('the track gained exactly one group reference', refsA.length, refsB.length + 1)
  const newRef = refsA[refsA.length - 1]
  c.eq('the new reference points at the new group', newRef[2], r.groupUUID)
  c.eq('the reference window starts at the first onset', newRef[3], 0)
  c.eq('the reference window COVERS the whole content', newRef[4], 3 * QUARTER)
  c.eq('the track group count grew', tracksOf(after)[0][7], tracksOf(before)[0][7] + 1)

  const groups = groupsOf(after)
  c.eq('the group library grew by one', groups.length, groupsOf(before).length + 1)
  c.eq('the main group is untouched', groups[0][2], 3)
  c.eq('main group pitches unchanged',
    JSON.stringify(notesOf(groups[0]).map((n) => n[3])), JSON.stringify([60, 62, 64]))
  const created = groups[groups.length - 1]
  c.eq('the created group really holds 3 notes', notesOf(created).length, 3)
  c.eq('created group pitches',
    JSON.stringify(notesOf(created).map((n) => n[3])), JSON.stringify([60, 64, 67]))
  c.eq('created group uuid', created[1], r.groupUUID)
  c.eq('created group name round-trips', created[0], r.groupName)
  c.done('14', TESTS[14][1])
}

// ---------------------------------------------------------------------------
// test 15 — get_notes: the WHOLE group + a stable groupFp
// ---------------------------------------------------------------------------
// groupFp is delete_notes' only guard, so it has to be (a) present, (b) stable
// while nothing changes and (c) different the moment anything does.
function testGetNotes() {
  const c = checks()
  resetWorld()
  const a = req('get_notes', {})
  c.eq('ok', a.ok, true)
  const r = a.result || {}
  c.eq('count', r.count, 3)
  c.eq('returned', r.returned, 3)
  c.eq('truncated', r.truncated, false)
  c.eq('groupName', r.groupName, 'Main')
  c.ok('groupUUID non-empty', typeof r.groupUUID === 'string' && r.groupUUID.length > 0, r.groupUUID)
  c.ok('groupFp non-empty', typeof r.groupFp === 'string' && r.groupFp.length > 0, r.groupFp)
  c.eq('pitches', JSON.stringify((r.notes || []).map((n) => n.pitch)), JSON.stringify([60, 62, 64]))
  c.eq('host indices are reported as-is (1-based)', JSON.stringify((r.notes || []).map((n) => n.index)), JSON.stringify([1, 2, 3]))
  c.eq('onsetQuarter', JSON.stringify((r.notes || []).map((n) => n.onsetQuarter)), JSON.stringify([0, 1, 2]))
  c.eq('durationQuarter', JSON.stringify((r.notes || []).map((n) => n.durationQuarter)), JSON.stringify([1, 1, 1]))
  c.ok('every note carries its own fp', (r.notes || []).every((n) => typeof n.fp === 'string' && n.fp.length > 0))

  const b = req('get_notes', {})
  c.eq('groupFp is STABLE across two reads of an unchanged group', b.result && b.result.groupFp, r.groupFp)

  callGlobal(L, '__T_mutatePitch', [1, 1])
  const d = req('get_notes', {})
  c.ok('groupFp changes after a host-side edit (the guard is not vacuous)',
    d.result && d.result.groupFp !== r.groupFp, `${r.groupFp} -> ${d.result && d.result.groupFp}`)

  const e = req('get_notes', { limit: 2 })
  c.eq('limit honoured (returned)', e.result && e.result.returned, 2)
  c.eq('limit honoured (truncated)', e.result && e.result.truncated, true)
  c.eq('count still reports the whole group', e.result && e.result.count, 3)
  c.done('15', TESTS[15][1])
}

// ---------------------------------------------------------------------------
// test 16 — delete_notes: the fingerprint guard
// ---------------------------------------------------------------------------
function testDeleteNotesGuards() {
  const c = checks()
  resetWorld()
  const g = req('get_notes', {})
  const fp = g.result.groupFp
  const before = snap()

  const a = req('delete_notes', { indices: [0] })
  c.eq('(a) missing expectGroupFp rejected', a.ok, false)
  c.ok('(a) error mentions expectGroupFp',
    typeof a.error === 'string' && a.error.includes('expectGroupFp'), a.error)
  sameSnap(c, '(a) no note was deleted', before)

  // the user edits the group in the host, behind the bridge's back
  callGlobal(L, '__T_mutatePitch', [1, 2])
  const edited = snap()
  c.ok('host-side edit applied', edited !== before)

  const b = req('delete_notes', { indices: [0], expectGroupFp: fp })
  c.eq('(b) stale expectGroupFp rejected', b.ok, false)
  c.ok('(b) error mentions STALE_SELECTION',
    typeof b.error === 'string' && b.error.includes('STALE_SELECTION'), b.error)
  sameSnap(c, '(b) NOTHING was deleted', edited)
  c.eq('(b) the group still has 3 notes', callGlobal(L, '__T_noteCount'), 3)

  const c2 = req('delete_notes', { indices: [0], expectGroupFp: '' })
  c.eq('(c) an empty expectGroupFp is rejected too', c2.ok, false)
  sameSnap(c, '(c) nothing deleted', edited)
  c.done('16', TESTS[16][1])
}

// ---------------------------------------------------------------------------
// test 17 — delete_notes: batch semantics (bounds first, then delete)
// ---------------------------------------------------------------------------
function testDeleteNotesBatch() {
  const c = checks()
  resetWorld()
  const fp = req('get_notes', {}).result.groupFp
  const before = snap()

  const a = req('delete_notes', { indices: [0, 5], expectGroupFp: fp })
  c.eq('(a) an out-of-range index is rejected', a.ok, false)
  c.ok('(a) error names the offending element',
    typeof a.error === 'string' && a.error.includes('indices[2]'), a.error)
  sameSnap(c, '(a) rejected BEFORE deleting anything', before)

  const a2 = req('delete_notes', { indices: [-1], expectGroupFp: fp })
  c.eq('(a2) a negative index is rejected', a2.ok, false)
  sameSnap(c, '(a2) nothing deleted', before)

  const a3 = req('delete_notes', { indices: [1, 1], expectGroupFp: fp })
  c.eq('(a3) duplicate indices are rejected', a3.ok, false)
  sameSnap(c, '(a3) nothing deleted', before)

  const a4 = req('delete_notes', { indices: [], expectGroupFp: fp })
  c.eq('(a4) an empty index list is rejected', a4.ok, false)
  sameSnap(c, '(a4) nothing deleted', before)

  // (a5) a FRACTIONAL index is rejected before any host call. 0.5 is inside
  //      0..3, so only the integer check can reject it — and it must be rejected
  //      BEFORE removeNote() ever sees a non-integer (that input class pops a
  //      modal dialog on the real host).
  const calls0 = callCount()
  const a5 = req('delete_notes', { indices: [0.5], expectGroupFp: fp })
  c.eq('(a5) a fractional index is rejected', a5.ok, false)
  c.ok('(a5) the error mentions "整数"',
    typeof a5.error === 'string' && a5.error.includes('整数'), a5.error)
  sameSnap(c, '(a5) nothing deleted', before)
  const ledger5 = callsSince(calls0)
  c.eq('(a5) removeNote was never called', ledger5.filter((e) => e.op === 'removeNote').length, 0)
  c.eq('(a5) NO fractional index reached the host at all', fractionalCalls(ledger5).length, 0)
  c.eq('(a5) the group still has 3 notes', callGlobal(L, '__T_noteCount'), 3)

  // valid: delete the 1st and the 3rd (0-based 0 and 2) out of [60, 62, 64]
  const b = req('delete_notes', { indices: [0, 2], expectGroupFp: fp })
  c.eq('(b) ok', b.ok, true)
  c.eq('(b) removed', b.result && b.result.removed, 2)
  c.eq('(b) remaining', b.result && b.result.remaining, 1)
  c.eq('(b) the SURVIVOR is the middle note (indices did not shift mid-batch)',
    callGlobal(L, '__T_pitches'), '62')
  c.ok('(b) the returned groupFp is the post-delete one',
    b.result && b.result.groupFp !== fp, `${fp} -> ${b.result && b.result.groupFp}`)

  const d = req('delete_notes', { indices: [0], expectGroupFp: fp })
  c.eq('(d) the pre-delete fp is now stale', d.ok, false)
  c.ok('(d) error mentions STALE_SELECTION',
    typeof d.error === 'string' && d.error.includes('STALE_SELECTION'), d.error)
  c.eq('(d) the survivor is still there', callGlobal(L, '__T_pitches'), '62')
  c.done('17', TESTS[17][1])
}

// ---------------------------------------------------------------------------
// test 18 — write_pit / get_pit / clear_pit
// ---------------------------------------------------------------------------
// The API is ABSOLUTE MIDI pitch in quarter notes; the host wants a relative
// offset from an anchor. Getting that conversion wrong silently detunes the
// whole group, so the round-trip is asserted point by point.
function testPitchControl() {
  const c = checks()
  resetWorld()
  const before = snap()

  const a = req('write_pit', { points: [{ at: -1, pitch: 60 }] })
  c.eq('(a) a point with at < 0 is rejected', a.ok, false)
  c.ok('(a) error mentions >= 0', typeof a.error === 'string' && a.error.includes('>= 0'), a.error)
  c.eq('(a) no curve was created', callGlobal(L, '__T_pitCount'), 0)
  sameSnap(c, '(a) nothing was written', before)

  const b = req('write_pit', { points: [{ at: 1, pitch: 64 }, { at: 2, pitch: 67 }] })
  c.eq('(b) ok', b.ok, true)
  c.eq('(b) pointsWritten', b.result && b.result.pointsWritten, 2)
  c.eq('(b) anchorQuarter', b.result && b.result.anchorQuarter, 1)
  c.eq('(b) anchorPitch', b.result && b.result.anchorPitch, 64)
  c.eq('(b) readBack pitches are ABSOLUTE',
    JSON.stringify((b.result.readBack || []).map((x) => x.pitch)), JSON.stringify([64, 67]))
  c.eq('(b) readBack positions are absolute quarters',
    JSON.stringify((b.result.readBack || []).map((x) => x.atQuarter)), JSON.stringify([1, 2]))
  c.eq('(b) exactly one curve exists', callGlobal(L, '__T_pitCount'), 1)

  const pit = req('get_pit', {})
  c.eq('(c) get_pit count', pit.result && pit.result.count, 1)
  const curve = (pit.result.curves || [])[0] || {}
  c.eq('(c) kind', curve.kind, 'curve')
  c.eq('(c) anchorPitch', curve.anchorPitch, 64)
  c.eq('(c) positionQuarter', curve.positionQuarter, 1)
  c.eq('(c) absolute point pitches',
    JSON.stringify((curve.points || []).map((x) => x.pitch)), JSON.stringify([64, 67]))
  c.eq('(c) absolute point positions',
    JSON.stringify((curve.points || []).map((x) => x.atQuarter)), JSON.stringify([1, 2]))

  const d = req('write_pit', { points: [{ at: 0, pitch: 60 }] })
  c.eq('(d) the default clear=true removed the old curve', d.result && d.result.clearedExisting, 1)
  c.eq('(d) still exactly one curve (nothing stacked)', callGlobal(L, '__T_pitCount'), 1)

  const e = req('write_pit', { points: [{ at: 0, pitch: 60 }], clear: false })
  c.eq('(e) clear=false does not clear', e.result && e.result.clearedExisting, 0)
  c.eq('(e) the curves stack to 2', callGlobal(L, '__T_pitCount'), 2)

  const f = req('clear_pit', {})
  c.eq('(f) clear_pit removed', f.result && f.result.removed, 2)
  c.eq('(f) remaining', f.result && f.result.remaining, 0)
  c.eq('(f) really gone', callGlobal(L, '__T_pitCount'), 0)

  const g = req('clear_pit', {})
  c.eq('(g) clearing an empty group is a no-op', g.result && g.result.removed, 0)
  c.done('18', TESTS[18][1])
}

// ---------------------------------------------------------------------------
// test 19 — get_computed
// ---------------------------------------------------------------------------
function testGetComputed() {
  const c = checks()
  resetWorld()

  const a = req('get_computed', { kind: 'phonemes' })
  c.eq('(a) ok', a.ok, true)
  c.eq('(a) count', a.result && a.result.count, 3)
  c.eq('(a) phonemes', JSON.stringify(a.result && a.result.phonemes), JSON.stringify(['la-ph', 'li-ph', 'lu-ph']))

  callGlobal(L, '__T_setComputedReady', [false])
  const b = req('get_computed', { kind: 'phonemes' })
  c.eq('(b) an empty array is reported honestly', b.result && b.result.count, 0)
  c.ok('(b) and carries the "not computed yet" note',
    typeof (b.result && b.result.note) === 'string' && b.result.note.length > 0, b.result && b.result.note)
  callGlobal(L, '__T_setComputedReady', [true])

  const d = req('get_computed', { kind: 'attributes' })
  c.eq('(d) count', d.result && d.result.count, 3)
  c.eq('(d) attributes pass through', d.result && d.result.attributes[0] && d.result.attributes[0].pitch, 60)

  const e = req('get_computed', { kind: 'pitch', startQuarter: 1, stepQuarter: 0.5, frames: 8 })
  c.eq('(e) frames', e.result && e.result.frames, 8)
  c.eq('(e) echoes startQuarter', e.result && e.result.startQuarter, 1)
  c.eq('(e) echoes stepQuarter', e.result && e.result.stepQuarter, 0.5)
  const call1 = JSON.parse(callGlobal(L, '__T_lastComputedPitch'))
  c.eq('(e) blickStart = startQuarter*QUARTER + ref.timeOffset', call1.blickStart, 1 * QUARTER)
  c.eq('(e) blickInterval', call1.blickInterval, 0.5 * QUARTER)
  c.eq('(e) numFrames', call1.frames, 8)

  // the group reference's time offset MUST be added to blickStart (official docs)
  callGlobal(L, '__T_setRefTimeOffset', [QUARTER])
  req('get_computed', { kind: 'pitch', startQuarter: 1, stepQuarter: 0.5, frames: 4 })
  const call2 = JSON.parse(callGlobal(L, '__T_lastComputedPitch'))
  c.eq('(f) the reference timeOffset is added to blickStart', call2.blickStart, 2 * QUARTER)

  const g = req('get_computed', { kind: 'nope' })
  c.eq('(g) an unknown kind is rejected', g.ok, false)
  c.ok('(g) error lists the kinds', typeof g.error === 'string' && g.error.includes('phonemes'), g.error)

  const h = req('get_computed', { kind: 'pitch', stepQuarter: 0 })
  c.eq('(h) stepQuarter <= 0 rejected', h.ok, false)
  const i = req('get_computed', { kind: 'pitch', frames: 1 })
  c.eq('(i) frames < 2 rejected', i.ok, false)
  const j = req('get_computed', { kind: 'pitch', frames: 99999 })
  c.eq('(j) frames > 4096 rejected', j.ok, false)
  c.done('19', TESTS[19][1])
}

// ---------------------------------------------------------------------------
// test 20 — get_automation sampling
// ---------------------------------------------------------------------------
function testGetAutomation() {
  const c = checks()
  resetWorld()

  const a = req('get_automation', { type: 'voicing', startQuarter: 0, endQuarter: 1, stepQuarter: 0.25 })
  c.eq('ok', a.ok, true)
  c.eq('5 samples for 0..1 by 0.25', (a.result.samples || []).length, 5)
  c.eq('sample positions', JSON.stringify(a.result.samples.map((s) => s.atQuarter)),
    JSON.stringify([0, 0.25, 0.5, 0.75, 1]))
  c.eq('an untouched voicing reads its default (1)',
    JSON.stringify(a.result.samples.map((s) => s.value)), JSON.stringify([1, 1, 1, 1, 1]))
  c.eq('range is reported', JSON.stringify(a.result.range), JSON.stringify({ min: 0, max: 1 }))

  // no endQuarter ⇒ the current group reference's duration
  const b = req('get_automation', { type: 'tension', startQuarter: 0, stepQuarter: 0.5 })
  c.eq('endQuarter defaults to the reference duration (3 quarters)', b.result.sampledTo, 3)
  c.eq('7 samples for 0..3 by 0.5', (b.result.samples || []).length, 7)

  const before = snap()
  const d = req('get_automation', { type: 'tension', startQuarter: 0, endQuarter: 1, stepQuarter: 0 })
  c.eq('stepQuarter <= 0 rejected', d.ok, false)
  const e = req('get_automation', { type: 'tension', startQuarter: 1, endQuarter: 1, stepQuarter: 1 })
  c.eq('endQuarter <= startQuarter rejected', e.ok, false)
  const f = req('get_automation', { startQuarter: 0, endQuarter: 1, stepQuarter: 1 })
  c.eq('missing type rejected', f.ok, false)
  c.ok('error lists the types', typeof f.error === 'string' && f.error.includes('loudness'), f.error)
  const g = req('get_automation', { type: 'notAParam', startQuarter: 0, endQuarter: 1, stepQuarter: 1 })
  c.eq('unknown type rejected', g.ok, false)
  c.ok('error lists the known types', typeof g.error === 'string' && g.error.includes('pitchDelta'), g.error)
  sameSnap(c, 'no rejected read wrote anything', before)
  c.done('20', TESTS[20][1])
}

// ---------------------------------------------------------------------------
// test 21 — set_automation: range validation + the dynamics hard reject
// ---------------------------------------------------------------------------
function testSetAutomationGuards() {
  const c = checks()
  resetWorld()
  const before = snap()

  const a = req('set_automation', { type: 'tension', points: [{ at: 1, value: 5 }] })
  c.eq('(a) an out-of-range value is rejected', a.ok, false)
  c.ok('(a) error names the type and the documented range',
    typeof a.error === 'string' && a.error.includes('tension') && a.error.includes('(-1..1)'), a.error)
  sameSnap(c, '(a) NOTHING was written', before)
  c.eq('(a) no point was added at all',
    JSON.parse(callGlobal(L, '__T_autoLog')).filter((e) => e.op === 'add').length, 0)

  const paramsBefore = JSON.parse(callGlobal(L, '__T_paramCalls')).length
  const b = req('set_automation', { type: 'dynamics', points: [{ at: 1, value: 0.5 }] })
  c.eq('(b) dynamics is hard-rejected', b.ok, false)
  c.ok('(b) error explains why', typeof b.error === 'string' && b.error.includes('dynamics'), b.error)
  const params = JSON.parse(callGlobal(L, '__T_paramCalls'))
  c.eq('(b) getParameter("dynamics") was NEVER called', params.includes('dynamics'), false)
  c.eq('(b) getParameter was not called at all for THIS request', params.length, paramsBefore)

  const d = req('set_automation', { type: 'tension', points: [{ at: -1, value: 0.5 }] })
  c.eq('(d) a point with at < 0 is rejected', d.ok, false)
  sameSnap(c, '(d) nothing written', before)

  const e = req('set_automation', { type: 'tension', points: [{ at: 1, value: 0.5 }] })
  c.eq('(e) a legal write is accepted', e.ok, true)
  c.eq('(e) written', e.result && e.result.written, 1)
  c.eq('(e) readBack value', e.result.readBack[0].value, 0.5)
  c.done('21', TESTS[21][1])
}

// ---------------------------------------------------------------------------
// test 22 — set_automation: closeShape writes the boundary baseline points
// ---------------------------------------------------------------------------
// Two things must hold, and both are observable through the fake host's call
// log: (1) the baseline is READ before it is written (writing first would read
// back the shaped value as the "baseline" and freeze it in), and (2) the
// boundary points sit STRICTLY OUTSIDE the shaped span — at the same blick they
// would simply be overwritten by the user's own points.
function testCloseShapeWritesBoundary() {
  const c = checks()
  resetWorld()
  const GUARD = 0.0625                       // the bridge's default guardQuarter
  const beforeB = (1 - GUARD) * QUARTER
  const afterB = (2 + GUARD) * QUARTER

  const a = req('set_automation', { type: 'voicing', points: [{ at: 1, value: 0.3 }, { at: 2, value: 0.3 }] })
  c.eq('ok', a.ok, true)
  c.eq('closedShape is reported', a.result && a.result.closedShape, true)
  c.eq('written', a.result && a.result.written, 2)

  const log = JSON.parse(callGlobal(L, '__T_autoLog'))
  const iAdd = log.findIndex((e) => e.op === 'add')
  const iGet1 = log.findIndex((e) => e.op === 'get' && e.blick === beforeB)
  const iGet2 = log.findIndex((e) => e.op === 'get' && e.blick === afterB)
  c.ok('BOTH baselines are read BEFORE anything is written',
    iGet1 !== -1 && iGet2 !== -1 && iGet1 < iAdd && iGet2 < iAdd, JSON.stringify(log))

  const baselineAdds = log.filter((e) => e.op === 'add' && e.value === 1)
  c.eq('both boundary points are written with the baseline value', baselineAdds.length, 2)
  c.eq('the leading boundary point is BEFORE the first shaped point',
    baselineAdds[0] && baselineAdds[0].blick, beforeB)
  c.eq('the trailing boundary point is AFTER the last shaped point',
    baselineAdds[1] && baselineAdds[1].blick, afterB)
  c.ok('the boundary points do NOT share a blick with any shaped point',
    baselineAdds.every((e) => e.blick !== 1 * QUARTER && e.blick !== 2 * QUARTER))

  // closeShape:false ⇒ no boundary writes at all
  resetWorld()
  const d = req('set_automation', {
    type: 'voicing', points: [{ at: 1, value: 0.3 }, { at: 2, value: 0.3 }], closeShape: false,
  })
  c.eq('closeShape:false ok', d.ok, true)
  c.eq('closeShape:false is reported as not closed', d.result && d.result.closedShape, false)
  const log2 = JSON.parse(callGlobal(L, '__T_autoLog'))
  c.eq('closeShape:false writes only the shaped points',
    log2.filter((e) => e.op === 'add').length, 2)
  c.done('22', TESTS[22][1])
}

// ---------------------------------------------------------------------------
// test 23 — set_automation: closeShape really restores the baseline
// ---------------------------------------------------------------------------
// This is the observable consequence of test 22, and the reason the flag is
// documented as correctness rather than cosmetics: without working boundary
// points the shaped value HOLDS to the end of the group (the original
// "one point changes the whole group" accident).
function testCloseShapeRestoresBaseline() {
  const c = checks()
  resetWorld()
  // NOTE: get_automation rejects a zero-width span (endQuarter <= startQuarter),
  // so "outside the shaped span" is sampled as a short window on either side.
  const OUTSIDE_AFTER = { type: 'voicing', startQuarter: 2.5, endQuarter: 3, stepQuarter: 0.5 }
  const OUTSIDE_BEFORE = { type: 'voicing', startQuarter: 0, endQuarter: 0.5, stepQuarter: 0.5 }

  const b0 = req('get_automation', OUTSIDE_AFTER)
  c.eq('ok (pre-write sample)', b0.ok, true)
  c.eq('baseline after the span, before the write',
    JSON.stringify(b0.result.samples.map((s) => s.value)), JSON.stringify([1, 1]))

  const w = req('set_automation', { type: 'voicing', points: [{ at: 1, value: 0.3 }, { at: 2, value: 0.3 }] })
  c.eq('write ok', w.ok, true)
  c.eq('closedShape reported true', w.result && w.result.closedShape, true)

  const inside = req('get_automation', { type: 'voicing', startQuarter: 1, endQuarter: 2, stepQuarter: 1 })
  c.eq('inside the shaped span reads the shaped value',
    JSON.stringify(inside.result.samples.map((s) => s.value)), JSON.stringify([0.3, 0.3]))

  const after = req('get_automation', OUTSIDE_AFTER)
  c.eq('AFTER the shaped span still reads the ORIGINAL baseline',
    JSON.stringify(after.result.samples.map((s) => s.value)), JSON.stringify([1, 1]))

  const pre = req('get_automation', OUTSIDE_BEFORE)
  c.eq('BEFORE the shaped span still reads the ORIGINAL baseline',
    JSON.stringify(pre.result.samples.map((s) => s.value)), JSON.stringify([1, 1]))
  c.done('23', TESTS[23][1])
}

// ---------------------------------------------------------------------------
// test 24 — set_tempo replaces a mark at the same blick
// ---------------------------------------------------------------------------
// addTempoMark does NOT update an existing mark at the same position (real host
// behaviour, reproduced by the fake), so set_tempo MUST removeTempoMark first.
function testSetTempo() {
  const c = checks()
  resetWorld()
  const t0 = req('get_tempo', {})
  c.eq('ok', t0.ok, true)
  c.eq('one tempo mark', (t0.result.tempos || []).length, 1)
  c.eq('tempo mark position (quarter)', t0.result.tempos[0].atQuarter, 0)
  c.eq('tempo mark bpm', t0.result.tempos[0].bpm, 120)
  c.eq('one measure mark', (t0.result.meters || []).length, 1)
  c.eq('measure mark is 4/4',
    JSON.stringify([t0.result.meters[0].numerator, t0.result.meters[0].denominator]), JSON.stringify([4, 4]))
  c.eq('durationQuarter', t0.result.durationQuarter, 3)

  const before = snap()
  const bad = req('set_tempo', { marks: [{ atQuarter: 0, bpm: 0 }] })
  c.eq('bpm 0 rejected', bad.ok, false)
  sameSnap(c, 'rejected before writing anything', before)

  const a = req('set_tempo', { marks: [{ atQuarter: 0, bpm: 90 }] })
  c.eq('ok', a.ok, true)
  c.eq('written', a.result && a.result.written, 1)
  const marks = JSON.parse(callGlobal(L, '__T_tempoMarks'))
  c.eq('exactly ONE mark at blick 0 (replaced, not stacked)', marks.length, 1)
  c.eq('the mark carries the NEW bpm', marks[0].bpm, 90)

  req('set_tempo', { marks: [{ atQuarter: 2, bpm: 100 }] })
  c.eq('a mark at another blick is added', JSON.parse(callGlobal(L, '__T_tempoMarks')).length, 2)

  req('set_tempo', { marks: [{ atQuarter: 0, bpm: 140 }, { atQuarter: 2, bpm: 150 }] })
  const marks2 = JSON.parse(callGlobal(L, '__T_tempoMarks'))
  c.eq('both marks replaced ⇒ still exactly 2', marks2.length, 2)
  c.eq('bpm at 0', marks2[0].bpm, 140)
  c.eq('bpm at 2', marks2[1].bpm, 150)

  const e = req('get_tempo', {})
  c.eq('get_tempo reflects the replacement', e.result.tempos[0].bpm, 140)
  c.eq('get_tempo atQuarter of the second mark', e.result.tempos[1].atQuarter, 2)
  c.done('24', TESTS[24][1])
}

// ---------------------------------------------------------------------------
// test 25 — set_meter
// ---------------------------------------------------------------------------
function testSetMeter() {
  const c = checks()
  resetWorld()
  const before = snap()

  const a = req('set_meter', { measure: 1, numerator: 3, denominator: 3 })
  c.eq('a non-power-of-two denominator is rejected', a.ok, false)
  c.ok('error mentions "power of two"', typeof a.error === 'string' && a.error.includes('power of two'), a.error)
  sameSnap(c, 'nothing written', before)

  const b = req('set_meter', { measure: 0, numerator: 4, denominator: 4 })
  c.eq('measure 0 rejected', b.ok, false)
  const d = req('set_meter', { measure: 1, numerator: 0, denominator: 4 })
  c.eq('numerator 0 rejected', d.ok, false)
  const e0 = req('set_meter', { measure: 1, numerator: 4, denominator: 64 })
  c.eq('denominator 64 rejected', e0.ok, false)
  sameSnap(c, 'still nothing written', before)

  const e = req('set_meter', { measure: 1, numerator: 3, denominator: 4 })
  c.eq('3/4 accepted', e.ok, true)
  c.eq('readBackNumerator', e.result && e.result.readBackNumerator, 3)
  c.eq('readBackDenominator', e.result && e.result.readBackDenominator, 4)
  const mm = JSON.parse(callGlobal(L, '__T_measureMarks'))
  // ⚠️ 对外的 `measure` 是 1 起(和 DAW 界面一致),宿主的索引是 0 起
  //    (真机实测:传 measure=1 落在第 4 拍 @4/4)⇒ measure 1 应当落到宿主索引 0,
  //    并且**替换**掉那里原有的默认 4/4,而不是叠一个。
  c.eq('exactly one mark at host index 0 (1-based measure 1 → host index 0; replaced, not stacked)',
    mm.filter((m) => m.measure === 0).length, 1)
  c.eq('the mark really is 3/4', JSON.stringify([mm[0].numerator, mm[0].denominator]), JSON.stringify([3, 4]))

  const f = req('get_tempo', {})
  c.eq('get_tempo sees 3/4',
    JSON.stringify([f.result.meters[0].numerator, f.result.meters[0].denominator]), JSON.stringify([3, 4]))
  // ⚠️ 0.5.8 回归守卫:拍号标记的位置字段是 `positionBlick`,而假宿主**故意**让
  //    `position` 返回一个 ~1 blick 的垃圾值(真机实测)。读错字段就会得到 1.4e-9 拍。
  c.eq('get_tempo reads the meter position from positionBlick, not the ~1 blick garbage field',
    f.result.meters[0].atQuarter, 0)
  c.done('25', TESTS[25][1])
}

// ---------------------------------------------------------------------------
// test 26 — transport
// ---------------------------------------------------------------------------
function testTransport() {
  const c = checks()
  resetWorld()
  const before = snap()

  const a = req('transport', { action: 'seek' })
  c.eq('seek without seconds rejected', a.ok, false)
  c.ok('error mentions seconds', typeof a.error === 'string' && a.error.includes('seconds'), a.error)
  const b = req('transport', { action: 'seek', seconds: -1 })
  c.eq('seek -1 rejected', b.ok, false)
  sameSnap(c, 'the playhead never moved', before)

  const d = req('transport', { action: 'seek', seconds: 1.5 })
  c.eq('seek ok', d.ok, true)
  c.eq('reported playhead', d.result && d.result.playheadSeconds, 1.5)
  c.eq('the fake playhead really moved', playbackOf()[2], 1.5)

  const e = req('transport', { action: 'status' })
  c.eq('status reports the fake playhead', e.result && e.result.playheadSeconds, 1.5)
  c.eq('status', e.result && e.result.status, 'stopped')

  const f = req('transport', { action: 'play' })
  c.eq('play -> playing', f.result && f.result.status, 'playing')
  const g = req('transport', { action: 'pause' })
  c.eq('pause -> paused', g.result && g.result.status, 'paused')
  const h = req('transport', { action: 'stop' })
  c.eq('stop -> stopped', h.result && h.result.status, 'stopped')
  c.eq('stop resets the playhead', playbackOf()[2], 0)

  const i = req('transport', { action: 'loop', loopBegin: 2, loopEnd: 2 })
  c.eq('loop with loopEnd <= loopBegin rejected', i.ok, false)
  const j = req('transport', { action: 'loop', loopBegin: 0, loopEnd: 2 })
  c.eq('loop ok', j.ok, true)

  const k = req('transport', { action: 'nope' })
  c.eq('unknown action rejected', k.ok, false)
  c.ok('error lists the actions', typeof k.error === 'string' && k.error.includes('seek'), k.error)
  c.done('26', TESTS[26][1])
}

// ---------------------------------------------------------------------------
// test 27 — group_ops
// ---------------------------------------------------------------------------
function testGroupOps() {
  const c = checks()
  resetWorld()
  const info = req('group_ops', { action: 'info' })
  c.eq('ok', info.ok, true)
  c.eq('groupName', info.result.groupName, 'Main')
  c.eq('noteCount', info.result.noteCount, 3)
  c.eq('isMain', info.result.isMain, true)
  c.eq('trackIndex is 0-based', info.result.trackIndex, 0)
  c.eq('onsetQuarter', info.result.onsetQuarter, 0)
  c.eq('durationQuarter', info.result.durationQuarter, 3)

  const before = snap()
  const a = req('group_ops', { action: 'rename', name: '' })
  c.eq('rename without a name is rejected', a.ok, false)
  sameSnap(c, 'nothing renamed', before)

  const b = req('group_ops', { action: 'rename', name: 'Verse' })
  c.eq('rename ok', b.ok, true)
  c.eq('rename round-trips', b.result && b.result.groupName, 'Verse')
  c.eq('the fake group really is renamed', at(groupsOf(), 0)[0], 'Verse')

  const s1 = snap()
  const d = req('group_ops', { action: 'offset', pitchOffset: 49 })
  c.eq('pitchOffset 49 is rejected', d.ok, false)
  c.ok('error names the field', typeof d.error === 'string' && d.error.includes('pitchOffset'), d.error)
  c.eq('the reference pitch offset is untouched', refsOf()[0][6], 0)
  c.eq('the reference time offset is untouched', refsOf()[0][5], 0)
  sameSnap(c, 'the rejected offset wrote no data', s1)

  const e = req('group_ops', { action: 'offset', pitchOffset: 3, timeOffsetQuarter: 1 })
  c.eq('offset ok', e.ok, true)
  c.eq('pitchOffset read-back', e.result && e.result.pitchOffset, 3)
  c.eq('timeOffsetQuarter read-back', e.result && e.result.timeOffsetQuarter, 1)
  c.eq('the fake reference really moved', refsOf()[0][6], 3)
  c.eq('the fake time offset is in blicks', refsOf()[0][5], QUARTER)

  const g = req('group_ops', { action: 'delete' })
  c.eq('deleting the MAIN group is refused', g.ok, false)
  c.eq('the main group is still mounted', refsOf().length, 1)
  c.eq('its notes are untouched', at(groupsOf(), 0)[2], 3)

  const w = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 72 }] })
  c.eq('write_notes ok (to get a non-main group)', w.ok, true)
  c.eq('two groups on the track', refsOf().length, 2)
  callGlobal(L, '__T_useGroupAt', [2])
  const h = req('group_ops', { action: 'delete' })
  c.eq('deleting a non-main group ok', h.ok, true)
  c.eq('removedFromTrack', h.result && h.result.removedFromTrack, true)
  c.eq('the track is back to one group', refsOf().length, 1)
  callGlobal(L, '__T_useGroupAt', [1])
  c.done('27', TESTS[27][1])
}

// ---------------------------------------------------------------------------
// test 28 — track_ops
// ---------------------------------------------------------------------------
function testTrackOps() {
  const c = checks()
  resetWorld()
  const list = req('track_ops', { action: 'list' })
  c.eq('ok', list.ok, true)
  c.eq('count', list.result.count, 1)
  c.eq('index is 0-based', list.result.tracks[0].index, 0)
  c.eq('name', list.result.tracks[0].name, 'Lead')
  c.eq('groupCount', list.result.tracks[0].groupCount, 1)
  c.eq('isBounced', list.result.tracks[0].isBounced, false)

  const before = snap()
  const a = req('track_ops', { action: 'setMixer', trackIndex: 0, gainDecibel: 30 })
  c.eq('gain 30 is rejected', a.ok, false)
  c.ok('error names the field', typeof a.error === 'string' && a.error.includes('gainDecibel'), a.error)
  c.eq('NOTHING was written (gain)', tracksOf()[0][3], 0)
  const b = req('track_ops', { action: 'setMixer', trackIndex: 0, pan: 1.5 })
  c.eq('pan 1.5 is rejected', b.ok, false)
  c.eq('NOTHING was written (pan)', tracksOf()[0][4], 0)
  sameSnap(c, 'the whole mixer is untouched', before)
  const b2 = req('track_ops', { action: 'setMixer', trackIndex: 0 })
  c.eq('setMixer with no field at all is rejected', b2.ok, false)
  sameSnap(c, 'still untouched', before)

  const d = req('track_ops', { action: 'setMixer', trackIndex: 0, gainDecibel: -6, pan: 0.5, muted: true })
  c.eq('setMixer ok', d.ok, true)
  c.eq('gain read-back', d.result && d.result.gainDecibel, -6)
  c.eq('pan read-back', d.result && d.result.pan, 0.5)
  c.eq('muted read-back', d.result && d.result.muted, true)
  c.eq('the fake mixer really changed',
    JSON.stringify(tracksOf()[0].slice(3, 6)), JSON.stringify([-6, 0.5, 1]))

  const e = req('track_ops', { action: 'add', name: 'Harmony' })
  c.eq('add ok', e.ok, true)
  // ⚠️ 对外一律 0 起。宿主的 `addTrack` 返回值是 **1 起/计数**(真机实测:加完返回 2,
  //    而新轨的 0 起下标其实是 1)⇒ 断言"报出来的下标确实指向新轨",别透传宿主原值。
  c.eq('addedIndex is 0-based and points at the new track', e.result && e.result.addedIndex, 1)
  c.eq('numTracks', e.result && e.result.numTracks, 2)
  const list2 = req('track_ops', { action: 'list' })
  c.eq('list count after add', list2.result.count, 2)
  c.eq('the new track is at 0-based index 1', list2.result.tracks[1].index, 1)
  c.eq('the new track name', list2.result.tracks[1].name, 'Harmony')

  const f = req('track_ops', { action: 'rename', trackIndex: 1, name: 'Harm' })
  c.eq('rename ok', f.ok, true)
  c.eq('rename round-trips', f.result && f.result.name, 'Harm')
  const g = req('track_ops', { action: 'color', trackIndex: 1, color: '#FF0000' })
  c.eq('color ok', g.ok, true)
  c.eq('color round-trips', g.result && g.result.displayColor, '#FF0000')

  const h = req('track_ops', { action: 'remove', trackIndex: 1 })
  c.eq('remove ok', h.ok, true)
  c.eq('numTracks after remove', h.result && h.result.numTracks, 1)
  const i = req('track_ops', { action: 'remove', trackIndex: 0 })
  c.eq('removing the LAST track is refused', i.ok, false)
  c.eq('the last track is still there', tracksOf().length, 1)
  c.eq('and it is still called Lead', at(tracksOf(), 0)[0], 'Lead')
  c.done('28', TESTS[28][1])
}

// ---------------------------------------------------------------------------
// test 29 — set_note_attrs: the four new fields
// ---------------------------------------------------------------------------
function testNoteAttrsNewFields() {
  const c = checks()
  resetWorld()
  const fpNow = () => callGlobal(L, '__T_selectionFp')

  // (a) rapAccent is the STRING "1".."5" — a number must be refused
  let before = snap()
  const a = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, rapAccent: 3 }] })
  c.eq('(a) a numeric rapAccent is rejected', a.ok, false)
  c.ok('(a) error says it must be a string',
    typeof a.error === 'string' && a.error.includes('must be a string'), a.error)
  sameSnap(c, '(a) nothing written', before)

  const b = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, rapAccent: '6' }] })
  c.eq('(b) rapAccent "6" is rejected', b.ok, false)
  c.ok('(b) error names the allowed values',
    typeof b.error === 'string' && b.error.includes('1 / 2 / 3 / 4 / 5'), b.error)
  sameSnap(c, '(b) nothing written', before)

  const d = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, rapAccent: '3' }] })
  c.eq('(d) rapAccent "3" accepted', d.ok, true)
  c.eq('(d) the fake note really carries it', at(notesOf(groupsOf()[0]), 0)[8], '3')

  // (c) phonemes: bounded length is the rule that has survived every revision of
  //     the whitelist. The character-set rule deliberately is NOT pinned here:
  //     real phonemes are X-SAMPA-ish, and a hand-rolled whitelist only rejects
  //     legal input, so the bridge has changed its mind about it more than once.
  before = snap()
  const longPhonemes = 'a'.repeat(257)
  const e = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 1, phonemes: longPhonemes }] })
  c.eq('(c) an over-long phoneme string is rejected', e.ok, false)
  c.ok('(c) error names the field and the limit',
    typeof e.error === 'string' && e.error.includes('phonemes') && e.error.includes('256'), e.error)
  sameSnap(c, '(c) nothing written', before)

  const e2 = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 1, phonemes: 'bad\u0001chars' }] })
  if (e2.ok === false) sameSnap(c, '(c2) a rejected control byte wrote nothing', before)

  const f = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 1, phonemes: 'l@a{#}~' }] })
  c.eq('(f) X-SAMPA-ish printable phonemes are NOT over-rejected', f.ok, true)
  c.eq('(f) the fake note really carries them', at(notesOf(groupsOf()[0]), 1)[5], 'l@a{#}~')

  // language: a control byte is invalid under every revision (printable-ASCII
  // and the `^[%a][%a%d_%-]*$` pattern agree on that)
  before = snap()
  const g = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 2, language: 'zh\tcn' }] })
  c.eq('(g) a language with a control byte is rejected', g.ok, false)
  sameSnap(c, '(g) nothing written', before)
  const h = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 2, language: 'zh-cn' }] })
  c.eq('(h) language "zh-cn" accepted', h.ok, true)
  c.eq('(h) the fake note really carries it', at(notesOf(groupsOf()[0]), 2)[7], 'zh-cn')

  // detune is the one numeric field that allows fractions (integer = false)
  before = snap()
  const i = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, detune: 1201 }] })
  c.eq('(i) detune 1201 is rejected', i.ok, false)
  c.ok('(i) error mentions the range', typeof i.error === 'string' && i.error.includes('out of range'), i.error)
  sameSnap(c, '(i) nothing written', before)

  const j = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, detune: -12.5 }] })
  c.eq('(j) a FRACTIONAL detune is accepted (integer = false)', j.ok, true)
  c.eq('(j) the fake note really carries it', at(notesOf(groupsOf()[0]), 0)[6], -12.5)

  // a rejected entry LATE in the batch must abort the whole batch
  before = snap()
  const k = req('set_note_attrs', {
    expectFp: fpNow(),
    updates: [{ index: 0, lyrics: 'nope' }, { index: 1, rapAccent: 'x' }],
  })
  c.eq('(k) the batch is rejected', k.ok, false)
  sameSnap(c, '(k) nothing written (all-or-nothing)', before)
  c.done('29', TESTS[29][1])
}

// ---------------------------------------------------------------------------
// test 30 — select_notes: programmatic selection
// ---------------------------------------------------------------------------
// Before this op the selection could only be set by hand in SV2, so every
// "write to the selection" op (set_note_attrs / set_lyrics / transpose_selected)
// needed the user to click first. The op is a user-visible side effect by
// design; what must hold is (a) each action lands on the RIGHT notes and (b) a
// REJECTED request leaves the previous selection exactly as it was.
function testSelectNotes() {
  const c = checks()
  resetWorld()
  // the fake selection is UI state, so it has its own deterministic accessor
  // (__T_selection) instead of being folded into __T_snap()
  const sel = () => JSON.parse(callGlobal(L, '__T_selection'))

  // (a) none
  callGlobal(L, '__T_selectAll')
  c.eq('(a) precondition: 3 notes selected', sel().count, 3)
  let r = req('select_notes', { action: 'none' })
  c.eq('(a) ok', r.ok, true)
  c.eq('(a) reported selected', r.result && r.result.selected, 0)
  c.eq('(a) the fake selection really is empty', sel().count, 0)
  c.eq('(a) hasSelectedNotes went false', sel().has, false)

  // (b) all — every note of the CURRENT group
  callGlobal(L, '__T_selectOnly', ['2'])
  c.eq('(b) precondition: only note 2 selected', JSON.stringify(sel().indices), JSON.stringify([2]))
  r = req('select_notes', { action: 'all' })
  c.eq('(b) ok', r.ok, true)
  c.eq('(b) selected every note in the group', r.result && r.result.selected, 3)
  c.eq('(b) the fake selection is exactly notes 1,2,3',
    JSON.stringify(sel().indices), JSON.stringify([1, 2, 3]))
  c.eq('(b) hasSelectedNotes', sel().has, true)

  // (c) indices — exactly the named 0-based ones. Note 3 is selected FIRST so
  //     that a dropped clearAll() would leave it behind and be visible.
  callGlobal(L, '__T_selectOnly', ['3'])
  r = req('select_notes', { action: 'indices', indices: [0] })
  c.eq('(c) ok', r.ok, true)
  c.eq('(c) selected', r.result && r.result.selected, 1)
  c.eq('(c) the OLD selection was replaced (clearAll ran), not merged',
    JSON.stringify(sel().indices), JSON.stringify([1]))

  r = req('select_notes', { action: 'indices', indices: [2, 0] })
  c.eq('(c2) selected', r.result && r.result.selected, 2)
  c.eq('(c2) exactly notes 1 and 3', JSON.stringify(sel().indices), JSON.stringify([1, 3]))

  // (d) a rejected request must not touch the selection, the project data, or the
  //     user's undo stack. (0.6.0 moved newUndoRecord() and clearAll() AFTER the
  //     validation: clearing first meant a rejected request had already wiped the
  //     user's selection, and the undo stack gained a no-op step.)
  const keep = callGlobal(L, '__T_selection')
  const before = snap()
  const undo0 = callGlobal(L, '__T_undo')
  const d = req('select_notes', { action: 'indices', indices: [0, 5] })
  c.eq('(d) an out-of-range index is rejected', d.ok, false)
  c.ok('(d) error names the offending element',
    typeof d.error === 'string' && d.error.includes('indices[2]'), d.error)
  c.eq('(d) the selection is untouched', callGlobal(L, '__T_selection'), keep)
  sameSnap(c, '(d) and no project data was written', before)

  const d2 = req('select_notes', { action: 'indices', indices: [-1] })
  c.eq('(d2) a negative index is rejected', d2.ok, false)
  c.eq('(d2) selection untouched', callGlobal(L, '__T_selection'), keep)
  const d3 = req('select_notes', { action: 'indices', indices: [] })
  c.eq('(d3) an empty index list is rejected', d3.ok, false)
  const d4 = req('select_notes', { action: 'indices' })
  c.eq('(d4) missing indices is rejected', d4.ok, false)
  const d5 = req('select_notes', { action: 'nope' })
  c.eq('(d5) an unknown action is rejected', d5.ok, false)
  c.ok('(d5) the error lists the actions',
    typeof d5.error === 'string' && ['all', 'indices', 'group', 'none'].every((x) => d5.error.includes(x)),
    d5.error)

  // (d6) a FRACTIONAL index. 0.5 is inside 0..3, so only the integer check can
  //      reject it — and it must be rejected before getNote() ever receives a
  //      non-integer (that input class pops a modal dialog on the real host).
  const calls0 = callCount()
  const d6 = req('select_notes', { action: 'indices', indices: [0.5] })
  c.eq('(d6) a fractional index is rejected', d6.ok, false)
  c.ok('(d6) the error mentions "整数"',
    typeof d6.error === 'string' && d6.error.includes('整数'), d6.error)
  c.eq('(d6) NO fractional index reached the host', fractionalCalls(callsSince(calls0)).length, 0)

  c.eq('(d) the selection survived ALL SIX rejected requests',
    callGlobal(L, '__T_selection'), keep)
  c.eq('(d) none of them pushed an undo step', callGlobal(L, '__T_undo'), undo0)
  sameSnap(c, '(d) still nothing written', before)

  // (e) group — the CURRENT group's notes, not the first group's
  const w = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 72, lyrics: 'x' }] })
  c.eq('(e) write_notes ok (a second group to aim at)', w.ok, true)
  callGlobal(L, '__T_useGroupAt', [2])
  callGlobal(L, '__T_selectAll')   // still the Main group's notes (H.notes)
  c.ok('(e) precondition: the selection belongs to the OTHER group',
    sel().groupUUID !== w.result.groupUUID, `${sel().groupUUID} vs ${w.result.groupUUID}`)
  r = req('select_notes', { action: 'group' })
  c.eq('(e) ok', r.ok, true)
  c.eq('(e) selectedGroup is the current group', r.result && r.result.selectedGroup, w.result.groupName)
  c.eq('(e) the selection is the new group\'s only note',
    JSON.stringify(sel().indices), JSON.stringify([1]))
  c.eq('(e) and it belongs to the NEW group', sel().groupUUID, w.result.groupUUID)
  c.eq('(e) the old selection was cleared, not merged', sel().count, 1)
  callGlobal(L, '__T_useGroupAt', [1])
  c.done('30', TESTS[30][1])
}

// ---------------------------------------------------------------------------
// test 31 — get_note_attrs: scope / limit / the raw attributes table
// ---------------------------------------------------------------------------
// The point of this op is "what has actually been SET on this note", so the raw
// attributes table must contain ONLY keys that were written. The real host
// returns nil for everything else (reference project SV-007) — inventing
// defaults would make the agent believe a value is pinned when it is not.
function testGetNoteAttrs() {
  const c = checks()
  resetWorld()

  // (a) group scope reads every note of the current group
  let r = req('get_note_attrs', {})
  c.eq('(a) ok', r.ok, true)
  const g = r.result || {}
  c.eq('(a) scope echoes', g.scope, 'group')
  c.eq('(a) groupName', g.groupName, 'Main')
  c.eq('(a) count', g.count, 3)
  c.eq('(a) returned', g.returned, 3)
  c.eq('(a) truncated', g.truncated, false)
  c.eq('(a) pitches', JSON.stringify((g.notes || []).map((n) => n.pitch)), JSON.stringify([60, 62, 64]))
  c.eq('(a) lyrics', JSON.stringify((g.notes || []).map((n) => n.lyrics)), JSON.stringify(['la', 'li', 'lu']))
  c.eq('(a) onsetQuarter', JSON.stringify((g.notes || []).map((n) => n.onsetQuarter)), JSON.stringify([0, 1, 2]))
  c.eq('(a) durationQuarter', JSON.stringify((g.notes || []).map((n) => n.durationQuarter)), JSON.stringify([1, 1, 1]))
  c.ok('(a) every note carries its own fp',
    (g.notes || []).every((n) => typeof n.fp === 'string' && n.fp.length > 0))
  c.ok('(a) the result states the attributes contract',
    typeof g.note === 'string' && g.note.length > 0, g.note)

  // (b) THE RAW TABLE: only keys that were actually written
  const raw = (g.notes || []).map((n) => n.attributes)
  c.ok('(b) a note with nothing written has an EMPTY attributes table (no invented defaults)',
    raw.every((a) => a === undefined || Object.keys(a).length === 0), JSON.stringify(raw))
  c.ok('(b) never-written per-note fields stay ABSENT rather than defaulted',
    (g.notes || []).every((n) => n.musicalType === undefined && n.pitchAutoMode === undefined),
    JSON.stringify((g.notes || []).map((n) => [n.musicalType, n.pitchAutoMode])))

  // (c) limit truncates and says so
  r = req('get_note_attrs', { limit: 2 })
  c.eq('(c) returned', r.result && r.result.returned, 2)
  c.eq('(c) truncated', r.result && r.result.truncated, true)
  c.eq('(c) count still reports the whole group', r.result && r.result.count, 3)

  // (d) scope:"selection" reads only the selected notes
  callGlobal(L, '__T_selectOnly', ['1,3'])
  r = req('get_note_attrs', { scope: 'selection' })
  c.eq('(d) scope echoes', r.result && r.result.scope, 'selection')
  c.eq('(d) count', r.result && r.result.count, 2)
  c.eq('(d) only the selected notes come back',
    JSON.stringify((r.result.notes || []).map((n) => n.pitch)), JSON.stringify([60, 64]))
  c.eq('(d) a selection scope has no groupName', r.result && r.result.groupName, undefined)

  // (e) after writing, the raw table holds EXACTLY the keys that were written
  resetWorld()
  const fp = callGlobal(L, '__T_selectionFp')
  const w = req('set_note_attrs', {
    expectFp: fp,
    updates: [{ index: 0, detune: -12.5 }, { index: 0, phonemes: 'a-b' }, { index: 1, rapAccent: '3' }],
  })
  c.eq('(e) the write is accepted', w.ok, true)
  r = req('get_note_attrs', {})
  const n = (r.result || {}).notes || []
  c.eq('(e) note 0 attributes are EXACTLY the written keys',
    JSON.stringify(Object.keys(n[0].attributes || {}).sort()), JSON.stringify(['detune', 'phonemes']))
  c.eq('(e) note 1 attributes are EXACTLY the written key',
    JSON.stringify(Object.keys(n[1].attributes || {}).sort()), JSON.stringify(['rapAccent']))
  c.ok('(e) note 2 still has no attributes at all',
    n[2].attributes === undefined || Object.keys(n[2].attributes).length === 0,
    JSON.stringify(n[2].attributes))
  c.eq('(e) the value round-trips through the raw table', n[0].attributes.detune, -12.5)
  c.eq('(e) and through the per-note field', n[0].detune, -12.5)
  c.eq('(e) rapAccent lands in the raw table', n[1].attributes.rapAccent, '3')
  // the fake host's own ledger (1-based: set_note_attrs index 1 == note 2)
  c.eq('(e) the fake host agrees (ledger)', JSON.parse(callGlobal(L, '__T_attributes', [2])).rapAccent, '3')
  c.done('31', TESTS[31][1])
}

// ---------------------------------------------------------------------------
// test 32 — split_notes: fingerprint, split-point bounds, head + tail
// ---------------------------------------------------------------------------
// Splitting is the one op that both MODIFIES an existing note and CREATES a new
// one, so it is the easiest place to lose lyrics/pitch or to shift indices. It
// is also destructive, so every rejected shape must be rejected before a single
// write (asserted with the whole-host snapshot).
function testSplitNotes() {
  const c = checks()
  resetWorld()
  const fp = req('get_notes', {}).result.groupFp
  const before = snap()

  // (a) expectGroupFp is required
  const a = req('split_notes', { splits: [{ index: 0, atQuarter: 0.5 }] })
  c.eq('(a) a missing expectGroupFp is rejected', a.ok, false)
  c.ok('(a) the error mentions expectGroupFp',
    typeof a.error === 'string' && a.error.includes('expectGroupFp'), a.error)
  sameSnap(c, '(a) nothing was split', before)

  // (b) stale fingerprint: the user edited the group behind the bridge's back
  callGlobal(L, '__T_mutatePitch', [1, 2])
  const edited = snap()
  c.ok('(b) the host-side edit really changed the world', edited !== before)
  const b = req('split_notes', { splits: [{ index: 0, atQuarter: 0.5 }], expectGroupFp: fp })
  c.eq('(b) a stale expectGroupFp is rejected', b.ok, false)
  c.ok('(b) the error mentions STALE_SELECTION',
    typeof b.error === 'string' && b.error.includes('STALE_SELECTION'), b.error)
  sameSnap(c, '(b) NOTHING was split', edited)
  c.eq('(b) the group still has 3 notes', callGlobal(L, '__T_noteCount'), 3)

  // put the pitch back: the fingerprint is content-derived, so it must return to
  // exactly the value we read before the edit
  callGlobal(L, '__T_setPitch', [1, 60])
  const fp2 = req('get_notes', {}).result.groupFp
  c.ok('(b) the fingerprint is content-derived and came back unchanged', fp2 === fp, `${fp} -> ${fp2}`)
  const base = snap()

  // (c) the split point must lie strictly inside the note, at least MIN_Q
  //     (0.125 quarter) from either edge. Note 0 is 0..1.
  for (const at of [0, 1, -0.5, 1.5, 2, 0.124, 0.876]) {
    const r = req('split_notes', { splits: [{ index: 0, atQuarter: at }], expectGroupFp: fp2 })
    c.eq(`(c) at=${at} is rejected`, r.ok, false)
    c.eq(`(c) at=${at} the group still has 3 notes`, callGlobal(L, '__T_noteCount'), 3)
    sameSnap(c, `(c) at=${at}: nothing was written`, base)
  }
  const cm = req('split_notes', { splits: [{ index: 0, atQuarter: 0.124 }], expectGroupFp: fp2 })
  c.ok('(c) the error explains the 0.125-quarter margin',
    typeof cm.error === 'string' && cm.error.includes('0.125'), cm.error)

  const c2 = req('split_notes', { splits: [{ index: 9, atQuarter: 0.5 }], expectGroupFp: fp2 })
  c.eq('(c2) an out-of-range index is rejected', c2.ok, false)
  const c3 = req('split_notes', { splits: [{ index: 0 }], expectGroupFp: fp2 })
  c.eq('(c3) a missing atQuarter is rejected', c3.ok, false)
  const c4 = req('split_notes', { splits: [], expectGroupFp: fp2 })
  c.eq('(c4) an empty splits array is rejected', c4.ok, false)
  const c5 = req('split_notes', { splits: [{ index: 0, atQuarter: 0.5 }], expectGroupFp: '' })
  c.eq('(c5) an empty expectGroupFp is rejected', c5.ok, false)
  sameSnap(c, '(c2-c5) nothing was written', base)

  // (c6) a FRACTIONAL index must be rejected BEFORE any host call: `getNote(1.5)`
  //      is exactly the non-integer argument class that pops a modal dialog and
  //      freezes the host, and the fake host would silently return nil for it.
  const calls0 = callCount()
  const c6 = req('split_notes', { splits: [{ index: 0.5, atQuarter: 0.5 }], expectGroupFp: fp2 })
  c.eq('(c6) a fractional index is rejected', c6.ok, false)
  c.ok('(c6) the error mentions "整数"',
    typeof c6.error === 'string' && c6.error.includes('整数'), c6.error)
  sameSnap(c, '(c6) nothing was written', base)
  c.eq('(c6) NO fractional index reached the host (not even getNote)',
    fractionalCalls(callsSince(calls0)).length, 0)
  c.eq('(c6) the group still has 3 notes', callGlobal(L, '__T_noteCount'), 3)

  // (d) the same note cannot be split twice in one request
  const d = req('split_notes', {
    splits: [{ index: 0, atQuarter: 0.25 }, { index: 0, atQuarter: 0.75 }], expectGroupFp: fp2,
  })
  c.eq('(d) splitting the same index twice is rejected', d.ok, false)
  c.ok('(d) the error names the index',
    typeof d.error === 'string' && d.error.includes('index 0'), d.error)
  sameSnap(c, '(d) nothing was split', base)

  // (e) a valid split: the head keeps the onset, the tail is a NEW note carrying
  //     the second half. ⚠️ addNote INSERTS by onset (measured on the real host),
  //     so the tail lands right after its own head and everything after the split
  //     note shifts one index up.
  const e = req('split_notes', { splits: [{ index: 1, atQuarter: 1.5 }], expectGroupFp: fp2 })
  c.eq('(e) ok', e.ok, true)
  c.eq('(e) split count', e.result && e.result.split, 1)
  c.eq('(e) remaining == before + 1', e.result && e.result.remaining, 4)
  c.eq('(e) the fake group really grew by one', callGlobal(L, '__T_noteCount'), 4)
  c.ok('(e) the returned groupFp DIFFERS from the input fingerprint',
    typeof (e.result || {}).groupFp === 'string' && e.result.groupFp !== fp2,
    `${fp2} -> ${e.result && e.result.groupFp}`)

  const at = req('get_note_attrs', {}).result.notes
  // ⚠️ 真机实测(桥 0.5.9):`addNote` **按 onset 插进组里**,不是追加到末尾。
  //    所以尾音落在**它自己那个头的后面**,而被拆音符之后的音符整体后移一位。
  c.eq('(e) onsets in group order', JSON.stringify(at.map((x) => x.onsetQuarter)), JSON.stringify([0, 1, 1.5, 2]))
  c.eq('(e) durations in group order', JSON.stringify(at.map((x) => x.durationQuarter)), JSON.stringify([1, 0.5, 0.5, 1]))
  c.eq('(e) pitches in group order', JSON.stringify(at.map((x) => x.pitch)), JSON.stringify([60, 62, 62, 64]))
  c.eq('(e) lyrics in group order', JSON.stringify(at.map((x) => x.lyrics)), JSON.stringify(['la', 'li', 'li', 'lu']))
  c.eq('(e) the head keeps the onset', at[1].onsetQuarter, 1)
  c.eq('(e) head duration == at - onset', at[1].durationQuarter, 0.5)
  c.eq('(e) tail onset == at', at[2].onsetQuarter, 1.5)
  c.eq('(e) tail duration == end - at', at[2].durationQuarter, 0.5)
  c.eq('(e) pitch preserved on both halves', JSON.stringify([at[1].pitch, at[2].pitch]), JSON.stringify([62, 62]))
  c.eq('(e) lyrics preserved on both halves', JSON.stringify([at[1].lyrics, at[2].lyrics]), JSON.stringify(['li', 'li']))
  c.eq('(e) the tail sits immediately after its head (index 3)', at[2].index, 3)
  c.eq('(e) the notes BEFORE the split keep their indices',
    JSON.stringify([at[0].index, at[1].index]), JSON.stringify([1, 2]))
  c.eq('(e) the note that followed the split is pushed back by one (3 -> 4)', at[3].index, 4)

  // (f) the pre-split fingerprint is stale now
  const f = req('split_notes', { splits: [{ index: 0, atQuarter: 0.5 }], expectGroupFp: fp2 })
  c.eq('(f) the pre-split fingerprint is stale', f.ok, false)
  c.ok('(f) the error mentions STALE_SELECTION',
    typeof f.error === 'string' && f.error.includes('STALE_SELECTION'), f.error)
  c.eq('(f) still 4 notes (the rejected call split nothing)', callGlobal(L, '__T_noteCount'), 4)

  // (g) two splits in one request. This is the 0.5.9 regression: because addNote
  //     INSERTS, splitting index 0 first pushes every later note's index up by
  //     one, so an ASCENDING plan would hit the wrong note with the second split.
  //     The bridge therefore processes the plan in DESCENDING index order.
  resetWorld()
  const fp3 = req('get_notes', {}).result.groupFp
  const g = req('split_notes', {
    splits: [{ index: 0, atQuarter: 0.5 }, { index: 2, atQuarter: 2.5 }], expectGroupFp: fp3,
  })
  c.eq('(g) ok', g.ok, true)
  c.eq('(g) split count', g.result && g.result.split, 2)
  c.eq('(g) remaining', g.result && g.result.remaining, 5)
  const gt = req('get_note_attrs', {}).result.notes
  c.eq('(g) both notes were split at the RIGHT place (no tail landed on a neighbour)',
    JSON.stringify(gt.map((x) => x.onsetQuarter)), JSON.stringify([0, 0.5, 1, 2, 2.5]))
  c.eq('(g) durations', JSON.stringify(gt.map((x) => x.durationQuarter)), JSON.stringify([0.5, 0.5, 1, 0.5, 0.5]))
  c.eq('(g) pitches', JSON.stringify(gt.map((x) => x.pitch)), JSON.stringify([60, 60, 62, 64, 64]))
  c.eq('(g) lyrics', JSON.stringify(gt.map((x) => x.lyrics)), JSON.stringify(['la', 'la', 'li', 'lu', 'lu']))
  c.eq('(g) every note sits at its own onset index',
    JSON.stringify(gt.map((x) => x.index)), JSON.stringify([1, 2, 3, 4, 5]))
  // the two assertions that pin the 0.5.9 regression hardest: with an ascending
  // plan the SECOND split would land on the note that shifted into index 2, so
  // the second head would be stretched and its tail would carry a neighbour's pitch
  c.eq('(g) the second head was shortened to 0.5 (not stretched to 1.5)', gt[3].durationQuarter, 0.5)
  c.eq('(g) the second tail carries the SECOND note\'s pitch (not a neighbour\'s)', gt[4].pitch, 64)
  c.eq('(g) and the second tail keeps its lyrics', gt[4].lyrics, 'lu')
  c.done('32', TESTS[32][1])
}

// ---------------------------------------------------------------------------
// test 33 — get_layout: the layout health check
// ---------------------------------------------------------------------------
// Overlapping notes inside one SOUNDING group are a violation in SV2 (they make
// the pronunciation misbehave), and nothing in the API reports them. get_layout
// is the read-only half of that check: write_notes guards its OWN output, this
// one inspects groups somebody else built (hand-drawn, or SV2's own audio→notes
// transcription). So "an overlap is actually detected" is the whole point — a
// version that reports 0 overlaps for everything would look perfectly healthy.
function testGetLayout() {
  const c = checks()
  resetWorld()

  // (a) the pristine group: 3 notes of 1 quarter each, each one starting exactly
  //     where the previous one ends ⇒ 0 overlaps AND 0 gaps.
  const before = snap()
  let r = req('get_layout', {})
  c.eq('(a) ok', r.ok, true)
  let g = r.result || {}
  c.eq('(a) scope echoes', g.scope, 'group')
  c.eq('(a) groupName', g.groupName, 'Main')
  c.eq('(a) noteCount', g.noteCount, 3)
  c.eq('(a) overlapCount', g.overlapCount, 0)
  c.eq('(a) overlaps is an empty array', JSON.stringify(g.overlaps), '[]')
  c.eq('(a) spanStartQuarter', g.spanStartQuarter, 0)
  c.eq('(a) spanEndQuarter', g.spanEndQuarter, 3)
  c.ok('(a) the verdict starts with OK', typeof g.verdict === 'string' && g.verdict.startsWith('OK'), g.verdict)
  c.eq('(a) the layout is sorted by onset',
    JSON.stringify((g.layout || []).map((x) => x.onsetQuarter)), JSON.stringify([0, 1, 2]))
  c.eq('(a) each layout row carries the host index',
    JSON.stringify((g.layout || []).map((x) => x.index)), JSON.stringify([0, 1, 2]))
  c.eq('(a) each layout row carries pitch + lyrics',
    JSON.stringify((g.layout || []).map((x) => [x.pitch, x.lyrics])),
    JSON.stringify([[60, 'la'], [62, 'li'], [64, 'lu']]))
  // (b) notes that merely TOUCH (end == next onset) are not overlaps and not gaps
  c.eq('(b) touching neighbours are neither overlaps nor gaps',
    JSON.stringify([g.overlapCount, g.gapCount]), JSON.stringify([0, 0]))
  sameSnap(c, '(b) a read-only op wrote nothing', before)

  // (c) a real overlap: note 1 is stretched to 1.5 quarters, so it runs 0.5
  //     quarter INTO note 2. Note 2/3 still touch, so exactly one overlap.
  resetWorld()
  callGlobal(L, '__T_setNoteRangeQuarter', [1, 0, 1.5])
  const overlapSnap = snap()
  r = req('get_layout', {})
  c.eq('(c) ok', r.ok, true)
  g = r.result || {}
  c.eq('(c) the overlap IS detected', g.overlapCount, 1)
  c.eq('(c) gaps stay 0', g.gapCount, 0)
  c.eq('(c) the pair is reported by host index',
    JSON.stringify([g.overlaps[0].aIndex, g.overlaps[0].bIndex]), JSON.stringify([0, 1]))
  c.eq('(c) the overlap size is in quarters', g.overlaps[0].overlapQuarter, 0.5)
  c.eq('(c) both pitches are named',
    JSON.stringify([g.overlaps[0].aPitch, g.overlaps[0].bPitch]), JSON.stringify([60, 62]))
  c.eq('(c) the boundary is named',
    JSON.stringify([g.overlaps[0].aEndQuarter, g.overlaps[0].bOnsetQuarter]), JSON.stringify([1.5, 1]))
  c.ok('(c) the verdict says it is a VIOLATION',
    typeof g.verdict === 'string' && g.verdict.includes('违规'), g.verdict)
  c.eq('(c) spanEnd follows the stretched note', g.spanEndQuarter, 3)
  sameSnap(c, '(c) get_layout itself wrote nothing', overlapSnap)

  // (d) a real gap is reported in gaps, and is NOT an overlap.
  //     ⚠️ Everything stays inside 3 quarters: `onset + duration` is computed in
  //     blicks, and fengari's integers are 32-bit, so 3.5 quarters (2469600000)
  //     would wrap and make spanEndQuarter silently read 2.5 (see the NOTE).
  resetWorld()
  callGlobal(L, '__T_setNoteRangeQuarter', [2, 1.25, 0.5])
  callGlobal(L, '__T_setNoteRangeQuarter', [3, 2, 0.5])
  r = req('get_layout', {})
  c.eq('(d) ok', r.ok, true)
  g = r.result || {}
  c.eq('(d) overlapCount', g.overlapCount, 0)
  c.eq('(d) gapCount', g.gapCount, 2)
  c.eq('(d) the first gap is 0.25 quarter', g.gaps[0].gapQuarter, 0.25)
  c.eq('(d) the second gap is 0.25 quarter', g.gaps[1].gapQuarter, 0.25)
  c.eq('(d) a gap is never reported as an overlap', g.overlaps.length, 0)
  c.ok('(d) the verdict is OK', g.verdict.startsWith('OK'), g.verdict)
  c.eq('(d) spanEndQuarter covers the last note', g.spanEndQuarter, 2.5)

  // (e) scope:"selection" looks at the SELECTED notes only
  callGlobal(L, '__T_selectOnly', ['1,3'])
  r = req('get_layout', { scope: 'selection' })
  c.eq('(e) ok', r.ok, true)
  g = r.result || {}
  c.eq('(e) scope echoes', g.scope, 'selection')
  c.eq('(e) noteCount is the selection size', g.noteCount, 2)
  c.eq('(e) only the selected notes are laid out',
    JSON.stringify((g.layout || []).map((x) => x.pitch)), JSON.stringify([60, 64]))
  c.eq('(e) a selection scope has no groupName', g.groupName, undefined)
  c.done('33', TESTS[33][1])
}

// ---------------------------------------------------------------------------
// test 34 — apply_lyrics: CJK per character, Latin per word, ordered by ONSET
// ---------------------------------------------------------------------------
function testApplyLyrics() {
  const c = checks()

  // (a) CJK splits per character; extra tokens are reported, not silently dropped
  resetWorld()
  let r = req('apply_lyrics', { lyrics: '晚风轻轻' })
  c.eq('(a) ok', r.ok, true)
  c.eq('(a) tokenCount', r.result.tokenCount, 4)
  c.eq('(a) noteCount', r.result.noteCount, 3)
  c.eq('(a) written', r.result.written, 3)
  c.eq('(a) one character per note',
    JSON.stringify(r.result.lyricsWritten), JSON.stringify(['晚', '风', '轻']))
  c.eq('(a) leftoverTokens', r.result.leftoverTokens, 1)
  c.ok('(a) the leftover is explained in prose',
    typeof r.result.note === 'string' && r.result.note.includes('1'), r.result.note)
  c.eq('(a) the fake host really carries them',
    JSON.stringify(notesOf(groupsOf()[0]).map((n) => n[4])), JSON.stringify(['晚', '风', '轻']))

  // (b) Latin/digits accumulate into WORDS; the spare note takes the filler
  resetWorld()
  r = req('apply_lyrics', { lyrics: 'hello world' })
  c.eq('(b) ok', r.ok, true)
  c.eq('(b) tokenCount is the WORD count', r.result.tokenCount, 2)
  c.eq('(b) words + filler',
    JSON.stringify(r.result.lyricsWritten), JSON.stringify(['hello', 'world', '-']))
  c.eq('(b) no leftovers', r.result.leftoverTokens, 0)
  c.eq('(b) the filler really landed on note 3',
    JSON.stringify(notesOf(groupsOf()[0]).map((n) => n[4])), JSON.stringify(['hello', 'world', '-']))

  // (c) ORDER IS BY ONSET, not by getNote(i). Build a 4-note group whose STORAGE
  //     order is deliberately different from its time order.
  resetWorld()
  c.eq('(c) precondition: 4 notes', callGlobal(L, '__T_addNoteToMainGroup', [3, 0.5, 67, 'z']), 4)
  // storage order becomes [onset 2, onset 0, onset 3, onset 1]
  c.eq('(c) precondition: the storage order was permuted', callGlobal(L, '__T_reorderNotes', ['3,1,4,2']), 4)
  r = req('apply_lyrics', { lyrics: '甲乙丙丁' })
  c.eq('(c) ok', r.ok, true)
  c.eq('(c) the lyrics follow TIME order, not storage order',
    callGlobal(L, '__T_lyricsByOnset'), '0:甲,1:乙,2:丙,3:丁')
  c.eq('(c) the returned mapping is in time order too',
    JSON.stringify(r.result.lyricsWritten), JSON.stringify(['甲', '乙', '丙', '丁']))

  // (d) more tokens than notes ⇒ the surplus is COUNTED and named
  resetWorld()
  r = req('apply_lyrics', { lyrics: '一二三四五六' })
  c.eq('(d) ok', r.ok, true)
  c.eq('(d) only three are written',
    JSON.stringify(r.result.lyricsWritten), JSON.stringify(['一', '二', '三']))
  c.eq('(d) leftoverTokens counts the surplus', r.result.leftoverTokens, 3)

  // (e) filler:"" means "leave the remaining notes ALONE" (not "write an empty
  //     string"): the third note keeps its original lyric.
  resetWorld()
  r = req('apply_lyrics', { lyrics: '晚风', filler: '' })
  c.eq('(e) ok', r.ok, true)
  c.eq('(e) written', r.result.written, 2)
  c.eq('(e) the untouched note keeps its ORIGINAL lyrics',
    JSON.stringify(notesOf(groupsOf()[0]).map((n) => n[4])), JSON.stringify(['晚', '风', 'lu']))

  // (f) a non-string / empty / missing lyrics is rejected BEFORE anything is written
  resetWorld()
  const b6 = snap()
  for (const [label, args] of [
    ['a number', { lyrics: 123 }],
    ['an array', { lyrics: ['甲'] }],
    ['an empty string', { lyrics: '' }],
    ['a missing field', {}],
  ]) {
    const rr = req('apply_lyrics', args)
    c.eq(`(f) ${label} is rejected`, rr.ok, false)
    c.ok(`(f) ${label}: the error names lyrics`,
      typeof rr.error === 'string' && rr.error.includes('lyrics'), rr.error)
    sameSnap(c, `(f) ${label}: NOT ONE BYTE was written`, b6)
  }

  // (g) startIndex must be a non-negative INTEGER (it indexes the token list)
  resetWorld()
  const b7 = snap()
  const g1 = req('apply_lyrics', { lyrics: '甲乙丙', startIndex: -1 })
  c.eq('(g) a negative startIndex is rejected', g1.ok, false)
  c.ok('(g) the error names startIndex',
    typeof g1.error === 'string' && g1.error.includes('startIndex'), g1.error)
  const g2 = req('apply_lyrics', { lyrics: '甲乙丙', startIndex: 0.5 })
  c.eq('(g) a fractional startIndex is rejected', g2.ok, false)
  sameSnap(c, '(g) neither rejected call wrote anything', b7)

  // (h) …and a legal startIndex really skips leading tokens
  r = req('apply_lyrics', { lyrics: '甲乙丙', startIndex: 1 })
  c.eq('(h) ok', r.ok, true)
  c.eq('(h) the first token was skipped',
    JSON.stringify(r.result.lyricsWritten), JSON.stringify(['乙', '丙', '-']))
  c.done('34', TESTS[34][1])
}

// ---------------------------------------------------------------------------
// test 35 — align_lyrics: LRC timestamps + a PURE dry-run
// ---------------------------------------------------------------------------
// The harness world runs at 120 bpm, so 1 quarter = 0.5 s: notes at onsets
// 0/1/2/3 quarters sit at 0.0/0.5/1.0/1.5 seconds.
function testAlignLyrics() {
  const c = checks()
  const fourNotes = () => {
    resetWorld()
    callGlobal(L, '__T_addNoteToMainGroup', [3, 0.5, 67, 'z'])
    callGlobal(L, '__T_selectAll')
  }

  // (a) two segments, four notes
  fourNotes()
  const LRC = '[00:00.00]甲乙\n[00:01.00]丙丁'
  let r = req('align_lyrics', { lrc: LRC })
  c.eq('(a) ok', r.ok, true)
  c.eq('(a) applied', r.result.applied, true)
  c.eq('(a) segmentCount', r.result.segmentCount, 2)
  c.eq('(a) noteCount', r.result.noteCount, 4)
  c.eq('(a) written', r.result.written, 4)
  c.eq('(a) each note gets the next unused token of its segment',
    JSON.stringify(r.result.mapping.map((m) => m.lyrics)), JSON.stringify(['甲', '乙', '丙', '丁']))
  c.eq('(a) the note times are reported in SECONDS',
    JSON.stringify(r.result.mapping.map((m) => m.atSec)), JSON.stringify([0, 0.5, 1, 1.5]))
  c.eq('(a) the fake host really got them (read in TIME order)',
    callGlobal(L, '__T_lyricsByOnset'), '0:甲,1:乙,2:丙,3:丁')
  c.eq('(a) nothing is left over', r.result.unusedSegments.length, 0)

  // (b) apply:false is a PURE dry-run — the mapping is computed, nothing is written
  fourNotes()
  const before = snap()
  r = req('align_lyrics', { lrc: LRC, apply: false })
  c.eq('(b) ok', r.ok, true)
  c.eq('(b) applied is false', r.result.applied, false)
  c.eq('(b) the mapping is still computed',
    JSON.stringify(r.result.mapping.map((m) => m.lyrics)), JSON.stringify(['甲', '乙', '丙', '丁']))
  c.ok('(b) the dry-run says so', typeof r.result.note === 'string' && r.result.note.length > 0, r.result.note)
  sameSnap(c, '(b) apply:false wrote NOT ONE BYTE', before)

  // (c) [mm:ss] without fractions parses, and the segments are SORTED by time
  fourNotes()
  r = req('align_lyrics', { lrc: '[00:00]甲乙\n[00:01]丙丁' })
  c.eq('(c) ok', r.ok, true)
  c.eq('(c) segmentCount', r.result.segmentCount, 2)
  c.eq('(c) mapping',
    JSON.stringify(r.result.mapping.map((m) => m.lyrics)), JSON.stringify(['甲', '乙', '丙', '丁']))

  // (c2) fractional seconds are honoured, and an out-of-order LRC is sorted
  fourNotes()
  r = req('align_lyrics', { lrc: '[00:00.50]乙\n[00:00.00]甲' })
  c.eq('(c2) ok', r.ok, true)
  c.eq('(c2) [mm:ss.xx] is read as fractional seconds',
    JSON.stringify(r.result.mapping.map((m) => m.atSec)), JSON.stringify([0, 0.5, 1, 1.5]))
  c.eq('(c2) the segments were sorted by time',
    JSON.stringify(r.result.mapping.map((m) => m.lyrics)), JSON.stringify(['甲', '乙', '-', '-']))

  // (d) an LRC with no valid lines is rejected before anything is written
  resetWorld()
  const b2 = snap()
  const d = req('align_lyrics', { lrc: 'this is not an lrc file at all' })
  c.eq('(d) rejected', d.ok, false)
  c.ok('(d) the error names the expected shape',
    typeof d.error === 'string' && d.error.includes('mm:ss'), d.error)
  sameSnap(c, '(d) nothing written', b2)
  const d2 = req('align_lyrics', { lrc: '[00:00.00]' })
  c.eq('(d2) a timestamp with no text is rejected too', d2.ok, false)
  const d3 = req('align_lyrics', {})
  c.eq('(d3) a missing lrc is rejected', d3.ok, false)
  sameSnap(c, '(d2-d3) nothing written', b2)

  // (e) unusedSegments reports the tokens nobody reached
  fourNotes()
  r = req('align_lyrics', { lrc: '[00:00.00]甲\n[00:01.00]乙丙丁' })
  c.eq('(e) ok', r.ok, true)
  c.eq('(e) a segment with no token left falls back to the filler',
    JSON.stringify(r.result.mapping.map((m) => m.lyrics)), JSON.stringify(['甲', '-', '乙', '丙']))
  c.eq('(e) one segment is reported as unused', r.result.unusedSegments.length, 1)
  c.eq('(e) it starts at 1 s', r.result.unusedSegments[0].sec, 1)
  c.eq('(e) and has 1 token left', r.result.unusedSegments[0].left, 1)
  c.done('35', TESTS[35][1])
}

// ---------------------------------------------------------------------------
// test 36 — get_audio_tracks
// ---------------------------------------------------------------------------
// An "audio track" is a NoteGroupReference whose isInstrumental() is true: it
// backs an external audio file and therefore has NO editable note group (its
// getTarget() is nil). This op is how the agent finds the backing track the user
// dragged in — before that it has to say so instead of guessing.
function testGetAudioTracks() {
  const c = checks()

  // (a) nothing audio-backed yet
  resetWorld()
  const before = snap()
  let r = req('get_audio_tracks', {})
  c.eq('(a) ok', r.ok, true)
  c.eq('(a) count', r.result.count, 0)
  c.eq('(a) audio is an empty array', JSON.stringify(r.result.audio), '[]')
  c.ok('(a) it tells the user to drag the backing track into SV2 first',
    typeof r.result.note === 'string' && r.result.note.length > 0, r.result.note)
  sameSnap(c, '(a) a read-only op wrote nothing', before)

  // (b) one instrumental reference, on the SECOND track (0-based index 1)
  resetWorld()
  const add = req('track_ops', { action: 'add', name: 'Audio' })
  c.eq('(b) a second track exists', add.result.addedIndex, 1)
  c.eq('(b) the audio reference lands at group index 0',
    callGlobal(L, '__T_addInstrumentalRef', [1, QUARTER, 2 * QUARTER, 0]), 0)
  r = req('get_audio_tracks', {})
  c.eq('(b) count', r.result.count, 1)
  c.eq('(b) no "nothing found" note when something was found', r.result.note, undefined)
  const a0 = (r.result.audio || [])[0] || {}
  c.eq('(b) trackIndex is 0-based', a0.trackIndex, 1)
  c.eq('(b) groupIndex is 0-based', a0.groupIndex, 0)
  c.eq('(b) trackName', a0.trackName, 'Audio')
  c.eq('(b) onsetQuarter', a0.onsetQuarter, 1)
  c.eq('(b) durationQuarter', a0.durationQuarter, 2)
  c.eq('(b) endQuarter', a0.endQuarter, 3)
  c.eq('(b) timeOffsetQuarter', a0.timeOffsetQuarter, 0)

  // (c) a second one on the FIRST track ⇒ ordering is by (track, group)
  c.eq('(c) the second audio reference is at track 0 group 1',
    callGlobal(L, '__T_addInstrumentalRef', [0, 0, QUARTER, QUARTER]), 1)
  r = req('get_audio_tracks', {})
  c.eq('(c) count', r.result.count, 2)
  c.eq('(c) ordering follows track then group index',
    JSON.stringify(r.result.audio.map((x) => [x.trackIndex, x.groupIndex])), JSON.stringify([[0, 1], [1, 0]]))
  c.eq('(c) the time offset is reported in quarters', r.result.audio[0].timeOffsetQuarter, 1)
  c.ok('(c) the non-instrumental Main reference is never listed',
    r.result.audio.every((x) => !(x.trackIndex === 0 && x.groupIndex === 0)), JSON.stringify(r.result.audio))
  c.done('36', TESTS[36][1])
}

// ---------------------------------------------------------------------------
// test 37 — align_audio
// ---------------------------------------------------------------------------
// The audio's "first beat" (measured outside SV2, in seconds) must land exactly
// on an anchor. Two things are load-bearing: the seconds→blick conversion goes
// through the HOST (tempo-dependent, never a constant), and the public `measure`
// is 1-based while TimeAxis:getMeasureMarkAt() is 0-based.
function testAlignAudio() {
  const c = checks()

  // (a) no audio reference ⇒ error, and NOTHING is written
  resetWorld()
  const before = snap()
  const a = req('align_audio', { firstBeatSec: 0, anchor: 'measure', measure: 1 })
  c.eq('(a) rejected', a.ok, false)
  c.ok('(a) the error explains that an instrumental reference is needed',
    typeof a.error === 'string' && a.error.includes('isInstrumental'), a.error)
  sameSnap(c, '(a) nothing written', before)

  // (d) firstBeatSec is required
  const d = req('align_audio', { anchor: 'measure', measure: 1 })
  c.eq('(d) a missing firstBeatSec is rejected', d.ok, false)
  c.ok('(d) the error names it',
    typeof d.error === 'string' && d.error.includes('firstBeatSec'), d.error)

  // (e) measure 0 is rejected: the public API is 1-based
  const e = req('align_audio', { firstBeatSec: 0, anchor: 'measure', measure: 0 })
  c.eq('(e) measure 0 is rejected', e.ok, false)
  c.ok('(e) the error says the measure is 1-based',
    typeof e.error === 'string' && e.error.includes('1 起'), e.error)
  sameSnap(c, '(d-e) nothing written by either rejected call', before)

  // (b) anchor measure 1 ⇒ the first beat lands on quarter 0 (measure 1's blick)
  resetWorld()
  callGlobal(L, '__T_addInstrumentalRef', [0, 0, 2 * QUARTER, 0])
  let r = req('align_audio', { firstBeatSec: 0, anchor: 'measure', measure: 1 })
  c.eq('(b) ok', r.ok, true)
  c.eq('(b) anchor echoes', r.result.anchor, 'measure')
  c.eq('(b) measure echoes', r.result.measure, 1)
  c.eq('(b) the 1-based measure 1 maps to quarter 0',
    r.result.measureStartQuarter, 0)
  c.eq('(b) firstBeatLandsAtQuarter', r.result.firstBeatLandsAtQuarter, 0)
  c.eq('(b) audioOnsetQuarter', r.result.audioOnsetQuarter, 0)
  c.eq('(b) the read-back agrees', r.result.audioOnsetReadBackQuarter, 0)
  c.eq('(b) the fake reference really moved', refsOf()[1][3], 0)
  c.eq('(b) the reference window kept its duration', refsOf()[1][4], 2 * QUARTER)

  // (b2) a first beat 0.5 s in (= 1 beat at 120 bpm) ⇒ the audio starts one
  //      quarter EARLY so that the beat still lands on the anchor.
  r = req('align_audio', { firstBeatSec: 0.5, anchor: 'measure', measure: 1 })
  c.eq('(b2) ok', r.ok, true)
  c.eq('(b2) firstBeatQuarter comes from the host conversion', r.result.firstBeatQuarter, 1)
  c.eq('(b2) so the audio onset is one quarter BEFORE the anchor', r.result.audioOnsetQuarter, -1)
  c.eq('(b2) but the first beat still lands ON the anchor', r.result.firstBeatLandsAtQuarter, 0)
  c.eq('(b2) the fake reference really moved', refsOf()[1][3], -QUARTER)

  // (c) shiftBeats moves the target by whole beats
  resetWorld()
  callGlobal(L, '__T_addInstrumentalRef', [0, 0, 2 * QUARTER, 0])
  r = req('align_audio', { firstBeatSec: 0, anchor: 'measure', measure: 1, shiftBeats: 2 })
  c.eq('(c) ok', r.ok, true)
  c.eq('(c) shiftBeats echoes', r.result.shiftBeats, 2)
  c.eq('(c) the anchor moved by 2 beats', r.result.anchorQuarter, 2)
  c.eq('(c) firstBeatLandsAtQuarter', r.result.firstBeatLandsAtQuarter, 2)
  c.eq('(c) the fake reference really moved by 2 quarters', refsOf()[1][3], 2 * QUARTER)

  // (f) bpm writes a tempo mark AT the anchor, REPLACING any mark already there
  resetWorld()
  callGlobal(L, '__T_addInstrumentalRef', [0, 0, 2 * QUARTER, 0])
  c.eq('(f) precondition: exactly one tempo mark', JSON.parse(callGlobal(L, '__T_tempoMarks')).length, 1)
  r = req('align_audio', { firstBeatSec: 0, anchor: 'measure', measure: 1, bpm: 90 })
  c.eq('(f) ok', r.ok, true)
  c.eq('(f) tempoBpm read back', r.result.tempoBpm, 90)
  const marks = JSON.parse(callGlobal(L, '__T_tempoMarks'))
  c.eq('(f) the mark was REPLACED, not stacked', marks.length, 1)
  c.eq('(f) it carries the new bpm', marks[0].bpm, 90)
  c.eq('(f) and it sits at the anchor', marks[0].position, 0)

  // (f2) without bpm no tempo mark is touched at all
  resetWorld()
  callGlobal(L, '__T_addInstrumentalRef', [0, 0, 2 * QUARTER, 0])
  r = req('align_audio', { firstBeatSec: 0, anchor: 'measure', measure: 1 })
  c.eq('(f2) tempoBpm is absent', r.result.tempoBpm, undefined)
  const marks2 = JSON.parse(callGlobal(L, '__T_tempoMarks'))
  c.eq('(f2) still exactly one mark', marks2.length, 1)
  c.eq('(f2) and it still says 120', marks2[0].bpm, 120)
  c.done('37', TESTS[37][1])
}

// ---------------------------------------------------------------------------
// test 38 — set_note_attrs: the `attributes` layer (SV2 2.1.1+)
// ---------------------------------------------------------------------------
// This layer is the only way to touch per-phoneme properties (which is how you
// stop a short note's consonant from eating the previous note). It is also the
// dangerous one: on SV1 an unknown key made setAttributes pop a MODAL error
// dialog and freeze the host, so the bridge whitelists every key — and a batch
// is all-or-nothing, like every other write op.
function testNoteAttrsLayer() {
  const c = checks()
  resetWorld()
  const fpNow = () => callGlobal(L, '__T_selectionFp')
  const attrsOf = (i) => JSON.parse(callGlobal(L, '__T_attributes', [i]))

  // (a) muted:true writes and reads back — and ONLY that key is stored
  let r = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, attributes: { muted: true } }] })
  c.eq('(a) ok', r.ok, true)
  c.eq('(a) changed', r.result.changed, 1)
  c.eq('(a) readBack.attributes.muted', r.result.readBack[0].attributes.muted, true)
  c.eq('(a) the fake host really stores it', attrsOf(1).muted, true)
  c.eq('(a) the raw table holds EXACTLY the written key',
    JSON.stringify(Object.keys(attrsOf(1)).sort()), JSON.stringify(['muted']))
  c.eq('(a) the note still has 3 siblings', attrsOf(2).muted, undefined)

  // (b) an UNKNOWN attribute key is rejected and nothing is written
  resetWorld()
  const before = snap()
  const b = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, attributes: { bogusKey: 1 } }] })
  c.eq('(b) rejected', b.ok, false)
  c.ok('(b) the error names the offending key',
    typeof b.error === 'string' && b.error.includes('bogusKey'), b.error)
  c.ok('(b) and lists the allowed keys',
    typeof b.error === 'string' &&
    ['muted', 'evenSyllableDuration', 'dF0VbrMod', 'phonemes'].every((k) => b.error.includes(k)), b.error)
  sameSnap(c, '(b) NOT ONE BYTE was written', before)

  // (c) bad TYPES
  const c1 = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, attributes: { muted: 'yes' } }] })
  c.eq('(c1) muted:"yes" is rejected', c1.ok, false)
  c.ok('(c1) the error says true/false',
    typeof c1.error === 'string' && c1.error.includes('true/false'), c1.error)
  const c2 = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, attributes: { dF0VbrMod: 'loud' } }] })
  c.eq('(c2) dF0VbrMod:"loud" is rejected', c2.ok, false)
  c.ok('(c2) the error says it must be a number',
    typeof c2.error === 'string' && c2.error.includes('必须是数字'), c2.error)
  const c3 = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, attributes: { phonesetOverride: 42 } }] })
  c.eq('(c3) phonesetOverride:42 is rejected', c3.ok, false)
  sameSnap(c, '(c) none of the bad types wrote anything', before)

  // (d) an out-of-range number
  const d = req('set_note_attrs', { expectFp: fpNow(), updates: [{ index: 0, attributes: { rTone: 200 } }] })
  c.eq('(d) rTone 200 is rejected', d.ok, false)
  c.ok('(d) the error names the value and the range',
    typeof d.error === 'string' && d.error.includes('200') && d.error.includes('-100'), d.error)
  sameSnap(c, '(d) nothing written', before)

  // (e) the per-phoneme array: legal in, unknown sub-key / out-of-range out
  const e1 = req('set_note_attrs', {
    expectFp: fpNow(),
    updates: [{ index: 0, attributes: { phonemes: [{ leftOffset: -0.1, position: 0.5 }] } }],
  })
  c.eq('(e1) a legal per-phoneme entry is accepted', e1.ok, true)
  const stored = attrsOf(1)
  c.eq('(e1) leftOffset round-trips', stored.phonemes[0].leftOffset, -0.1)
  c.eq('(e1) position round-trips', stored.phonemes[0].position, 0.5)
  c.eq('(e1) no invented sub-keys',
    JSON.stringify(Object.keys(stored.phonemes[0]).sort()), JSON.stringify(['leftOffset', 'position']))

  const afterE1 = snap()
  const e2 = req('set_note_attrs', {
    expectFp: fpNow(),
    updates: [{ index: 0, attributes: { phonemes: [{ foo: 1 }] } }],
  })
  c.eq('(e2) an unknown sub-key is rejected', e2.ok, false)
  c.ok('(e2) the error names the sub-key',
    typeof e2.error === 'string' && e2.error.includes('foo'), e2.error)
  const e3 = req('set_note_attrs', {
    expectFp: fpNow(),
    updates: [{ index: 0, attributes: { phonemes: [{ position: 5 }] } }],
  })
  c.eq('(e3) an out-of-range sub-value is rejected', e3.ok, false)
  c.eq('(e3) the earlier array is untouched', attrsOf(1).phonemes.length, 1)
  sameSnap(c, '(e2-e3) neither rejected call wrote anything', afterE1)

  // (f) THE HOUSE RULE: a bad entry late in the batch aborts the WHOLE batch
  const beforeF = snap()
  const f = req('set_note_attrs', {
    expectFp: fpNow(),
    updates: [
      { index: 0, attributes: { muted: true } },
      { index: 1, attributes: { notAKey: true } },
    ],
  })
  c.eq('(f) the batch is rejected', f.ok, false)
  c.eq('(f) the FIRST entry was not applied either', attrsOf(1).muted, undefined)
  sameSnap(c, '(f) nothing written (all-or-nothing)', beforeF)
  c.done('38', TESTS[38][1])
}

// ---------------------------------------------------------------------------
// test 39 — track_ops list: displayOrder + the summed noteCount
// ---------------------------------------------------------------------------
// Two answers the transcription workflow needs: "is the topmost track empty?"
// (noteCount, summed across the track's groups) and "which track IS the topmost
// one?" (min(displayOrder) — the arrangement view sorts by display order, which
// can differ from the storage index).
function testTrackOpsListOrder() {
  const c = checks()
  resetWorld()

  let r = req('track_ops', { action: 'list' })
  c.eq('(a) ok', r.ok, true)
  c.eq('(a) one track', r.result.count, 1)
  c.eq('(a) noteCount sums the track\'s groups', r.result.tracks[0].noteCount, 3)
  c.ok('(a) displayOrder is reported',
    typeof r.result.tracks[0].displayOrder === 'number', r.result.tracks[0].displayOrder)

  // a SECOND group on the same track ⇒ noteCount is a SUM, not a group count
  const w = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 72, lyrics: 'x' }] })
  c.eq('(a) write_notes ok', w.ok, true)
  r = req('track_ops', { action: 'list' })
  c.eq('(a) groupCount grew', r.result.tracks[0].groupCount, 2)
  c.eq('(a) noteCount is the SUM across the groups (3 + 1)', r.result.tracks[0].noteCount, 4)

  // an empty track reports 0 — that is the "is the topmost track free?" answer
  const add = req('track_ops', { action: 'add', name: 'Empty' })
  c.eq('(a) a second track exists', add.result.addedIndex, 1)
  r = req('track_ops', { action: 'list' })
  c.eq('(a) an empty track reports noteCount 0', r.result.tracks[1].noteCount, 0)
  c.eq('(a) and groupCount 0', r.result.tracks[1].groupCount, 0)

  // (b) displayOrder can DIFFER from the storage index — the bridge must report
  //     the host's value, not reuse its own loop counter.
  callGlobal(L, '__T_setTrackDisplayOrder', [0, 1])
  callGlobal(L, '__T_setTrackDisplayOrder', [1, 0])
  r = req('track_ops', { action: 'list' })
  c.eq('(b) track 0 keeps its storage index', r.result.tracks[0].index, 0)
  c.eq('(b) track 1 keeps its storage index', r.result.tracks[1].index, 1)
  c.eq('(b) track 0 reports the host displayOrder 1', r.result.tracks[0].displayOrder, 1)
  c.eq('(b) track 1 reports the host displayOrder 0', r.result.tracks[1].displayOrder, 0)
  c.eq('(b) so the visually topmost track is min(displayOrder), not index 0',
    r.result.tracks.find((t) => t.displayOrder === 0).index, 1)
  c.done('39', TESTS[39][1])
}

// ---------------------------------------------------------------------------
// test 40 — group_ops {action:"move"}
// ---------------------------------------------------------------------------
// `move` exists so the topmost track can be emptied before SV2's own
// audio→notes transcription dumps its result there. The rule the op was built
// around is ORDER: mount the new reference on the destination FIRST, and only
// then remove the old one — the reverse order loses the group outright if
// addGroupReference fails. Test (c) pins that with a fake host that can fail the
// add on demand.
//
// ⚠️ Only the DESTINATION half of a successful move is asserted. The source half
//    is currently BROKEN (it removes the reference at the source TRACK's index
//    instead of the reference's own index), which is reported as a live NOTE by
//    documentLimitations() and documented in README.md. See that note for the
//    minimal reproduction; when the bridge is fixed, promote it to an assertion
//    here (track 0 must keep the Main reference, track 1 must hold exactly the
//    moved one).
function testGroupMove() {
  const c = checks()

  // (a) moving a group to the track it is already on is a no-op
  resetWorld()
  req('track_ops', { action: 'add', name: 'Target' })
  const w = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 72, lyrics: 'x' }] })
  c.eq('(a) write_notes ok', w.ok, true)
  c.eq('(a) track 0 carries 2 references', callGlobal(L, '__T_trackRefCount', [0]), 2)
  c.eq('(a) track 1 is empty', callGlobal(L, '__T_trackRefCount', [1]), 0)
  callGlobal(L, '__T_useGroupAt', [2])

  const b0 = snap()
  const b = req('group_ops', { action: 'move', targetTrackIndex: 0 })
  c.eq('(a) ok', b.ok, true)
  c.eq('(a) moved:false', b.result.moved, false)
  c.ok('(a) it explains why', typeof b.result.note === 'string' && b.result.note.length > 0, b.result.note)
  sameSnap(c, '(a) a same-track move writes nothing', b0)

  // (b) the MAIN group belongs to the host and cannot be moved
  resetWorld()
  req('track_ops', { action: 'add', name: 'Target' })
  const b1 = snap()
  const d = req('group_ops', { action: 'move', targetTrackIndex: 1 })
  c.eq('(b) the main group is refused', d.ok, false)
  c.ok('(b) the error says it is the host\'s own group',
    typeof d.error === 'string' && d.error.includes('主组'), d.error)
  sameSnap(c, '(b) nothing moved', b1)
  c.eq('(b) the main reference is still on track 0', callGlobal(L, '__T_trackRefCount', [0]), 1)

  // (c) a FAILING addGroupReference must leave the source reference intact —
  //     this is the whole reason the two steps are in that order.
  resetWorld()
  req('track_ops', { action: 'add', name: 'Target' })
  const wc = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 72, lyrics: 'x' }] })
  callGlobal(L, '__T_useGroupAt', [2])
  const beforeFail = snap()
  callGlobal(L, '__T_failAddGroupReference', [true])
  const e = req('group_ops', { action: 'move', targetTrackIndex: 1 })
  c.eq('(c) the move fails', e.ok, false)
  c.ok('(c) the error names addGroupReference',
    typeof e.error === 'string' && e.error.includes('addGroupReference'), e.error)
  c.eq('(c) the source reference is STILL THERE (the group was not lost)',
    callGlobal(L, '__T_trackRefCount', [0]), 2)
  c.eq('(c) the destination gained nothing', callGlobal(L, '__T_trackRefCount', [1]), 0)
  c.eq('(c) the group is still in the library with its note',
    JSON.stringify(notesOf(groupsOf().find((g) => g[1] === wc.result.groupUUID)).map((n) => n[3])),
    JSON.stringify([72]))
  callGlobal(L, '__T_failAddGroupReference', [false])
  sameSnap(c, '(c) and the arrangement is byte-identical', beforeFail)

  // (d) a successful move: the DESTINATION really gains a reference to THIS
  //     group, and the group keeps its notes (see the caveat above).
  resetWorld()
  req('track_ops', { action: 'add', name: 'Target' })
  const w2 = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 72, lyrics: 'x' }] })
  callGlobal(L, '__T_useGroupAt', [2])
  // 源轨移动前有 2 个引用:下标 0 是主组,下标 1 是刚写进去的组
  const mainUuid = at(groupsOf(), 0)[1]
  c.eq('(d) setup: the source track holds the Main group + ours',
    callGlobal(L, '__T_trackRefCount', [0]), 2)
  const m = req('group_ops', { action: 'move', targetTrackIndex: 1 })
  c.eq('(d) ok', m.ok, true)
  c.eq('(d) moved', m.result.moved, true)
  c.eq('(d) fromTrackIndex', m.result.fromTrackIndex, 0)
  c.eq('(d) toTrackIndex', m.result.toTrackIndex, 1)
  c.eq('(d) noteCount', m.result.noteCount, 1)
  c.eq('(d) dstGroupCount', m.result.dstGroupCount, 1)
  c.eq('(d) the destination carries a reference to THIS group',
    callGlobal(L, '__T_refTargets', [1]), w2.result.groupUUID)
  c.eq('(d) the group survived in the library with its notes',
    JSON.stringify(notesOf(groupsOf().find((g) => g[1] === w2.result.groupUUID)).map((n) => n[3])),
    JSON.stringify([72]))

  // ⚠️ **源轨那一半** —— 这两条是 0.6.6 那个严重 bug 的回归守卫。
  //    当时 `move` 用**源轨的工程下标**去调 removeGroupReference(要的是**引用**的下标),
  //    于是:被移动的组**同时挂在两条轨上**(重复发声),而源轨第 N 个引用被误删 ——
  //    常常就是主组,主组从编排里消失。只断言目标轨那一半是抓不到的。
  c.eq('(d) the source track no longer references the moved group (0.6.6 regression)',
    callGlobal(L, '__T_refTargets', [0]), mainUuid)
  c.eq('(d) the source track kept exactly one reference — the Main group',
    callGlobal(L, '__T_trackRefCount', [0]), 1)
  c.done('40', TESTS[40][1])
}

// ---------------------------------------------------------------------------
// test 41 — directory candidates: Windows / macOS / empty env
// ---------------------------------------------------------------------------
// The bridge used to read only USERPROFILE / TEMP / TMP. macOS sets neither of
// those (it sets HOME / TMPDIR), so the candidate list came out EMPTY and the
// bridge died with "no writable channel dir" — while the DSH plugin had happily
// created ~/.dsh/sv-bridge via os.homedir(). dirCandidates() takes an injected
// getenv, so this test runs — and therefore guards macOS — on every platform,
// including the Windows CI job.
function testDirCandidates() {
  const c = checks()

  const win = JSON.parse(callGlobal(L, '__T_dircands', ['win']))
  c.eq('win: two candidates', win.length, 2)
  c.eq('win: home first (USERPROFILE)', win[0], 'C:\\Users\\u\\.dsh\\sv-bridge')
  c.eq('win: temp second (TEMP)', win[1], 'C:\\Temp\\dsh-sv-bridge')

  const mac = JSON.parse(callGlobal(L, '__T_dircands', ['mac']))
  c.eq('mac: two candidates (not zero)', mac.length, 2)
  c.eq('mac: HOME is honoured', mac[0], '/Users/u/.dsh/sv-bridge')
  c.eq('mac: TMPDIR is honoured', mac[1], '/var/folders/t/dsh-sv-bridge')

  const none = JSON.parse(callGlobal(L, '__T_dircands', ['empty']))
  c.eq('empty env ⇒ no candidates (fatal, never a wrong guess)', none.length, 0)

  c.done('41', TESTS[41][1])
}

// ---------------------------------------------------------------------------
// test 42 — snapshot / restore (rollback)
// ---------------------------------------------------------------------------
// Every write op is irreversible: the batch discipline guarantees "never writes
// something broken", not "never writes the wrong thing". This pins the safety
// net, including the two shapes that actually bite — restoring a DELETED note
// (needs create+addNote, and addNote inserts by onset) and rolling back after
// the user has already switched to a different group (must locate by UUID).
function testSnapshotRestore() {
  const c = checks()
  resetWorld()
  callGlobal(L, '__T_snapReset')
  const A0 = callGlobal(L, '__T_notesState')
  const N = callGlobal(L, '__T_noteCount')

  // (a) nothing to roll back yet ⇒ refuse, do not guess
  const a = req('restore', {})
  c.eq('(a) restore with no snapshot is refused', a.ok, false)
  c.ok('(a) the error says there is nothing to roll back',
    /没有任何快照/.test(a.error || ''), a.error)

  // (b) snapshot captures the group and lands on disk
  const b = req('snapshot', { label: 'unit' })
  c.eq('(b) snapshot ok', b.ok, true)
  c.eq('(b) first id', b.result && b.result.id, 's1')
  c.eq('(b) noteCount', b.result && b.result.noteCount, N)
  c.ok('(b) the snapshot file exists', callGlobal(L, '__T_snapRaw').length > 0)
  c.ok('(b) the reply states what is NOT covered (no over-promising)',
    /属性层/.test((b.result && b.result.notCovered) || ''), b.result && b.result.notCovered)

  // (c) a host-side edit (pitch + time range) is undone by restore
  callGlobal(L, '__T_setPitch', [1, 71])
  callGlobal(L, '__T_setNoteRangeQuarter', [2, 0.5, 0.25])
  c.ok('(c) the edit really changed the group', callGlobal(L, '__T_notesState') !== A0)
  const r1 = req('restore', {})
  c.eq('(c) restore ok', r1.ok, true)
  c.eq('(c) no read-back mismatch', r1.result && r1.result.mismatchCount, 0)
  c.eq('(c) the group is back to the snapshot', callGlobal(L, '__T_notesState'), A0)

  // (d) a deleted note comes back (create + addNote path)
  const fp = req('get_notes', {}).result.groupFp
  const d = req('delete_notes', { indices: [1], expectGroupFp: fp })
  c.eq('(d) delete_notes ok', d.ok, true)
  c.eq('(d) one note fewer', callGlobal(L, '__T_noteCount'), N - 1)
  const r2 = req('restore', {})
  c.eq('(d) restore brought the note back', callGlobal(L, '__T_noteCount'), N)
  c.eq('(d) content matches the snapshot', callGlobal(L, '__T_notesState'), A0)

  // (e) two splits add two notes; restore removes BOTH extras.
  // Two extras on purpose: with a single extra, ascending and descending removal
  // happen to agree, so the direction bug would stay invisible (the mutant
  // `restore-remove-ascending` exists to keep that honest).
  const fp2 = req('get_notes', {}).result.groupFp
  const e = req('split_notes', { splits: [{ index: 0, atQuarter: 0.5 }], expectGroupFp: fp2 })
  c.eq('(e) first split ok', e.ok, true)
  const fp3 = req('get_notes', {}).result.groupFp
  const e2 = req('split_notes', { splits: [{ index: 2, atQuarter: 1.5 }], expectGroupFp: fp3 })
  c.eq('(e) second split ok', e2.ok, true)
  c.eq('(e) two notes more', callGlobal(L, '__T_noteCount'), N + 2)
  const r3 = req('restore', {})
  c.eq('(e) restore removed both extra notes', callGlobal(L, '__T_noteCount'), N)
  c.eq('(e) content matches the snapshot', callGlobal(L, '__T_notesState'), A0)

  // (f) the user switched to another group ⇒ locate the snapshot's group by UUID
  const g2 = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 72 }] })
  c.eq('(f) a second group exists', g2.ok, true)
  callGlobal(L, '__T_useGroupAt', [2])
  const B0 = JSON.stringify(req('get_notes', {}).result.notes)
  callGlobal(L, '__T_setPitch', [1, 55])       // mutate group A behind the bridge's back
  const r4 = req('restore', {})
  c.eq('(f) located by uuid, not by "current group"', r4.result && r4.result.locatedBy, 'uuid')
  c.eq('(f) group A is restored', callGlobal(L, '__T_notesState'), A0)
  c.eq('(f) the current group (B) was NOT touched',
    JSON.stringify(req('get_notes', {}).result.notes), B0)
  callGlobal(L, '__T_useGroupAt', [1])

  // (g) unknown id / corrupt snapshot ⇒ refuse, and say why
  const g = req('restore', { id: 's99' })
  c.eq('(g) an unknown id is refused', g.ok, false)
  c.ok('(g) the error lists the ids that do exist', /s1/.test(g.error || ''), g.error)
  callGlobal(L, '__T_snapWrite', ['{"seq":1,"items":[{"id":"s1","notes":"not-an-array"}]}'])
  const h = req('restore', {})
  c.eq('(h) a corrupt snapshot is refused', h.ok, false)
  c.ok('(h) the message names the damage', /损坏/.test(h.error || ''), h.error)

  c.done('42', TESTS[42][1])
}

// ---------------------------------------------------------------------------
// test 43 — selftest: the full-chain self check
// ---------------------------------------------------------------------------
function testSelftest() {
  const c = checks()
  resetWorld()
  const r = req('selftest', {})
  c.eq('selftest ok', r.ok, true)
  const res = r.result || {}
  c.eq('overall ok', res.ok, true)
  c.eq('bridge version matches the module', res.bridge, callGlobal(L, '__T_version'))

  const names = (res.checks || []).map((x) => x.name)
  for (const need of ['dir', 'write', 'atomic-overwrite', 'remove', 'heartbeat',
                      'log', 'timer', 'ticks', 'host', 'project', 'snapshot-store']) {
    c.ok(`check present: ${need}`, names.includes(need), names.join(','))
  }
  c.ok('every check passed',
    (res.checks || []).every((x) => x.ok === true),
    JSON.stringify((res.checks || []).filter((x) => !x.ok)))
  c.eq('opCount counts every registered op', res.opCount,
    callGlobal(L, '__T_opnames').split(',').length)
  c.ok('the probe file is cleaned up afterwards',
    !fs.existsSync(path.join(BRIDGE_DIR, 'svdsh-selftest.tmp')))
  c.done('43', TESTS[43][1])
}

// ---------------------------------------------------------------------------
// test 44 — snapshot / restore: the GROUP-level layout
// ---------------------------------------------------------------------------
// 0.8.0 的快照只覆盖音符层,于是 `write_notes` 建出来的组、`group_ops delete` 摘掉的引用、
// `move` 挪到别的轨的组**都回滚不掉**(返回里如实写着"不含组的增删")。0.8.3 把
// **编排布局**(每条轨的引用清单)也存进快照。这个测试钉住四种变化 + 两条纪律:
//   新建 → 摘掉 · 删除 → 挂回来(靠组库按 UUID 找回孤儿组)· 移动 → 挪回来 · 几何 → 改回来;
//   主组**绝不被碰** · 旧版快照要如实说"做不了",不能假装回滚了。
function testSnapshotLayout() {
  const c = checks()
  resetWorld()
  callGlobal(L, '__T_snapReset')

  // ⚠️ 快照里 refs[i][0] 是**1 起**的轨下标(桥对外的索引是 0 起,这里只是测试装置的表示)
  const refsOn = (t) => refsOf().filter((r) => r[0] === t + 1)
  const mainUuid = () => (groupsOf().find((g) => g[0] === 'Main') || [])[1]

  // (a) 快照要带上布局
  const a = req('snapshot', { label: 'layout' })
  c.eq('(a) snapshot ok', a.ok, true)
  c.ok('(a) 记了轨数与引用数', a.result.refCount >= 1 && a.result.trackCount >= 1, a.result)
  c.ok('(a) covers 写明包含"编排布局"', /编排布局/.test(a.result.covers || ''), a.result.covers)
  c.ok('(a) notCovered 不再声称"不含组的增删"',
    !/组的新建与删除/.test(a.result.notCovered || ''), a.result.notCovered)

  // (b) 新建的组:回滚把它从轨上摘掉
  const b1 = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 72 }] })
  c.eq('(b) write_notes 建了新组', b1.ok, true)
  c.eq('(b) 轨上现在两个引用', refsOn(0).length, 2)
  const b2 = req('restore', {})
  c.eq('(b) restore ok', b2.ok, true)
  c.eq('(b) 新建的组被摘掉了', refsOn(0).length, 1)
  c.eq('(b) 报告里 removed=1', b2.result.layout.removed, 1)
  c.eq('(b) 顺序复原(没有残留)', b2.result.layout.orderRestored, true)
  c.eq('(b) 主组还在原位', refsOn(0)[0][2], mainUuid())

  // (c) 删掉的组:回滚把引用挂回来(靠**组库**按 UUID 找回那个孤儿组)
  const c1 = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 74 }] })
  c.ok('(c) 又建了一个组', c1.ok === true, c1.error || JSON.stringify(c1).slice(0, 160))
  c.ok('(c) 轨上又有了两个引用', refsOn(0).length === 2, JSON.stringify(refsOn(0)))
  const bUuid = refsOn(0)[1][2]
  c.ok('(c) 拿到了它的 UUID', typeof bUuid === 'string' && bUuid.length > 0, bUuid)
  req('snapshot', { label: 'two-groups' })
  callGlobal(L, '__T_useGroupAt', [2])
  const c2 = req('group_ops', { action: 'delete' })
  c.eq('(c) 删除成功', c2.ok, true)
  c.eq('(c) 轨上只剩主组', refsOn(0).length, 1)
  const c3 = req('restore', {})
  c.eq('(c) restore ok', c3.ok, true)
  c.eq('(c) 引用挂回来了', refsOn(0).length, 2)
  c.eq('(c) 挂回来的就是原来那个组(UUID 一致)', refsOn(0)[1][2], bUuid)
  c.eq('(c) 报告里 readded=1', c3.result.layout.readded, 1)
  c.eq('(c) 没有"找不回来"的', JSON.stringify(c3.result.layout.unrecoverable), '[]')
  callGlobal(L, '__T_useGroupAt', [1])

  // (d) 挪到别的轨:回滚把它挪回来
  //     ⚠️ 这条最容易被漏:组还在快照里(不是"多余"),但挂在错的轨上(也不是"缺失")
  //        ⇒ 只按"UUID 在不在快照里"判的话,谁都不会管它。写这个测试时才发现。
  const d0 = req('track_ops', { action: 'add', name: 'Harmony' })
  c.eq('(d) 加了第二条轨', d0.ok, true)
  req('snapshot', { label: 'before-move' })
  callGlobal(L, '__T_useGroupAt', [2])
  const d1 = req('group_ops', { action: 'move', targetTrackIndex: 1 })
  c.eq('(d) 移动成功', d1.ok, true)
  c.eq('(d) 轨 0 上只剩一个引用', refsOn(0).length, 1)
  c.eq('(d) 轨 1 上有了一个', refsOn(1).length, 1)
  const d2 = req('restore', {})
  c.eq('(d) restore ok', d2.ok, true)
  c.eq('(d) 挪回轨 0 了', refsOn(0).length, 2)
  c.eq('(d) 轨 1 空了', refsOn(1).length, 0)
  c.eq('(d) 报告里 moved=1', d2.result.layout.moved, 1)
  callGlobal(L, '__T_useGroupAt', [1])

  // (e) 几何:时间偏移改了要改回来
  const e0 = refsOn(0)[1][5]
  callGlobal(L, '__T_useGroupAt', [2])
  const e1 = req('group_ops', { action: 'offset', timeOffsetQuarter: 3 })
  c.eq('(e) 改了时间偏移', e1.ok, true)
  c.ok('(e) 真的变了', refsOn(0)[1][5] !== e0, refsOn(0)[1][5])
  const e2 = req('restore', {})
  c.eq('(e) restore ok', e2.ok, true)
  c.eq('(e) 偏移改回来了', refsOn(0)[1][5], e0)
  c.ok('(e) 报告里 geometry ≥ 1', e2.result.layout.geometry >= 1, e2.result.layout.geometry)
  callGlobal(L, '__T_useGroupAt', [1])

  // (f) 主组绝不被碰:从头到尾都在轨 0 的第 0 个位置、仍标记为主组
  c.eq('(f) 主组引用还在原位', refsOn(0)[0][2], mainUuid())
  c.eq('(f) 主组标记没变', refsOn(0)[0][7], 1)

  // (g) 旧版快照(没有 layout):如实说"做不了",而不是假装回滚了
  callGlobal(L, '__T_snapWrite', [JSON.stringify({
    seq: 1,
    items: [{ id: 's1', ts: 1, groupUuid: mainUuid(), groupName: 'Main', noteCount: 3, notes: [] }],
  })])
  const g = req('restore', {})
  c.eq('(g) restore ok(音符层照做)', g.ok, true)
  c.eq('(g) 布局那部分如实标为不可用', g.result.layout.available, false)
  c.ok('(g) 并且说清了原因', /没有编排布局/.test(g.result.layout.skipped || ''), g.result.layout.skipped)

  c.done('44', TESTS[44][1])
}

// ---------------------------------------------------------------------------
// beyond-spec observations (NOT tests): printed as NOTE, never as a failure
// ---------------------------------------------------------------------------

function documentLimitations() {

  // jenc encodes non-integral numbers with %.10g (test 1 is the W2 guard).
  // 10 significant digits is not bit-exact for every double, so record the real
  // boundary instead of pretending otherwise.
  try {
    const enc = callGlobal(L, '__T_jencNum', [1 / 3])
    const back = callGlobal(L, '__T_jdecNum', [enc])
    if (back !== 1 / 3) {
      note(
        'accepted limitation: jenc encodes non-integral numbers with %.10g, so a value needing more than 10 ' +
        `significant digits is not round-tripped bit-exactly (1/3 -> ${enc} -> ${back}). Integers and 16-digit ids ` +
        'stay exact (they take the %d / %.0f branches), and 10 digits is far more than onsetQuarter/durationQuarter ' +
        '(blick/705600000) need — test 1 pins a <=1e-9 relative error on exactly that conversion.')
    }
  } catch (e) {
    note(`limitation probe could not run: ${e.message}`)
  }

  // A rejected op should not touch the project AT ALL — including the undo
  // stack. Each op is probed separately (resetWorld() re-zeroes the counter) so
  // the note names exactly the ops that still do this. Both were bugs that have
  // since been fixed (group_ops offset in 0.5.3, select_notes in 0.6.0), so the
  // note normally does not print at all — it is a regression detector.
  try {
    const offenders = []

    resetWorld()
    let u0 = callGlobal(L, '__T_undo')
    const badOffset = req('group_ops', { action: 'offset', pitchOffset: 999 })
    if (badOffset.ok === false && callGlobal(L, '__T_undo') !== u0) {
      offenders.push('group_ops {action:"offset"} (pitchOffset out of range)')
    }

    resetWorld()
    u0 = callGlobal(L, '__T_undo')
    const badSel = req('select_notes', { action: 'indices', indices: [9] })
    if (badSel.ok === false && callGlobal(L, '__T_undo') !== u0) {
      offenders.push('select_notes {action:"indices"} (index out of range)')
    }

    if (offenders.length > 0) {
      note(`${offenders.length} op(s) call project:newUndoRecord() BEFORE validating: ` +
        `${offenders.join(', ')}. A rejected request writes no project data (tests 27 and 30 pin that), but it ` +
        "still pushes a no-op step onto the user's undo stack. Every other op validates before it touches the " +
        'project. (The 0.5.3 / 0.6.0 fix is the pattern: validate first, then newUndoRecord.)')
    }
  } catch (e) {
    note(`undo-record probe could not run: ${e.message}`)
  }

  // fengari's integers are 32-bit (see luaenv.mjs); integer arithmetic WRAPS.
  try {
    const wrapped = callGlobal(L, '__T_overflowProbe')
    if (wrapped !== '2822400000') {
      note('harness limitation: fengari integers are 32-bit, so integer arithmetic wraps above 2^31 ' +
        `(705600000*4 evaluates to ${wrapped} instead of 2822400000). Every offline test therefore keeps ` +
        'blick products below 2^31 (<= 3 quarter notes); behaviour at larger positions — long projects, ' +
        'write_notes past ~3 quarters, and the duration ceiling 705600000*64 in ATTR_WHITELIST — cannot be ' +
        'validated here and still needs the real host.')
    }
  } catch (e) {
    note(`integer-width probe could not run: ${e.message}`)
  }

  // A LIVE BUG PROBE (not a test, so the run still exits 0): group_ops move
  // removes the source reference using the SOURCE TRACK's project index instead
  // of the reference's index within that track, so it deletes the wrong
  // reference whenever the moved group is not the track's first one — and the
  // track's first reference is always the Main group, which may not be moved.
  // Result: the moved group is duplicated onto both tracks and the Main group
  // disappears from the arrangement. The probe reproduces that and names it;
  // once the bridge is fixed it goes silent on its own.
  try {
    resetWorld()
    req('track_ops', { action: 'add', name: 'Target' })
    const w = req('write_notes', { notes: [{ onset: 0, duration: 1, pitch: 72, lyrics: 'x' }] })
    callGlobal(L, '__T_useGroupAt', [2])
    const mainUuid = at(groupsOf(), 0)[1]
    const m = req('group_ops', { action: 'move', targetTrackIndex: 1 })
    if (w.ok === true && m.ok === true && m.result && m.result.moved === true) {
      const src = callGlobal(L, '__T_refTargets', [0])
      const dst = callGlobal(L, '__T_refTargets', [1])
      if (src.includes(w.result.groupUUID)) {
        note('BUG in group_ops {action:"move"} (DSHBridge.lua:2333 reads ' +
          'src:getIndexInParent(), DSHBridge.lua:2351 passes it to src:removeGroupReference): the ' +
          'source reference is removed by the SOURCE TRACK\'s 1-based project index, not by the ' +
          'reference\'s index within that track. Minimal reproduction: __T_resetWorld → track_ops add → ' +
          'write_notes → __T_useGroupAt(2) → group_ops {action:"move", targetTrackIndex:1}. Reported ' +
          `moved:true, but track 0 is now "${src}" (the moved group is STILL there and the Main ` +
          `reference "${mainUuid}" is GONE from the arrangement) while track 1 is "${dst}" — the group ` +
          'is duplicated and the main group vanished. Only a group that is the FIRST reference of the ' +
          'FIRST track escapes this, and that slot is always the unmovable Main group, so every legal ' +
          'move is affected. Fix: use the REFERENCE index (call(ref, "getIndexInParent")) for ' +
          'removeGroupReference and keep the track index for the same-track comparison — but first ' +
          'confirm on the real host which base Track:getIndexInParent() uses, because the same-track ' +
          'test (srcIdx == dstTi + 1) assumes 1-based. Test 40 therefore only asserts the destination ' +
          'half of a successful move; promote this probe to an assertion once the bridge is fixed.')
      }
    }
  } catch (e) {
    note(`group_ops move probe could not run: ${e.message}`)
  }

  // align_lyrics / align_audio depend on the HOST's seconds<->blick conversion,
  // which the fake models as piecewise-linear over its own tempo marks. The whole
  // harness runs at 120 bpm (1 quarter = 0.5 s); if the fake's model ever drifts,
  // every LRC / audio expectation above becomes meaningless, so check it live.
  try {
    resetWorld()
    const rt = JSON.parse(callGlobal(L, '__T_secondsRoundTrip', [QUARTER]))
    if (rt.sec !== 0.5 || rt.blick !== QUARTER) {
      note('fake-host seconds<->blick model changed: 1 quarter now reads as ' +
        `${rt.sec}s and 0.5s converts to ${rt.blick} blicks (tests 35/37 assume 120 bpm ⇒ 1 quarter = ` +
        '0.5 s). Update their expected values, or the LRC / audio-anchor assertions are vacuous.')
    }
  } catch (e) {
    note(`seconds<->blick probe could not run: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const PLAN = [
  ['0', testSyntax],
  ['1', () => callGlobal(L, '__T1')],
  ['2', () => callGlobal(L, '__T2')],
  ['3', () => callGlobal(L, '__T3')],
  ['4', testBoot],
  ['5', testRead],
  ['6', testFingerprint],
  ['7', testMissingFp],
  ['8', testIdempotency],
  ['9', testUnknownOp],
  ['10', testMalformed],
  ['11', testAtomic],
  ['12', testFailsClosed],
  ['13', testNonIntegerAttrs],
  ['14', testWriteNotesMount],
  ['15', testGetNotes],
  ['16', testDeleteNotesGuards],
  ['17', testDeleteNotesBatch],
  ['18', testPitchControl],
  ['19', testGetComputed],
  ['20', testGetAutomation],
  ['21', testSetAutomationGuards],
  ['22', testCloseShapeWritesBoundary],
  ['23', testCloseShapeRestoresBaseline],
  ['24', testSetTempo],
  ['25', testSetMeter],
  ['26', testTransport],
  ['27', testGroupOps],
  ['28', testTrackOps],
  ['29', testNoteAttrsNewFields],
  ['30', testSelectNotes],
  ['31', testGetNoteAttrs],
  ['32', testSplitNotes],
  ['33', testGetLayout],
  ['34', testApplyLyrics],
  ['35', testAlignLyrics],
  ['36', testGetAudioTracks],
  ['37', testAlignAudio],
  ['38', testNoteAttrsLayer],
  ['39', testTrackOpsListOrder],
  ['40', testGroupMove],
  ['41', testDirCandidates],
  ['42', testSnapshotRestore],
  ['43', testSelftest],
  ['44', testSnapshotLayout],
]

function main() {
  if (!fs.existsSync(BRIDGE)) {
    console.error(`bridge not found: ${BRIDGE}`)
    process.exit(2)
  }

  setupDirs()
  setupLua()

  for (const [id, fn] of PLAN) {
    const name = TESTS.find((t) => t[0] === id)[1]
    try {
      fn()
    } catch (e) {
      record(id, false, `harness error: ${e.message}`)
    }
    if (!results.has(id)) record(id, false, 'test did not report a result')
  }

  documentLimitations()

  // ---- report ------------------------------------------------------------
  const w = (s, n) => String(s).padEnd(n)
  console.log('')
  console.log('DSH ⇄ SV2 bridge — offline harness (fengari Lua 5.3 + fake SV host)')
  console.log(`bridge: ${BRIDGE}`)
  console.log(`run dir: ${BRIDGE_DIR}`)
  console.log('')
  console.log(`${w('ID', 4)}${w('STATUS', 8)}${w('TEST', 46)}DETAIL`)
  console.log('-'.repeat(120))

  let failed = 0
  for (const [id, name] of TESTS) {
    const r = results.get(id) || { ok: false, detail: 'not run' }
    if (!r.ok) failed += 1
    console.log(`${w(id, 4)}${w(r.ok ? 'PASS' : 'FAIL', 8)}${w(name, 46)}${r.detail}`)
  }
  console.log('-'.repeat(120))
  console.log(`${TESTS.length - failed}/${TESTS.length} passed`)

  if (notes.length > 0) {
    console.log('')
    console.log('NOTE:')
    notes.forEach((x) => console.log(`  - ${x}`))
  }
  console.log('')

  process.exit(failed === 0 ? 0 : 1)
}

main()
