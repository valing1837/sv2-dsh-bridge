// Generic app.asar accessor for the DSH installation.
//
//   node asar.cjs list <relpath>            -> writes a directory listing
//   node asar.cjs read <relpath> [maxBytes] -> writes file text (or a byte range)
//   node asar.cjs grep <relpath> <regex>    -> writes matching lines of a text file
//
// Results are always written to reference/_asar-out.txt, because stdio capture
// of the Electron-as-node child is unreliable from PowerShell.
const fs = require('node:fs')
const path = require('node:path')

const ROOT =
  'C:/Users/huang/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh'
const OUT = 'C:/Users/huang/Desktop/deepseek harness/reference/_asar-out.txt'

const [mode, target, extra] = process.argv.slice(2)
let text = ''

const abs = (rel) => (rel ? `${ROOT}/${rel}` : ROOT)

try {
  if (mode === 'list') {
    const dir = abs(target)
    const lines = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) lines.push(`[dir ] ${entry.name}`)
      else lines.push(`[file] ${entry.name}  ${fs.statSync(full).size}`)
    }
    text = lines.join('\n')
  } else if (mode === 'read') {
    const max = extra ? Number(extra) : 0
    const buf = fs.readFileSync(abs(target))
    text = max > 0 ? buf.subarray(0, max).toString('utf8') : buf.toString('utf8')
  } else if (mode === 'grep') {
    const re = new RegExp(extra)
    const lines = fs.readFileSync(abs(target), 'utf8').split(/\r?\n/)
    const hits = []
    lines.forEach((line, index) => {
      if (re.test(line)) hits.push(`${index + 1}: ${line}`)
    })
    text = hits.join('\n') || '(no match)'
  } else {
    text = `unknown mode: ${mode}`
  }
} catch (error) {
  text = `ERROR: ${error.message}`
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, text)
