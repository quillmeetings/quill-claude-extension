import fs from 'fs'
import os from 'os'
import path from 'path'
import ENV from '../env'

type LogLevel = 'info' | 'warn' | 'error'

function resolveLogPath(): string {
  const appFolderName = ENV === 'development' ? 'Quill-development' : 'Quill'

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appFolderName, 'logs', 'claude-extension.log')
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, appFolderName, 'logs', 'claude-extension.log')
  }

  return ''
}

const EXTENSION_LOG_PATH = resolveLogPath()

export function getExtensionLogPath(): string {
  return EXTENSION_LOG_PATH
}

export function log(level: LogLevel, event: string, metadata: Record<string, unknown> = {}): void {
  try {
    if (!EXTENSION_LOG_PATH) {
      throw new Error('unsupported_platform')
    }

    fs.mkdirSync(path.dirname(EXTENSION_LOG_PATH), { recursive: true })
    fs.appendFileSync(EXTENSION_LOG_PATH, `${level.toUpperCase()} ${new Date().toISOString()} [${event}] ${JSON.stringify(metadata)}\n`, 'utf8')
    console.error(level.toUpperCase(), new Date().toISOString(), event, JSON.stringify(metadata))
  } catch (error) {
    console.error('[extension_logger_error]', String(error))
  }
}
