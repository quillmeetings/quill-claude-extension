#!/usr/bin/env node

// @ts-check

import os from 'os'
import WebSocket from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  {
    name: 'quill-claude-extension',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

const TIMEOUT_MS = 10000
const isWindows = os.platform() === 'win32'
const SOCKET_PATH = isWindows ? '\\\\.\\pipe\\quill_mcp' : '/tmp/quill_mcp.sock'
const CLIENT_URL = isWindows ? 'ws+pipe://./pipe/quill_mcp' : `ws+unix://${SOCKET_PATH}`

/** @type {WebSocket | undefined} */
let ws
let nextId = 1
/** @type {Map<string, {resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
const pending = new Map()

function ensureSocket() {
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) return ws
    if (ws.readyState === WebSocket.CONNECTING) return ws
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      try {
        // Ensure we don't hold onto a socket that is closing/closed
        ws.terminate?.()
      } catch (_) {}
      ws = undefined
    }
  }
  ws = new WebSocket(CLIENT_URL)
  ws.on('open', () => {
    // ready
  })
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      const { id, result, error } = msg || {}
      if (!id) return
      const entry = pending.get(String(id))
      if (!entry) return
      pending.delete(String(id))
      clearTimeout(entry.timer)
      if (error) entry.reject(new Error(String(error)))
      else entry.resolve(result)
    } catch (error) {
      console.error('mcp_ws_event', 'parse_error', error)
    }
  })
  ws.on('close', (code, reason) => {
    console.error('mcp_ws_event', 'close', { code, reason })
    // reject all pending
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('socket_closed'))
    }
    pending.clear()
  })
  ws.on('error', (error) => {
    console.error('mcp_socket_error', error)
  })
  return ws
}

function waitForOpen(sock, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (sock.readyState === WebSocket.OPEN) return resolve(null)

    const onOpen = () => {
      cleanup()
      resolve(null)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('socket_closed'))
    }
    const onError = (e) => {
      cleanup()
      reject(e instanceof Error ? e : new Error('socket_error'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('socket_open_timeout'))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      // ws uses Node EventEmitter, which supports off/removeListener
      sock.off?.('open', onOpen)
      sock.off?.('close', onClose)
      sock.off?.('error', onError)
    }

    sock.once('open', onOpen)
    sock.once('close', onClose)
    sock.once('error', onError)
  })
}

async function callBridge(method, params) {
  const sock = ensureSocket()
  await waitForOpen(sock)
  if (sock.readyState !== WebSocket.OPEN) {
    throw new Error('socket_not_open')
  }
  const id = String(nextId++)
  const payload = JSON.stringify({ id, method, params })
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout'))
    }, TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
  })
  sock.send(payload, (err) => {
    if (err) {
      const entry = pending.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(id)
        entry.reject(err)
      }
    }
  })
  return p
}

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async (_request) => {
  return {
    tools: [
      {
        name: 'list_meetings',
        description: 'Return a list of meetings from the local Electron app',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of meetings to return',
              minimum: 1,
            },
            offset: { type: 'number', minimum: 0 },
            from: { type: 'string', description: 'ISO date lower bound' },
            to: { type: 'string', description: 'ISO date upper bound' },
            type: { type: 'string' },
            q: { type: 'string' },
          },
        },
      },
      {
        name: 'get_meeting',
        description: 'Get a single meeting by id',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      {
        name: 'search_meetings',
        description:
          'Search meetings by text query and/or filter by contacts. Searches meeting title, blurb, participants, tags, full transcript, and note contents.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to search for in meeting content' },
            limit: { type: 'number', minimum: 1 },
            offset: { type: 'number', minimum: 0 },
            thread_id: { type: 'string', description: 'Filter to specific thread' },
            contact_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter to meetings with these contact IDs as participants',
            },
          },
          required: [],
        },
      },
      {
        name: 'get_minutes',
        description: 'Return minutes or formatted transcript for a meeting',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, prefer_existing_minutes: { type: 'boolean' } },
          required: ['id'],
        },
      },
      {
        name: 'get_transcript',
        description:
          'Return formatted transcript for a meeting. CAUTION: Can be very long and consume many context tokens; prefer minutes first unless needed.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      {
        name: 'list_notes',
        description: 'List notes for a meeting',
        inputSchema: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            template_id: { type: 'string' },
            include_body: { type: 'boolean' },
            limit: { type: 'number', minimum: 1 },
            offset: { type: 'number', minimum: 0 },
          },
          required: ['meeting_id'],
        },
      },
      {
        name: 'get_note',
        description: 'Get a single note by id',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, include_body: { type: 'boolean' } }, required: ['id'] },
      },
      {
        name: 'list_contacts',
        description: 'List contacts with optional search',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            limit: { type: 'number', minimum: 1 },
            offset: { type: 'number', minimum: 0 },
          },
        },
      },
      {
        name: 'get_contact',
        description: 'Get a single contact by id',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      {
        name: 'search_contacts',
        description: 'Search contacts by name, email, or bio',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
          required: ['query'],
        },
      },
      {
        name: 'list_threads',
        description: 'List threads, optionally including meetings',
        inputSchema: {
          type: 'object',
          properties: { include_meetings: { type: 'boolean' }, meetings_limit: { type: 'number', minimum: 1 } },
        },
      },
    ],
  }
})

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments || {}
  try {
    if (name === 'list_meetings') {
      const data = await callBridge('list_meetings', {
        limit: args.limit ?? 10,
        offset: args.offset ?? 0,
        from: args.from,
        to: args.to,
        type: args.type,
        q: args.q,
      })
      return { content: [{ type: 'text', text: JSON.stringify(data.meetings ?? [], null, 2) }] }
    }

    if (name === 'get_meeting') {
      const data = await callBridge('get_meeting', { id: args.id })
      return { content: [{ type: 'text', text: JSON.stringify(data.meeting ?? null, null, 2) }] }
    }

    if (name === 'search_meetings') {
      const data = await callBridge('search_meetings', {
        query: args.query,
        limit: args.limit ?? 10,
        offset: args.offset ?? 0,
        thread_id: args.thread_id,
        contact_ids: args.contact_ids,
      })
      return { content: [{ type: 'text', text: JSON.stringify(data.meetings ?? [], null, 2) }] }
    }

    if (name === 'get_minutes') {
      const data = await callBridge('get_minutes', { id: args.id, prefer_existing_minutes: args.prefer_existing_minutes })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'get_transcript') {
      const data = await callBridge('get_transcript', { id: args.id })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'list_notes') {
      const data = await callBridge('list_notes', {
        meeting_id: args.meeting_id,
        template_id: args.template_id,
        include_body: args.include_body,
        limit: args.limit ?? 10,
        offset: args.offset ?? 0,
      })
      return { content: [{ type: 'text', text: JSON.stringify(data.notes ?? [], null, 2) }] }
    }

    if (name === 'get_note') {
      const data = await callBridge('get_note', { id: args.id, include_body: args.include_body })
      return { content: [{ type: 'text', text: JSON.stringify(data.note ?? null, null, 2) }] }
    }

    if (name === 'list_contacts') {
      const data = await callBridge('list_contacts', { q: args.q, limit: args.limit ?? 10, offset: args.offset ?? 0 })
      return { content: [{ type: 'text', text: JSON.stringify(data.contacts ?? [], null, 2) }] }
    }

    if (name === 'get_contact') {
      const data = await callBridge('get_contact', { id: args.id })
      return { content: [{ type: 'text', text: JSON.stringify(data.contact ?? null, null, 2) }] }
    }

    if (name === 'search_contacts') {
      const data = await callBridge('search_contacts', { query: args.query, limit: args.limit ?? 10, offset: args.offset ?? 0 })
      return { content: [{ type: 'text', text: JSON.stringify(data.contacts ?? [], null, 2) }] }
    }

    if (name === 'list_threads') {
      const data = await callBridge('list_threads', { include_meetings: args.include_meetings, meetings_limit: args.meetings_limit ?? 10 })
      return { content: [{ type: 'text', text: JSON.stringify(data.threads ?? [], null, 2) }] }
    }

    throw new Error(`Unknown tool: ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

// Start the server
const transport = new StdioServerTransport()
server.connect(transport)

console.error('Quill MCP server running...')
