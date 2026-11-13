import { strFromU8, unzipSync } from 'fflate'

export type Severity = 'high' | 'medium' | 'low'
export type Finding = { severity: Severity; reason: string; evidence?: string; where?: string; code?: string }
export type PluginScan = { id: string; name: string; version: string; findings: Finding[]; skipped?: string }
export type Verdict = 'clean' | 'suspicious' | 'dangerous' | 'unknown'
export type RepoScan = { url: string; source?: string; name: string; at: number; plugins: PluginScan[]; verdict: Verdict }

type Rule = { severity: Severity; reason: string; test: RegExp; evidence?: (match: string) => string }
type IndexPlugin = { name?: string; channels?: Record<string, string>; versions?: Record<string, { url?: string; size?: number; sha256?: string }> }

const MAX_ZIP = 5 * 1024 * 1024
const MAX_FILE = 3 * 1024 * 1024
const MAX_UNPACKED = 20 * 1024 * 1024
// two at a time keeps memory low, each archive can unpack to 20 MB
const PARALLEL = 2
const CACHE_TTL = 10 * 60 * 1000
const DOWNLOAD_TIMEOUT = 20000

const EXECUTABLE = /\.(exe|bat|cmd|sh|apk|scr|dll|vbs|ps1|msi)$/i
const NATIVE = /\.(jar|dex|so)$/i
const TRUSTED_HOST = /(^|\.)(discord\.com|discordapp\.com|discordapp\.net|discord\.gg|github\.com|githubusercontent\.com|github\.io|valenced\.app|gstatic\.com|googleapis\.com|example\.(?:com|org|net))$/i
const OBFUSCATED = /_0x[0-9a-f]{4,6}\b/g
const URL_HOST = /https?:\/\/((?:[a-z0-9-]+\.)+[a-z0-9-]+)/gi
// a plugin whose index entry has not changed is not downloaded again for a while
const cache = new Map<string, { at: number; findings: Finding[] }>()
const TOKEN = 'Touches login token'
const CLIPBOARD = 'Reads clipboard'

