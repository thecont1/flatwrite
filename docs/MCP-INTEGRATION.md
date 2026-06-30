# MCP Server Integration Guide

This document describes the Model Context Protocol (MCP) server integrations available in the FlatWrite project.

## Installed MCP Servers

### 1. FlatWrite Render MCP Server

**Purpose**: Exposes FlatWrite's markdown rendering API as MCP tools.

**Configuration**: See `.mcp.json`

**Environment Variables**:
- `FLATWRITE_RENDER_API_KEY` - API key for the FlatWrite render service (required)

**Available Tools**:
- `render_markdown` - Render markdown to FlatWrite-styled HTML
- `render_markdown_from_url` - Fetch markdown from a URL and render it

**Setup**:
```bash
cd mcp/flatwrite-render-server
npm install
npm run build
```

### 2. Chrome DevTools MCP Server

**Purpose**: Provides browser automation and debugging capabilities via Chrome DevTools.

**Configuration**: See `.mcp.json`

**Available Tools** (25+ tools across categories):
- **Navigation automation**: `navigate_page`, `new_page`, `close_page`, `select_page`, `wait_for`
- **Input automation**: `click`, `fill`, `type_text`, `press_key`, `drag`, `fill_form`
- **Performance**: `performance_start_trace`, `performance_stop_trace`, `lighthouse_audit`
- **Debugging**: `get_console_message`, `list_console_messages`, `take_screenshot`, `take_snapshot`
- **Network**: `list_network_requests`, `get_network_request`

**Setup**:
The Chrome DevTools MCP server is installed as a local dependency and can be run via:
```bash
npx chrome-devtools-mcp@latest
```

**First Test Prompt**:
```
Check the performance of https://developers.chrome.com
```

## Configuration File

The MCP server configuration is stored in `.mcp.json` at the project root. This file is compatible with Warp, Claude Code, Cursor, and other MCP-aware clients.

### Client-Specific Configuration

#### Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "flatwrite-render": {
      "command": "node",
      "args": ["mcp/flatwrite-render-server/dist/index.js"],
      "env": {
        "FLATWRITE_RENDER_API_KEY": "your-api-key-here"
      }
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

#### Warp
Go to `Settings | AI | Manage MCP Servers` -> `+ Add` and use the configuration from `.mcp.json`.

## Verification

### Chrome DevTools MCP ✅ Verified
The server is available and functional. Test with:
```
Check the performance of https://developers.chrome.com
```

### FlatWrite Render MCP
Requires `FLATWRITE_RENDER_API_KEY` environment variable. Test with:
```
Call list_render_options to see available rendering options
```

## Troubleshooting

### Chrome DevTools MCP
- Ensure Chrome is running with remote debugging enabled (port 9222) if connecting manually
- Use `--headless=true` for automated testing environments
- Use `--isolated=true` to create a temporary Chrome profile

### FlatWrite Render
- Ensure `FLATWRITE_RENDER_API_KEY` environment variable is set
- Verify the render Worker at `render.flatwrite.md` is accessible