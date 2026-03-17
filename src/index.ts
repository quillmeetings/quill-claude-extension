import os from 'os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SOCKET_CONFIG } from './socketConfig'
import { EXTENSION_VERSION } from './version'
import { ConnectionManager } from './lib/connectionManager'
import { ProtocolClient } from './lib/protocolClient'
import { registerHandlers } from './lib/handlers'

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
const SOCKET_PATH = isWindows ? SOCKET_CONFIG.paths.windows : SOCKET_CONFIG.paths.darwin

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
console.error('Quill MCP server running...')
