// The 24 frames of the privacy evaluation set: 12 scenes, each in a dark and a light variant
// with its own content, at 100%, 125% or 150% display scale (every frame is 1920x1080 device
// pixels). make-eval-set.mjs renders them. See eval-lib.mjs for the markers.
import { O, P, QR, LISTED_NAMES, baseCss, browserChrome, esc, makeTokens, taskbar, toast } from './eval-lib.mjs'

const [PRIYA, TOMASZ, AISHA, JORDAN, MEI] = LISTED_NAMES
const N = (s) => P('name', s)

// ---------------------------------------------------------------------------------------------
// Code editor
function editorFrame(t, { file, tabs, tree, lines, font = 13, fontFamily = 'JetBrains Mono', selLines = [], status, wrap = true }) {
  const rows = lines
    .map((l, i) => `<div class="ln${selLines.includes(i) ? ' sel' : ''}"><span class="no">${i + 1}</span><span class="code">${l}</span></div>`)
    .join('')
  return {
    css: `
    .ed{position:absolute;inset:0;display:flex;flex-direction:column}
    .act{width:48px;background:${t.panel2}}
    .side{width:250px;background:${t.panel};font-size:13px;padding:8px 0;border-right:1px solid ${t.border}}
    .side div{padding:2px 16px;white-space:nowrap}
    .tabs{display:flex;background:${t.panel};height:35px;font-size:13px}
    .tabs div{padding:8px 16px;border-right:1px solid ${t.border};color:${t.dim}}
    .tabs .on{background:${t.bg};color:${t.text}}
    .crumb{font-size:12px;color:${t.dim};padding:3px 16px}
    .body{font-family:'${fontFamily}',monospace;font-size:${font}px;line-height:${Math.round(font * 1.5)}px;padding-top:4px;overflow:hidden}
    .ln{display:flex}.ln.sel{background:${t.sel}}
    .no{width:56px;text-align:right;padding-right:22px;color:${t.dim};flex:none;user-select:none}
    .code{white-space:${wrap ? 'pre-wrap' : 'pre'};word-break:break-all;flex:1;padding-right:24px}
    .k{color:${t.key}}.s{color:${t.str}}.c{color:${t.com}}.w{color:${t.kw}}.n{color:${t.num}}
    .hit{background:${t.hit};color:#000}
    .status{height:24px;background:${t.accent};color:#fff;font-size:12px;display:flex;gap:22px;align-items:center;padding:0 12px}
    `,
    html: `<div class="ed"><div class="titlebar"><span>File&nbsp;&nbsp;Edit&nbsp;&nbsp;Selection&nbsp;&nbsp;View&nbsp;&nbsp;Go&nbsp;&nbsp;Run&nbsp;&nbsp;Terminal</span><span style="margin:auto">${file} — acme-cloud</span><span class="ctl">&#8212; &#9744; &#10005;</span></div>
      <div class="row grow"><div class="act"></div><div class="side"><div class="b dim">EXPLORER</div>${tree.map((x) => `<div>${x}</div>`).join('')}</div>
      <div class="col grow"><div class="tabs">${tabs.map((x, i) => `<div class="${i === 0 ? 'on' : ''}">${x}</div>`).join('')}</div><div class="crumb">${file}</div><div class="body grow">${rows}</div></div></div>
      <div class="status">${status}</div></div>`
  }
}

function sceneEditor(v, t, k) {
  if (v === 0) {
    const lines = [
      `<span class="c"># Production settings. Do not commit this file.</span>`,
      `<span class="k">NODE_ENV</span>=${O('production')}`,
      `<span class="k">APP_URL</span>=${O('https://app.acme-cloud.io')}`,
      `<span class="k">PORT</span>=${O('8080')}`,
      `<span class="k">DATABASE_URL</span>=postgres://app_admin:${P('password', 'Vq7#pL2m!xR9')}@db.prod.acme-cloud.io:5432/app`,
      `<span class="k">REDIS_URL</span>=redis://default:${P('password', 'R3dis-Pr0d-88')}@cache.acme-cloud.io:6379`,
      `<span class="k">AWS_ACCESS_KEY_ID</span>=${P('key', k.aws())}`,
      `<span class="k">AWS_SECRET_ACCESS_KEY</span>=${P('key', k.awsSecret())}`,
      `<span class="k">AWS_REGION</span>=${O('eu-west-2')}`,
      `<span class="k">STRIPE_SECRET_KEY</span>=${P('key', k.stripeLive())}`,
      `<span class="k">OPENAI_API_KEY</span>=${P('key', k.openai())}`,
      `<span class="k">GITHUB_TOKEN</span>=${P('key', k.ghp())}`,
      `<span class="k">SLACK_BOT_TOKEN</span>=${P('key', k.xoxb())}`,
      `<span class="k">SENDGRID_API_KEY</span>=${P('key', k.sendgrid())}`,
      `<span class="k">MAPS_API_KEY</span>=${P('key', k.gcp())}`,
      `<span class="k">JWT_SIGNING_SECRET</span>=${P('key', k.alnum(48))}`,
      `<span class="k">SUPPORT_EMAIL</span>=${P('email', 'support@acme-cloud.io')}`,
      `<span class="k">ONCALL_PHONE</span>=${P('phone', '+1 415 555 0132', { region: 'US' })}`,
      `<span class="k">SESSION_TIMEOUT</span>=${O('3600')}`,
      `<span class="k">LOG_LEVEL</span>=info`,
      `<span class="k">BUILD_SHA</span>=${O('a3f9c21')}`,
      `<span class="k">FEATURE_FLAGS</span>=search,exports,${O('beta-2026.11')}`,
      ``,
      `<span class="c"># Owner: ${N(PRIYA)} (platform)</span>`
    ]
    return editorFrame(t, {
      file: '.env.production',
      tabs: ['.env.production', 'server.ts', 'README.md'],
      tree: ['&#9662; ACME-CLOUD', '&nbsp;&nbsp;&#9656; .github', '&nbsp;&nbsp;&#9656; src', '&nbsp;&nbsp;&#9656; tests', '&nbsp;&nbsp;.env.example', '&nbsp;&nbsp;<b>.env.production</b>', '&nbsp;&nbsp;package.json', '&nbsp;&nbsp;README.md', '&nbsp;&nbsp;tsconfig.json'],
      lines,
      selLines: [6, 7],
      status: `<span>&#9095; main</span><span>${O('Ln 8, Col 23')}</span><span>Spaces: 2</span><span>UTF-8</span><span>LF</span><span>Properties</span>`
    })
  }
  const lines = [
    `<span class="w">import</span> os`,
    `<span class="w">from</span> pathlib <span class="w">import</span> Path`,
    ``,
    `BASE_DIR = Path(__file__).resolve().parent.parent`,
    `DEBUG = <span class="w">False</span>`,
    `ALLOWED_HOSTS = [<span class="s">"${O('northwind.test')}"</span>, <span class="s">"${O('127.0.0.1')}"</span>]`,
    `SECRET_KEY = <span class="s">"<span class="hit">${P('key', 'django-insecure-' + k.alnum(40))}</span>"</span>`,
    ``,
    `DATABASES = {`,
    `    <span class="s">"default"</span>: {`,
    `        <span class="s">"ENGINE"</span>: <span class="s">"django.db.backends.postgresql"</span>,`,
    `        <span class="s">"USER"</span>: <span class="s">"northwind_app"</span>,`,
    `        <span class="s">"PASSWORD"</span>: <span class="s">"${P('password', 'Hn8$wQ4z-Lk2')}"</span>,`,
    `        <span class="s">"PORT"</span>: <span class="n">${O('5432')}</span>,`,
    `    }`,
    `}`,
    `EMAIL_HOST_USER = <span class="s">"${P('email', 'mailer@northwind.test')}"</span>`,
    `EMAIL_HOST_PASSWORD = <span class="s">"${P('password', 'smtp-9QxT4vB2')}"</span>`,
    `TWILIO_API_KEY = <span class="s">"${P('key', k.twilio())}"</span>`,
    `HF_TOKEN = os.environ.get(<span class="s">"HF_TOKEN"</span>, <span class="s">"${P('key', k.hf())}"</span>)`,
    `NPM_TOKEN = <span class="s">"${P('key', k.npm())}"</span>`,
    `SHOPIFY_ADMIN_TOKEN = <span class="s">"${P('key', k.shopify())}"</span>`,
    `<span class="c"># ${O('TODO(jordan): move these to the vault before v3.2.0')}</span>`,
    `MAX_UPLOAD_MB = <span class="n">${O('250')}</span>`,
    `TEST_SERVICE_JWT = <span class="s">"${P('jwt', k.jwt({ sub: 'svc-tests', iat: 1795392000 }))}"</span>`
  ]
  return editorFrame(t, {
    file: 'northwind/settings.py',
    tabs: ['settings.py', 'urls.py', 'models.py'],
    tree: ['&#9662; NORTHWIND', '&nbsp;&nbsp;&#9656; api', '&nbsp;&nbsp;&#9662; northwind', '&nbsp;&nbsp;&nbsp;&nbsp;__init__.py', '&nbsp;&nbsp;&nbsp;&nbsp;<b>settings.py</b>', '&nbsp;&nbsp;&nbsp;&nbsp;urls.py', '&nbsp;&nbsp;manage.py', '&nbsp;&nbsp;requirements.txt'],
    lines,
    status: `<span>&#9095; release/3.2</span><span>${O('Ln 7, Col 18')}</span><span>Python 3.12.4</span><span>UTF-8</span>`
  })
}

