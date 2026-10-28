# MCP with AI Agents · OpenCode course

Connect, configure, build and secure **Model Context Protocol** integrations for AI agents, hands-on, with [OpenCode](https://opencode.ai) as the agent and a cheap model so you can experiment freely.

**Read the course online: <https://varoonsahgal.github.io/opencode-mcp-course/>**

| | |
|---|---|
| [Course home](https://varoonsahgal.github.io/opencode-mcp-course/) | schedule, how the guides work, quick start |
| [Student handout](https://varoonsahgal.github.io/opencode-mcp-course/handout.html) | one page per lab: commands, predictions, operator card |
| [Reference slides](https://varoonsahgal.github.io/opencode-mcp-course/slides/) | every concept with diagrams and speaker notes (`N`), cheat sheet, glossary |

## Modules

| # | Module | Lab |
|---|---|---|
| 00 | [Setup](course/00-setup.md) | `npm run check` |
| 01 | [Connecting AI agents to external systems with MCP](course/01-connecting-agents-with-mcp.md) | a live wiretap of every JSON-RPC message |
| 02 | [Configuring MCP servers with OpenCode](course/02-configuring-mcp-in-opencode.md) | remote servers, env vars, a debugging dojo, the context tax |
| 03 | [Building a custom MCP server](course/03-building-a-custom-mcp-server.md) | a weather server the model picks on its own |
| 04 | [Securing MCP integrations](course/04-securing-mcp-integrations.md) | an over-permissioned database server, broken and fixed |
| 05 | [Applied MCP agent challenge](course/05-applied-challenge.md) | the on-call helper |
| 06 | [Advanced MCP: going remote](course/06-advanced-mcp.md) *(optional)* | a shared Streamable HTTP server with identities, progress and dynamic tools |

## Get started

```bash
git clone https://github.com/varoonsahgal/opencode-mcp-course.git
cd opencode-mcp-course/course/labs
npm install && npm run check
```

You need Node.js 20+, OpenCode 1.18+ logged in to OpenCode Zen, and optionally `uv`. Details in [00 · Setup](course/00-setup.md).

## Repository layout

```
course/          the student guides (Markdown), handout, slides, images
course/labs/     one folder per lab; run `npm install` in course/labs once
tools/           builds the GitHub Pages site from the guides (npm run build)
outline.md       the course outline
```
