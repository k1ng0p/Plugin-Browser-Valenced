import { ActionSheetActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { ReactNative } from '@valenced/react'
import { RepoAvatar } from './components'
import { freshAvatarEpoch, listings } from './data'
import { VERDICTS, allScanReport, allVerdict, counts, finding, scanReport } from './scan'
import type { AllScan } from './scan'
import { flagged, serious } from './scanner'
import type { Finding, PluginScan, RepoScan } from './scanner'
import type { Repo } from './shared'
import { RefPage } from './sheets'
import { ago, copyToClipboard, h, logText, tap } from './shared'

const WHY: Record<string, string> = {
	'Discord webhook': 'A webhook lets code post data to a Discord channel. Stolen data is often sent this way.',
	'Telegram bot address': 'Code can send data to a Telegram bot. This is a common way to send stolen data out.',
	'Token-like string': 'This text looks like a Discord login token.',
	'IP logger': 'These sites record who opens a link, including their IP address.',
	'Looks for stored logins': 'It looks for files where Discord or browsers keep logins.',
	'Touches login token': 'Your login token gives full access to your account. Most plugins never need it.',
	'Reads clipboard': 'It can read whatever you copied, such as passwords or wallet addresses.',
	'Decodes text while running': 'Hidden text is decoded when it runs, which can hide what the code really does.',
	'Link shortener': 'Short links hide where they lead, and the target can change later.',
	'Runs text as code': 'Code built from text can run anything, including code downloaded later.',
	'Raw IP address': 'It connects to a bare IP address instead of a named website.',
	'Tunnel or paste site': 'What these sites serve can change at any time without a plugin update.',
	'Obfuscated code': 'Names are scrambled on purpose, which makes the code hard to review.',
	'Token + outside servers': 'It can read your login token and reach servers that are not Discord or GitHub. This is how token stealers work.',
	'Clipboard + outside servers': 'It can read your clipboard and send it to outside servers.',
	'Hidden code + outside servers': 'It hides what its code does and also reaches outside servers.',
	'Program file in ZIP': 'A plugin has no reason to include a program file.',
	'Size differs from index': 'The file is not the size the repository says. It may have been replaced after publishing.',
	'Manifest id mismatch': 'The plugin says it is a different plugin than the one the index lists.',
	'No manifest.json': 'The archive has no manifest, so Valenced could not install it.',
	'Id mimics a Valenced plugin': "Its id looks like one of Valenced's own plugins, which could trick you.",
}

const why = (item: Finding) => (item.reason.startsWith('Contacts:') ? 'Servers it talks to. Check that you trust them.' : (WHY[item.reason] ?? ''))

// the explanation first, then where the match is and the code around it
const body = (item: Finding) => [why(item), item.where && `File: ${item.where}`, item.code && `Code: ${item.code}`].filter(Boolean).join('\n')

const copyFinding = (plugin: PluginScan, item: Finding) => {
	copyToClipboard(logText([`${plugin.name} ${plugin.version} (${plugin.id})`, finding(item), body(item)]))
	tap()
}

const mono = { fontFamily: ReactNative.Platform.OS === 'ios' ? 'Menlo' : 'monospace' }

// the matched part is bold and coloured inside the code around it
function codeBlock(item: Finding, onPress: () => void) {
	const { Pressable } = ReactNative
	const { Card, Text } = Design
	const code = item.code ?? item.evidence
	if (!code) return null
	const at = item.evidence ? code.indexOf(item.evidence) : -1
	const parts =
		at < 0 || !item.evidence
			? [code]
			: [code.slice(0, at), h(Text, { key: 'match', variant: 'text-sm/semibold', color: 'text-feedback-warning', style: mono }, item.evidence), code.slice(at + item.evidence.length)]

	return h(
		Pressable,
		{ onPress, style: { marginTop: 8 } },
		h(
			Card,
			{ style: { padding: 10 } },
			h(Text, { variant: 'text-xs/medium', color: 'text-muted', style: { marginBottom: 4 } }, item.where || 'Found'),
			h(Text, { variant: 'text-sm/medium', color: 'text-default', style: mono }, ...parts),
		),
	)
}

const SCAN_SHEET = 'plugin-browser-scan'
const ALL_SCAN_SHEET = 'plugin-browser-scan-all'

type Summary = { verdict: string; alarming: boolean; subtitle: string; stats: { label: string; value: number }[]; onCopy?: () => void; sheet: string; again: () => void }

function summaryCard({ verdict, alarming, subtitle, stats, onCopy, sheet, again }: Summary) {
	const { View } = ReactNative
	const { Button, Card, Text } = Design
	return h(
		Card,
		{ border: 'strong', style: { padding: 16 } },
		h(Text, { variant: 'heading-md/semibold', color: alarming ? 'text-feedback-warning' : 'text-default' }, verdict),
		h(Text, { variant: 'text-sm/medium', color: 'text-muted', style: { marginTop: 2 } }, subtitle),
		h(
			View,
			{ style: { flexDirection: 'row', marginTop: 12 } },
			stats.map(({ label, value }) =>
				h(
					View,
					{ key: label, style: { flex: 1, alignItems: 'center' } },
					h(Text, { variant: 'heading-lg/semibold', color: 'text-default' }, String(value)),
					h(Text, { variant: 'text-xs/medium', color: 'text-muted' }, label),
				),
			),
		),
		h(
			View,
			{ style: { flexDirection: 'row', gap: 8, marginTop: 12 } },
			onCopy ? h(View, { style: { flex: 1 } }, h(Button, { text: 'Copy logs', variant: 'primary', onPress: onCopy })) : null,
			h(
				View,
				{ style: { flex: 1 } },
				h(Button, {
					text: 'Scan again',
					variant: onCopy ? 'secondary' : 'primary',
					onPress: () => {
						ActionSheetActionCreators.hideActionSheet(sheet)
						again()
					},
				}),
			),
		),
	)
}

// a flagged plugin with its findings, the matched code stands out inside the code around it
function pluginBlock(plugin: PluginScan, compact: boolean) {
	const { View } = ReactNative
	const { Text } = Design
	const contacts = plugin.findings.find(item => item.reason.startsWith('Contacts:'))
	const gap = compact ? 10 : 16
	return h(
		View,
		{ key: plugin.id },
		h(Text, { variant: 'heading-sm/semibold', color: 'text-default' }, `${plugin.name} ${plugin.version}`),
		h(Text, { variant: 'text-xs/medium', color: 'text-muted' }, `${plugin.id} - ${serious(plugin)[0].severity.toUpperCase()} risk`),
		...serious(plugin).map((item, index) =>
			h(
				View,
				{ key: index, style: { marginTop: gap } },
				h(Text, { variant: 'text-md/semibold', color: item.severity === 'high' ? 'text-feedback-warning' : 'text-default' }, `${item.severity.toUpperCase()} - ${item.reason}`),
				h(Text, { variant: 'text-xs/medium', color: 'text-muted', style: { marginTop: 2 } }, why(item)),
				codeBlock(item, () => copyFinding(plugin, item)),
			),
		),
		contacts ? h(Text, { variant: 'text-xs/medium', color: 'text-muted', style: { marginTop: gap } }, contacts.reason) : null,
	)
}

const pluginCards = (scan: RepoScan) => flagged(scan).map(plugin => h(Design.Card, { key: plugin.id, border: 'strong', style: { padding: 16 } }, pluginBlock(plugin, false)))

function frame(title: string, children: unknown[]) {
	const { BottomSheet, BottomSheetTitleHeader, Stack } = Design
	return h(BottomSheet, { scrollable: true, header: h(BottomSheetTitleHeader, { title }) }, h(RefPage, { empty: '' }, h(Stack, { spacing: 16 }, ...children)))
}

const footer = (notScanned: number) => [
	notScanned ? h(Design.Text, { key: 'skipped', variant: 'text-sm/medium', color: 'text-muted' }, `${notScanned} could not be scanned.`) : null,
	h(Design.Text, { key: 'note', variant: 'text-xs/medium', color: 'text-muted' }, 'This is a basic check of the plugin code. It can miss threats, so it does not prove a plugin is safe.'),
]

function ScanSheet({ scan, again }: { scan: RepoScan; again: () => void }) {
	const { plugins, scanned, detected, high, medium } = counts([scan])
	return frame(scan.name, [
		summaryCard({
			verdict: VERDICTS[scan.verdict],
			alarming: detected > 0,
			subtitle: `${scanned} of ${plugins} plugins scanned ${ago(scan.at)}. Tap code to copy a finding.`,
			stats: [
				{ label: 'High', value: high },
				{ label: 'Medium', value: medium },
				{ label: 'Clean', value: scanned - detected },
			],
			onCopy: detected ? () => copyToClipboard(scanReport(scan)) : undefined,
			sheet: SCAN_SHEET,
			again,
		}),
		...pluginCards(scan),
		...footer(plugins - scanned),
	])
}

// a repository with detections is one card, so its plugins are plainly part of it, the others are a short list below
function AllScanSheet({ all, again }: { all: AllScan; again: () => void }) {
	const { View } = ReactNative
	const { Card, TableRow, TableRowGroup, Text } = Design
	const { plugins, scanned, detected, high, medium } = counts(all.entries.map(entry => entry.scan))
	const epoch = freshAvatarEpoch()
	const avatar = (repo: Repo) => h(RepoAvatar, { repo, listing: listings.get(repo.url), epoch })
	const bad = all.entries.filter(entry => flagged(entry.scan).length)
	const rest = all.entries.filter(entry => !flagged(entry.scan).length)

	return frame('All repositories', [
		summaryCard({
			verdict: VERDICTS[allVerdict(all)],
			alarming: detected > 0,
			subtitle: `${all.entries.filter(entry => !entry.scan.error).length} of ${all.entries.length} repositories, ${scanned} of ${plugins} plugins scanned ${ago(all.at)}. Tap code to copy a finding.`,
			stats: [
				{ label: 'High', value: high },
				{ label: 'Medium', value: medium },
				{ label: 'Clean', value: scanned - detected },
			],
			onCopy: detected ? () => copyToClipboard(allScanReport(all)) : undefined,
			sheet: ALL_SCAN_SHEET,
			again,
		}),
		...bad.map(({ repo, scan }) => {
			const own = counts([scan])
			return h(
				Card,
				{ key: repo.url, border: 'strong', style: { padding: 16 } },
				h(
					View,
					{ style: { flexDirection: 'row', alignItems: 'center' } },
					avatar(repo),
					h(
						View,
						{ style: { flex: 1, marginLeft: 12 } },
						h(Text, { variant: 'heading-md/semibold', color: 'text-default', numberOfLines: 1 }, scan.name),
						h(Text, { variant: 'text-xs/medium', color: 'text-feedback-warning' }, `${VERDICTS[scan.verdict]} \u2022 ${own.detected} of ${own.plugins} plugins \u2022 ${own.high} high, ${own.medium} medium`),
					),
				),
				...flagged(scan).map(plugin => h(View, { key: plugin.id, style: { marginTop: 16 } }, pluginBlock(plugin, true))),
			)
		}),
		rest.length
			? h(
					TableRowGroup,
					{ title: 'No detections' },
					rest.map(({ repo, scan }) =>
						h(TableRow, {
							key: repo.url,
							icon: avatar(repo),
							label: scan.name,
							subLabel: scan.error ? `Could not be scanned: ${scan.error}` : `${VERDICTS[scan.verdict]} \u2022 ${scan.plugins.length} plugins`,
							labelLineClamp: 1,
							subLabelLineClamp: 2,
						}),
					),
				)
			: null,
		...footer(plugins - scanned),
	])
}

export const openScanSheet = (scan: RepoScan, again: () => void) => ActionSheetActionCreators.openLazy(Promise.resolve({ default: ScanSheet }), SCAN_SHEET, { scan, again })

export const openAllScanSheet = (all: AllScan, again: () => void) => ActionSheetActionCreators.openLazy(Promise.resolve({ default: AllScanSheet }), ALL_SCAN_SHEET, { all, again })
