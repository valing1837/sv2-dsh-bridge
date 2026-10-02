// luaenv.mjs — the JS half of the offline Lua environment.
//
// Builds a fengari (Lua 5.3) state whose `io`/`os` are backed by the REAL
// filesystem, so the bridge's atomic-write / rename-overwrite / append paths
// are exercised for real instead of against an in-memory mock.
//
// fengari is CommonJS and its modules have load-order dependencies, so the whole
// package is loaded first and only then are internals reached into.
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const fengari = require('fengari')

// ---------------------------------------------------------------------------
// fengari deviation shim: integers
// ---------------------------------------------------------------------------
// fengari models Lua integers as 32-bit (LUA_MAXINTEGER = 2147483647) while
// Lua 5.3/5.4 — and therefore SV2's embedded Lua — uses 64-bit integers.
// Consequence without this shim: `string.format("%08x", h)` raises
// "number has no integer representation" for every h >= 2^31, which is ~50% of
// hash32() outputs, so selectionFp() would blow up and the harness would report
// a fake bridge bug.
//
// lapi.lua_tointegerx() resolves `lvm.tointeger` at call time, so overriding it
// restores 64-bit-like %d/%x/%o semantics without touching the bridge.
const lvm = require('fengari/src/lvm.js')
const origToInteger = lvm.tointeger
lvm.tointeger = function (o) {
  const v = origToInteger(o)
  if (v !== false) return v
  if (o && typeof o.ttisfloat === 'function' && o.ttisfloat()) {
    const n = o.value
    if (typeof n === 'number' && Number.isInteger(n) && Math.abs(n) < 9007199254740992) return n
  }
  return false
}

export const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari

const LUA_OK = lua.LUA_OK

// ---------------------------------------------------------------------------
// stack marshalling helpers
// ---------------------------------------------------------------------------

export function createState() {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  return L
}

function pushValue(L, v) {
  if (v === null || v === undefined) lua.lua_pushnil(L)
  else if (typeof v === 'boolean') lua.lua_pushboolean(L, v)
  else if (typeof v === 'number') {
    // Integral args become Lua integers (like a real host call would); fengari's
    // integer model is 32-bit, so anything larger is pushed as a float.
    if (Number.isInteger(v) && Math.abs(v) <= 2147483647) lua.lua_pushinteger(L, v)
    else lua.lua_pushnumber(L, v)
  } else lua.lua_pushstring(L, to_luastring(String(v)))
}

function topValue(L) {
  const t = lua.lua_type(L, -1)
  switch (t) {
    case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, -1)
    case lua.LUA_TNUMBER: return lua.lua_tonumber(L, -1)
    case lua.LUA_TSTRING: return lua.lua_tojsstring(L, -1)
    case lua.LUA_TNIL:
    case lua.LUA_TNONE: return null
    default: return `<${lua.lua_typename(L, t)}>`
  }
}

/** Call a Lua global by name; throws a JS Error when the Lua side errors. */
export function callGlobal(L, name, args = []) {
  const base = lua.lua_gettop(L)
  lua.lua_getglobal(L, to_luastring(name))
  for (const a of args) pushValue(L, a)
  const st = lua.lua_pcall(L, args.length, 1, 0)
  if (st !== LUA_OK) {
    const msg = lua.lua_tojsstring(L, -1)
    lua.lua_settop(L, base)
    throw new Error(`lua ${name}(): ${msg}`)
  }
  const v = topValue(L)
  lua.lua_settop(L, base)
  return v
}

/** Load and run a chunk; `name` shows up in Lua error messages. */
export function runChunk(L, name, source) {
  const st = lauxlib.luaL_loadbuffer(L, to_luastring(source), null, to_luastring(`@${name}`))
  if (st !== LUA_OK) {
    const msg = lua.lua_tojsstring(L, -1)
    lua.lua_settop(L, 0)
    throw new Error(`load ${name}: ${msg}`)
  }
  const st2 = lua.lua_pcall(L, 0, 0, 0)
  if (st2 !== LUA_OK) {
    const msg = lua.lua_tojsstring(L, -1)
    lua.lua_settop(L, 0)
    throw new Error(`run ${name}: ${msg}`)
  }
}

/** Register a JS callback as a Lua global. */
export function setGlobalFunction(L, name, fn) {
  lua.lua_pushcfunction(L, fn)
  lua.lua_setglobal(L, to_luastring(name))
}

// ---------------------------------------------------------------------------
// io over the real filesystem
// ---------------------------------------------------------------------------

const IO_GLUE = String.raw`
-- io.open backed by the real filesystem. JS provides __fs_open/__fs_read/
-- __fs_write/__fs_close (see luaenv.mjs); the handle shape below is what the
-- bridge (and the SV host) expose: f:read(fmt) / f:write(s) / f:close().
io = {}
function io.open(path, mode)
  local id, err = __fs_open(path, mode or "r")
  if id == nil then return nil, err end
  local h = { __id = id }
  function h:read(fmt) return __fs_read(self.__id, fmt) end
  function h:write(s) __fs_write(self.__id, s); return self end
  function h:close() __fs_close(self.__id); return true end
  return h
end
function io.type(f)
  if type(f) == "table" and f.__id ~= nil then return "file" end
  return nil
end
`

