--[[
DSH ⇄ SV2 能力探针(菜单脚本)  v0.1.0
================================================================================
用途:在**不改动工程**的前提下,一次性把「新桥能不能这么写」依赖的几个假设验掉。
     结果写到 %TEMP%\dsh-sv-probe.json,并弹一个摘要框。

用法:
  1. 复制到 %APPDATA%\Dreamtonics\Synthesizer V Studio 2\scripts\DSH\
  2. 宿主里 [脚本] > [重新扫描]
  3. 先打开侧栏的「DSH 面板探针」(可选,验面板沙箱),再运行本脚本

为什么单独写成一个脚本而不是塞进常驻桥:
  Lua 绑定的错误**穿透 pcall、直接弹模态脚本错误框**,而模态框会冻住主线程。
  所以「探测」这件事只能在**一次性脚本**里做,绝不能留在常驻桥里。

设计纪律(全部来自参考实现的实测教训):
  · 只读字段(type(x.y))是安全的;调用未知成员**不是**。
  · 任何一步都用 pcall 包住,并且**报告失败而不是让脚本死掉**。
  · 不写工程、不建撤销点、不弹同步对话框(除了最后那个摘要)。
================================================================================
]]

local PROBE_VERSION = "0.1.0"
local OUT_NAME = "dsh-sv-probe.json"

-- ---------------------------------------------------------------- 小工具

local function safe(fn)
  local ok, v = pcall(fn)
  if not ok then return "<error: " .. tostring(v) .. ">" end
  return v
end

local function typename(v)
  return type(v)
end

