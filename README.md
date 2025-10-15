# Quill MCPB Desktop Extension

This is a simple stdio-based MCPB extension that exposes tools locally by creating a bridge with Quill desktop application.

## Requirements

- Node.js 18+
- npm

## Install

```bash
npm install
```

This extension uses stdio transport.

## Run locally (manual)

```bash
npm run dev
```

This will start the MCP server over stdio. Typically, a host (like MCPB/Claude Desktop) will spawn it using the manifest.

## Build/Pack

```bash
npm run pack
```

This will package the extension per MCPB tooling and create an `extension.mcpb` file at the root.

## Manifest

See `manifest.json`. Important fields:

- manifest_version: 0.2
- server.type: node
- server.mcp_config.transport: stdio
- server.entry_point: src/index.js

## Tools

All tools are defined in `src/index.js` and return JSON text content. Example shapes:

- get_meeting: { id, title, notes }
- search_notes: [{ id, snippet, score }]
- get_contact: { name, email }

## Debugging

- Set `MCP_TOOL_TIMEOUT_MS` to adjust tool call timeouts.
- Errors are printed to stderr with a clear prefix `[MCPB:quill-mcpb]`.

## Testing

- Validate the manifest with MCPB tooling by loading the folder.
- Ensure tool calls return structured responses; errors will be returned with `isError: true`.
