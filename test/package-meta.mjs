/**
 * Package metadata suite.
 *
 * The plugin manager renders a bundle's title and description from exported
 * locale resources, never from the manifest description on its own, so a
 * package without them shows no description at all. The suite pins what this
 * package publishes for that surface:
 *   1. locale/en.json parses and carries a non-empty meta.title and
 *      meta.description, the two fields the host rejects the whole read for
 *      when they are present but not a non-empty string.
 *   2. The locale directory holds en and zh, and every file in it carries both
 *      display fields, so no language falls back to the manifest for one field.
 *   3. exports maps ./locale/*.json and ./package.json, the resources the host
 *      resolves before it can read a title, a description or a fallback.
 *   4. files ships locale/*.json, so a packed install carries what the exports
 *      point at.
 *   5. Every locale file resolves from inside the package into one directory,
 *      which is how the host discovers the dictionaries beside the English one.
 *
 * The suite reads the package itself and uses the Node standard library only,
 * so it runs without a dsh install beside the checkout.
 */

import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const localeDir = join(packageRoot, 'locale')
const require = createRequire(import.meta.url)

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)

/** Parse a JSON file, returning undefined when it is unreadable or malformed. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Report whether a value is a non-empty string. */
const filled = (value) => typeof value === 'string' && value.trim() !== ''

/** Resolve one specifier from inside the package, returning undefined when Node refuses it. */
function resolveIn(specifier) {
  try {
    return require.resolve(specifier)
  } catch {
    return undefined
  }
}

async function main() {
  const manifest = await readJson(join(packageRoot, 'package.json'))
  if (manifest === undefined) {
    console.error('package.json is unreadable')
    process.exitCode = 1
    return
  }

  const languages = (await readdir(localeDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort()
  const locales = new Map()
  for (const language of languages) {
    locales.set(language, await readJson(join(localeDir, `${language}.json`)))
  }

  section('1. The English locale is the discovery entry')
  const english = locales.get('en')
  check('locale/en.json parses', english !== undefined)
  check('locale/en.json carries a meta object', typeof english?.meta === 'object' && english.meta !== null,
    JSON.stringify(english))
  check('locale/en.json meta.title is a non-empty string', filled(english?.meta?.title), JSON.stringify(english?.meta?.title))
  check('locale/en.json meta.description is a non-empty string', filled(english?.meta?.description),
    JSON.stringify(english?.meta?.description))

  section('2. Every locale file carries both display fields')
  check('the directory holds locale/en.json', languages.includes('en'), languages.join(','))
  check('the directory holds locale/zh.json', languages.includes('zh'), languages.join(','))
  for (const language of languages) {
    const meta = locales.get(language)?.meta
    check(`locale/${language}.json meta.title is a non-empty string`, filled(meta?.title), JSON.stringify(meta?.title))
    check(`locale/${language}.json meta.description is a non-empty string`, filled(meta?.description),
      JSON.stringify(meta?.description))
  }

  section('3. exports exposes the resources the host resolves')
  check("exports maps './locale/*.json'", manifest.exports?.['./locale/*.json'] === './locale/*.json',
    JSON.stringify(manifest.exports?.['./locale/*.json']))
  check("exports maps './package.json'", manifest.exports?.['./package.json'] === './package.json',
    JSON.stringify(manifest.exports?.['./package.json']))

  section('4. files ships the locale directory')
  check("files includes 'locale/*.json'", Array.isArray(manifest.files) && manifest.files.includes('locale/*.json'),
    JSON.stringify(manifest.files))

  section('5. Every locale file resolves from inside the package')
  const name = manifest.name
  check('the manifest resolves', resolveIn(`${name}/package.json`) === join(packageRoot, 'package.json'),
    String(resolveIn(`${name}/package.json`)))
  for (const language of languages) {
    const resolved = resolveIn(`${name}/locale/${language}.json`)
    check(`locale/${language}.json resolves into locale/`, resolved !== undefined && dirname(resolved) === localeDir,
      String(resolved))
  }

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS: ${passed} assertions`)
    process.exitCode = 0
  } else {
    console.log(`FAIL: ${failures.length} of ${passed + failures.length} assertions`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
