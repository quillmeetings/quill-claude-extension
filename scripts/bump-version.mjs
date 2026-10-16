#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.resolve(__dirname, '..')

const packageJsonPath = path.join(ROOT_DIR, 'package.json')
const versionModulePath = path.join(ROOT_DIR, 'src', 'version.ts')

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    throw new Error(`Invalid semver "${version}". Expected x.y.z`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function nextVersion(current, bumpArg) {
  const parsed = parseVersion(current)

  if (bumpArg === 'major') return `${parsed.major + 1}.0.0`
  if (bumpArg === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`
  if (bumpArg === 'patch') return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`

  parseVersion(bumpArg)
  return bumpArg
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8')
}

const bumpArg = process.argv[2] ?? 'patch'
const packageJson = JSON.parse(readText(packageJsonPath))
const currentVersion = packageJson.version
const updatedVersion = nextVersion(currentVersion, bumpArg)

packageJson.version = updatedVersion
writeText(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

if (!fs.existsSync(versionModulePath)) {
  throw new Error('Could not find src/version.ts to update EXTENSION_VERSION.')
}

writeText(versionModulePath, `export const EXTENSION_VERSION = '${updatedVersion}'\n`)

console.log(`Version bumped: ${currentVersion} -> ${updatedVersion}`)
console.log(`Updated ${path.relative(ROOT_DIR, packageJsonPath)}`)
console.log(`Updated ${path.relative(ROOT_DIR, versionModulePath)}`)
