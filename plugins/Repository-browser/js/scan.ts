import { fetchRepo, listings } from './data'
import { details, flagged, scanRepo, serious } from './scanner'
import { confirm, fail, formatBytes, logProblem, logText, slash } from './shared'
import type { Finding, RepoScan, Verdict } from './scanner'
import type { Repo } from './shared'

export const scans = new Map<string, RepoScan>()
export const lastScan = (url: string) => scans.get(slash(url))

export const VERDICTS: Record<Verdict, string> = {
	clean: 'No red flags found',
	suspicious: 'Suspicious',
	dangerous: 'Dangerous',
	unknown: 'Could not be scanned',
}

export const finding = ({ severity, reason, evidence }: Finding) => `[${severity.toUpperCase()}] ${reason}${evidence ? ` (${evidence})` : ''}`

// no "1." or "- " at the start of a line, Discord turns those into one long list
export function scanReport(scan: RepoScan) {
	const bad = flagged(scan)
	const scanned = scan.plugins.filter(plugin => !plugin.skipped).length
	const found = bad.flatMap(serious)
	const count = (severity: Finding['severity']) => found.filter(item => item.severity === severity).length
	const lines = [
		`Scan: ${scan.name}`,
		`Level: ${VERDICTS[scan.verdict]}`,
		`Repo: ${scan.url}`,
		scan.source && `Source: ${scan.source}`,
		`${scan.plugins.length} plugins, ${scanned} scanned, ${bad.length} detected (${count('high')} high, ${count('medium')} medium)`,
		`${new Date(scan.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
		'',
	]
	for (const [index, plugin] of bad.entries()) {
		if (index) lines.push('')
		lines.push(`${index + 1}) ${plugin.name} ${plugin.version} (${plugin.id}) - ${serious(plugin)[0].severity.toUpperCase()}`)
		for (const item of details(plugin)) lines.push(`\u2022 ${finding(item)}`)
	}
	return logText([...lines, '', 'Basic scan, it can miss threats.', ''])
}

// returns null when the person declines, cancels or the scan fails
export async function scanRepository(repo: Repo, name: string, signal: AbortSignal, onProgress: (done: number, total: number) => void) {
	const plugins = listings.get(repo.url)?.plugins ?? []
	const bytes = plugins.reduce((sum, plugin) => sum + (plugin.size ?? 0), 0)
	const what = plugins.length ? `each of its ${plugins.length} plugins` : 'each plugin'
	const text = `${name}\n\nThis downloads the newest version of ${what}${bytes ? ` (about ${formatBytes(bytes)})` : ''} and checks the code for token grabbers, data stealing and other red flags. Nothing is installed.`
	if (!(await confirm('Scan repository?', text, 'Scan'))) return null

	try {
		const index = await fetchRepo(repo.url)
		const result = await scanRepo({ url: repo.url, name, index }, signal, onProgress, (id, error) => logProblem(`scan ${id}`, error, [`Repository: ${repo.url}`]))
		result.source = repo.source
		scans.set(slash(repo.url), result)
		return result
	} catch (e) {
		if (!signal.aborted) fail(e, 'scan repository', [`Repository: ${repo.url}`])
		return null
	}
}
