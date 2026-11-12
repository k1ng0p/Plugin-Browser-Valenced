import { fetchRepo, listings } from './data'
import { scanRepo } from './scanner'
import type { PluginScan, RepoScan, Severity, Verdict } from './scanner'
import { ago, confirm, copyToClipboard, errorMessage, fail, formatBytes, h, logProblem, logText, modal, slash } from './shared'
import type { Repo } from './shared'

// results stay until the app restarts, a repository is scanned again on request
export const scans = new Map<string, RepoScan>()

export const lastScan = (url: string) => scans.get(slash(url))

export const VERDICTS: Record<Verdict, string> = {
	clean: 'No red flags found',
	suspicious: 'Suspicious',
	dangerous: 'Dangerous',
	unknown: 'Could not be scanned',
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
const MAX_SHOWN = 6

const flagged = (scan: RepoScan) =>
	scan.plugins
		.filter(plugin => plugin.findings.some(finding => finding.severity !== 'low'))
		.sort((a, b) => Math.min(...a.findings.map(f => ORDER[f.severity])) - Math.min(...b.findings.map(f => ORDER[f.severity])))

const seriousFindings = (plugin: PluginScan) => plugin.findings.filter(finding => finding.severity !== 'low').sort((a, b) => ORDER[a.severity] - ORDER[b.severity])

const RISK: Record<Severity, string> = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' }

const riskOf = (plugin: PluginScan) => RISK[seriousFindings(plugin)[0].severity]

// kept short on purpose, it gets pasted into chat
export function scanReport(scan: RepoScan) {
	const bad = flagged(scan)
	const scanned = scan.plugins.filter(plugin => !plugin.skipped).length
	const count = (severity: Severity) => bad.reduce((sum, plugin) => sum + plugin.findings.filter(finding => finding.severity === severity).length, 0)
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
		// no "1." or "- " at the start of a line, Discord turns those into one long numbered list
		if (index) lines.push('')
		lines.push(`${index + 1}) ${plugin.name} ${plugin.version} (${plugin.id}) - ${riskOf(plugin)}`)
		for (const finding of seriousFindings(plugin)) lines.push(`\u2022 [${RISK[finding.severity]}] ${finding.label ?? finding.reason}${finding.evidence ? ` (${finding.evidence})` : ''}`)
	}
	lines.push('', 'Basic scan, it can miss threats.', '')
	return logText(lines)
}

function summary(scan: RepoScan) {
	const scanned = scan.plugins.filter(plugin => !plugin.skipped).length
	const bad = flagged(scan)
	const parts: string[] = []

	if (scan.verdict === 'unknown') parts.push('No plugin could be downloaded and checked. Try again later.')
	else if (!bad.length) parts.push(`No red flags found in ${scanned} plugin${scanned === 1 ? '' : 's'}.`)
	else {
		parts.push(`${bad.length} of ${scanned} plugin${scanned === 1 ? '' : 's'} ${scan.verdict === 'dangerous' ? 'have serious red flags' : 'look suspicious'}.`)
		for (const [index, plugin] of bad.slice(0, MAX_SHOWN).entries()) {
			parts.push(`${index + 1}. ${plugin.name} ${plugin.version} (${riskOf(plugin)} risk)\n${seriousFindings(plugin).map(finding => `- ${finding.reason}${finding.evidence ? `\n  Found: ${finding.evidence}` : ''}`).join('\n')}`)
		}
		if (bad.length > MAX_SHOWN) parts.push(`And ${bad.length - MAX_SHOWN} more. Copy the logs to see everything.`)
	}

	const skipped = scan.plugins.length - scanned
	if (skipped && scan.verdict !== 'unknown') parts.push(`${skipped} could not be scanned.`)
	parts.push('This is a basic check of the plugin code. It can miss threats, so it does not prove a plugin is safe.')
	return parts.join('\n\n')
}

export function showScan(scan: RepoScan, again: () => void) {
	modal(`${VERDICTS[scan.verdict]} \u2022 ${scan.name}`, `${summary(scan)}\n\nScanned ${ago(scan.at)}`, Button =>
		[
		h(Button, { key: 'ok', text: 'OK', variant: 'secondary' }),
		flagged(scan).length ? h(Button, { key: 'copy', text: 'Copy logs', variant: 'tertiary', onPress: () => copyToClipboard(scanReport(scan)) }) : null,
		h(Button, { key: 'again', text: 'Scan again', variant: 'tertiary', onPress: again }),
	])
}

// every plugin is downloaded once, so the person is told how much data that is before it starts
export async function scanRepository(repo: Repo, name: string, onProgress: (done: number, total: number) => void) {
	const plugins = listings.get(repo.url)?.plugins ?? []
	const bytes = plugins.reduce((sum, plugin) => sum + (plugin.size ?? 0), 0)
	const size = bytes ? ` (about ${formatBytes(bytes)})` : ''
	if (!(await confirm('Scan repository?', `${name}\n\nThis downloads the newest version of each of its ${plugins.length || ''} plugins${size} and checks the code for token grabbers, data stealing and other red flags. Nothing is installed.`, 'Scan'))) return null

	try {
		const index = await fetchRepo(repo.url)
		const result = await scanRepo({ url: repo.url, name, index }, onProgress, (id, error) => logProblem(`scan ${id}`, error, [`Repository: ${repo.url}`, 'The plugin file could not be downloaded or opened for the scan']))
		result.source = repo.source
		scans.set(slash(repo.url), result)
		return result
	} catch (e) {
		fail(e, 'scan repository', [`Repository: ${repo.url}`, `Reason: ${errorMessage(e).split('\n')[0]}`])
		return null
	}
}
