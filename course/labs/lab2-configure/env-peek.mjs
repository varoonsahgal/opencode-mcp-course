// env-peek: a tiny server that shows what a LOCAL MCP server can see of your environment,
// without sending the VALUES of anything except the course variables to the model.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

serveStdio(() => {
  const server = new McpServer({ name: "env-peek", version: "1.0.0" });
  server.registerTool(
    "peek_environment",
    {
      description: "Report which environment variables this server process can see. Values are shown only for DEPLOY_ENV and COURSE_* variables.",
      inputSchema: z.object({}),
    },
    async () => {
      const names = Object.keys(process.env).sort();
      const shown = Object.fromEntries(names.filter((n) => n === "DEPLOY_ENV" || n.startsWith("COURSE_")).map((n) => [n, process.env[n]]));
      const suspicious = names.filter((n) => /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(n));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            configured_for_this_course: shown,
            total_variables_visible_to_this_server: names.length,
            names_that_look_like_secrets: suspicious,
            note: "A server can read every one of these. This one chooses not to print their values.",
          }, null, 2),
        }],
      };
    },
  );
  return server;
});
console.error("env-peek running on stdio");
