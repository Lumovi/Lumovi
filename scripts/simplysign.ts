// Logs in to SimplySign Desktop on the release's Windows runner, so that signtool can sign with
// Lumovi's certificate. It's Certum's code signing in the cloud: the key never leaves Certum, and
// SimplySign Desktop, logged in, shows it to Windows as a smart card, its certificate in the
// user's store. The login is the account's email and a one-time code from the SimplySign app,
// made here from the secret the app was set up with: the otpauth:// link its QR code holds.
//
// WIN_SIMPLYSIGN_ID is the email, WIN_SIMPLYSIGN_OTP_URI the link, and WIN_CERTIFICATE_SHA1 the
// certificate's thumbprint, which it waits for.
import { createHash, createHmac } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// SimplySign Desktop, as Certum publishes it (support.certum.eu: software and libraries).
const VERSION = '9.4.4.92'
const SHA256 = '8ec420fc27798b86078b7bd02fe7152097e1b3005bab51820eaca8e57df84da3'
const APP = join(
  process.env.ProgramFiles ?? 'C:\\Program Files',
  'Certum',
  'SimplySign Desktop',
  'SimplySignDesktop.exe',
)

export interface Otp {
  secret: string
  algorithm: string
  digits: number
  period: number
}

/** What makes the codes, from the otpauth:// link (Google Authenticator's Key Uri Format). */
export function readLink(link: string): Otp {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    // Not the link, in what's thrown: it's the secret.
    throw new Error('WIN_SIMPLYSIGN_OTP_URI isn’t an otpauth:// link.')
  }
  const secret = url.searchParams.get('secret')
  if (url.protocol !== 'otpauth:' || !secret) {
    throw new Error('WIN_SIMPLYSIGN_OTP_URI isn’t an otpauth:// link with a secret.')
  }
  // SimplySign's codes are SHA-256's (the format's default is SHA-1).
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA256').toLowerCase()
  if (!['sha1', 'sha256', 'sha512'].includes(algorithm)) {
    throw new Error(`WIN_SIMPLYSIGN_OTP_URI’s codes are ${algorithm}’s, which isn’t made here.`)
  }
  return {
    secret,
    algorithm,
    digits: Number(url.searchParams.get('digits') ?? 6),
    period: Number(url.searchParams.get('period') ?? 30),
  }
}

/** The code for one period (counted from 1970): RFC 6238's TOTP. */
export function oneTimeCode(otp: Otp, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const hash = createHmac(otp.algorithm, base32(otp.secret)).update(message).digest()
  const offset = hash[hash.length - 1]! & 0xf
  const code = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** otp.digits
  return String(code).padStart(otp.digits, '0')
}

function base32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of text.toUpperCase().replace(/[\s=]/g, '')) {
    const index = alphabet.indexOf(char)
    if (index < 0) throw new Error('WIN_SIMPLYSIGN_OTP_URI’s secret isn’t base32.')
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

/** Windows PowerShell; what's secret goes in `env`, not its command line, which others can see. */
function powershell(script: string, env: Record<string, string> = {}): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim()
}

