#!/usr/bin/env node
'use strict'
/*
 * A stand-in for ssw-ocr.exe for the end-to-end run of a crash in one read (docs/design/auto-blur.md
 * §17.3 A10). It runs the real helper (SSW_OCR_REAL) and passes every line both ways, until the first
 * process of it receives its SSW_OCR_CRASH_READ-th `read` (2 by default): then it ends at once with
 * exit code 3, as a crash inside that read would, and that read is never answered. Every later process
 * (the scan starts the helper once more) passes everything. Processes are counted in SSW_OCR_LOG.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const readline = require('node:readline')

const logFile = process.env.SSW_OCR_LOG
let processNo = 1
try {
  processNo = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('"start":true')).length + 1
} catch {
  // The first process.
}
if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ start: true, n: processNo })}\n`)
const crashAt = processNo === 1 ? Number(process.env.SSW_OCR_CRASH_READ || 2) : Infinity

const real = spawn(process.env.SSW_OCR_REAL, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] })
real.stdout.pipe(process.stdout)
real.on('exit', (code) => process.exit(code ?? 0))

let reads = 0
readline.createInterface({ input: process.stdin }).on('line', (text) => {
  let op = null
  try {
    op = JSON.parse(text).op
  } catch {
    // Passed on as it is: the real helper answers a bad line.
  }
  if (op === 'read' && ++reads === crashAt) {
    if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ crashed: true, n: processNo, read: reads })}\n`)
    real.kill('SIGKILL')
    process.exit(3)
  }
  real.stdin.write(`${text}\n`)
})
process.stdin.on('end', () => real.stdin.end())
