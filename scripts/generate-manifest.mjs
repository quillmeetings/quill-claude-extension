#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.resolve(__dirname, '..')

function getMode(argv) {
  const modeIndex = argv.findIndex((arg) => arg === '--mode')
  if (modeIndex === -1) return 'prod'
  const mode = argv[modeIndex + 1]
  if (mode !== 'dev' && mode !== 'prod') {
    throw new Error(`Invalid --mode value "${mode}". Expected "dev" or "prod".`)
  }
  return mode
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

const mode = getMode(process.argv.slice(2))
const packageJsonPath = path.join(ROOT_DIR, 'package.json')
const templatePath = path.join(ROOT_DIR, 'manifest.template.json')
const outputPath = path.join(ROOT_DIR, 'manifest.json')

const packageJson = readJson(packageJsonPath)
const template = readJson(templatePath)

const extensionName = mode === 'dev' ? 'Quill (Dev)' : 'Quill'
const manifest = {
  ...template,
  name: extensionName,
  display_name: extensionName,
  version: packageJson.version,
}

writeJson(outputPath, manifest)

console.log(`Generated manifest.json (${mode}) version ${packageJson.version}`)
