--[[
DSH ⇄ SV2 能力探针(侧栏面板版)  v0.1.0
================================================================================
用途:验一件对架构有决定性影响的事 ——
     **SidePanelSection 脚本到底能不能读写文件。**

背景(参考实现的实测结论,但只测过某一个宿主版本):
     · 普通菜单脚本的 Lua 环境里 io.open **可用**(文件通道成立的前提)。
     · 面板沙箱里 `io` 表**存在**、但 `io.open` **返回 nil** ⇒ 面板没有任何文件能力。
     · 面板里 **project scriptData 可写**(实测),定时器可用,refreshSidePanel 可用。
     ⇒ 所以架构上必须「桥(Lua,碰文件) + 面板(JS 或 Lua,只碰 scriptData)」两个脚本。

本探针就是把这个结论在**你这台机器的 SV2 2.3.0 上**重验一次。
结果写进 project scriptData 的 `svdsh.probe.panel` 键,由同目录的 `Probe.lua` 读走。

用法:复制到 scripts\DSH\ → [脚本] > [重新扫描] → 从侧栏打开本面板 → 再运行 Probe.lua
注意:面板脚本里**任何错误都会弹宿主对话框并中断脚本**,所以这里全部 pcall。
================================================================================
]]

local PANEL_VERSION = "0.1.0"
local KEY = "svdsh.probe.panel"

local RESULT = "(未运行)"
local DETAIL = ""

local function typename(v)
  return type(v)
end

local function probe()
  local bits = {}
  bits[#bits + 1] = "panel=" .. PANEL_VERSION
  bits[#bits + 1] = "lua=" .. tostring(_VERSION)
  bits[#bits + 1] = "io=" .. typename(io)
  bits[#bits + 1] = "io.open=" .. typename(io and io.open)
  bits[#bits + 1] = "os.getenv=" .. typename(os and os.getenv)
  bits[#bits + 1] = "SV=" .. typename(SV)
  bits[#bits + 1] = "setTimeout=" .. typename(SV and SV.setTimeout)

  -- ① 面板能不能写文件?(这是关键问题)
  local writeResult = "no-io"
  if type(io) == "table" and type(io.open) == "function" then
    local dir = "."
    pcall(function() dir = os.getenv("TEMP") or os.getenv("TMP") or "." end)
    local path = dir .. "\\dsh-panel-probe.tmp"
    local ok, r = pcall(function()
      local f = io.open(path, "w")
      if not f then return "io.open-returned-nil" end
      f:write("x")
      f:close()
      pcall(function() os.remove(path) end)
      return "wrote"
    end)
    writeResult = ok and r or ("error:" .. tostring(r))
  end
  bits[#bits + 1] = "fileWrite=" .. tostring(writeResult)

  -- ② 面板能不能读写 project scriptData?
  local sdResult = "no-project"
  local okSd, rSd = pcall(function()
    local proj = SV:getProject()
    if proj == nil then return "getProject-nil" end
    proj:setScriptData(KEY, table.concat(bits, " | "))
    local back = proj:getScriptData(KEY)
    return (back ~= nil) and "roundtrip-ok" or "read-back-nil"
  end)
  sdResult = okSd and rSd or ("error:" .. tostring(rSd))
  bits[#bits + 1] = "scriptData=" .. tostring(sdResult)

  -- ③ refreshSidePanel 是否存在(只读字段)
  bits[#bits + 1] = "refreshSidePanel=" .. typename(SV and SV.refreshSidePanel)

  RESULT = tostring(writeResult)
  DETAIL = table.concat(bits, " | ")

  -- 把完整结果再写一次(带上 scriptData 自检结论)
  pcall(function()
    SV:getProject():setScriptData(KEY, DETAIL)
  end)
end

pcall(probe)

function getClientInfo()
  return {
    -- ⚠️ SidePanelSection 的脚本名**必须是纯 ASCII**:含中文会被宿主直接拒绝加载
    --    (「SidePanelSection 脚本名称必须仅包含 ASCII 字符」)。
    --    中文只能出现在 Label 等**内容**里,不能出现在 name / title 里。
    name = "DSH Panel Probe",
    category = "DSH",
    author = "dsh-sv-bridge",
    versionNumber = 1,
    -- 官方要求侧栏面板 >= 131330(2.1.2);本机 SV2 2.3.0 满足。
    minEditorVersion = 131330,
    type = "SidePanelSection",
  }
end

-- ⚠️ 这个函数**必须永不抛错**(抛错会弹宿主对话框并中断脚本)
function getSidePanelSectionState()
  local rows = {}
  local ok = pcall(function()
    rows = {
      { type = "Label", text = "面板沙箱能力探针 v" .. PANEL_VERSION },
      { type = "Label", text = "文件写入: " .. RESULT },
      { type = "Label", text = "完整结果见 project scriptData 键: " .. KEY },
      { type = "Label", text = "然后运行菜单脚本「DSH Probe」汇总" },
    }
  end)
  if not ok then rows = { { type = "Label", text = "探针内部错误(已捕获)" } } end
  return { title = "DSH Panel Probe", rows = rows }
end
