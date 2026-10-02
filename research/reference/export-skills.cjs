// Export DSH plugin-development skills out of app.asar into the workspace.
// Run with: $env:ELECTRON_RUN_AS_NODE=1 ; & "<dsh exe>" export-skills.cjs
const fs = require('node:fs')
const path = require('node:path')

const BASE =
  'C:/Users/huang/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills'
const OUT = 'C:/Users/huang/Desktop/deepseek harness/reference/dsh-plugin-skills'

const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(full)
    else files.push(full)
  }
}

const report = []
try {
  walk(BASE)
  report.push(`scanned ${files.length} files`)
  for (const file of files) {
    const rel = file.slice(BASE.length + 1)
    const dest = path.join(OUT, rel)
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, fs.readFileSync(file))
      report.push(`OK   ${rel} [${fs.statSync(file).size}]`)
    } catch (error) {
      report.push(`FAIL ${rel} :: ${error.message}`)
    }
  }
} catch (error) {
  report.push(`FATAL ${error.message}`)
}
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, '_export-report.txt'), report.join('\n'))
process.stdout.write(report.join('\n') + '\n')