async function install(): Promise<void> {
  const file = `SimplySignDesktop-${VERSION}-64-bit-en.msi`
  const url = `https://files.certum.eu/software/SimplySignDesktop/Windows/${VERSION}/${file}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`files.certum.eu answered ${response.status} for ${file}.`)
  const msi = Buffer.from(await response.arrayBuffer())
  const got = createHash('sha256').update(msi).digest('hex')
  if (got !== SHA256) throw new Error(`${file} isn’t Certum’s: its SHA-256 is ${got}.`)
  const path = join(process.env.RUNNER_TEMP!, file)
  writeFileSync(path, msi, { flag: 'wx' })
  const run = spawnSync('msiexec.exe', ['/i', path, '/qn', '/norestart'])
  // 3010: installed, with a restart asked for, which signing does without.
  if (run.status !== 0 && run.status !== 3010) {
    throw new Error(`SimplySign Desktop didn’t install: msiexec exited with ${run.status}.`)
  }
  if (!existsSync(APP)) throw new Error(`SimplySign Desktop isn’t where it’s started from: ${APP}.`)
}

/** SimplySign Desktop's windows: its login, or what it says after. */
const WINDOWS = `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and
  ($_.ProcessName -like '*SimplySign*' -or $_.MainWindowTitle -like '*SimplySign*') }`

/** Started afresh, with its login open: its first start puts it in the notification area. */
async function openLogin(): Promise<void> {
  powershell(`Get-Process *SimplySign* | Stop-Process -Force`)
  for (let start = 0; start < 2; start++) {
    spawn(APP, { detached: true, stdio: 'ignore' }).unref()
    await sleep(3000)
  }
  for (let wait = 0; wait < 30; wait++) {
    if (powershell(`[bool](${WINDOWS})`) === 'True') return
    await sleep(1000)
  }
  throw new Error('SimplySign Desktop’s login didn’t open.')
}

/** The email, a tab, the code and Enter, typed into its login. */
const TYPE = `
Add-Type -Namespace Lumovi -Name Window -MemberDefinition '
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);'
$app = ${WINDOWS} | Select-Object -First 1
[void][Lumovi.Window]::ShowWindow($app.MainWindowHandle, 9)
[void][Lumovi.Window]::SetForegroundWindow($app.MainWindowHandle)
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate($app.Id)
Start-Sleep -Milliseconds 500
foreach ($keys in @('^a', $env:SIMPLYSIGN_ID, '{TAB}', '^a', $env:SIMPLYSIGN_CODE, '{ENTER}')) {
  $shell.SendKeys($keys)
  Start-Sleep -Milliseconds 200
}`

/** What was on screen, for a login that didn't work: its windows, and a screenshot. */
function describeScreen(): string {
  const path = join(process.env.RUNNER_TEMP!, 'simplysign.png')
  return powershell(
    `Get-Process | Where-Object MainWindowTitle | ForEach-Object { "$($_.ProcessName): $($_.MainWindowTitle)" }
    try {
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $image = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
      [System.Drawing.Graphics]::FromImage($image).CopyFromScreen($screen.Left, $screen.Top, 0, 0, $image.Size)
      $image.Save($env:SCREENSHOT)
      "(A screenshot: $env:SCREENSHOT)"
    } catch { "(No screenshot: $_)" }`,
    { SCREENSHOT: path },
  )
}

async function login(id: string, otp: Otp, sha1: string): Promise<void> {
  const loggedIn = `[bool](Get-Item -LiteralPath Cert:\\CurrentUser\\My\\${sha1} -ErrorAction SilentlyContinue).HasPrivateKey`
  // SendKeys' own characters, typed as themselves.
  const keys = id.replace(/[+^%~(){}[\]]/g, '{$&}')
  let used = -1
  // Twice at most: too many wrong codes could lock the account.
  for (let attempt = 1; attempt <= 2; attempt++) {
    await openLogin()
    // A code not used yet, with time left to be typed and checked: else the next period's.
    const now = Date.now() / 1000
    let counter = Math.floor(now / otp.period)
    const left = otp.period - (now % otp.period)
    if (counter === used || left < 15) {
      await sleep(left * 1000 + 250)
      counter++
    }
    used = counter
    powershell(TYPE, { SIMPLYSIGN_ID: keys, SIMPLYSIGN_CODE: oneTimeCode(otp, counter) })
    for (let wait = 0; wait < 30; wait++) {
      await sleep(2000)
      if (powershell(loggedIn) === 'True') return
    }
    console.log(`SimplySign Desktop isn’t logged in (attempt ${attempt} of 2).`)
  }
  throw new Error(`SimplySign Desktop didn’t log in. On screen:\n${describeScreen()}`)
}

if (import.meta.main) {
  const {
    WIN_SIMPLYSIGN_ID: id,
    WIN_SIMPLYSIGN_OTP_URI: link,
    WIN_CERTIFICATE_SHA1: sha1,
  } = process.env
  if (!id || !link || !sha1) {
    throw new Error(
      'WIN_SIMPLYSIGN_ID, WIN_SIMPLYSIGN_OTP_URI and WIN_CERTIFICATE_SHA1 are needed.',
    )
  }
  const otp = readLink(link)
  // GitHub hides the link in the log, but not the secret on its own.
  console.log(`::add-mask::${otp.secret}`)
  await install()
  await login(id, otp, sha1.toUpperCase())
  console.log(`SimplySign Desktop is logged in: ${sha1} is in the user’s store.`)
}