-- 极简 JSON 编码器。⚠️ 大整数必须走 %d / %.0f:
--    参考实现曾用 %.14g 把 16 位 seq 写成 1.78917538422e+15,丢末位后
--    客户端按 seq 匹配**永远失败**,而桥日志一切正常(排查了很久)。
local function enc(v)
  local tv = type(v)
  if v == nil then return "null" end
  if tv == "boolean" then return v and "true" or "false" end
  if tv == "number" then
    if math.type and math.type(v) == "integer" then return string.format("%d", v) end
    if v == math.floor(v) and math.abs(v) < 9007199254740992 then
      return string.format("%.0f", v)
    end
    return string.format("%.6g", v)
  end
  if tv == "string" then
    local s = v:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n")
    s = s:gsub("\r", "\\r"):gsub("\t", "\\t")
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
      for i = 1, #v do parts[#parts + 1] = enc(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, val in pairs(v) do
      parts[#parts + 1] = enc(tostring(k)) .. ":" .. enc(val)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return enc(tostring(v))
end

local function tempDir()
  local d = os.getenv and (os.getenv("TEMP") or os.getenv("TMP"))
  if d and #d > 0 then return d end
  local u = os.getenv and os.getenv("USERPROFILE")
  if u and #u > 0 then return u end
  return "."
end

-- ---------------------------------------------------------------- 探测项

-- ① 文件能力:桥的命脉。只调用**已知安全**的成员。
local function probeFile()
  local r = {
    hasIoTable = typename(io) == "table",
    ioOpen = typename(io and io.open),
    ioLines = typename(io and io.lines),
    ioPopen = typename(io and io.popen),   -- ⚠️ 只报类型,绝不调用
    ioRead = typename(io and io.read),
    osExecute = typename(os and os.execute), -- ⚠️ 同上
    osTmpname = typename(os and os.tmpname),
    osRemove = typename(os and os.remove),
    osRename = typename(os and os.rename),
    osDate = typename(os and os.date),
    osTime = typename(os and os.time),
    osGetenv = typename(os and os.getenv),
  }
  r.temp = safe(tempDir)
  r.userProfile = safe(function() return os.getenv("USERPROFILE") end)

  -- 写 → 读回 → 改名 → 删除,四步都验一遍(桥全都要用)
  local dir = tempDir()
  local base = dir .. "\\dsh-sv-probe-wtest"
  r.writeOk = safe(function()
    local f = io.open(base .. ".txt", "w")
    if not f then return false end
    f:write("hello")
    f:close()
    return true
  end)
  r.readBackOk = safe(function()
    local f = io.open(base .. ".txt", "r")
    if not f then return false end
    local s = f:read("*a")
    f:close()
    return s == "hello"
  end)
  r.appendOk = safe(function()
    local f = io.open(base .. ".txt", "a")
    if not f then return false end
    f:write("+")
    f:close()
    local g = io.open(base .. ".txt", "r")
    local s = g and g:read("*a") or ""
    if g then g:close() end
    return s == "hello+"
  end)
  -- ⚠️ 关键:Windows 上 C 的 rename 在**目标已存在**时会失败 ⇒ 必须先删目标
  r.renameOverwriteOk = safe(function()
    local a, b = base .. ".txt", base .. ".dst"
    os.remove(b)
    if not os.rename(a, b) then return false end
    local f = io.open(a, "w"); if f then f:write("second"); f:close() end
    if os.rename(a, b) then return "overwrote" end
    os.remove(b)
    local ok = os.rename(a, b)
    return ok and "needs-remove-first" or false
  end)
  r.cleanupOk = safe(function()
    os.remove(base .. ".txt"); os.remove(base .. ".dst")
    os.remove(base .. ".txt.tmp")
    return true
  end)

  -- ② 目标目录是否已经存在、可写(桥不能 mkdir)
  local target = (r.userProfile or "") .. "\\.dsh\\sv-bridge"
  r.bridgeDirExists = safe(function()
    local f = io.open(target .. "\\probe.txt", "w")
    if not f then return false end
    f:close()
    os.remove(target .. "\\probe.txt")
    return true
  end)
  r.bridgeDirPath = target
  return r
end

-- ③ 宿主与运行时
local function probeHost()
  local r = {}
  r.lua = _VERSION
  r.svTable = typename(SV)
  r.svQuarter = safe(function() return SV.QUARTER end)
  r.setTimeoutField = typename(SV and SV.setTimeout)   -- 只读字段,不调用
  r.setIntervalField = typename(SV and SV.setInterval)

  local info = safe(function() return SV:getHostInfo() end)
  if type(info) == "table" then
    r.hostName = info.hostName
    r.hostVersion = info.hostVersion
    r.hostVersionNumber = info.hostVersionNumber
    r.osType = info.osType
    r.osName = info.osName
    r.languageCode = info.languageCode
  else
    r.hostInfoError = tostring(info)
  end
  return r
end

-- ④ 常驻桥需要的 API 是否都在(只看**存在性**,不试错调用)
local function probeApi()
  local r = {}
  local proj = safe(function() return SV:getProject() end)
  r.projectOk = type(proj) == "table" or typename(proj) == "userdata"
  if r.projectOk then
    r.getScriptData = typename(proj.getScriptData)
    r.setScriptData = typename(proj.setScriptData)
    r.newUndoRecord = typename(proj.newUndoRecord)
    r.getTimeAxis = typename(proj.getTimeAxis)
    r.getNumTracks = typename(proj.getNumTracks)
    -- scriptData 真的能写能读吗(参考实现实测面板里可写)
    r.scriptDataRoundTrip = safe(function()
      proj:setScriptData("svdsh.probe.menu", PROBE_VERSION)
      return proj:getScriptData("svdsh.probe.menu") == PROBE_VERSION
    end)
    -- 面板探针留下的结果(如果用户先开过侧栏探针)
    r.panelProbe = safe(function() return proj:getScriptData("svdsh.probe.panel") end)
  end
  local ed = safe(function() return SV:getMainEditor() end)
  r.mainEditorOk = (type(ed) == "table" or typename(ed) == "userdata")
  if r.mainEditorOk then
    r.getSelection = typename(ed.getSelection)
    r.getCurrentGroup = typename(ed.getCurrentGroup)
  end
  return r
end

-- ---------------------------------------------------------------- 主流程

function getClientInfo()
  return {
    -- 脚本名保持纯 ASCII:SidePanelSection 强制要求,菜单脚本也统一,
    -- 免得将来把它改成面板时再踩一次。中文只放在内容里。
    name = "DSH Probe",
    category = "DSH",
    author = "dsh-sv-bridge",
    versionNumber = 1,
    minEditorVersion = 65536,
  }
end

function main()
  local result = {
    probe = PROBE_VERSION,
    at = safe(function() return os.date("%Y-%m-%d %H:%M:%S") end),
    file = probeFile(),
    host = probeHost(),
    api = probeApi(),
  }

  local json = enc(result)
  local outPath = tempDir() .. "\\" .. OUT_NAME
  local written = safe(function()
    local f = io.open(outPath, "w")
    if not f then return false end
    f:write(json)
    f:close()
    return true
  end)
  result.written = written
  result.outPath = outPath

  -- 摘要框:只用**异步**版本,同步版会阻塞脚本
  local lines = {
    "探针 " .. PROBE_VERSION .. "  ·  " .. tostring(result.host.hostVersion or "?") ..
      "  ·  " .. tostring(result.host.lua or "?"),
    "写文件: " .. tostring(result.file.writeOk) ..
      "   读回: " .. tostring(result.file.readBackOk) ..
      "   追加: " .. tostring(result.file.appendOk),
    "io.popen: " .. tostring(result.file.ioPopen) ..
      "   os.execute: " .. tostring(result.file.osExecute),
    "rename 覆盖: " .. tostring(result.file.renameOverwriteOk),
    ".dsh\\sv-bridge 可写: " .. tostring(result.file.bridgeDirExists),
    "scriptData: " .. tostring(result.api.scriptDataRoundTrip),
    "面板探针: " .. tostring(result.api.panelProbe or "(未运行面板探针)"),
    "",
    written and ("已写入: " .. outPath) or "⚠️ 写入失败,请看 %TEMP%",
  }
  pcall(function()
    SV:showMessageBoxAsync("DSH 能力探针", table.concat(lines, "\n"))
  end)
end
