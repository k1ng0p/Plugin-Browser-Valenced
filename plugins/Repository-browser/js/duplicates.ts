import type { ListedPlugin } from './shared'

export type Copy = { repoUrl: string; plugin: ListedPlugin }

const MIN_NAME = 4

export const normalizeName = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '')

// the same plugin on other repositories: the same name once spaces and symbols are ignored, or the same id
export function otherCopies(subject: Copy, all: Copy[]) {
	const name = normalizeName(subject.plugin.name)
	return all.filter(copy => copy.repoUrl !== subject.repoUrl && (copy.plugin.id === subject.plugin.id || (name.length >= MIN_NAME && normalizeName(copy.plugin.name) === name)))
}

export function compareVersion(a = '', b = '') {
	const left = a.match(/\d+/g)?.map(Number) ?? []
	const right = b.match(/\d+/g)?.map(Number) ?? []
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0)
		if (diff) return Math.sign(diff)
	}
	return 0
}

const jaccard = (a: Set<string>, b: Set<string>) => {
	let shared = 0
	for (const item of a) if (b.has(item)) shared++
	return a.size + b.size ? shared / (a.size + b.size - shared) : 0
}

const words = (text = '') => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g))

export const descriptionMatch = (a?: string, b?: string) => jaccard(words(a), words(b))

// runs of four tokens, so moved or renamed code still counts as the same code
function shingles(source: string) {
	const tokens = source.match(/[A-Za-z0-9_$]+/g) ?? []
	const set = new Set<string>()
	for (let index = 0; index + 4 <= tokens.length; index++) set.add(tokens.slice(index, index + 4).join(' '))
	return set
}

export const codeMatch = (a: string, b: string) => jaccard(shingles(a), shingles(b))

const STRING = /"((?:[^"\\\n]|\\.){12,200})"|'((?:[^'\\\n]|\\.){12,200})'/g

// text the person can read in the code (labels, messages), which hints at what a plugin offers
function readable(source: string) {
	const found = new Set<string>()
	for (const match of source.matchAll(STRING)) {
		const text = match[1] ?? match[2]
		if (/\s/.test(text) && /[a-z]{3}/i.test(text) && !/[{};=<>]|https?:/.test(text)) found.add(text)
	}
	return found
}

// the readable strings only this code has, longest first
export function onlyHere(here: string, there: string, limit = 5) {
	const other = readable(there)
	return [...readable(here)].filter(text => !other.has(text)).sort((a, b) => b.length - a.length).slice(0, limit)
}

// facts from the two listings, they say what differs and do not rank the copies
// facts from the two listings, they say what differs and do not rank the copies
// they only mean something for copies of the same plugin, a look-alike is a different plugin
export function differences(mine: ListedPlugin, theirs: ListedPlugin, sameOne = true) {
	if (!sameOne) return []
	const found: string[] = []
	const order = compareVersion(theirs.version, mine.version)
	if (order) found.push(`${order > 0 ? 'Newer' : 'Older'} version: ${theirs.version ?? 'unknown'} (this copy: ${mine.version ?? 'unknown'})`)
	if (mine.size && theirs.size && Math.abs(theirs.size - mine.size) / mine.size >= 0.1) found.push(`${theirs.size > mine.size ? 'Larger' : 'Smaller'} download: ${theirs.size} bytes (this copy: ${mine.size})`)
	if (mine.author !== theirs.author) found.push(`Different author: ${theirs.author ?? 'unknown'} (this copy: ${mine.author ?? 'unknown'})`)
	// every plugin needs the app itself, so that says nothing
	const extra = (theirs.requires ?? []).filter(item => item !== 'discord' && !item.startsWith('valenced.') && !(mine.requires ?? []).includes(item))
	if (extra.length) found.push(`Also needs: ${extra.join(', ')}`)
	return found
}

export type CopyKind = 'latest' | 'older' | 'same' | 'similar'

