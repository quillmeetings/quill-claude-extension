# Quill MCPB Desktop Extension

This is a simple stdio-based MCPB extension that exposes tools locally by creating a bridge with the Quill desktop application.

## Requirements

- Node.js 18+
- npm

## Install

```bash
npm install
```

This extension uses stdio transport.

## How it works

- **Claude Desktop ↔ MCP server (this project)**  
  - Claude Desktop launches this extension using the `manifest.json` definition.  
  - The extension runs `node src/index.js` and speaks the MCP protocol over **stdio** using `@modelcontextprotocol/sdk`.  
  - The MCP server only exposes **tools**; it does not persist any state itself.

- **MCP server ↔ Quill Desktop (Electron app)**  
  - `src/index.js` opens a **local WebSocket connection** to the Quill desktop app:
    - macOS: Unix domain socket at `/tmp/quill_mcp.sock`
    - Windows: Named pipe at `\\\\.\\pipe\\quill_mcp`
  - All actual data access (meetings, minutes, transcripts, contacts, threads, etc.) happens inside Quill; this extension only forwards requests and responses.
  - Communication never leaves the device: both the stdio channel and the socket/pipe are local only.

- **Dynamic tools & schema versioning**
  - On connection, the extension calls a `list_tools` RPC over the socket to Quill.  
  - Quill returns the current tool schemas and a `_schemaVersion`; the extension caches this version and reports the tools to Claude via the MCP `listTools` handler.  
  - Each subsequent tool call forwards the user arguments plus `_clientSchemaVersion` back to Quill.  
  - If Quill detects a schema mismatch and replies with a `schema_outdated` error, the extension clears its cached version and instructs the user (via Claude) to retry so it can re‑sync tool schemas.

## Security & privacy

- **Local‑only architecture**
  - All communication is local to the user’s machine:
    - Claude Desktop ↔ MCP server over stdio.
    - MCP server ↔ Quill over a fixed Unix domain socket (`/tmp/quill_mcp.sock`) on macOS or named pipe (`\\\\.\\pipe\\quill_mcp`) on Windows.
  - The extension does not initiate any outbound network connections and does not talk to Quill cloud services.

- **Access control**
  - The Quill desktop app owns the socket/pipe and only accepts connections from processes on the local machine.
  - No secrets or credentials are required; access is implicitly scoped to the current user session since only local processes can connect to the Unix domain socket or named pipe.

- **Data handling**
  - Meeting, transcript, notes, contacts, and thread data all originate from the Quill desktop app and flow over the local socket only.
  - The MCP server acts as a thin adapter: it does not cache or store payloads on disk; it simply forwards responses into Claude’s MCP tool response format.
  - Any long‑lived storage of user data remains within the Quill desktop application itself (outside the scope of this extension).

- **Logging**
  - The extension logs minimal diagnostic information to stderr (e.g., connection lifecycle events, tool invocation errors).
  - Logs may include tool names and basic argument metadata (such as IDs or short queries) for debugging, but the implementation avoids logging full meeting transcripts or note bodies.
  - There are no analytics, tracking, or remote log upload mechanisms in this package.

## Tooling and build workflow

The extension now uses a TypeScript-first build pipeline:

1. Generate `src/socketConfig.ts` (`dev` or `prod` mode)
2. Generate `manifest.json` from `manifest.template.json` (`dev` or `prod` mode)
3. Compile `src/**/*.ts` to `dist/`
4. Package with `mcpb pack`

### Scripts

- `npm run socket:dev` - generate socket config for dev mode (`quill_mcp_dev`)
- `npm run socket:prod` - generate socket config for prod mode (`quill_mcp`)
- `npm run manifest:dev` - generate manifest with dev display identity
- `npm run manifest:prod` - generate manifest with prod display identity
- `npm run build:ts` - compile TypeScript to `dist/`
- `npm run build:mcpb` - package extension to `extension.mcpb`
- `npm run copy:mcpb` - copy `extension.mcpb` to `app/assets/claude/quill.mcpb`
- `npm run build:dev` - clean + dev socket config + dev manifest + TS build + package + copy to app assets
- `npm run build:prod` - clean + prod socket config + prod manifest + TS build + package + copy to app assets
- `npm run build` - alias to `build:prod`

