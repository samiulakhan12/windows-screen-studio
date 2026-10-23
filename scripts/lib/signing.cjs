// Chooses how electron-builder signs the Windows build, from environment variables only,
// so adding a certificate later needs no config change (see docs/BUILDING.md):
//   pfx    CSC_LINK / WIN_CSC_LINK (+ CSC_KEY_PASSWORD / WIN_CSC_KEY_PASSWORD), read by electron-builder itself
//          (signtool on Windows, osslsigncode on Linux/macOS)
//   store  WIN_SIGN_CERT_SHA1 or WIN_SIGN_CERT_SUBJECT: a certificate in the Windows store (USB token, cloud HSM)
//   azure  AZURE_TRUSTED_SIGNING_{ENDPOINT,ACCOUNT,PROFILE,PUBLISHER} (+ Microsoft Entra credentials)
// With none of them the build is unsigned, which still succeeds.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const AZURE_VARS = {
  endpoint: 'AZURE_TRUSTED_SIGNING_ENDPOINT',
  codeSigningAccountName: 'AZURE_TRUSTED_SIGNING_ACCOUNT',
  certificateProfileName: 'AZURE_TRUSTED_SIGNING_PROFILE',
  publisherName: 'AZURE_TRUSTED_SIGNING_PUBLISHER'
}

/** Mirrors electron-builder's CSC_LINK handling: https URL, base64 data, or a file path. */
function cscLinkFile(link, projectDir) {
  const value = link.trim()
  if (value.startsWith('https://') || /^data:.*;base64,/.test(value) || value.length > 2048 || value.endsWith('=')) return null
  let file = value
  if (file.startsWith('~/')) return path.join(os.homedir(), file.slice(2))
  if (file.startsWith('file://')) file = file.slice('file://'.length)
  return path.isAbsolute(file) ? file : path.resolve(projectDir, file)
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ platform?: string, projectDir?: string, exists?: (file: string) => boolean }} [options]
 * @returns {{ mode: 'unsigned' | 'pfx' | 'store' | 'azure', win: object, forceCodeSigning: boolean,
 *   errors: string[], warnings: string[], summary: string }}
 */
