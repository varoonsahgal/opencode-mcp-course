
MCP with AI Agents

This course introduces software developers to the Model Context Protocol (MCP) for connecting AI agents to external tools, data sources, and services. Participants learn how MCP works, how to configure and use MCP servers with OpenCode, and how to extend agent capabilities through custom MCP integrations.
The course focuses on practical implementation, including connecting pre-built MCP servers, building a custom MCP server, and applying security controls and organizational guardrails to reduce the risks associated with giving AI agents access to external systems.
Audience
This course is ideal for:
Software developers
Technical leads
Security engineers
Prerequisites
To get the most out of this session, participants should have:
MUST HAVE: Completion of Orchestration Fundamentals for Agentic Development course or equivalent working experience
Experience with terminal-based development workflows
Basic understanding of APIs
Basic familiarity with TypeScript or Python
Familiarity with using AI-assisted development tools
Learning Objectives
After this course, participants will be able to:
Explain the purpose and architecture of the Model Context Protocol
Understand how MCP connects AI agents to external tools, systems, and data
Understand the roles of MCP clients and MCP servers
Configure and connect existing MCP servers to OpenCode
Understand how OpenCode discovers and invokes capabilities exposed through MCP
Build and register a basic custom MCP server
Test and troubleshoot MCP integrations
Identify security risks introduced by MCP integrations
Apply permissions, least-privilege principles, and trust boundaries to MCP-enabled agents
Duration
4 hours
Outline
1. Connecting AI Agents to External Systems with MCP
Why AI agents need access to external tools and data
The problem MCP is designed to solve
Understanding the MCP architecture:
AI application / host
MCP client
MCP server
External tools, APIs, files, databases, and services
Understanding MCP capabilities:
Tools
Resources
Prompts
The role of OpenCode as an MCP client
How OpenCode connects to MCP servers
Local versus remote MCP servers
How an agent discovers capabilities exposed by an MCP server
How an agent selects and invokes an MCP tool
Understanding the request and response flow between OpenCode and an MCP server
Hands-on: Connect OpenCode to a pre-built MCP server, inspect the available capabilities, and invoke an MCP tool through the agent.
2. Configuring MCP Servers with OpenCode
Understanding OpenCode MCP configuration
Adding and configuring MCP servers
Starting local MCP servers
Connecting to remote MCP servers
Providing environment variables and configuration to MCP servers
Enabling and disabling MCP integrations
Verifying server connectivity
Troubleshooting common MCP connection issues
Understanding how MCP tools become available alongside OpenCode's built-in tools
Hands-on: Configure an existing MCP server in OpenCode and use it to retrieve information from an external source.
3. Building a Custom MCP Server
Anatomy of an MCP server
Designing capabilities that should be exposed to an AI agent
Defining MCP tools
Defining tool inputs and outputs
Returning structured results to an agent
Connecting an MCP server to an external API or local system
Handling invalid requests and errors
Registering the custom server with OpenCode
Testing tool discovery
Testing tool execution through natural-language requests
Hands-on: Build a custom MCP server that exposes an external API or system utility as an MCP tool, connect it to OpenCode, and invoke the new capability from the agent.
4. Securing MCP Integrations
How MCP expands an AI agent's security boundary
Understanding the trust chain:
User → AI Agent → MCP Client → MCP Server → External System
Risks associated with third-party MCP servers
Risks of exposing filesystem and shell access
API and database access risks
Credential and secret exposure
Excessive permissions
Prompt injection through external content
Malicious or misleading tool definitions
Applying least-privilege principles to MCP tools
Separating read-only and write capabilities
Controlling which tools an agent may use
Requiring user approval for sensitive operations
Allowing, denying, or requiring approval for tool execution
Reviewing third-party MCP servers before deployment
Logging and auditing MCP interactions
Establishing organizational guardrails for MCP adoption
Hands-on: Review an intentionally over-permissioned MCP integration, identify its risks, and redesign it using least privilege and approval controls.
5. Applied MCP Agent Challenge
Participants combine the concepts from the course to configure an MCP-enabled OpenCode agent for a realistic development scenario.
Given an agent that requires access to both local and external information, participants will:
Determine which capabilities should be exposed through MCP
Define appropriate MCP tool boundaries
Connect the MCP server to OpenCode
Verify that the agent can discover and invoke the required tools
Identify sensitive operations
Configure appropriate permissions and approval boundaries
Test the resulting workflow



