import { fetchRepo, listings } from './data'
import { flagged, scanRepo, serious } from './scanner'
import { confirm, errorMessage, fail, formatBytes, logProblem, logText, slash } from './shared'
import type { Finding, PluginScan, RepoScan, Verdict } from './scanner'
import type { Repo } from './shared'

export type AllScan = { at: number; entries: { repo: Repo; scan: RepoScan }[] }

export const scans = new Map<string, RepoScan>()
export const lastScan = (url: string) => scans.get(slash(url))

let lastAll: AllScan | null = null
export const lastAllScan = () => lastAll

export const VERDICTS: Record<Verdict, string> = {
	clean: 'No red flags found',
	suspicious: 'Suspicious',
	dangerous: 'Dangerous',
	unknown: 'Could not be scanned',
}

export const finding = ({ severity, reason, evidence }: Finding) => `[${severity.toUpperCase()}] ${reason}${evidence ? ` (${evidence})` : ''}`

export function counts(list: RepoScan[]) {
	const found = list.flatMap(scan => flagged(scan).flatMap(serious))
	return {
		plugins: list.reduce((sum, scan) => sum + scan.plugins.length, 0),
		scanned: list.reduce((sum, scan) => sum + scan.plugins.filter(plugin => !plugin.skipped).length, 0),
		detected: list.reduce((sum, scan) => sum + flagged(scan).length, 0),
		high: found.filter(item => item.severity === 'high').length,
		medium: found.filter(item => item.severity === 'medium').length,
	}
}

export function allVerdict(all: AllScan): Verdict {
	const found = all.entries.map(entry => entry.scan.verdict)
	return (['dangerous', 'suspicious', 'clean'] as const).find(verdict => found.includes(verdict)) ?? 'unknown'
}

const when = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
const summaryLine = (list: RepoScan[], prefix: string) => {
	const { plugins, scanned, detected, high, medium } = counts(list)
	return `${prefix}${plugins} plugins, ${scanned} scanned, ${detected} detected (${high} high, ${medium} medium)`
}

// Discord cuts messages at 2000 characters, so a log keeps what fits and says how much is left
const LOG_LIMIT = 1880

function fitted(head: string[], entries: string[][], tail: string[]) {
	let kept = 0
	while (kept < entries.length && logText([...head, ...entries.slice(0, kept + 1).flat(), ...tail]).length <= LOG_LIMIT) kept++
	const more = entries.length - kept
	return logText([...head, ...entries.slice(0, kept).flat(), ...(more ? [`...${more} more plugin${more === 1 ? '' : 's'} cut (Discord's 2000 limit), see the scan sheet`] : []), ...tail])
}

// repository names are in code style so they stand out from the plugin lines
const tag = (name: string) => `\`${name.replace(/`/g, "'")}\``

// one line per plugin, the code and the explanations are in the sheet
// no "1." or "- " at the start of a line, Discord turns those into one long list
const pluginLine = (plugin: PluginScan, index: number) => `${index + 1}) ${plugin.name} ${plugin.version} - ${serious(plugin)[0].severity.toUpperCase()}: ${[...new Set(serious(plugin).map(item => item.reason))].join('; ')}`

export const scanReport = (scan: RepoScan) =>
	fitted(
		[`Scan: ${tag(scan.name)}`, `Level: ${VERDICTS[scan.verdict]}`, `Repo: ${scan.url}`, ...(scan.source ? [`Source: ${scan.source}`] : []), `${summaryLine([scan], '')} - ${when(scan.at)}`, ''],
		flagged(scan).map((plugin, index) => [pluginLine(plugin, index)]),
		['Basic scan, it can miss threats.', ''],
	)

export function allScanReport(all: AllScan) {
	const scanned = all.entries.filter(entry => !entry.scan.error)
	const bad = scanned.filter(entry => flagged(entry.scan).length)
	const failed = all.entries.filter(entry => entry.scan.error)
	const clean = scanned.length - bad.length
	return fitted(
		['Scan: all repositories', `Level: ${VERDICTS[allVerdict(all)]}`, `${scanned.length} repos, ${summaryLine(scanned.map(entry => entry.scan), '')} - ${when(all.at)}`, ''],
		bad.flatMap(({ scan }, repoIndex) => {
			const own = counts([scan])
			const header = [...(repoIndex ? [''] : []), `${tag(scan.name)} (${own.high} high, ${own.medium} medium)`]
			return flagged(scan).map((plugin, index) => [...(index ? [] : header), pluginLine(plugin, index)])
		}),
		[...(clean ? [`Clean: ${clean} repos`] : []), ...(failed.length ? [`Not scanned: ${failed.map(entry => tag(entry.scan.name)).join(', ')}`] : []), 'Basic scan, it can miss threats.', ''],
	)
}

// shared by the single and the all-repositories scan
async function runRepoScan(repo: Repo, name: string, signal: AbortSignal, onProgress: (done: number, total: number) => void) {
	const index = await fetchRepo(repo.url)
	const result = await scanRepo({ url: repo.url, name, index }, signal, onProgress, (id, error) => logProblem(`scan ${id}`, error, [`Repository: ${repo.url}`]))
	result.source = repo.source
	scans.set(slash(repo.url), result)
	return result
}

const download = (repos: Repo[]) => {
	const plugins = repos.flatMap(repo => listings.get(repo.url)?.plugins ?? [])
	const bytes = plugins.reduce((sum, plugin) => sum + (plugin.size ?? 0), 0)
	return `${plugins.length ? `${plugins.length} plugins` : 'every plugin'}${bytes ? ` (about ${formatBytes(bytes)})` : ''}`
}

// returns null when the person declines, cancels or the scan fails
export async function scanRepository(repo: Repo, name: string, signal: AbortSignal, onProgress: (done: number, total: number) => void) {
	const text = `${name}\n\nThis downloads the newest version of ${download([repo])} and checks the code for token grabbers, data stealing and other red flags. Nothing is installed.`
	if (!(await confirm('Scan repository?', text, 'Scan'))) return null

	try {
		return await runRepoScan(repo, name, signal, onProgress)
	} catch (e) {
		if (!signal.aborted) fail(e, 'scan repository', [`Repository: ${repo.url}`])
		return null
	}
}

export async function scanAllRepositories(repos: { repo: Repo; name: string }[], signal: AbortSignal, onProgress: (done: number, total: number) => void) {
	const text = `Scanning all repositories will take time.\n\nThis downloads the newest version of ${download(repos.map(item => item.repo))} from ${repos.length} repositories and checks the code for token grabbers, data stealing and other red flags. Nothing is installed. You can cancel while it runs.`
	if (!(await confirm('Scan all repositories?', text, 'Scan all'))) return null

	const entries: AllScan['entries'] = []
	for (const [index, { repo, name }] of repos.entries()) {
		onProgress(index, repos.length)
		try {
			entries.push({ repo, scan: await runRepoScan(repo, name, signal, () => {}) })
		} catch (e) {
			if (signal.aborted) return null
			logProblem(`scan ${repo.url}`, e, [`Repository: ${repo.url}`])
			entries.push({ repo, scan: { url: repo.url, name, at: Date.now(), plugins: [], verdict: 'unknown', error: errorMessage(e).split('\n')[0] } })
		}
	}
	lastAll = { at: Date.now(), entries }
	return lastAll
}