function resolveWindowsSigning(env, options = {}) {
  const { platform = process.platform, projectDir = process.cwd(), exists = fs.existsSync } = options
  const has = (name) => typeof env[name] === 'string' && env[name].trim() !== ''
  const errors = []
  const warnings = []
  const required = env.SSW_REQUIRE_SIGNING === '1'
  const timestamp = has('WIN_SIGN_TIMESTAMP_URL') ? env.WIN_SIGN_TIMESTAMP_URL.trim() : undefined
  // SHA-256 only: Windows 10+ ignores SHA-1 Authenticode, and dual signing doubles the signing time.
  const signtool = {
    signingHashAlgorithms: ['sha256'],
    ...(timestamp ? { rfc3161TimeStampServer: timestamp, timeStampServer: timestamp } : {})
  }

  const azureSet = Object.values(AZURE_VARS).filter(has)
  const configured = []
  if (azureSet.length) configured.push('azure')
  if (has('CSC_LINK') || has('WIN_CSC_LINK')) configured.push('pfx')
  if (has('WIN_SIGN_CERT_SHA1') || has('WIN_SIGN_CERT_SUBJECT')) configured.push('store')

  let mode = 'unsigned'
  let win = {}
  let summary = 'unsigned (no signing variables set; Windows SmartScreen will warn on first run)'

  if (configured.length > 1) {
    errors.push(`Several code-signing methods are configured (${configured.join(', ')}). Set the variables of only one.`)
  } else if (configured[0] === 'azure') {
    mode = 'azure'
    const missing = Object.values(AZURE_VARS).filter((name) => !has(name))
    if (missing.length) errors.push(`Azure Trusted Signing is partly configured; missing: ${missing.join(', ')}.`)
    if (platform !== 'win32') {
      errors.push('Azure Trusted Signing runs only on a Windows build machine (it uses the TrustedSigning PowerShell module and SignTool).')
    }
    const entra =
      has('AZURE_TENANT_ID') &&
      has('AZURE_CLIENT_ID') &&
      (has('AZURE_CLIENT_SECRET') || has('AZURE_CLIENT_CERTIFICATE_PATH') || (has('AZURE_USERNAME') && has('AZURE_PASSWORD')))
    if (!entra) {
      warnings.push(
        'No Microsoft Entra credentials in the environment (AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET); ' +
          'Invoke-TrustedSigning will try other sign-ins such as the Azure CLI or a managed identity.'
      )
    }
    const azureSignOptions = {}
    for (const [key, name] of Object.entries(AZURE_VARS)) if (has(name)) azureSignOptions[key] = env[name].trim()
    if (timestamp) azureSignOptions.timestampRfc3161 = timestamp
    win = { azureSignOptions }
    summary = `Azure Trusted Signing (account ${env[AZURE_VARS.codeSigningAccountName] ?? '?'}, profile ${env[AZURE_VARS.certificateProfileName] ?? '?'})`
  } else if (configured[0] === 'pfx') {
    mode = 'pfx'
    const linkVar = has('WIN_CSC_LINK') ? 'WIN_CSC_LINK' : 'CSC_LINK'
    const file = cscLinkFile(env[linkVar], projectDir)
    if (file && !exists(file)) errors.push(`${linkVar} points to ${file}, which does not exist.`)
    if (!has('WIN_CSC_KEY_PASSWORD') && !has('CSC_KEY_PASSWORD')) {
      warnings.push('CSC_KEY_PASSWORD is not set; the certificate will be opened with an empty password.')
    }
    if (platform === 'linux' && env.USE_SYSTEM_SIGNCODE !== 'true' && env.USE_SYSTEM_OSSLSIGNCODE !== 'true') {
      warnings.push(
        "electron-builder's bundled osslsigncode needs OpenSSL 1.1 (libcrypto.so.1.1), which current Linux " +
          'distributions lack. If signing fails with that error, install osslsigncode and set USE_SYSTEM_SIGNCODE=true.'
      )
    }
    win = { signtoolOptions: signtool }
    summary = `certificate file from ${linkVar}${file ? ` (${path.basename(file)})` : ''}`
  } else if (configured[0] === 'store') {
    mode = 'store'
    if (platform !== 'win32') {
      errors.push('WIN_SIGN_CERT_SHA1 / WIN_SIGN_CERT_SUBJECT select a certificate from the Windows certificate store, so they work only on Windows.')
    }
    const sha1 = has('WIN_SIGN_CERT_SHA1') ? env.WIN_SIGN_CERT_SHA1.replace(/\s+/g, '') : undefined
    const subject = has('WIN_SIGN_CERT_SUBJECT') ? env.WIN_SIGN_CERT_SUBJECT.trim() : undefined
    win = { signtoolOptions: { ...signtool, ...(sha1 ? { certificateSha1: sha1 } : { certificateSubjectName: subject }) } }
    summary = `certificate from the Windows store (${sha1 ? `SHA-1 ${sha1}` : `subject "${subject}"`})`
  }

  if (required && mode === 'unsigned') {
    errors.push('SSW_REQUIRE_SIGNING=1 but no code-signing method is configured (see docs/BUILDING.md).')
  }
  return { mode, win, forceCodeSigning: required, errors, warnings, summary }
}

/**
 * electron-builder's CLI loads electron-builder.env from the project folder before it reads the
 * config (without overriding variables already set). predist does the same so that both see the
 * same signing variables. Returns the names that were added to `env`.
 */
function loadBuilderEnv(projectDir, env = process.env) {
  let text
  try {
    text = fs.readFileSync(path.join(projectDir, 'electron-builder.env'), 'utf8')
  } catch {
    return []
  }
  const added = []
  for (const [name, value] of Object.entries(require('node:util').parseEnv(text))) {
    if (Object.prototype.hasOwnProperty.call(env, name)) continue
    env[name] = value
    added.push(name)
  }
  return added
}

module.exports = { resolveWindowsSigning, loadBuilderEnv, cscLinkFile, AZURE_VARS }