// what the badge on a card says: the newest copy is marked, an older one names where the newer one is
export function badgeFor(subject: ListedPlugin, others: Copy[], nameOf: (url: string) => string): { label: string; kind: CopyKind } {
	const newest = others.filter(copy => compareVersion(copy.plugin.version, subject.version) > 0).sort((a, b) => compareVersion(b.plugin.version, a.plugin.version))[0]
	if (newest) return { label: `Newer on ${nameOf(newest.repoUrl).slice(0, 20)}`, kind: 'older' }
	if (others.some(copy => compareVersion(subject.version, copy.plugin.version) > 0)) return { label: `Latest of ${others.length + 1} copies`, kind: 'latest' }
	return { label: `Also on ${others.length} repo${others.length === 1 ? '' : 's'}`, kind: 'same' }
}

const STOP = new Set(
	'the and for with from that this your you are can all any each every into more most only other some such than then them they will when which while not has have had its also one two use used using via per new set get see make lets let'.split(' '),
)

// words that mean the same thing for plugins, so "Are you sure?" prompts and a confirmation dialog end up as one term
const CONCEPTS: Record<string, string> = Object.fromEntries(
	Object.entries({
		confirm: 'confirm confirmation prompt dialog popup sure',
		skip: 'skip without bypass',
		hide: 'hide hidden remove declutter clutter clean cleanup',
		color: 'color colour hue pastel recolor colored',
		spoof: 'spoof fake',
		notify: 'notify notification toast alert',
		sound: 'sound audio',
		avatar: 'avatar pfp picture',
		translate: 'translate translation translator',
		clipboard: 'copy clipboard',
		logger: 'log logger logging',
		voice: 'voice call',
	}).flatMap(([concept, list]) => list.split(' ').map(word => [word, concept])),
)

function stem(word: string) {
	const base = word.replace(/(ations?|ings?|ed|es|s)$/, '')
	return (base.length >= 4 ? base : word).replace(/e$/, '')
}

export function terms(plugin: ListedPlugin) {
	const found = new Set<string>()
	for (const raw of `${plugin.name} ${plugin.description ?? ''}`.toLowerCase().match(/[a-z]{2,}/g) ?? []) {
		const concept = CONCEPTS[raw] ?? CONCEPTS[raw.replace(/s$/, '')]
		if (concept) found.add(concept)
		else if (!STOP.has(raw)) found.add(stem(raw))
	}
	return found
}

type Vector = { terms: Set<string>; norm: number }

export type Index = { weight: Map<string, number>; vectors: Map<ListedPlugin, Vector>; all: Copy[] }

// rare words count more than common ones, "message" is in half the plugins and says little
export function buildIndex(all: Copy[]): Index {
	const frequency = new Map<string, number>()
	const sets = new Map<ListedPlugin, Set<string>>()
	for (const { plugin } of all) {
		const found = terms(plugin)
		sets.set(plugin, found)
		for (const term of found) frequency.set(term, (frequency.get(term) ?? 0) + 1)
	}
	const weight = new Map([...frequency].map(([term, count]) => [term, Math.log(1 + all.length / count)]))
	const vectors = new Map([...sets].map(([plugin, found]) => [plugin, { terms: found, norm: Math.sqrt([...found].reduce((sum, term) => sum + (weight.get(term) ?? 0) ** 2, 0)) }]))
	return { weight, vectors, all }
}

const MIN_SHARED = 2
const MIN_SCORE = 0.3

// plugins that do much the same thing under another name, found from what their names and descriptions say
export function similarTo(subject: Copy, index: Index, skip: Copy[], limit = 3) {
	const mine = index.vectors.get(subject.plugin)
	if (!mine?.norm) return []
	return index.all
		.filter(copy => copy.repoUrl !== subject.repoUrl && !skip.includes(copy))
		.map(copy => {
			const theirs = index.vectors.get(copy.plugin)
			const shared = theirs ? [...mine.terms].filter(term => theirs.terms.has(term)) : []
			const dot = shared.reduce((sum, term) => sum + (index.weight.get(term) ?? 0) ** 2, 0)
			return { copy, shared, score: theirs?.norm ? dot / (mine.norm * theirs.norm) : 0 }
		})
		.filter(match => match.shared.length >= MIN_SHARED && match.score >= MIN_SCORE)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
}
