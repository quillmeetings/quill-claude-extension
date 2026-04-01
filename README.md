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

- **Dynamic tools**
  - On connection, the extension calls a `list_tools` RPC over the socket to Quill.
  - Quill returns the current tool schemas, and the extension reports them through the MCP `listTools` handler.
  - Tool calls are forwarded directly with the user-provided arguments.

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

1. Generate `src/env.ts` (`development` or `production`)
2. Generate `manifest.json` from `manifest.template.json` (`dev` or `prod` mode)
3. Typecheck TypeScript, then bundle a single Node ESM output to `dist/index.js` via esbuild
4. Package with `mcpb pack`

### Scripts

- `npm run env:dev` - generate `ENV='development'`
- `npm run env:prod` - generate `ENV='production'`
- `npm run manifest:dev` - generate manifest with dev display identity
- `npm run manifest:prod` - generate manifest with prod display identity
- `npm run build:ts` - typecheck + bundle `src/index.ts` to `dist/index.js` via esbuild
- `npm run build:mcpb` - package extension to `extension.mcpb`
- `npm run build:dev` - clean + dev env + dev manifest + TS build + package
- `npm run build:prod` - clean + prod env + prod manifest + TS build + prune dev dependencies + package (notarization-safe distribution)
- `npm run build` - alias to `build:prod`

### Build examples

```bash
# Default production build
npm run build

# Development variant (manifest display identity differs)
npm run build:dev
```

## Local rebuild procedure (manual QA)

Use this when testing the full Claude extension flow locally and you need to refresh:
- extension package (`.mcpb`)
- app extension version module
- stdio bridge bundle

### Recommended: use the helper script

From repo root:

```bash
bash scripts/rebuild-claude-extension-local.sh --mode prod
```

Or from `mcp/extension`:

```bash
npm run rebuild:local -- --mode prod
```

Useful flags:

- `--mode <prod|dev>` (default `prod`)
- `--bump <patch|minor|major|x.y.z>` (optional pre-build version bump)
- `--skip-install` (skip `npm ci` / `npm install`)
- `--skip-bridge` (skip `npm run build:mcpBridge` in `app`)

Examples:

```bash
# Dev build + patch bump
bash scripts/rebuild-claude-extension-local.sh --mode dev --bump patch

# Fast rerun without reinstalling dependencies
bash scripts/rebuild-claude-extension-local.sh --mode prod --skip-install
```

### Manual steps (equivalent)

### 1) Use correct Node version

```bash
cd /Users/achraf/code/quill/dev
. ~/.nvm/nvm.sh
cd app && nvm use
cd ../mcp/extension && nvm use || true
```

### 2) Build extension package

```bash
cd /Users/achraf/code/quill/dev/mcp/extension
npm ci
```

Optional (if you want a new version):

```bash
npm run version:bump -- patch
# or: -- minor / -- major / -- 0.x.y
```

Build artifact:

```bash
npm run build:prod
# for dev testing instead: npm run build:dev
```

### 3) Copy extension artifact to app assets

```bash
cp "/Users/achraf/code/quill/dev/mcp/extension/extension.mcpb" \
   "/Users/achraf/code/quill/dev/app/assets/claude/quill.mcpb"
```

### 4) Regenerate app extension version module

```bash
cd /Users/achraf/code/quill/dev/app
node scripts/generate-claude-extension-version.mjs
```

### 5) Rebuild MCP stdio bridge

```bash
cd /Users/achraf/code/quill/dev/app
npm run build:mcpBridge
```

### One-shot command (prod)

```bash
cd /Users/achraf/code/quill/dev && . ~/.nvm/nvm.sh && \
cd app && nvm use && cd ../mcp/extension && npm ci && \
npm run build:prod && \
cp extension.mcpb ../../app/assets/claude/quill.mcpb && \
cd ../../app && \
node scripts/generate-claude-extension-version.mjs && \
npm run build:mcpBridge
```

## Environment generation

`src/index.ts` imports environment mode from a generated module:

- `src/env.ts`

The generated default export includes:

- `ENV` value (`development` or `production`)

Runtime code derives socket paths and log folder selection from `ENV`, which keeps behavior consistent between extension builds.

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