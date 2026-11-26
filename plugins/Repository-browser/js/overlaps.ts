import { ActionSheetActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { React, ReactNative } from '@valenced/react'
import { Badge } from './components'
import { catalog, dependentsOf, listings, parseAuthor, readStore } from './data'
import { buildIndex, groupOverlaps, overlapsWith } from './duplicates'
import type { Copy } from './duplicates'
import { PluginByline, RefPage } from './sheets'
import { SELF_ID, fail, h, hostOf, logProblem, modal, slash } from './shared'
import type { ListedPlugin } from './shared'
import { readState, toggle, uninstall } from './valenced'
import type { InstalledPlugin } from './valenced'

const OVERLAP_SHEET = 'plugin-browser-overlaps'

const asListed = (item: InstalledPlugin): ListedPlugin => ({ id: item.id, name: item.name, description: item.description, author: item.author, contributors: item.contributors, version: item.version })

const listingOf = (url: string) => [...listings].find(([key]) => slash(key) === slash(url))?.[1]

const repoName = (url: string) => listingOf(url)?.name ?? hostOf(url)

const where = (item: InstalledPlugin) => (item.repo ? `Installed from ${repoName(item.repo)}` : 'Installed from a file or an unknown source')

// every installed plugin gets a place of its own, so two of them are never taken for copies from one repository
const installedCopies = (list: InstalledPlugin[]): Copy[] => list.map(item => ({ repoUrl: `installed:${item.id}`, plugin: asListed(item) }))

// the listed plugins give the words their weight, an installed plugin takes the place of the listed one with its id
function corpus(installed: Copy[], extra: Copy[] = []) {
	const taken = new Set([...installed, ...extra].map(copy => copy.plugin.id))
	const listed = catalog.flatMap(repo => (listingOf(repo.url)?.plugins ?? []).filter(plugin => !taken.has(plugin.id)).map(plugin => ({ repoUrl: repo.url, plugin })))
	return buildIndex([...listed, ...installed, ...extra])
}

async function installedList() {
	return (await readState()).list.filter(item => item.id !== SELF_ID)
}

export type Found = { groups: { same: boolean; members: InstalledPlugin[] }[]; installed: Map<string, InstalledPlugin> }

export async function findOverlaps(): Promise<Found> {
	const list = await installedList()
	const copies = installedCopies(list)
	const groups = groupOverlaps(copies, corpus(copies)).map(group => ({ same: group.same, members: group.members.map(copy => list.find(item => item.id === copy.plugin.id) as InstalledPlugin) }))
	return { groups, installed: new Map(list.map(item => [item.id, item])) }
}

type Target = { repoUrl: string; plugin: Pick<ListedPlugin, 'id' | 'name'> }

// before installing, what is already installed (enabled or not) that the plugin would double up
export async function warnOverlap(items: Target[]) {
	if (readStore().overlapWarning === false) return true
	let list: InstalledPlugin[]
	try {
		list = await installedList()
	} catch (e) {
		logProblem('check installed plugins', e)
		return true
	}
	if (!list.length) return true

	const installed = installedCopies(list)
	const candidates = items.map(({ repoUrl, plugin }) => ({ repoUrl, plugin: listingOf(repoUrl)?.plugins.find(listed => listed.id === plugin.id) ?? plugin }))
	const index = corpus(installed, candidates)
	const hits = candidates
		.map(candidate => ({ candidate, ...overlapsWith(candidate, installed, index) }))
		.filter(hit => hit.same.length || hit.similar.length)
	if (!hits.length) return true

	const byId = (copy: Copy) => list.find(item => item.id === copy.plugin.id) as InstalledPlugin
	const describe = (copy: Copy) => {
		const item = byId(copy)
		return `\u2022 ${item.name} ${item.version} (${item.enabled ? 'enabled' : 'disabled'})\n  by ${parseAuthor(item.author).name}. ${where(item)}`
	}
	const text = hits
		.map(hit => [`${hit.candidate.plugin.name} from ${repoName(hit.candidate.repoUrl)}`, ...(hit.same.length ? ['Already installed:', ...hit.same.map(describe)] : []), ...(hit.similar.length ? ['Does much the same:', ...hit.similar.map(describe)] : [])].join('\n'))
		.join('\n\n')

	return new Promise<boolean>(done =>
		modal(hits.length === 1 ? (hits[0].same.length ? 'Already installed' : 'Similar plugin installed') : 'Some plugins overlap with installed ones', text, Button => [
			h(Button, { key: 'install', text: 'Install anyway', variant: 'destructive', onPress: () => done(true) }),
			h(Button, { key: 'cancel', text: 'Cancel', variant: 'secondary', onPress: () => done(false) }),
		], () => done(false)),
	)
}

function OverlapSheet() {
	const { View } = ReactNative
	const { BottomSheet, BottomSheetTitleHeader, Button, Card, Stack, Text } = Design
	const [found, setFound] = React.useState<Found | null>(null)
	const [busy, setBusy] = React.useState('')

	const load = () =>
		findOverlaps().then(setFound, error => {
			setFound({ groups: [], installed: new Map() })
			fail(error, 'find overlapping plugins')
		})

	React.useEffect(() => {
		load()
	}, [])

	const act = async (item: InstalledPlugin, run: () => Promise<unknown>) => {
		setBusy(item.id)
		try {
			await run()
		} finally {
			setBusy('')
			await load()
		}
	}

	const member = (item: InstalledPlugin, installed: Found['installed']) =>
		h(
			View,
			{ key: item.id, style: { marginTop: 16 } },
			h(
				View,
				{ style: { flexDirection: 'row', alignItems: 'center', gap: 8 } },
				h(Text, { variant: 'heading-sm/semibold', color: 'text-default', style: { flexShrink: 1 } }, `${item.name} ${item.version}`),
				h(Badge, { label: item.enabled ? 'Enabled' : 'Disabled' }),
			),
			h(PluginByline, { plugin: asListed(item) }),
			h(Text, { variant: 'text-xs/medium', color: 'text-muted' }, where(item)),
			h(
				View,
				{ style: { flexDirection: 'row', gap: 8, marginTop: 8 } },
				h(View, { style: { flex: 1 } }, h(Button, { text: item.enabled ? 'Disable' : 'Enable', variant: 'secondary', loading: busy === item.id, onPress: () => act(item, () => toggle(item.id, !item.enabled, item.name)) })),
				h(View, { style: { flex: 1 } }, h(Button, { text: 'Delete', variant: 'destructive', disabled: busy === item.id, onPress: () => act(item, () => uninstall(asListed(item), dependentsOf(item.id, installed))) })),
			),
		)

	const groups: Found['groups'] = found?.groups ?? []
	return h(
		BottomSheet,
		{ scrollable: true, header: h(BottomSheetTitleHeader, { title: 'Duplicate plugins' }) },
		h(
			RefPage,
			{ empty: '' },
			h(
				Stack,
				{ spacing: 16 },
				h(
					Card,
					{ border: 'strong', style: { padding: 16 } },
					h(Text, { variant: 'heading-md/semibold', color: groups.length ? 'text-feedback-warning' : 'text-default' }, found ? (groups.length ? `${groups.length} ${groups.length === 1 ? 'group' : 'groups'} of overlapping plugins` : 'No overlapping plugins found') : 'Checking installed plugins...'),
					h(Text, { variant: 'text-sm/medium', color: 'text-muted', style: { marginTop: 2 } }, 'Every installed plugin is checked, enabled or not. Ones with the same name or that do much the same are grouped, keep the one you prefer and disable or delete the others.'),
				),
				...groups.map(group =>
					h(
						Card,
						{ key: group.members.map(item => item.id).join('+'), border: 'strong', style: { padding: 16 } },
						h(Text, { variant: 'heading-md/semibold', color: 'text-default' }, group.same ? 'Same plugin installed more than once' : 'Plugins that do much the same'),
						...group.members.map(item => member(item, found?.installed ?? new Map())),
					),
				),
			),
		),
	)
}

export const openOverlapSheet = () => ActionSheetActionCreators.openLazy(Promise.resolve({ default: OverlapSheet }), OVERLAP_SHEET, {})
