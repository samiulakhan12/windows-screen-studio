// Full-stack window recording: runs recording-window.e2e.cjs scenarios (a) and (b) with the
// app's REAL nativeCapture client driving a helper process (tests/fixtures/fake-capture-helper.cjs)
// over the real stdin/stdout protocol, instead of an in-process fake.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const r = spawnSync(process.execPath, [path.join(__dirname, 'recording-window.e2e.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, SSW_E2E_REAL_HELPER: '1' }
})
process.exit(r.status ?? 1)
