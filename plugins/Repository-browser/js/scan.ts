import { fetchRepo, listings } from './data'
import { flagged, scanRepo, serious } from './scanner'
import { ago, confirm, copyToClipboard, fail, formatBytes, h, logProblem, logText, modal, slash } from './shared'
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

const finding = ({ severity, reason, evidence }: Finding) => `[${severity.toUpperCase()}] ${reason}${evidence ? ` (${evidence})` : ''}`

// no "1." or "- " at the start of a line, Discord turns those into one long list
function scanReport(scan: RepoScan) {
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
		for (const item of serious(plugin)) lines.push(`\u2022 ${finding(item)}`)
	}
	return logText([...lines, '', 'Basic scan, it can miss threats.', ''])
}

function summary(scan: RepoScan) {
	const scanned = scan.plugins.filter(plugin => !plugin.skipped).length
	const bad = flagged(scan)
	const shown = bad.slice(0, 6)
	const parts = [
		scan.verdict === 'unknown'
			? 'No plugin could be downloaded and checked. Try again later.'
			: bad.length
				? `${bad.length} of ${scanned} plugins ${scan.verdict === 'dangerous' ? 'have serious red flags' : 'look suspicious'}.`
				: `No red flags found in ${scanned} plugins.`,
		...shown.map((plugin, index) => `${index + 1}. ${plugin.name} ${plugin.version}\n${serious(plugin).map(item => `- ${finding(item)}`).join('\n')}`),
	]
	if (bad.length > shown.length) parts.push(`And ${bad.length - shown.length} more. Copy the logs to see everything.`)
	if (scanned < scan.plugins.length && scan.verdict !== 'unknown') parts.push(`${scan.plugins.length - scanned} could not be scanned.`)
	parts.push('This is a basic check of the plugin code. It can miss threats, so it does not prove a plugin is safe.')
	return parts.join('\n\n')
}

export function showScan(scan: RepoScan, again: () => void) {
	modal(`${VERDICTS[scan.verdict]} \u2022 ${scan.name}`, `${summary(scan)}\n\nScanned ${ago(scan.at)}`, Button => [
		h(Button, { key: 'ok', text: 'OK', variant: 'secondary' }),
		flagged(scan).length ? h(Button, { key: 'copy', text: 'Copy logs', variant: 'tertiary', onPress: () => copyToClipboard(scanReport(scan)) }) : null,
		h(Button, { key: 'again', text: 'Scan again', variant: 'tertiary', onPress: again }),
	])
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