function sceneEditorSmall(v, t, k) {
  if (v === 0) {
    const pem = [k.pemBody(), k.pemBody(), k.pemBody()]
    const lines = [
      `{`,
      `  <span class="k">"Logging"</span>: { <span class="k">"LogLevel"</span>: { <span class="k">"Default"</span>: <span class="s">"Information"</span> } },`,
      `  <span class="k">"AllowedHosts"</span>: <span class="s">"*"</span>,`,
      `  <span class="k">"ConnectionStrings"</span>: {`,
      `    <span class="k">"Main"</span>: <span class="s">"Server=tcp:contoso-sql.database.windows.net,1433;User ID=contoso_admin;Password=${P('password', 'Az!7mKq2#Lp9')};Encrypt=True"</span>,`,
      `    <span class="k">"Storage"</span>: <span class="s">"DefaultEndpointsProtocol=https;AccountName=contosofiles;AccountKey=${P('key', k.b64(86) + '==')};EndpointSuffix=core.windows.net"</span>`,
      `  },`,
      `  <span class="k">"AzureAd"</span>: {`,
      `    <span class="k">"TenantId"</span>: <span class="s">"${O('72f988bf-86f1-41af-91ab-2d7cd011db47')}"</span>,`,
      `    <span class="k">"ClientId"</span>: <span class="s">"${O('5b1c9e2a-3d4f-4e8a-9b6c-0d1e2f3a4b5c')}"</span>,`,
      `    <span class="k">"ClientSecret"</span>: <span class="s">"${P('key', k.azureSecret())}"</span>`,
      `  },`,
      `  <span class="k">"Signing"</span>: {`,
      `    <span class="k">"PrivateKey"</span>: <span class="s">"${P('privateKey', '-----BEGIN PRIVATE KEY-----')}\\n</span>`,
      `<span class="s">${P('privateKey', pem[0])}\\n</span>`,
      `<span class="s">${P('privateKey', pem[1])}\\n</span>`,
      `<span class="s">${P('privateKey', pem[2])}\\n</span>`,
      `<span class="s">${P('privateKey', '-----END PRIVATE KEY-----')}"</span>`,
      `  },`,
      `  <span class="k">"GitLab"</span>: { <span class="k">"Token"</span>: <span class="s">"${P('key', k.glpat())}"</span>, <span class="k">"ProjectId"</span>: <span class="n">${O('48213907')}</span> },`,
      `  <span class="k">"Pypi"</span>: { <span class="k">"UploadToken"</span>: <span class="s">"${P('key', k.pypi())}"</span> },`,
      `  <span class="k">"Alerts"</span>: { <span class="k">"Email"</span>: <span class="s">"${P('email', 'ops-alerts@contoso.example')}"</span>, <span class="k">"Sms"</span>: <span class="s">"${P('phone', '+44 7700 900461', { region: 'GB' })}"</span> },`,
      `  <span class="k">"Cache"</span>: { <span class="k">"Key"</span>: <span class="s">"${P('randomString', k.alnum(24))}"</span>, <span class="k">"Ttl"</span>: <span class="n">${O('86400')}</span> },`,
      `  <span class="k">"Version"</span>: <span class="s">"${O('4.18.2-rc.1')}"</span>,`,
      `  <span class="k">"BuildDate"</span>: <span class="s">"${O('2026-11-23T09:41:07Z')}"</span>`,
      `}`
    ]
    return editorFrame(t, {
      file: 'appsettings.Production.json',
      font: 11,
      fontFamily: 'DejaVu Sans Mono',
      tabs: ['appsettings.Production.json', 'Program.cs', 'Startup.cs'],
      tree: ['&#9662; CONTOSO.API', '&nbsp;&nbsp;&#9656; Controllers', '&nbsp;&nbsp;&#9656; Models', '&nbsp;&nbsp;appsettings.json', '&nbsp;&nbsp;<b>appsettings.Production.json</b>', '&nbsp;&nbsp;Program.cs', '&nbsp;&nbsp;Contoso.Api.csproj'],
      lines,
      status: `<span>&#9095; main</span><span>${O('Ln 11, Col 42')}</span><span>JSON</span><span>CRLF</span>`
    })
  }
  const lines = [
    `<span class="w">apiVersion</span>: v1`,
    `<span class="w">kind</span>: Secret`,
    `<span class="w">metadata</span>:`,
    `  <span class="w">name</span>: ${O('payments-api')}`,
    `  <span class="w">namespace</span>: ${O('prod-eu')}`,
    `<span class="w">type</span>: Opaque`,
    `<span class="w">stringData</span>:`,
    `  <span class="k">DB_PASSWORD</span>: <span class="s">"${P('password', 'pg-Wm4!rT8vQz')}"</span>`,
    `  <span class="k">STRIPE_RESTRICTED_KEY</span>: <span class="s">"${P('key', k.stripeRestricted())}"</span>`,
    `  <span class="k">GITHUB_PAT</span>: <span class="s">"${P('key', k.ghpat())}"</span>`,
    `  <span class="k">SLACK_WEBHOOK</span>: <span class="s">"https://hooks.slack.com/services/${P('linkToken', k.slackHookPath())}"</span>`,
    `  <span class="k">SERVICE_TOKEN</span>: <span class="s">"${P('jwt', k.jwt({ sub: 'svc-payments', iat: 1795392000, scope: 'payments:write' }))}"</span>`,
    `  <span class="k">ADMIN_PIN</span>: <span class="s">"${P('password', '4729')}"</span>`,
    `---`,
    `<span class="w">apiVersion</span>: apps/v1`,
    `<span class="w">kind</span>: Deployment`,
    `<span class="w">spec</span>:`,
    `  <span class="w">replicas</span>: ${O('3')}`,
    `  <span class="w">image</span>: ${O('registry.acme-cloud.io/payments:2.31.0')}`,
    `  <span class="w">resources</span>: { <span class="k">limits</span>: { <span class="k">memory</span>: ${O('512Mi')}, <span class="k">cpu</span>: ${O('500m')} } }`
  ]
  return editorFrame(t, {
    file: 'k8s/payments-secret.yaml',
    font: 12,
    tabs: ['payments-secret.yaml', 'deployment.yaml'],
    tree: ['&#9662; INFRA', '&nbsp;&nbsp;&#9662; k8s', '&nbsp;&nbsp;&nbsp;&nbsp;<b>payments-secret.yaml</b>', '&nbsp;&nbsp;&nbsp;&nbsp;deployment.yaml', '&nbsp;&nbsp;&#9656; terraform'],
    lines,
    selLines: [9],
    status: `<span>&#9095; ops/rotate</span><span>${O('Ln 10, Col 3')}</span><span>YAML</span><span>LF</span>`
  })
}

