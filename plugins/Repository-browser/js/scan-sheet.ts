import { ActionSheetActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { ReactNative } from '@valenced/react'
import { VERDICTS, finding, scanReport } from './scan'
import { flagged, serious } from './scanner'
import type { Finding, PluginScan, RepoScan } from './scanner'
import { RefPage } from './sheets'
import { ago, copyToClipboard, h, logText, tap } from './shared'

const SCAN_SHEET = 'plugin-browser-scan'

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

function ScanSheet({ scan, again }: { scan: RepoScan; again: () => void }) {
	const { View } = ReactNative
	const { BottomSheet, BottomSheetTitleHeader, Button, Card, Stack, Text } = Design
	const bad = flagged(scan)
	const scanned = scan.plugins.filter(plugin => !plugin.skipped).length
	const found = bad.flatMap(serious)
	const stats = [
		{ label: 'High', value: found.filter(item => item.severity === 'high').length },
		{ label: 'Medium', value: found.filter(item => item.severity === 'medium').length },
		{ label: 'Clean', value: scanned - bad.length },
	]
	const notScanned = scan.plugins.length - scanned

	return h(
		BottomSheet,
		{ scrollable: true, header: h(BottomSheetTitleHeader, { title: scan.name }) },
		h(
			RefPage,
			{ empty: '' },
			h(
				Stack,
				{ spacing: 16 },
				h(
					Card,
					{ border: 'strong', style: { padding: 16 } },
					h(Text, { variant: 'heading-md/semibold', color: bad.length ? 'text-feedback-warning' : 'text-default' }, VERDICTS[scan.verdict]),
					h(Text, { variant: 'text-sm/medium', color: 'text-muted', style: { marginTop: 2 } }, `${scanned} of ${scan.plugins.length} plugins scanned ${ago(scan.at)}. Tap code to copy a finding.`),
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
						bad.length ? h(View, { style: { flex: 1 } }, h(Button, { text: 'Copy logs', variant: 'primary', onPress: () => copyToClipboard(scanReport(scan)) })) : null,
						h(
							View,
							{ style: { flex: 1 } },
							h(Button, {
								text: 'Scan again',
								variant: bad.length ? 'secondary' : 'primary',
								onPress: () => {
									ActionSheetActionCreators.hideActionSheet(SCAN_SHEET)
									again()
								},
							}),
						),
					),
				),
				...bad.map(plugin => {
					const contacts = plugin.findings.find(item => item.reason.startsWith('Contacts:'))
					return h(
						Card,
						{ key: plugin.id, border: 'strong', style: { padding: 16 } },
						h(Text, { variant: 'heading-sm/semibold', color: 'text-default' }, `${plugin.name} ${plugin.version}`),
						h(Text, { variant: 'text-xs/medium', color: 'text-muted' }, `${plugin.id} - ${serious(plugin)[0].severity.toUpperCase()} risk`),
						...serious(plugin).map((item, index) =>
							h(
								View,
								{ key: index, style: { marginTop: 16 } },
								h(Text, { variant: 'text-md/semibold', color: item.severity === 'high' ? 'text-feedback-warning' : 'text-default' }, `${item.severity.toUpperCase()} - ${item.reason}`),
								h(Text, { variant: 'text-sm/medium', color: 'text-muted', style: { marginTop: 2 } }, why(item)),
								codeBlock(item, () => copyFinding(plugin, item)),
							),
						),
						contacts ? h(Text, { variant: 'text-xs/medium', color: 'text-muted', style: { marginTop: 16 } }, contacts.reason) : null,
					)
				}),
				notScanned ? h(Text, { variant: 'text-sm/medium', color: 'text-muted' }, `${notScanned} could not be scanned.`) : null,
				h(Text, { variant: 'text-xs/medium', color: 'text-muted' }, 'This is a basic check of the plugin code. It can miss threats, so it does not prove a plugin is safe.'),
			),
		),
	)
}

export const openScanSheet = (scan: RepoScan, again: () => void) => ActionSheetActionCreators.openLazy(Promise.resolve({ default: ScanSheet }), SCAN_SHEET, { scan, again })