const RULES: Rule[] = [
	{ severity: 'high', reason: 'Discord webhook', test: /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/i, evidence: () => 'Discord webhook address' },
	{ severity: 'high', reason: 'Telegram bot address', test: /api\.telegram\.org\/bot/i, evidence: () => 'Telegram bot address' },
	{ severity: 'high', reason: 'Token-like string', test: /mfa\.[\w-]{80,}|[\w-]{24,28}\.[\w-]{6,7}\.[\w-]{27,38}/, evidence: match => `${match.slice(0, 6)}...` },
	{ severity: 'high', reason: 'IP logger', test: /grabify\.link|iplogger\.(?:org|com|ru)|2no\.co|yip\.su|leancoding\.co|stopify\.co|joinmy\.site|catsnthings\.fun/i },
	// character classes keep this plugin's own code from matching its own rule
	{ severity: 'high', reason: 'Looks for stored logins', test: /Local[ ]Storage[\\/]+level[d]b|discord_desktop_cor[e]|Login[ ]Dat[a]/ },
	{ severity: 'medium', reason: TOKEN, test: /\b(?:get|set)Token\s*\(|\bloginToken\s*\(|Token[M]anager|Authentication[S]tore/ },
	{ severity: 'medium', reason: CLIPBOARD, test: /Clipboard\.getString/ },
	{ severity: 'medium', reason: 'Decodes text while running', test: /\batob\s*\(/ },
	{ severity: 'medium', reason: 'Link shortener', test: /\b(?:bit\.ly|tinyurl\.com|cutt\.ly|is\.gd|rb\.gy|shorturl\.at)\//i },
	{ severity: 'medium', reason: 'Runs text as code', test: /\beval\s*\(|new\s+Function\s*\(/ },
	{ severity: 'medium', reason: 'Raw IP address', test: /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}/ },
	{
		severity: 'medium',
		reason: 'Tunnel or paste site',
		test: /ngrok(?:-free)?\.(?:io|app|dev)|trycloudflare\.com|pastebin\.com\/raw|hastebin\.com\/raw|rentry\.co\/\w+\/raw|serveo\.net|loca\.lt/i,
	},
]

const EXCERPT = 50

const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

export const serious = (plugin: PluginScan) => plugin.findings.filter(finding => finding.severity !== 'low').sort((a, b) => rank[a.severity] - rank[b.severity])

// the places a flagged plugin talks to help judge it, so they are listed with its findings
export const details = (plugin: PluginScan) => [...serious(plugin), ...plugin.findings.filter(finding => finding.reason.startsWith('Contacts:'))]

export const flagged = (scan: RepoScan) => scan.plugins.filter(plugin => serious(plugin).length).sort((a, b) => rank[serious(a)[0].severity] - rank[serious(b)[0].severity])

function lineOf(source: string, index: number) {
	let line = 1
	for (let at = source.indexOf('\n'); at !== -1 && at < index; at = source.indexOf('\n', at + 1)) line++
	return line
}

// the code around a match, with the match itself replaced by what is safe to show
function excerpt(source: string, index: number, matched: string, shown: string) {
	const end = index + matched.length
	const code = `${source.slice(Math.max(0, index - EXCERPT), index)}${shown}${source.slice(end, end + EXCERPT)}`
	return `${index > EXCERPT ? '...' : ''}${code.replace(/\s+/g, ' ').trim()}${end + EXCERPT < source.length ? '...' : ''}`
}

export function scanSource(source: string, ownHost: string, file = '') {
	const findings: Finding[] = []
	for (const rule of RULES) {
		const match = rule.test.exec(source)
		if (!match) continue
		const shown = rule.evidence ? rule.evidence(match[0]) : match[0].slice(0, 48)
		findings.push({ severity: rule.severity, reason: rule.reason, evidence: shown, where: file && `${file}:${lineOf(source, match.index)}`, code: excerpt(source, match.index, match[0], shown) })
	}
	const scrambled = source.match(OBFUSCATED)?.length ?? 0
	if (scrambled >= 20) findings.push({ severity: 'medium', reason: 'Obfuscated code', evidence: `${scrambled} scrambled names`, where: file })

	const hosts = [...new Set([...source.matchAll(URL_HOST)].map(match => match[1].toLowerCase().replace(/\.$/, '')))].filter(host => host !== ownHost && !TRUSTED_HOST.test(host))
	const has = (reason: string) => findings.some(finding => finding.reason === reason)
	const hidden = has('Obfuscated code') || has('Decodes text while running')
	const combos: [boolean, string][] = [
		[has(TOKEN), 'Token + outside servers'],
		[has(CLIPBOARD), 'Clipboard + outside servers'],
		[hidden, 'Hidden code + outside servers'],
	]
	for (const [applies, reason] of combos) if (applies && hosts.length) findings.push({ severity: 'high', reason, evidence: hosts.slice(0, 3).join(', ') })
	if (hosts.length) findings.push({ severity: 'low', reason: `Contacts: ${hosts.slice(0, 6).join(', ')}${hosts.length > 6 ? ` and ${hosts.length - 6} more` : ''}` })
	return findings
}

export function scanArchive(bytes: Uint8Array, expected: { id: string; size?: number; ownHost: string }) {
	const findings: Finding[] = []
	let unpacked = 0
	const files = unzipSync(bytes, {
		filter: file => {
			if (file.originalSize <= MAX_FILE && (unpacked += file.originalSize) <= MAX_UNPACKED) return true
			findings.push({ severity: 'low', reason: `${file.name} too large to read` })
			return false
		},
	})

	if (expected.size !== undefined && expected.size !== bytes.length) findings.push({ severity: 'medium', reason: 'Size differs from index', evidence: `${bytes.length} instead of ${expected.size} bytes` })

	for (const name of Object.keys(files)) {
		if (EXECUTABLE.test(name)) findings.push({ severity: 'high', reason: 'Program file in ZIP', evidence: name })
		else if (NATIVE.test(name)) findings.push({ severity: 'low', reason: `Native code: ${name}` })
	}

	if (files['manifest.json']) {
		const manifestId = (JSON.parse(strFromU8(files['manifest.json'])) as { id?: unknown }).id
		if (manifestId !== expected.id) findings.push({ severity: 'medium', reason: 'Manifest id mismatch', evidence: String(manifestId) })
	} else {
		findings.push({ severity: 'medium', reason: 'No manifest.json' })
	}

	for (const [name, data] of Object.entries(files)) {
		if (/\.(js|mjs|cjs)$/i.test(name)) findings.push(...scanSource(strFromU8(data), expected.ownHost, name))
	}
	return findings
}

export function verdictOf(plugins: PluginScan[]): Verdict {
	const scanned = plugins.filter(plugin => !plugin.skipped)
	if (!scanned.length) return 'unknown'
	const levels = scanned.flatMap(serious).map(finding => finding.severity)
	if (levels.includes('high')) return 'dangerous'
	return levels.length ? 'suspicious' : 'clean'
}

const hostOf = (url: string) => url.match(/^https:\/\/([^/]+)/)?.[1].toLowerCase() ?? ''
const aborted = (message: string) => Object.assign(new Error(message), { name: 'AbortError' })

// XMLHttpRequest instead of fetch so a download can be cut off once it passes the size limit
function download(url: string, signal: AbortSignal) {
	return new Promise<Uint8Array>((resolve, reject) => {
		const xhr = new XMLHttpRequest()
		const stop = (error: Error) => {
			xhr.abort()
			reject(error)
		}
		xhr.responseType = 'arraybuffer'
		xhr.timeout = DOWNLOAD_TIMEOUT
		xhr.onprogress = event => event.loaded > MAX_ZIP && stop(new Error('larger than 5 MB'))
		xhr.onload = () => {
			if (xhr.status < 200 || xhr.status >= 300) reject(new Error(`HTTP ${xhr.status}`))
			else if (xhr.response.byteLength > MAX_ZIP) reject(new Error('larger than 5 MB'))
			else resolve(new Uint8Array(xhr.response))
		}
		xhr.onerror = () => reject(new Error('Network request failed'))
		xhr.ontimeout = () => reject(aborted('Download timed out'))
		signal.addEventListener('abort', () => stop(aborted('Scan cancelled')))
		xhr.open('GET', url)
		xhr.send()
	})
}

// scans the newest build of every plugin in the index, a plugin that can't be scanned says why
export async function scanRepo(repo: { url: string; name: string; index: { plugins: Record<string, IndexPlugin> } }, signal: AbortSignal, onProgress: (done: number, total: number) => void, onSkip: (id: string, error: unknown) => void) {
	const entries = Object.entries(repo.index.plugins)
	const plugins: PluginScan[] = []
	const ownHost = hostOf(repo.url)
	let next = 0

	const scanOne = async ([id, plugin]: [string, IndexPlugin]) => {
		const version = plugin.channels?.latest ?? Object.values(plugin.channels ?? {})[0] ?? ''
		const build = plugin.versions?.[version]
		const result: PluginScan = { id, name: plugin.name || id, version, findings: [] }
		if (!build?.url?.startsWith('https://')) {
			result.skipped = 'No download address in the index'
			return result
		}
		const key = build.sha256 && [ownHost, id, build.size, build.sha256].join(':')
		const hit = key ? cache.get(key) : undefined
		if (hit && Date.now() - hit.at < CACHE_TTL) {
			result.findings = [...hit.findings]
		} else {
			try {
				result.findings = scanArchive(await download(build.url, signal), { id, size: build.size, ownHost })
				if (key) cache.set(key, { at: Date.now(), findings: [...result.findings] })
			} catch (e) {
				result.skipped = (e as Error).message.split('\n')[0]
				if (!signal.aborted) onSkip(id, e)
			}
		}
		if (/^(valenced|revenge)\./.test(id) && !ownHost.endsWith('valenced.app')) result.findings.push({ severity: 'medium', reason: 'Id mimics a Valenced plugin' })
		return result
	}

	await Promise.all(
		Array.from({ length: PARALLEL }, async () => {
			while (next < entries.length && !signal.aborted) {
				plugins.push(await scanOne(entries[next++]))
				onProgress(plugins.length, entries.length)
			}
		}),
	)
	if (signal.aborted) throw aborted('Scan cancelled')

	plugins.sort((a, b) => a.name.localeCompare(b.name))
	const result: RepoScan = { url: repo.url, name: repo.name, at: Date.now(), plugins, verdict: verdictOf(plugins) }
	return result
}