// ---------------------------------------------------------------------------------------------
// Terminals
function termFrame(t, { title, font, fontFamily, lines, light }) {
  const fg = light ? '#1f1f1f' : '#cccccc'
  const bg = light ? '#ffffff' : '#0c0c0c'
  return {
    css: `
    .term{position:absolute;inset:0;background:${bg};color:${fg};display:flex;flex-direction:column}
    .ttabs{height:36px;background:${light ? '#e9e9e9' : '#1f1f1f'};display:flex;align-items:flex-end;padding:0 8px;font-size:12px}
    .ttabs div{padding:8px 16px;border-radius:6px 6px 0 0;background:${bg}}
    pre{font-family:'${fontFamily}',monospace;font-size:${font}px;line-height:${Math.round(font * 1.35)}px;padding:10px 14px;white-space:pre-wrap;word-break:break-all;flex:1;overflow:hidden}
    .p{color:${light ? '#0037da' : '#16c60c'}}.y{color:${light ? '#986f0b' : '#f9f1a5'}}.g{color:${light ? '#767676' : '#8a8a8a'}}
    `,
    html: `<div class="term"><div class="ttabs"><div>${title}</div><div style="background:none;opacity:.6">+</div></div><pre>${lines.join('\n')}</pre></div>`
  }
}

function sceneTerminal(v, t, k) {
  if (v === 0) {
    const jwt = k.jwt({ sub: 'u_8812', email: 'priya.raman@example.com', role: 'admin', exp: 1795478400 })
    const lines = [
      `<span class="p">priya@build-07</span>:<span class="y">~/acme-cloud</span>$ export AWS_ACCESS_KEY_ID=${P('key', k.aws())}`,
      `<span class="p">priya@build-07</span>:<span class="y">~/acme-cloud</span>$ export AWS_SECRET_ACCESS_KEY=${P('key', k.awsSecret())}`,
      `<span class="p">priya@build-07</span>:<span class="y">~/acme-cloud</span>$ aws s3 ls s3://acme-cloud-backups/`,
      `${O('2026-11-20 03:14:07')}  ${O('48213907')} db-2026-11-20.sql.gz`,
      `${O('2026-11-21 03:14:09')}  ${O('48299115')} db-2026-11-21.sql.gz`,
      `<span class="p">priya@build-07</span>:<span class="y">~/acme-cloud</span>$ curl -s https://api.acme-cloud.io/v2/me -H "Authorization: Bearer ${P('jwt', jwt)}"`,
      `{"id":"u_8812","name":"${N(PRIYA)}","email":"${P('email', 'priya.raman@example.com')}","plan":"team"}`,
      `<span class="p">priya@build-07</span>:<span class="y">~/acme-cloud</span>$ git remote set-url origin https://${P('key', k.ghp())}@github.com/acme/cloud.git`,
      `<span class="p">priya@build-07</span>:<span class="y">~/acme-cloud</span>$ npm config set //registry.npmjs.org/:_authToken=${P('key', k.npm())}`,
      `<span class="p">priya@build-07</span>:<span class="y">~/acme-cloud</span>$ cat ~/.ssh/id_ed25519`,
      P('privateKey', '-----BEGIN OPENSSH PRIVATE KEY-----'),
      P('privateKey', k.pemBody().slice(0, 70 - 6) + k.b64(6)),
      P('privateKey', k.pemBody()),
      P('privateKey', k.pemBody()),
      P('privateKey', '-----END OPENSSH PRIVATE KEY-----'),
      `<span class="p">priya@build-07</span>:<span class="y">~/acme-cloud</span>$ git log --oneline -3`,
      `${O('e4b1c9a')} Fix retry on 429 (#2211)`,
      `${O('7d02f3e')} Bump node to ${O('22.11.0')}`,
      `${O('19ac0b4')} Add export presets`,
      `<span class="p">priya@build-07</span>:<span class="y">~/acme-cloud</span>$ <span style="background:#ccc">&nbsp;</span>`
    ]
    return termFrame(t, { title: 'priya@build-07: ~/acme-cloud', font: 13, fontFamily: 'Liberation Mono', lines })
  }
  const lines = [
    `<span class="g">PowerShell 7.5.2</span>`,
    `<span class="p">PS C:\\src\\northwind&gt;</span> $env:GITHUB_TOKEN = "${P('key', k.ghpat())}"`,
    `<span class="p">PS C:\\src\\northwind&gt;</span> $env:OPENAI_API_KEY = "${P('key', k.openai())}"`,
    `<span class="p">PS C:\\src\\northwind&gt;</span> $headers = @{ Authorization = "Bearer ${P('key', k.glpat())}" }`,
    `<span class="p">PS C:\\src\\northwind&gt;</span> Invoke-RestMethod https://gitlab.northwind.test/api/v4/user -Headers $headers`,
    ``,
    `id       : ${O('1042')}`,
    `username : jellis`,
    `name     : ${N(JORDAN)}`,
    `email    : ${P('email', 'jordan.ellis@northwind.test')}`,
    `state    : active`,
    ``,
    `<span class="p">PS C:\\src\\northwind&gt;</span> az login --service-principal -u ${O('5b1c9e2a-3d4f-4e8a-9b6c-0d1e2f3a4b5c')} -p ${P('key', k.azureSecret())}`,
    `<span class="g">[ { "cloudName": "AzureCloud", "tenantId": "${O('72f988bf-86f1-41af-91ab-2d7cd011db47')}", "state": "Enabled" } ]</span>`,
    `<span class="p">PS C:\\src\\northwind&gt;</span> Get-Content .\\deploy\\wifi.txt`,
    `Network: Northwind-Guest   Password: ${P('password', 'Tulip-Harbour-73')}`,
    `<span class="p">PS C:\\src\\northwind&gt;</span> python manage.py createsuperuser --email ${P('email', 'admin@northwind.test')}`,
    `Password: `,
    `Superuser created successfully.`,
    `<span class="p">PS C:\\src\\northwind&gt;</span> Write-Host "Build ${O('3.2.0+20261123.4')} finished in ${O('41.7 s')}"`,
    `Build ${O('3.2.0+20261123.4')} finished in ${O('41.7 s')}`,
    `<span class="p">PS C:\\src\\northwind&gt;</span> `
  ]
  return termFrame(t, { title: 'Windows PowerShell', font: 14, fontFamily: 'JetBrains Mono', lines, light: true })
}

