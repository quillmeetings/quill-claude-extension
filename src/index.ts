import os from 'os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import ENV from './env'
import { EXTENSION_VERSION } from './version'
import { ConnectionManager } from './lib/connectionManager'
import { ProtocolClient } from './lib/protocolClient'
import { registerHandlers } from './lib/handlers'
import { log } from './lib/logger'

const MCP_SERVER_INSTRUCTIONS = `Quill is a local meeting recording and note-taking app. Meeting data is stored on the user's own machine. This server exposes the current user's local Quill data — recorded meetings, transcripts, AI-generated minutes, contacts, and meeting threads. It does not reach other users' data.

Listing recent meetings: search_meetings also lists — for "recent meetings" or "meetings this week" with no topic in mind, call it with query omitted and drive everything through filter/ranking instead. There is no separate list-meetings tool.

Picking the right meeting-content tool:
- search_meetings — find which meetings match, by title/blurb/participants/tags (and optionally minutes/transcripts via ranking.scope).
- search_minutes — full-text search inside AI-generated minutes across meetings; returns chunks with meeting_id + chunk_position — follow up with get_minutes for full context.
- get_minutes — the live AI summary for one known meeting. Fast, but may be lossy.
- get_transcript — verbatim transcript with speakers/timestamps. Use for exact quotes or when minutes aren't detailed enough; slice with start_seconds/duration_seconds on long meetings instead of pulling the whole thing.

Contacts: search_contacts matches name/email/bio/notes and requires a query. list_contacts browses/paginates and only loosely filters by name/email. Use search_contacts when the ask references something about a person, not just their name.

Events vs. meetings: list_events is upcoming/future calendar events only. For anything already recorded, use search_meetings.

Threads: recurring series (e.g. weekly 1:1s) are grouped as threads — use list_threads with include_meetings to see a series' history rather than reconstructing it via repeated searches.

IDs are opaque — get a meeting_id/contact_id from a search or list result before calling a single-item tool (get_meeting, get_transcript, get_contact); don't guess one.`

const server = new Server(
  {
    name: 'quill-claude-extension',
    version: EXTENSION_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: MCP_SERVER_INSTRUCTIONS,
  },
)

const TIMEOUT_MS = 10000
const isWindows = os.platform() === 'win32'
const socketName = ENV === 'development' ? 'quill_mcp_development' : 'quill_mcp'
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