### Build examples

```bash
# Default production build
npm run build

# Development variant (manifest display identity differs)
npm run build:dev
```

## Socket config generation

`src/index.ts` imports socket paths from a generated module:

- `src/socketConfig.ts`

The generated `SOCKET_CONFIG` object includes:

- `paths.windows` (named pipe path)
- `paths.darwin` (Unix socket path)
- `mode` (`dev` or `prod`)

This keeps runtime code free of manual mode branching and lets the build mode control socket routing.

## Versioning

Versioning has a single source of truth constant in `src/version.ts`:

```ts
export const EXTENSION_VERSION = 'x.y.z'
```

`scripts/bump-version.mjs` updates both:

- `package.json` -> `version`
- `src/version.ts` -> `EXTENSION_VERSION`

### `version:bump` command

Run:

```bash
npm run version:bump -- <target>
```

Where `<target>` can be:

- `patch` (default if omitted)
- `minor`
- `major`
- an explicit version (`x.y.z`)

Examples:

```bash
# 0.1.4 -> 0.1.5
npm run version:bump

# 0.1.4 -> 0.2.0
npm run version:bump -- minor

# 0.1.4 -> 1.0.0
npm run version:bump -- major

# force exact version
npm run version:bump -- 0.3.7
```

The script validates semver and fails fast if an invalid value is supplied.

## Manifest

See `manifest.json`. Important fields:

- manifest_version: 0.2
- server.type: node
- server.entry_point: dist/index.js

## Tools

Tool metadata is declared in `manifest.json` (names and human‑readable descriptions), while the **actual schemas** and implementations live in the Quill desktop app and are discovered dynamically at runtime via the `list_tools` bridge call.

The current tool surface includes (non‑exhaustive):

- **`list_meetings`**: Return a list of meetings.
- **`get_meeting`**: Get a single meeting by id.
- **`search_meetings`**: Search meetings by free‑text query and/or filter by contacts.
- **`get_minutes`**: Return minutes or a formatted summary for a meeting.
- **`get_transcript`**: Return the full formatted transcript for a meeting (can be long; prefer `get_minutes` first).
- **`list_notes`** / **`get_note`**: Work with structured notes attached to a meeting.
- **`list_contacts`**, **`get_contact`**, **`search_contacts`**: Explore and fetch contact records.
- **`list_threads`**: List related threads, optionally including meetings, for deeper context.

All tools ultimately return **structured JSON** to Claude; the extension adapts that into MCP `text` content so Claude can reason over it.

## Example use cases

- **1. Summarize a recent meeting and extract action items**
  - Claude calls `list_meetings` or `search_meetings` to find the relevant meeting by title, participants, or keywords.
  - It then uses `get_minutes` (and, if needed, `get_transcript`) to pull the detailed content.
  - From there, Claude can draft a summary, extract decisions, and propose next‑step action items entirely on‑device.

- **2. Prepare for an upcoming call with a specific contact**
  - Claude looks up the person using `search_contacts` or `get_contact` by name or email.
  - Using that contact id, it queries `search_meetings` / `list_meetings` and `list_notes` to gather past interactions, notes, and talking points.
  - With this context, Claude can generate a tailored pre‑read, agenda, or email prep for the call.

- **3. Review all discussions around a topic across meetings and threads**
  - Claude uses `search_meetings` with a topical query (e.g., “Q4 roadmap”, “pricing changes”) to find relevant meetings.
  - It can then call `list_threads` to surface related discussion threads and `get_minutes` / `get_note` for deeper detail.
  - This enables cross‑meeting synthesis, e.g., “Show me everything we decided about pricing across the last three weeks.”