function sceneLogs(v, t, k) {
  if (v === 0) {
    const card = k.visa()
    const ts = (s) => `<span class="g">${O('2026-11-23T10:' + s + 'Z')}</span>`
    const lines = [
      `${ts('02:11.204')} INFO  http  GET /healthz 200 ${O('1.8ms')}`,
      `${ts('02:11.388')} INFO  auth  login ok user=${P('email', 'tomasz.kowalczyk@contoso.example')} ip=${O('10.24.8.17')}`,
      `${ts('02:12.017')} INFO  sms   sent code ${P('code', '482913')} to ${P('phone', '+44 7700 900877', { region: 'GB' })} (template=login_otp)`,
      `${ts('02:12.442')} WARN  pay   retrying charge ch_${O('3PqL0x2eZvKu')} attempt=${O('2')}`,
      `${ts('02:12.951')} DEBUG pay   card=${P('card', card)} exp=${O('09/29')} amount=${O('129.00')} EUR`,
      `${ts('02:13.006')} INFO  pay   payout to ${P('iban', k.ibanDE())} ok ref=${P('randomString', k.upnum(16))}`,
      `${ts('02:13.370')} INFO  user  profile updated name="${N(TOMASZ)}" phone=${P('phone', '+48 512 345 678', { region: 'PL' })}`,
      `${ts('02:13.640')} DEBUG http  headers authorization="Bearer ${P('jwt', k.jwt({ sub: 'u_4410', name: 'Tomasz Kowalczyk', exp: 1795478400 }))}"`,
      `${ts('02:13.912')} ERROR mail  smtp auth failed user=noreply@contoso.example pass=${P('password', 'Mailer!2026x')}`,
      `${ts('02:14.115')} INFO  http  POST /api/v1/orders 201 ${O('42.3ms')} order=${O('ORD-104823')}`,
      `${ts('02:14.507')} INFO  hook  delivered https://discord.com/api/webhooks/${P('linkToken', k.discordHookPath())}`,
      `${ts('02:15.020')} DEBUG cfg   loaded secrets: SENTRY_DSN=https://${P('key', k.hex(32))}@o4507.ingest.sentry.io/${O('4507')}`,
      `${ts('02:15.633')} INFO  auth  password reset link https://contoso.example/reset?token=${P('linkToken', k.hex(40))}`,
      `${ts('02:16.104')} INFO  http  GET /api/v1/catalog?page=${O('3')} 200 ${O('12.0ms')}`,
      `${ts('02:16.882')} INFO  kyc   verified ssn=${P('id', '219-09-9999')} for ${N(AISHA)}`,
      `${ts('02:17.300')} INFO  cron  backup finished size=${O('4.2 GB')} in ${O('312 s')}`,
      `${ts('02:17.951')} INFO  sms   sent code ${P('code', '739204')} to ${P('phone', '+880 1712-345678', { region: 'BD' })}`,
      `${ts('02:18.006')} WARN  rate  ${O('429')} for key_id=${O('kid_00412')} limit=${O('600/min')}`,
      `${ts('02:18.440')} INFO  http  GET /api/v1/users/${O('8812')} 200 ${O('3.1ms')}`,
      `${ts('02:19.012')} INFO  deploy finished version=${O('2.31.0')} commit=${O('e4b1c9a')}`
    ]
    return termFrame(t, { title: 'kubectl logs -f payments-7c9d', font: 11, fontFamily: 'DejaVu Sans Mono', lines })
  }
  // A log viewer in a browser (light, 150%)
  const rows = [
    [O('10:41:07'), 'INFO', `Signed in: ${P('email', 'mei.lin.chen@fabrikam.example')}`],
    [O('10:41:09'), 'INFO', `MFA code ${P('code', '315 772')} sent by SMS to ${P('phone', '+61 2 5550 1234', { region: 'AU' })}`],
    [O('10:41:15'), 'WARN', `Payment declined for card ${P('card', k.mastercard())}`],
    [O('10:41:22'), 'INFO', `Invoice ${O('INV-2026-0417')} paid, ${O('$1,299.00')}`],
    [O('10:41:30'), 'INFO', `New contact: ${N(MEI)}, ${P('phone', '(646) 555-0173', { region: 'US' })}`],
    [O('10:41:41'), 'ERROR', `Token rejected: ${P('key', k.stripeTest())}`],
    [O('10:41:52'), 'INFO', `Export ready: report-${O('2026-11')}.csv (${O('18,402')} rows)`]
  ]
  return {
    css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.lv{padding:14px 18px}.lv td{font-size:13px}.lvl{font-weight:600}`,
    html: `<div class="wrap">${browserChrome(t, ['Logs · Fabrikam Ops', 'Inbox'], 'https://ops.fabrikam.example/logs?service=billing&amp;range=1h')}
      <div class="lv"><div class="row" style="gap:10px;margin-bottom:10px"><div class="field grow">service:billing level:*</div><span class="btn">Search</span></div>
      <table><tr><th>Time</th><th>Level</th><th>Message</th></tr>${rows.map((r) => `<tr><td>${r[0]}</td><td class="lvl">${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table></div></div>`
  }
}

// ---------------------------------------------------------------------------------------------
// Browser dashboards
function sceneDashboard(v, t, k, qrs) {
  if (v === 0) {
    const tok = k.hex(32)
    return {
      css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.nav{width:220px;background:${t.panel};padding:18px 14px;font-size:14px}.nav div{padding:7px 10px;border-radius:6px}.nav .on{background:${t.panel2};font-weight:600}
      .main{padding:22px 30px}.krow{display:flex;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid ${t.border};font-size:14px}.krow .n{width:180px;color:${t.dim}}.krow .v{font-family:'JetBrains Mono',monospace;font-size:13px}`,
      html: `<div class="wrap">${browserChrome(t, ['API keys · Acme Cloud', 'Docs', 'Inbox (3)'], `https://dashboard.acme-cloud.io/developers/keys?session=${P('linkToken', tok)}`)}
      <div class="row grow"><div class="nav"><div>Home</div><div>Payments</div><div>Customers</div><div class="on">Developers</div><div>Settings</div></div>
      <div class="main grow"><h2 style="font-size:22px;margin-bottom:4px">API keys</h2><div class="dim" style="margin-bottom:16px">Keys for ${O('Acme Cloud Ltd')} · live mode</div>
      <div class="card"><div class="krow"><span class="n">Publishable key</span><span class="v">${O(k.stripePublishable())}</span></div>
      <div class="krow"><span class="n">Secret key</span><span class="v">${P('key', k.stripeLive())}</span><span class="btn2">Hide</span></div>
      <div class="krow"><span class="n">Restricted key (reports)</span><span class="v">${P('key', k.stripeRestricted())}</span></div>
      <div class="krow"><span class="n">Webhook signing secret</span><span class="v">${P('key', k.whsec())}</span></div>
      <div class="krow"><span class="n">Webhook endpoint</span><span class="v">https://hooks.slack.com/services/${P('linkToken', k.slackHookPath())}</span></div>
      <div class="krow"><span class="n">Account owner</span><span>${N(PRIYA)} · ${P('email', 'priya.raman@example.com')}</span></div></div>
      <h3 style="font-size:16px;margin:22px 0 8px">Recent requests</h3>
      <table><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Request ID</th></tr>
      <tr><td>${O('10:42:07')}</td><td>POST</td><td>/v1/charges</td><td>${O('200')}</td><td class="mono">${O('req_9Hq2LmT4vB')}</td></tr>
      <tr><td>${O('10:41:55')}</td><td>GET</td><td>/v1/customers/${O('cus_Q1x8')}</td><td>${O('200')}</td><td class="mono">${O('req_4Kz7PwR1sD')}</td></tr>
      <tr><td>${O('10:41:12')}</td><td>POST</td><td>/v1/refunds</td><td>${O('402')}</td><td class="mono">${O('req_7Tn3BvX9cQ')}</td></tr></table></div></div>
      ${taskbar('10:42', '23/11/2026')}
      ${toast('Messages', 'Acme Cloud', `Your Acme verification code is ${P('code', '551902')}. Don't share it.`)}</div>`
    }
  }
  return {
    css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.main{padding:20px 28px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.kv{display:flex;gap:10px;padding:7px 0;font-size:13px;border-bottom:1px solid ${t.border}}.kv span:first-child{width:150px;color:${t.dim};flex:none}.kv .v{font-family:'JetBrains Mono',monospace;font-size:12px;word-break:break-all}`,
    html: `<div class="wrap">${browserChrome(t, ['Access tokens · Northwind Cloud', 'Pull requests'], 'https://console.northwind.test/settings/tokens')}
    <div class="main"><h2 style="font-size:20px;margin-bottom:14px">Access tokens</h2><div class="grid">
    <div class="card"><div class="b" style="margin-bottom:6px">New personal access token</div><div class="dim" style="margin-bottom:8px">Copy it now. You won't see it again.</div>
      <div class="kv"><span>Token</span><span class="v">${P('key', k.ghp())}</span></div><div class="kv"><span>Expires</span><span>${O('23 Feb 2027')}</span></div><div class="kv"><span>Scopes</span><span>repo, read:org</span></div></div>
    <div class="card"><div class="b" style="margin-bottom:6px">Cloud credentials</div>
      <div class="kv"><span>Access key ID</span><span class="v">${P('key', k.aws())}</span></div><div class="kv"><span>Secret access key</span><span class="v">${P('key', k.awsSecret())}</span></div><div class="kv"><span>Region</span><span>${O('us-east-1')}</span></div></div>
    <div class="card"><div class="b" style="margin-bottom:6px">Model hub</div><div class="kv"><span>Read token</span><span class="v">${P('key', k.hf())}</span></div><div class="kv"><span>Owner</span><span>${N(JORDAN)}</span></div><div class="kv"><span>Session</span><span class="v">${P('jwt', k.jwt({ sub: 'jellis', org: 'northwind', exp: 1795564800 }))}</span></div></div>
    <div class="card"><div class="b" style="margin-bottom:6px">Notifications</div><div class="kv"><span>Chat webhook</span><span class="v">https://discord.com/api/webhooks/${P('linkToken', k.discordHookPath())}</span></div><div class="kv"><span>Alert email</span><span>${P('email', 'alerts@northwind.test')}</span></div></div>
    </div><div class="dim" style="margin-top:14px">Last used ${O('2 hours ago')} from ${O('203.0.113.42')} · Token ID ${O('tok_000184')}</div></div></div>`
  }
}

function sceneCrm(v, t, k) {
  const people =
    v === 0
      ? [
          [N(PRIYA), P('email', 'priya.raman@example.com'), P('phone', '+44 20 7946 0958', { region: 'GB' }), P('card', k.visa()), P('address', '221B Baker Street, London NW1 6XE')],
          [O('Maria Lopez'), P('email', 'm.lopez@fabrikam.example'), P('phone', '+34 612 345 678', { region: 'ES' }), P('card', k.amex()), P('address', 'Calle Mayor 12, 28013 Madrid')],
          [N(TOMASZ), P('email', 'tomasz.k@contoso.example'), P('phone', '+48 22 123 45 67', { region: 'PL' }), P('card', k.mastercard('-')), P('address', 'ul. Marszałkowska 84, Warszawa')],
          [N(AISHA), P('email', 'aisha.rahman@example.org'), P('phone', '+880 1812-345679', { region: 'BD' }), P('card', k.discover()), P('address', 'House 14, Road 7, Dhanmondi, Dhaka')],
          [O('Daniel Okafor'), P('email', 'daniel.okafor@northwind.test'), P('phone', '+1 (212) 555-0199', { region: 'US' }), P('card', k.cardPlain()), P('address', '350 Fifth Ave, New York, NY 10118')]
        ]
      : [
          [N(MEI), P('email', 'mei.lin.chen@fabrikam.example'), P('phone', '+61 491 570 156', { region: 'AU' }), P('iban', k.ibanNL()), P('address', '1 Martin Pl, Sydney NSW 2000')],
          [N(JORDAN), P('email', 'jordan.ellis@northwind.test'), P('phone', '+1 646-555-0144', { region: 'US' }), P('iban', k.ibanGB()), P('address', '12 Elm Row, Edinburgh EH7 4AA')],
          [O('Sofia Rossi'), P('email', 'sofia.rossi@contoso.example'), P('phone', '+33 1 99 00 12 34', { region: 'FR' }), P('iban', k.ibanFR()), P('address', '8 Rue de Rivoli, 75004 Paris')],
          [O('Kenji Watanabe'), P('email', 'kenji.w@example.jp'), P('phone', '+81 3-1234-5678', { region: 'JP' }), P('iban', k.ibanDE()), P('address', '2-1 Marunouchi, Chiyoda, Tokyo')],
          [N(AISHA), P('email', 'aisha.r@contoso.example'), P('phone', '01712-345680', { region: 'BD' }), P('iban', k.ibanGB()), P('address', 'Plot 5, Gulshan Ave, Dhaka 1212')],
          [O('Lucas Silva'), P('email', 'lucas.silva@example.com.br'), P('phone', '+55 11 91234-5678', { region: 'BR' }), P('iban', k.ibanNL()), P('address', 'Av. Paulista 1000, São Paulo')]
        ]
  const head = v === 0 ? ['Name', 'Email', 'Phone', 'Card on file', 'Address'] : ['Name', 'Email', 'Phone', 'Payout IBAN', 'Address']
  return {
    css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.main{padding:18px 24px}td{font-size:13px}.tools{display:flex;gap:10px;margin-bottom:12px;align-items:center}`,
    html: `<div class="wrap">${browserChrome(t, ['Customers · Fabrikam CRM'], `https://crm.fabrikam.example/customers?view=${O('all')}&amp;page=${O('2')}`)}
    <div class="main"><div class="tools"><h2 style="font-size:20px">Customers</h2><span class="dim">${O('1,284')} customers · updated ${O('5 min ago')}</span><span class="btn" style="margin-left:auto">New customer</span></div>
    <table><tr>${head.map((h) => `<th>${h}</th>`).join('')}<th>Since</th></tr>${people
      .map((p, i) => `<tr${i === 2 ? ` style="background:${t.sel}"` : ''}>${p.map((c) => `<td>${c}</td>`).join('')}<td>${O(['Mar 2021', 'Jul 2022', 'Jan 2023', 'Oct 2024', 'Feb 2025', 'Jun 2026'][i])}</td></tr>`)
      .join('')}</table>
    <div class="dim" style="margin-top:12px">Order ${O('#104823')} · Ticket ${O('SUP-20931')} · ${O('Page 2 of 52')}</div></div></div>`
  }
}

function sceneInbox(v, t, k) {
  const list =
    v === 0
      ? [
          [N(AISHA), 'Quarterly numbers', O('09:12')],
          ['Acme Cloud', 'Your sign-in code', O('09:30')],
          [N(TOMASZ), 'Re: contract draft', O('Yesterday')],
          ['Northwind Bank', 'Statement ready', O('Mon')],
          [O('Daniel Okafor'), 'Lunch on Friday?', O('Mon')]
        ]
      : [
          ['IT Service Desk', 'Your temporary password', O('11:02')],
          [N(MEI), 'Photos from the offsite', O('10:47')],
          ['Fabrikam Billing', 'Invoice INV-2026-0417', O('Fri')],
          [N(JORDAN), 'Vendor contacts', O('Thu')]
        ]
  const reading =
    v === 0
      ? `<div class="b" style="font-size:20px;margin-bottom:6px">Your sign-in code</div>
      <div class="dim" style="margin-bottom:16px">Acme Cloud &lt;${P('email', 'no-reply@acme-cloud.io')}&gt; · to ${P('email', 'priya.raman@example.com')}</div>
      <p>Hi ${N(PRIYA)},</p><p style="margin:12px 0">Use this code to finish signing in. It expires in ${O('10 minutes')}.</p>
      <div style="font-size:30px;letter-spacing:6px;font-weight:600;margin:10px 0 16px">${P('code', '739204')}</div>
      <p>Or open this link: https://acme-cloud.io/login/magic?code=${P('linkToken', k.alnum(32))}</p>
      <p style="margin-top:12px">Your recovery codes (keep them safe):</p><p class="mono">${P('code', '8f3k-2m9q')}&nbsp;&nbsp;${P('code', 'x7p4-c1zt')}&nbsp;&nbsp;${P('code', 'h9w2-r6bd')}</p>
      <p style="margin-top:16px">Questions? Call ${P('phone', '+44 20 7946 0123', { region: 'GB' })} or reply to this email.</p>
      <p class="dim" style="margin-top:18px">Acme Cloud Ltd, ${O('Company no. 09876543')}. Sent ${O('23 Nov 2026, 09:30')}.</p>`
      : `<div class="b" style="font-size:20px;margin-bottom:6px">Your temporary password</div>
      <div class="dim" style="margin-bottom:16px">IT Service Desk &lt;${P('email', 'servicedesk@northwind.test')}&gt;</div>
      <p>Hello ${N(JORDAN)},</p><p style="margin:12px 0">Your account was reset. Sign in with</p>
      <p>Username: jellis</p><p>Temporary password: ${P('password', 'Kx9#mP2vL')}</p>
      <p>Employee ID: ${P('id', 'EMP-002931')} · Payroll ID: ${P('id', 'PR-55102')}</p>
      <p>SSN on file: ${P('id', '219-09-9998')}</p>
      <p style="margin-top:12px">Then set a new password at https://sso.northwind.test/first-login?ticket=${P('linkToken', k.hex(24))}</p>
      <p style="margin-top:12px">Ticket ${O('INC0042917')} · Desk phone ${P('phone', '(415) 555-0147', { region: 'US' })}</p>`
  return {
    css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;font-family:'Carlito',sans-serif;font-size:15px}.lst{width:360px;border-right:1px solid ${t.border}}.it{padding:10px 16px;border-bottom:1px solid ${t.border}}.it.on{background:${t.sel}}.rd{padding:24px 34px}p{line-height:1.5}`,
    html: `<div class="wrap">${browserChrome(t, ['Mail', 'Calendar'], `https://mail.example.com/inbox/${O('msg-77213')}`)}
    <div class="row grow"><div class="lst"><div class="it b">Inbox · ${O('3 unread')}</div>${list.map((x, i) => `<div class="it${i === 1 || (v === 1 && i === 0) ? ' on' : ''}"><div class="row"><span class="b grow">${x[0]}</span><span class="dim">${x[2]}</span></div><div>${x[1]}</div></div>`).join('')}</div>
    <div class="rd grow">${reading}</div></div></div>`
  }
}

function sceneSettings(v, t, k) {
  if (v === 0) {
    return {
      css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.main{padding:20px 30px;display:grid;grid-template-columns:1fr 1fr;gap:18px}.f{width:100%}.pw{letter-spacing:3px}`,
      html: `<div class="wrap">${browserChrome(t, ['Account settings · Fabrikam'], 'https://my.fabrikam.example/account/security')}
      <div class="main"><div class="card"><div class="b" style="font-size:17px">Profile</div>
        <div class="label">Full name</div><div class="field">${N(MEI)}</div>
        <div class="label">Email</div><div class="field">${P('email', 'mei.lin.chen@fabrikam.example')}</div>
        <div class="label">Mobile</div><div class="field">${P('phone', '+61 491 570 110', { region: 'AU' })}</div>
        <div class="label">Home address</div><div class="field">${P('address', '42 Wallaby Way, Sydney NSW 2000')}</div>
        <div class="label">Customer ID</div><div class="field">${P('id', 'CUS-48291-7730')}</div></div>
      <div class="card"><div class="b" style="font-size:17px">Sign-in &amp; security</div>
        <div class="label">Current password</div><div class="field pw">${P('dots', '••••••••••••')}</div>
        <div class="label">New password</div><div class="field row"><span class="grow">${P('password', 'c0rrect-H0rse-battery')}</span><span class="dim">Hide</span></div>
        <div class="label">Recovery codes</div><div class="field mono">${P('code', '4827 1930')}&nbsp;&nbsp;${P('code', '6619 0452')}&nbsp;&nbsp;${P('code', '3305 8871')}</div>
        <div class="label">Tax file number</div><div class="field">${P('id', '123 456 782')}</div>
        <div class="label">Passport number</div><div class="field">${P('id', '533380006')}</div></div>
      <div class="card"><div class="b">Connected apps</div><div class="dim" style="margin-top:6px">Calendar sync · last used ${O('3 days ago')} · ${O('v2.4.1')}</div></div>
      <div class="card"><div class="b">Language and region</div><div class="dim" style="margin-top:6px">${O('English (Australia)')} · ${O('UTC+11:00')} · ${O('dd/mm/yyyy')}</div></div></div></div>`
    }
  }
  // Windows-style settings, dark
  return {
    css: `.wrap{position:absolute;inset:0;display:flex}.nav{width:300px;padding:20px 14px;background:${t.panel}}.nav div{padding:8px 12px;border-radius:6px}.nav .on{background:${t.panel2}}.main{padding:28px 40px;flex:1}.set{background:${t.card};border:1px solid ${t.border};border-radius:6px;padding:14px 18px;margin-bottom:6px;display:flex;align-items:center;gap:12px}.set .grow{display:flex;flex-direction:column}`,
    html: `<div class="wrap"><div class="nav"><div class="row" style="gap:12px;margin-bottom:16px"><div style="width:52px;height:52px;border-radius:50%;background:${t.accent}"></div><div><div class="b">${N(TOMASZ)}</div><div class="dim">${P('email', 'tomasz.k@contoso.example')}</div></div></div>
      <div>System</div><div>Bluetooth &amp; devices</div><div class="on">Network &amp; internet</div><div>Accounts</div><div>Privacy &amp; security</div></div>
      <div class="main"><div style="font-size:28px;font-weight:600;margin-bottom:18px">Network &amp; internet &rsaquo; Wi-Fi &rsaquo; Contoso-Office</div>
      <div class="set"><div class="grow"><span>Network security key</span><span class="dim">WPA2-Personal</span></div><span class="mono">${P('password', 'Plum-Orchard-4418')}</span><span class="btn2">Hide</span></div>
      <div class="set"><div class="grow"><span>IPv4 address</span></div><span>${O('192.168.1.24')}</span></div>
      <div class="set"><div class="grow"><span>Physical address (MAC)</span></div><span>${O('3C-52-82-1A-7F-09')}</span></div>
      <div class="set"><div class="grow"><span>Link speed</span></div><span>${O('1201/1201 (Mbps)')}</span></div>
      <div class="set"><div class="grow"><span>Driver version</span></div><span>${O('23.110.0.5')}</span></div>
      <div class="set"><div class="grow"><span>Router admin PIN</span><span class="dim">From the sticker</span></div><span class="mono">${P('password', '58204716')}</span></div>
      <div class="set"><div class="grow"><span>National Insurance number</span><span class="dim">For payroll</span></div><span>${P('id', 'QQ 12 34 56 C')}</span></div>
      <div class="set"><div class="grow"><span>Support</span></div><span>${P('phone', '+48 512 345 679', { region: 'PL' })}</span></div></div>
      ${taskbar('16:05', '23/11/2026')}</div>`
  }
}

function scene2fa(v, t, k, qrs) {
  if (v === 0) {
    return {
      css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.main{padding:28px 40px;display:flex;gap:40px}.codes{display:grid;grid-template-columns:repeat(2,160px);gap:6px 18px;font-family:'JetBrains Mono',monospace;font-size:15px}`,
      html: `<div class="wrap">${browserChrome(t, ['Two-step verification · Acme Cloud'], 'https://acme-cloud.io/account/2fa/setup')}
      <div class="main"><div class="card" style="width:440px"><div class="b" style="font-size:18px;margin-bottom:10px">1. Scan this code</div>${QR(qrs, 'totp-priya', 220)}
        <div class="label">Or type this key</div><div class="mono" style="font-size:16px">${P('key', 'JBSW Y3DP EHPK 3PXP')}</div>
        <div class="label">Account</div><div>${P('email', 'priya.raman@example.com')}</div></div>
      <div class="card grow"><div class="b" style="font-size:18px;margin-bottom:10px">2. Save your backup codes</div><div class="dim" style="margin-bottom:12px">Each code works once. Generated ${O('23 Nov 2026')}.</div>
        <div class="codes">${['31842 77019', '90267 13358', '44721 06693', '18350 92274', '70913 55286', '62048 31197'].map((c) => P('code', c)).join('')}</div>
        <div class="b" style="font-size:18px;margin:22px 0 10px">3. Enter the 6-digit code</div><div class="field mono" style="width:200px;font-size:18px;letter-spacing:4px">${P('code', '204 617')}</div>
        <div class="dim" style="margin-top:18px">Need help? ${O('acme-cloud.io/help/2fa')} · Ref ${O('2FA-88213')}</div></div></div></div>`
    }
  }
  return {
    css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.main{padding:24px 32px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.card{display:flex;flex-direction:column;align-items:flex-start;gap:8px}`,
    html: `<div class="wrap">${browserChrome(t, ['Office handbook · Contoso'], 'https://intranet.contoso.example/handbook/first-day')}
    <div class="main"><div class="card"><div class="b">Guest Wi-Fi</div>${QR(qrs, 'wifi-office', 180)}<div>Network ${O('Acme-Office-5G')}</div><div>Password ${P('password', 'Sunflower-2291')}</div></div>
    <div class="card"><div class="b">Sign in on your phone</div>${QR(qrs, 'login-link', 180)}<div class="dim">Expires in ${O('5 minutes')}</div></div>
    <div class="card"><div class="b">Get the app</div>${QR(qrs, 'app-download', 150)}<div>${O('flown.example/download')}</div></div>
    <div class="card"><div class="b">Authenticator</div>${QR(qrs, 'totp-jordan', 160)}<div>Setup key ${P('key', 'KRUGKIDROVUWG2ZAMJZG653OEBTG66BAJZ2XA4DFOI')}</div></div>
    <div class="card"><div class="b">Canteen menu</div>${QR(qrs, 'menu-link', 150)}<div class="dim">Updated ${O('Monday')}</div></div>
    <div class="card"><div class="b">Facilities</div><div>Desk ${O('4.217')} · Floor ${O('4')}</div><div>Door code ${P('code', '7351')}</div><div>Front desk ${P('phone', '+44 20 7946 0402', { region: 'GB' })}</div></div></div></div>`
  }
}

function sceneCheckout(v, t, k) {
  if (v === 0) {
    return {
      css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.main{padding:18px 40px;display:flex;gap:30px}.form{width:520px}.two{display:flex;gap:12px}.two>div{flex:1}`,
      html: `<div class="wrap">${browserChrome(t, ['Checkout · Northwind Store'], 'https://shop.northwind.test/checkout/payment')}
      <div class="main"><div class="form"><div class="b" style="font-size:18px">Payment</div>
        <div class="label">Card number</div><div class="field">${P('card', k.visa())}</div>
        <div class="two"><div><div class="label">Expiry</div><div class="field">${O('09 / 29')}</div></div><div><div class="label">CVC</div><div class="field">${P('code', '381')}</div></div></div>
        <div class="label">Name on card</div><div class="field">${N(JORDAN)}</div>
        <div class="label">Email for receipt</div><div class="field">${P('email', 'jordan.ellis@northwind.test')}</div>
        <div class="label">Phone</div><div class="field">${P('phone', '+1 646 555 0181', { region: 'US' })}</div>
        <div class="label">Billing address</div><div class="field">${P('address', '12 Elm Row, Edinburgh EH7 4AA')}</div></div>
      <div class="card grow" style="align-self:flex-start"><div class="b">Order summary</div><div class="row" style="margin-top:8px"><span class="grow">Desk lamp × ${O('2')}</span><span>${O('$89.98')}</span></div>
        <div class="row"><span class="grow">Shipping</span><span>${O('$4.99')}</span></div><div class="row b"><span class="grow">Total</span><span>${O('$94.97')}</span></div><div class="dim" style="margin-top:8px">Order ${O('NW-2026-58812')}</div></div></div></div>`
    }
  }
  return {
    css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.main{padding:22px 40px;display:grid;grid-template-columns:1fr 1fr;gap:24px}`,
    html: `<div class="wrap">${browserChrome(t, ['Send money · Fabrikam Bank'], 'https://online.fabrikam-bank.example/transfer/new')}
    <div class="main"><div class="card"><div class="b" style="font-size:18px">New transfer</div>
      <div class="label">From</div><div class="field">Everyday account · ${P('iban', k.ibanGB())}</div>
      <div class="label">Payee name</div><div class="field">${N(AISHA)}</div>
      <div class="label">Payee IBAN</div><div class="field">${P('iban', k.ibanDE())}</div>
      <div class="label">BIC</div><div class="field">${O('DEUTDEFF')}</div>
      <div class="label">Amount</div><div class="field">${O('€2,450.00')}</div>
      <div class="label">Reference</div><div class="field">${O('Invoice 2026-0417')}</div>
      <div class="label">Confirmation code from your card reader</div><div class="field mono">${P('code', '90218744')}</div></div>
    <div class="card"><div class="b" style="font-size:18px">Saved payees</div>
      <table><tr><th>Name</th><th>IBAN</th></tr><tr><td>${N(MEI)}</td><td>${P('iban', k.ibanNL())}</td></tr><tr><td>${O('Fabrikam Utilities')}</td><td>${P('iban', k.ibanFR())}</td></tr><tr><td>${N(TOMASZ)}</td><td>${P('iban', k.ibanDE())}</td></tr></table>
      <div class="dim" style="margin-top:14px">Customer number ${P('id', '7741 0293 55')} · Help ${P('phone', '+49 30 23125 678', { region: 'DE' })}</div>
      <div class="dim" style="margin-top:6px">Rate ${O('1 EUR = 0.8412 GBP')} · ${O('23/11/2026 14:05')}</div></div></div></div>`
  }
}

function sceneChat(v, t, k) {
  const msg = (who, time, body) => `<div class="msg"><div class="av"></div><div><div><span class="b">${who}</span> <span class="dim">${O(time)}</span></div><div>${body}</div></div></div>`
  if (v === 0) {
    return {
      css: `.wrap{position:absolute;inset:0;display:flex}.chs{width:260px;background:${t.panel};padding:14px 10px}.chs div{padding:4px 10px;border-radius:5px}.chs .on{background:${t.accent};color:#fff}.feed{padding:14px 22px;display:flex;flex-direction:column;gap:14px}.msg{display:flex;gap:12px}.av{width:36px;height:36px;border-radius:6px;background:${t.panel2};flex:none}.code{font-family:'JetBrains Mono',monospace;background:${t.panel2};padding:2px 6px;border-radius:4px;font-size:13px}`,
      html: `<div class="wrap"><div class="chs"><div class="b" style="font-size:16px;margin-bottom:10px">Acme Cloud</div><div># general</div><div class="on"># deploys</div><div># support</div><div style="margin-top:12px" class="dim">Direct messages</div><div>${N(AISHA)}</div><div>${O('Daniel Okafor')}</div></div>
      <div class="col grow"><div class="titlebar" style="height:44px;font-size:15px"><span class="b"># deploys</span><span>${O('14 members')}</span></div><div class="feed grow">
      ${msg(N(PRIYA), '10:02', `Staging is down again, can someone check the bot? token is <span class="code">${P('key', k.xoxb())}</span>`)}
      ${msg(N(TOMASZ), '10:04', `Rotated. New user token <span class="code">${P('key', k.xoxp())}</span>, don't paste it anywhere else pls`)}
      ${msg(O('Daniel Okafor'), '10:06', `fyi the office wifi password is ${P('password', 'Sunflower-2291')} for the visitors today`)}
      ${msg(N(AISHA), '10:09', `Customer called about refund ${O('RF-20931')}, number is ${P('phone', '+880 1712-345681', { region: 'BD' })}, email ${P('email', 'aisha.rahman@example.org')}`)}
      ${msg(N(PRIYA), '10:12', `Webhook for alerts: <span class="code">https://hooks.slack.com/services/${P('linkToken', k.slackHookPath())}</span>`)}
      ${msg(N(TOMASZ), '10:15', `Deploy ${O('2.31.0')} is out, ${O('0 errors')} in the last ${O('15 min')}. Commit ${O('e4b1c9a')}`)}
      ${msg(N(JORDAN), '10:17', `PIN for the shared phone is ${P('password', '2580')}, card for the ads account ends ${O('4242')}`)}
      </div><div style="padding:12px 22px"><div class="field dim">Message #deploys</div></div></div>
      ${toast('Authenticator', 'Sign-in request', `Code ${P('code', '804 233')} · ${O('Windows 11, Chrome')}`)}</div>`
    }
  }
  return {
    css: `.wrap{position:absolute;inset:0;display:flex;font-family:'Liberation Sans',sans-serif}.chs{width:300px;background:${t.panel};border-right:1px solid ${t.border}}.chs div{padding:12px 16px;border-bottom:1px solid ${t.border}}.chs .on{background:${t.sel}}.feed{padding:18px 26px;display:flex;flex-direction:column;gap:12px}.bub{max-width:640px;padding:10px 14px;border-radius:12px;background:${t.panel}}.me{align-self:flex-end;background:${t.sel}}`,
    html: `<div class="wrap"><div class="chs"><div class="b">Chats</div><div class="on">${N(MEI)}</div><div>${N(JORDAN)}</div><div>${O('Sofia Rossi')}</div><div>${O('Facilities')}</div></div>
    <div class="col grow"><div class="titlebar" style="height:48px;font-size:15px;color:inherit"><span class="b">${N(MEI)}</span><span class="dim">Active now</span></div><div class="feed grow">
    <div class="bub">Can you send me the login for the shared drive?</div>
    <div class="bub me">user: ${P('email', 'team@fabrikam.example')} password: ${P('password', 'Drive!Share-907')}</div>
    <div class="bub">And the API key for the maps thing</div>
    <div class="bub me">${P('key', k.gcp())}</div>
    <div class="bub">thanks! also my new number is ${P('phone', '+61 2 5550 1299', { region: 'AU' })}</div>
    <div class="bub me">Got it. Meeting moved to ${O('3:30 pm')}, room ${O('4.12')}. Here is the doc: https://docs.fabrikam.example/d/${O('q3-plan')}?share_token=${P('linkToken', k.alnum(28))}</div>
    <div class="bub me">card for the hotel: ${P('card', k.mastercard())} exp ${O('04/28')}</div>
    <div class="bub">The parcel tracking is ${O('1Z999AA10123456784')} and order ${O('#58812')}</div>
    </div><div style="padding:12px 22px"><div class="field dim">Type a message</div></div></div></div>`
  }
}

function sceneDocs(v, t, k) {
  if (v === 0) {
    return {
      css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;font-family:'Liberation Sans',sans-serif}.main{padding:22px 60px;max-width:1180px}p{margin:8px 0}pre{background:${t.panel};padding:12px 14px;border-radius:6px;font-family:'JetBrains Mono',monospace;font-size:13px;margin:8px 0;white-space:pre-wrap}h2{font-size:22px;margin:6px 0 8px}h3{font-size:17px;margin:14px 0 4px}`,
      html: `<div class="wrap">${browserChrome(t, ['Authentication · Acme API docs'], 'https://docs.acme-cloud.io/api/v2/authentication')}
      <div class="main"><h2>Authentication</h2>
      <p>Send your API key in the Authorization header. Keys look like ${O('sk_live_...')} and test keys like ${O('sk_test_...')}. Never share your secret key.</p>
      <pre>curl https://api.acme-cloud.io/v2/charges \\\n  -H "Authorization: Bearer ${O('YOUR_API_KEY')}" \\\n  -d amount=${O('2000')} -d currency=${O('usd')}</pre>
      <p>Replace ${O('<token>')} with a token from the dashboard. A token such as ${O('xoxb-XXXXXXXXXXXX')} is only an example.</p>
      <h3>Versions</h3><p>The current version is ${O('2.31.0')} (released ${O('2026-11-20')}, commit ${O('e4b1c9a7d02f3e19ac0b4')}). Request IDs look like ${O('req_9Hq2LmT4vB')}.</p>
      <p>Object IDs are UUIDs, for example ${O('550e8400-e29b-41d4-a716-446655440000')}. Webhook events retry for ${O('72 hours')}.</p>
      <h3>Limits</h3><p>${O('600 requests per minute')} per key; bursts up to ${O('1,000')}. Files up to ${O('250 MB')}. The sandbox IP is ${O('203.0.113.10')}.</p>
      <p>Pricing: ${O('$0.30')} per call over ${O('10,000')} a month. ISBN of the printed guide: ${O('978-0-13-468599-1')}.</p>
      <h3>Contact</h3><p>Security reports: ${P('email', 'security@acme-cloud.io')} · Sales: ${P('phone', '+1 415 555 0100', { region: 'US' })}</p>
      <p class="dim">Example card for tests: ${O('4242 4242 4242 4242')} (always declined in live mode). Example IBAN format: ${O('GB00 XXXX 0000 0000 0000 00')}.</p></div></div>`
    }
  }
  return {
    css: `.wrap{position:absolute;inset:0;display:flex;flex-direction:column}.main{padding:20px 44px}li{margin:4px 0 4px 18px}h2{font-size:22px;margin-bottom:8px}h3{font-size:16px;margin:12px 0 4px}`,
    html: `<div class="wrap">${browserChrome(t, ['Release notes · Flown'], 'https://flown.example/releases/3.2')}
    <div class="main"><h2>Release ${O('3.2.0')}</h2><div class="dim">${O('23 November 2026')} · build ${O('3.2.0+20261123.4')}</div>
    <h3>New</h3><ul><li>Exports up to ${O('7680x2160')} at ${O('60 fps')}</li><li>Chapters from captions (${O('beta')})</li><li>Keyboard shortcut ${O('Ctrl+Shift+E')}</li></ul>
    <h3>Fixed</h3><ul><li>Crash when the path had ${O('260')} characters (${O('#2211')})</li><li>Colour ${O('#1E90FF')} was off by one in GIFs</li><li>Memory use dropped from ${O('1.4 GB')} to ${O('610 MB')}</li></ul>
    <h3>Thanks</h3><p>Reported by ${N(MEI)} and ${O('Kenji Watanabe')}. Contact ${P('email', 'releases@flown.example')}.</p>
    <p class="dim">SHA-256 ${O('9f86d081884c7d659a2feaa0c55ad015')}… · Size ${O('148.2 MB')}</p></div></div>`
  }
}

/** The 24 frames: [scene, variant, theme, scale]. */
export const FRAMES = [
  ['editor', 0, 'dark', 1.0, sceneEditor],
  ['editor', 1, 'light', 1.25, sceneEditor],
  ['editor-small', 0, 'dark', 1.0, sceneEditorSmall],
  ['editor-small', 1, 'light', 1.5, sceneEditorSmall],
  ['terminal', 0, 'dark', 1.0, sceneTerminal],
  ['terminal', 1, 'light', 1.25, sceneTerminal],
  ['logs', 0, 'dark', 1.0, sceneLogs],
  ['logs', 1, 'light', 1.5, sceneLogs],
  ['dashboard', 0, 'light', 1.0, sceneDashboard],
  ['dashboard', 1, 'dark', 1.25, sceneDashboard],
  ['crm', 0, 'light', 1.5, sceneCrm],
  ['crm', 1, 'dark', 1.0, sceneCrm],
  ['inbox', 0, 'light', 1.0, sceneInbox],
  ['inbox', 1, 'dark', 1.5, sceneInbox],
  ['settings', 0, 'light', 1.25, sceneSettings],
  ['settings', 1, 'dark', 1.0, sceneSettings],
  ['twofa', 0, 'light', 1.0, scene2fa],
  ['twofa', 1, 'dark', 1.25, scene2fa],
  ['checkout', 0, 'light', 1.5, sceneCheckout],
  ['checkout', 1, 'dark', 1.0, sceneCheckout],
  ['chat', 0, 'dark', 1.0, sceneChat],
  ['chat', 1, 'light', 1.25, sceneChat],
  ['docs', 0, 'light', 1.0, sceneDocs],
  ['docs', 1, 'dark', 1.5, sceneDocs]
]

export { baseCss, esc, makeTokens }