function installFs(L) {
  const handles = new Map()
  let nextId = 1

  const checkStr = (L, i) => to_jsstring(lauxlib.luaL_checkstring(L, i))
  const fail = (L, msg) => { lua.lua_pushnil(L); lua.lua_pushstring(L, to_luastring(msg)); return 2 }

  const fs_open = (L) => {
    const p = checkStr(L, 1)
    const mode = lua.lua_isnoneornil(L, 2) ? 'r' : checkStr(L, 2)
    const flags = { r: 'r', rb: 'r', w: 'w', wb: 'w', a: 'a', ab: 'a', 'r+': 'r+' }[mode]
    if (!flags) return fail(L, `invalid mode '${mode}'`)
    try {
      const fd = fs.openSync(p, flags)
      const id = nextId++
      handles.set(id, { fd, pos: flags === 'a' ? fs.fstatSync(fd).size : 0 })
      lua.lua_pushinteger(L, id)
      return 1
    } catch (e) {
      return fail(L, `${p}: ${e.code || e.message}`)
    }
  }

  const readTail = (h) => {
    const size = fs.fstatSync(h.fd).size
    const len = Math.max(0, size - h.pos)
    const buf = Buffer.alloc(len)
    if (len > 0) fs.readSync(h.fd, buf, 0, len, h.pos)
    h.pos += len
    return buf
  }

  const pushBytes = (L, buf) => lua.lua_pushlstring(L, buf, buf.length)

  const fs_read = (L) => {
    const id = lua.lua_tointeger(L, 1)
    const h = handles.get(id)
    if (!h) return fail(L, 'attempt to use a closed file')
    const fmt = lua.lua_isnoneornil(L, 2) ? '*l' : checkStr(L, 2)
    if (fmt === '*a' || fmt === 'a') {
      pushBytes(L, readTail(h))
      return 1
    }
    if (fmt === '*l' || fmt === 'l' || fmt === '*L') {
      const start = h.pos
      const buf = readTail(h)
      const nl = buf.indexOf(0x0a)
      if (nl === -1 && buf.length === 0) { lua.lua_pushnil(L); return 1 }
      const line = nl === -1 ? buf : buf.subarray(0, nl)
      h.pos = start + (nl === -1 ? buf.length : nl + 1)
      pushBytes(L, line)
      return 1
    }
    const n = /^\d+$/.test(fmt) ? Number(fmt) : null
    if (n !== null) {
      const size = fs.fstatSync(h.fd).size
      const len = Math.min(n, Math.max(0, size - h.pos))
      if (len === 0) { lua.lua_pushnil(L); return 1 }
      const buf = Buffer.alloc(len)
      fs.readSync(h.fd, buf, 0, len, h.pos)
      h.pos += len
      pushBytes(L, buf)
      return 1
    }
    return fail(L, `invalid format '${fmt}'`)
  }

  const fs_write = (L) => {
    const id = lua.lua_tointeger(L, 1)
    const h = handles.get(id)
    if (!h) return fail(L, 'attempt to use a closed file')
    const s = lauxlib.luaL_checkstring(L, 2)
    const buf = Buffer.from(s)
    try {
      fs.writeSync(h.fd, buf, 0, buf.length, null)
    } catch (e) {
      return fail(L, String(e.message || e))
    }
    h.pos = fs.fstatSync(h.fd).size
    lua.lua_pushboolean(L, true)
    return 1
  }

  const fs_close = (L) => {
    const id = lua.lua_tointeger(L, 1)
    const h = handles.get(id)
    if (h) {
      try { fs.closeSync(h.fd) } catch { /* already gone */ }
      handles.delete(id)
    }
    lua.lua_pushboolean(L, true)
    return 1
  }

  setGlobalFunction(L, '__fs_open', fs_open)
  setGlobalFunction(L, '__fs_read', fs_read)
  setGlobalFunction(L, '__fs_write', fs_write)
  setGlobalFunction(L, '__fs_close', fs_close)
  runChunk(L, 'io-glue', IO_GLUE)
}

// ---------------------------------------------------------------------------
// os.getenv
// ---------------------------------------------------------------------------

/**
 * Replace os.getenv with a lookup into `env` (a plain JS object).
 * os.time / os.date / os.remove / os.rename keep fengari's real-fs behaviour.
 */
function installOsEnv(L, env) {
  lua.lua_getglobal(L, to_luastring('os'))
  lua.lua_pushcfunction(L, (L) => {
    const key = to_jsstring(lauxlib.luaL_checkstring(L, 1))
    if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined && env[key] !== null) {
      lua.lua_pushstring(L, to_luastring(String(env[key])))
    } else {
      lua.lua_pushnil(L)
    }
    return 1
  })
  lua.lua_setfield(L, -2, to_luastring('getenv'))
  lua.lua_pop(L, 1)
}

// ---------------------------------------------------------------------------

export function installEnvironment(L, env) {
  installFs(L)
  installOsEnv(L, env)
}

/** Register `__report(id, name, ok, detail)` as a Lua global. */
export function installReporter(L, sink) {
  setGlobalFunction(L, '__report', (L) => {
    const id = to_jsstring(lauxlib.luaL_checkstring(L, 1))
    const name = to_jsstring(lauxlib.luaL_checkstring(L, 2))
    const ok = lua.lua_toboolean(L, 3)
    const detail = lua.lua_isnoneornil(L, 4) ? '' : lua.lua_tojsstring(L, 4)
    sink(id, name, ok, detail)
    return 0
  })
}
