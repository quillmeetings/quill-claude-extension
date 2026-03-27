import os from 'os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import ENV from './env'
import { EXTENSION_VERSION } from './version'
import { ConnectionManager } from './lib/connectionManager'
import { ProtocolClient } from './lib/protocolClient'
import { registerHandlers } from './lib/handlers'
import { log } from './lib/logger'

const server = new Server(
  {
    name: 'quill-claude-extension',
    version: EXTENSION_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

const TIMEOUT_MS = 10000
const isWindows = os.platform() === 'win32'
const socketName = ENV === 'development' ? 'quill_mcp_dev' : 'quill_mcp'
const SOCKET_PATH = isWindows ? `\\\\.\\pipe\\${socketName}` : `/tmp/${socketName}.sock`

const connectionManager = new ConnectionManager({
  socketPath: SOCKET_PATH,
  isWindows,
  openTimeoutMs: TIMEOUT_MS,
  requestTimeoutMs: TIMEOUT_MS,
  maxRetries: 2,
})
const protocolClient = new ProtocolClient(connectionManager)

registerHandlers(server, { bridge: protocolClient })

const transport = new StdioServerTransport()
void server.connect(transport)
log('info', 'extension_started', {
  version: EXTENSION_VERSION,
  platform: process.platform,
})
console.error('Quill MCP server running...')
