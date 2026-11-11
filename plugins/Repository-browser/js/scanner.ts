import { strFromU8, unzipSync } from 'fflate'

export type Severity = 'high' | 'medium' | 'low'
export type Finding = { severity: Severity; reason: string; evidence?: string }
export type PluginScan = { id: string; name: string; version: string; findings: Finding[]; skipped?: string }
export type Verdict = 'clean' | 'suspicious' | 'dangerous' | 'unknown'
export type RepoScan = { url: string; name: string; at: number; plugins: PluginScan[]; verdict: Verdict }

type Rule = { severity: Severity; reason: string; test: RegExp; evidence?: (match: string) => string }

const MAX_ZIP = 5 * 1024 * 1024
const MAX_FILE = 3 * 1024 * 1024
const PARALLEL = 3
const DOWNLOAD_TIMEOUT = 20000

const EXECUTABLE = /\.(exe|bat|cmd|sh|apk|scr|dll|vbs|ps1|msi)$/i
const NATIVE = /\.(jar|dex|so)$/i

// hosts a plugin can reasonably talk to, anything else is listed so it can be checked by hand
const TRUSTED_HOST = /(^|\.)(discord\.com|discordapp\.com|discordapp\.net|discord\.gg|github\.com|githubusercontent\.com|github\.io|valenced\.app|gstatic\.com|googleapis\.com)$/i

const RULES: Rule[] = [
	{
		severity: 'high',
		reason: 'Contains a Discord webhook address, a common way to send stolen data out',
		test: /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/i,
		evidence: () => 'Discord webhook address',
	},
	{ severity: 'high', reason: 'Contains a Telegram bot address, a common way to send stolen data out', test: /api\.telegram\.org\/bot/i, evidence: () => 'Telegram bot address' },
	{
		severity: 'high',
		reason: 'Contains the pattern of a Discord login token',
		test: /mfa\.[\w-]{80,}|[\w-]{24,28}\.[\w-]{6,7}\.[\w-]{27,38}/,
		evidence: match => `${match.slice(0, 6)}...`,
	},
	{
		severity: 'high',
		reason: 'Uses an IP logging service',
		test: /grabify\.link|iplogger\.(?:org|com|ru)|2no\.co|yip\.su|leancoding\.co|stopify\.co|joinmy\.site|catsnthings\.fun/i,
	},
	{
		severity: 'high',
		reason: 'Looks for Discord or browser data files where logins are stored',
		// written with character classes so this plugin's own code does not match its own rule
		test: /Local[ ]Storage[\\/]+level[d]b|discord_desktop_cor[e]|Login[ ]Dat[a]/,
	},
	{ severity: 'medium', reason: 'Reads your Discord login token', test: /\bgetToken\s*\(/ },
	{ severity: 'medium', reason: 'Runs code built from text while the app is running', test: /\beval\s*\(|new\s+Function\s*\(/ },
	{ severity: 'medium', reason: 'Connects to a raw IP address', test: /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}/ },
	{
		severity: 'medium',
		reason: 'Loads from a tunnel or paste site, its content can change at any time',
		test: /ngrok(?:-free)?\.(?:io|app|dev)|trycloudflare\.com|pastebin\.com\/raw|hastebin\.com\/raw|rentry\.co\/\w+\/raw|serveo\.net|loca\.lt/i,
	},
]

const OBFUSCATED = /_0x[0-9a-f]{4,6}\b/g
const URL_HOST = /https?:\/\/([a-z0-9.-]+)/gi

// the checks that need the whole script to be read together
export function scanSource(source: string, ownHost: string) {
	const findings: Finding[] = []
	for (const rule of RULES) {
		const match = source.match(rule.test)?.[0]
		if (match) findings.push({ severity: rule.severity, reason: rule.reason, evidence: (rule.evidence ?? ((text: string) => text.slice(0, 48)))(match) })
	}

	if ((source.match(OBFUSCATED)?.length ?? 0) >= 20) findings.push({ severity: 'medium', reason: 'Code is deliberately obfuscated, which hides what it does' })

	const hosts = [...new Set([...source.matchAll(URL_HOST)].map(match => match[1].toLowerCase().replace(/\.$/, '')))].filter(host => host.includes('.') && host !== ownHost && !TRUSTED_HOST.test(host))
	const readsToken = findings.some(finding => finding.reason === 'Reads your Discord login token')
	const runsText = findings.some(finding => finding.reason.startsWith('Runs code built from text'))

	if (hosts.length && readsToken) findings.push({ severity: 'high', reason: 'Reads your login token and also contacts outside servers', evidence: hosts.slice(0, 3).join(', ') })
	if (hosts.length && runsText) findings.push({ severity: 'high', reason: 'Can run code that comes from outside servers', evidence: hosts.slice(0, 3).join(', ') })
	if (hosts.length) findings.push({ severity: 'low', reason: `Contacts other servers: ${hosts.slice(0, 6).join(', ')}${hosts.length > 6 ? ` and ${hosts.length - 6} more` : ''}` })
	return findings
}

export function scanArchive(bytes: Uint8Array, expected: { id: string; size?: number; ownHost: string }) {
	const findings: Finding[] = []
	const tooLarge: string[] = []
	const files = unzipSync(bytes, {
		filter: file => {
			if (file.originalSize <= MAX_FILE) return true
			tooLarge.push(file.name)
			return false
		},
	})

	if (typeof expected.size === 'number' && expected.size !== bytes.length) {
		findings.push({ severity: 'medium', reason: `The file is ${bytes.length} bytes but the index says ${expected.size}, it may have been replaced after publishing` })
	}
	for (const name of tooLarge) findings.push({ severity: 'low', reason: `${name} is too large to read, it was not checked` })

	for (const name of Object.keys(files)) {
		if (EXECUTABLE.test(name)) findings.push({ severity: 'high', reason: 'Contains a program file that has no place in a plugin', evidence: name })
		else if (NATIVE.test(name)) findings.push({ severity: 'low', reason: `Contains native code (${name}), this scan cannot read it` })
	}

	if (files['manifest.json']) {
		const manifestId = (JSON.parse(strFromU8(files['manifest.json'])) as { id?: unknown }).id
		if (manifestId !== expected.id) findings.push({ severity: 'medium', reason: `The manifest id (${String(manifestId)}) does not match the id in the index`, evidence: expected.id })
	} else {
		findings.push({ severity: 'medium', reason: 'The archive has no manifest.json' })
	}

	for (const [name, data] of Object.entries(files)) {
		if (/\.(js|mjs|cjs)$/i.test(name)) findings.push(...scanSource(strFromU8(data), expected.ownHost))
	}
	return findings
}

export function verdictOf(plugins: PluginScan[]): Verdict {
	const scanned = plugins.filter(plugin => !plugin.skipped)
	if (!scanned.length) return 'unknown'
	const levels = scanned.flatMap(plugin => plugin.findings.map(finding => finding.severity))
	if (levels.includes('high')) return 'dangerous'
	return levels.includes('medium') ? 'suspicious' : 'clean'
}

const hostOf = (url: string) => url.match(/^https:\/\/([^/]+)/)?.[1].toLowerCase() ?? ''

async function download(url: string) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT)
	try {
		const res = await fetch(url, { signal: controller.signal })
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		if (Number(res.headers.get('content-length')) > MAX_ZIP) throw new Error('larger than 5 MB')
		const bytes = new Uint8Array(await res.arrayBuffer())
		if (bytes.length > MAX_ZIP) throw new Error('larger than 5 MB')
		return bytes
	} finally {
		clearTimeout(timer)
	}
}

