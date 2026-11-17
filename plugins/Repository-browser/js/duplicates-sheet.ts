import { ActionSheetActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { React, ReactNative } from '@valenced/react'
import { RepoAvatar } from './components'
import { catalog, fetchRepo, freshAvatarEpoch, listings, parseAuthor } from './data'
import { badgeFor, buildIndex, codeMatch, descriptionMatch, differences, onlyHere, otherCopies, similarTo } from './duplicates'
import type { Index } from './duplicates'
import type { Copy } from './duplicates'
import { download, readScripts } from './scanner'
import { RefPage } from './sheets'
import { copyToClipboard, fail, formatBytes, h, hostOf, slash, tap } from './shared'
import type { ListedPlugin, Repo } from './shared'

const DUPLICATES_SHEET = 'plugin-browser-duplicates'

const repoName = (url: string) => listings.get(url)?.name ?? hostOf(url)

let known: { key: string; index: Index } | null = null

// every plugin of the repositories on the list, rebuilt only when a listing changes
function everything() {
	const key = catalog.map(repo => `${repo.url}:${listings.get(repo.url)?.at ?? 0}:${listings.get(repo.url)?.plugins.length ?? 0}`).join('|')
	if (known?.key !== key) known = { key, index: buildIndex(catalog.flatMap(repo => (listings.get(repo.url)?.plugins ?? []).map(plugin => ({ repoUrl: repo.url, plugin })))) }
	return known.index
}

// the same plugin on other repositories, and plugins that do much the same under another name
export function relatedOf(repoUrl: string, plugin: ListedPlugin) {
	const index = everything()
	const subject = { repoUrl, plugin }
	const same = otherCopies(subject, index.all)
	return { same, similar: similarTo(subject, index, same).map(match => match.copy) }
}

// what a plugin card shows when it is on other repositories or has a look-alike
export function duplicateBadge(repo: Repo, plugin: ListedPlugin) {
	const { same, similar } = relatedOf(repo.url, plugin)
	const onPress = () => openDuplicatesSheet({ repo, plugin })
	if (same.length) return { ...badgeFor(plugin, same, repoName), onPress }
	return similar.length ? { label: `Similar: ${similar[0].plugin.name.slice(0, 22)}`, kind: 'similar' as const, onPress } : undefined
}

const sources = new Map<string, Promise<string>>()

// the script code of one listed version, kept for the session
function sourceOf(repo: Repo, plugin: ListedPlugin) {
	const key = `${slash(repo.url)}#${plugin.id}@${plugin.version}`
	let cached = sources.get(key)
	if (!cached) {
		cached = (async () => {
			const entry = (await fetchRepo(repo.url)).plugins[plugin.id]
			const url = entry?.versions?.[plugin.version ?? '']?.url ?? entry?.versions?.[entry?.channels?.latest]?.url
			if (!url) throw new Error('The index has no download address for it')
			return readScripts(await download(url, new AbortController().signal))
		})()
		sources.set(key, cached)
		cached.catch(() => sources.delete(key))
	}
	return cached
}

type Comparison = { match: number; sizes: [number, number]; mine: string[]; theirs: string[] }

const verdict = (match: number) => (match >= 0.7 ? 'looks like a copy or fork' : match >= 0.3 ? 'shares a lot of code' : 'is mostly different code')

function CodeCard({ text }: { text: string }) {
	const { Pressable } = ReactNative
	const { Card, Text } = Design
	return h(
		Pressable,
		{ onPress: () => { copyToClipboard(text); tap() }, style: { marginTop: 6 } },
		h(Card, { style: { padding: 10 } }, h(Text, { variant: 'text-sm/medium', color: 'text-default', style: { fontFamily: ReactNative.Platform.OS === 'ios' ? 'Menlo' : 'monospace' } }, text)),
	)
}

function CopyCard({ repo, plugin, copy, sameOne }: { repo: Repo; plugin: ListedPlugin; copy: Copy; sameOne: boolean }) {
	const { View } = ReactNative
	const { Button, Card, Text } = Design
	const [busy, setBusy] = React.useState(false)
	const [result, setResult] = React.useState<Comparison | null>(null)
	const theirRepo = catalog.find(item => item.url === copy.repoUrl)
	const name = repoName(copy.repoUrl)
	const named = (item: ListedPlugin) => ({ ...item, author: parseAuthor(item.author).name })
	const facts = differences(named(plugin), named(copy.plugin), sameOne)
	const same = descriptionMatch(plugin.description, copy.plugin.description)

	const compare = async () => {
		if (!theirRepo || busy) return
		setBusy(true)
		try {
			const [mine, theirs] = await Promise.all([sourceOf(repo, plugin), sourceOf(theirRepo, copy.plugin)])
			setResult({ match: codeMatch(mine, theirs), sizes: [mine.length, theirs.length], mine: onlyHere(mine, theirs), theirs: onlyHere(theirs, mine) })
		} catch (e) {
			fail(e, 'compare code', [`This copy: ${repo.url}`, `Other copy: ${copy.repoUrl}`])
		} finally {
			setBusy(false)
		}
	}

	const group = (title: string, strings: string[]) => [
		h(Text, { key: `${title}-title`, variant: 'text-sm/semibold', color: 'text-default', style: { marginTop: 12 } }, title),
		...(strings.length ? strings.map(text => h(CodeCard, { key: `${title}-${text}`, text })) : [h(Text, { key: `${title}-none`, variant: 'text-xs/medium', color: 'text-muted' }, 'No extra readable text found.')]),
	]

	return h(
		Card,
		{ border: 'strong', style: { padding: 16 } },
		h(
			View,
			{ style: { flexDirection: 'row', alignItems: 'center' } },
			theirRepo ? h(RepoAvatar, { repo: theirRepo, listing: listings.get(theirRepo.url), epoch: freshAvatarEpoch() }) : null,
			h(
				View,
				{ style: { flex: 1, marginLeft: 12 } },
				h(Text, { variant: 'heading-md/semibold', color: 'text-default', numberOfLines: 1 }, name),
				h(Text, { variant: 'text-xs/medium', color: 'text-muted' }, `${copy.plugin.name} \u2022 by ${parseAuthor(copy.plugin.author).name} \u2022 ${copy.plugin.version ?? 'no version'}${copy.plugin.size ? ` \u2022 ${formatBytes(copy.plugin.size)}` : ''}`),
			),
		),
		...(facts.length ? facts.map((fact, index) => h(Text, { key: index, variant: 'text-sm/medium', color: 'text-default', style: { marginTop: index ? 2 : 10 } }, `\u2022 ${fact}`)) : [h(Text, { key: 'same', variant: 'text-sm/medium', color: 'text-muted', style: { marginTop: 10 } }, sameOne ? 'Same version, size and author.' : 'Does much the same, matched by what the descriptions say.')]),
		h(Text, { variant: 'text-xs/medium', color: 'text-muted', style: { marginTop: 8 } }, `${copy.plugin.description ?? 'No description'}${sameOne ? `\n(${Math.round(same * 100)}% the same wording as this copy)` : ''}`),
		h(View, { style: { marginTop: 12 } }, h(Button, { text: result ? 'Compare again' : 'Compare code', variant: 'secondary', loading: busy, onPress: compare })),
		result
			? h(
					View,
					{ style: { marginTop: 12 } },
					h(Text, { variant: 'text-md/semibold', color: 'text-default' }, `${Math.round(result.match * 100)}% of the code matches, it ${verdict(result.match)}`),
					h(Text, { variant: 'text-xs/medium', color: 'text-muted' }, `Script size: ${formatBytes(result.sizes[1])} here, ${formatBytes(result.sizes[0])} in this copy`),
					...group(`Only in ${name}`, result.theirs),
					...group('Only in this copy', result.mine),
					h(Text, { variant: 'text-xs/medium', color: 'text-muted', style: { marginTop: 12 } }, 'These are texts found in the code. They hint at what each copy offers, they do not prove which one is better. Tap one to copy it.'),
				)
			: null,
	)
}

function DuplicatesSheet({ repo, plugin }: { repo: Repo; plugin: ListedPlugin }) {
	const { BottomSheet, BottomSheetTitleHeader, Card, Stack, Text } = Design
	const { same, similar } = relatedOf(repo.url, plugin)
	const where = `This copy is ${plugin.version ?? 'unversioned'} from ${repoName(repo.url)}.`
	const section = (title: string, text: string) => h(Card, { key: title, border: 'strong', style: { padding: 16 } }, h(Text, { variant: 'heading-md/semibold', color: 'text-default' }, title), h(Text, { variant: 'text-sm/medium', color: 'text-muted', style: { marginTop: 2 } }, text))
	const cards = (list: Copy[], sameOne: boolean) => list.map(copy => h(CopyCard, { key: `${copy.repoUrl}#${copy.plugin.id}`, repo, plugin, copy, sameOne }))

	return h(
		BottomSheet,
		{ scrollable: true, header: h(BottomSheetTitleHeader, { title: plugin.name }) },
		h(
			RefPage,
			{ empty: '' },
			h(
				Stack,
				{ spacing: 16 },
				same.length ? section(`Also on ${same.length} other ${same.length === 1 ? 'repository' : 'repositories'}`, `${where} Matched by name or id. The notes are facts from each listing, compare the code to see more.`) : null,
				...cards(same, true),
				similar.length ? section(`Similar plugin${similar.length === 1 ? '' : 's'}`, `${same.length ? '' : `${where} `}Different names, but the descriptions say they do much the same. Compare the code to see what each one offers.`) : null,
				...cards(similar, false),
			),
		),
	)
}

export const openDuplicatesSheet = (props: { repo: Repo; plugin: ListedPlugin }) => ActionSheetActionCreators.openLazy(Promise.resolve({ default: DuplicatesSheet }), DUPLICATES_SHEET, props)