type IndexPlugin = { name?: string; channels?: Record<string, string>; versions?: Record<string, { url?: string; size?: number }> }

// scans the newest build of every plugin in a repository's index, what could not be scanned says why
export async function scanRepo(repo: { url: string; name: string; index: { plugins: Record<string, IndexPlugin> } }, onProgress: (done: number, total: number) => void, onSkip: (id: string, error: unknown) => void) {
	const entries = Object.entries(repo.index.plugins)
	const plugins: PluginScan[] = []
	const ownHost = hostOf(repo.url)
	let next = 0
	let done = 0

	const scanOne = async ([id, plugin]: [string, IndexPlugin]) => {
		const version = plugin.channels?.latest ?? Object.values(plugin.channels ?? {})[0] ?? ''
		const build = plugin.versions?.[version]
		const result: PluginScan = { id, name: plugin.name || id, version, findings: [] }
		if (!build?.url || !/^https:\/\//.test(build.url)) {
			result.skipped = 'No download address in the index'
			return result
		}
		try {
			result.findings = scanArchive(await download(build.url), { id, size: build.size, ownHost })
		} catch (e) {
			result.skipped = (e as { name?: string } | null)?.name === 'AbortError' ? 'Download timed out' : ((e as { message?: string } | null)?.message ?? String(e)).split('\n')[0]
			onSkip(id, e)
		}
		if (/^(valenced|revenge)\./.test(id) && !/(^|\.)valenced\.app$/.test(ownHost)) result.findings.push({ severity: 'medium', reason: "Uses an id that looks like one of Valenced's own plugins" })
		return result
	}

	await Promise.all(
		Array.from({ length: PARALLEL }, async () => {
			while (next < entries.length) {
				plugins.push(await scanOne(entries[next++]))
				onProgress(++done, entries.length)
			}
		}),
	)

	plugins.sort((a, b) => a.name.localeCompare(b.name))
	return { url: repo.url, name: repo.name, at: Date.now(), plugins, verdict: verdictOf(plugins) } satisfies RepoScan
}
