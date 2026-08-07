import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { ClioApiError, ClioService, filterTasks } from "./clio.js";
import { authChallenge } from "./oauth.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const securitySchemes = [{ type: "oauth2", scopes: ["clio.read"] }];
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const toolDefinitions = [
  {
    name: "clio_who_am_i",
    title: "Identify connected Clio user",
    description: "Confirm which Clio Manage user is connected before reviewing private firm data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    securitySchemes,
    annotations: readAnnotations,
    _meta: { securitySchemes },
  },
  {
    name: "list_clio_users",
    title: "List active Clio users",
    description: "List active Clio users the connected account is allowed to see. Use this to resolve staff names to IDs.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 100 } }, additionalProperties: false },
    securitySchemes,
    annotations: readAnnotations,
    _meta: { securitySchemes },
  },
  {
    name: "list_clio_calendars",
    title: "List visible Clio calendars",
    description: "List calendars visible to the connected Clio user, including calendar ownership and write permission metadata.",
    inputSchema: { type: "object", properties: { visible_only: { type: "boolean", default: true } }, additionalProperties: false },
    securitySchemes,
    annotations: readAnnotations,
    _meta: { securitySchemes },
  },
  {
    name: "list_clio_calendar_entries",
    title: "Review Clio calendar entries",
    description: "Review calendar entries in an exact time window. Details are hidden as Busy unless include_details is explicitly true.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", format: "date-time", description: "Inclusive ISO-8601 start date and time." },
        to: { type: "string", format: "date-time", description: "Inclusive ISO-8601 end date and time." },
        calendar_id: { type: "integer" },
        include_details: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 200 },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    securitySchemes,
    annotations: readAnnotations,
    _meta: { securitySchemes },
  },
  {
    name: "list_clio_tasks",
    title: "Review Clio tasks",
    description: "List tasks visible to the connected Clio user and optionally filter by status, due window, or assignee.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "complete", "all"], default: "pending" },
        due_from: { type: "string", format: "date-time" },
        due_to: { type: "string", format: "date-time" },
        assignee_id: { type: "integer" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      additionalProperties: false,
    },
    securitySchemes,
    annotations: readAnnotations,
    _meta: { securitySchemes },
  },
] as const;

function sessionId(extra: Extra): string | undefined {
  const value = extra.authInfo?.extra?.sessionId;
  return typeof value === "string" ? value : undefined;
}

function success(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent };
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof ClioApiError) {
    const guidance = error.status === 401
      ? "The Clio connection expired or was revoked. Reconnect Clio and try again."
      : error.status === 403
        ? "Clio denied this request. Check the app's read permissions and the user's Clio role."
        : error.message;
    return { content: [{ type: "text", text: guidance }], isError: true };
  }
  return { content: [{ type: "text", text: error instanceof Error ? error.message : "The Clio request failed." }], isError: true };
}

async function authenticated(
  config: AppConfig,
  extra: Extra,
  handler: (sessionId: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const id = sessionId(extra);
  if (!id) return authChallenge(config);
  try { return await handler(id); } catch (error) { return toolError(error); }
}

export function createMcpServer(config: AppConfig, clio: ClioService): McpServer {
  const server = new McpServer(
    { name: "clio-manage-firm-assistant", version: "0.1.0" },
    { instructions: "Confirm the connected Clio user before private-data requests. Prefer busy/free calendar results. Never expose secrets. This first release is read-only." },
  );

  server.registerTool("clio_who_am_i", {
    title: toolDefinitions[0].title,
    description: toolDefinitions[0].description,
    inputSchema: {},
    annotations: readAnnotations,
    _meta: { securitySchemes },
  }, async (_args, extra) => authenticated(config, extra, async (id) => {
    const response = await clio.api(id, "/users/who_am_i", { fields: "id,name,time_zone,locale" });
    return success(`Connected as ${response.data?.name || "a Clio user"}.`, { user: response.data });
  }));

  server.registerTool("list_clio_users", {
    title: toolDefinitions[1].title,
    description: toolDefinitions[1].description,
    inputSchema: { limit: z.number().int().min(1).max(200).default(100) },
    annotations: readAnnotations,
    _meta: { securitySchemes },
  }, async ({ limit }, extra) => authenticated(config, extra, async (id) => {
    const response = await clio.api(id, "/users.json", {
      enabled: true,
      limit,
      order: "name(asc)",
      fields: "id,name,enabled,time_zone,default_calendar_id",
    });
    const users = response.data || [];
    return success(`Found ${users.length} active Clio users visible to this account.`, { users });
  }));

  server.registerTool("list_clio_calendars", {
    title: toolDefinitions[2].title,
    description: toolDefinitions[2].description,
    inputSchema: { visible_only: z.boolean().default(true) },
    annotations: readAnnotations,
    _meta: { securitySchemes },
  }, async ({ visible_only }, extra) => authenticated(config, extra, async (id) => {
    const response = await clio.api(id, "/calendars.json", {
      visible: visible_only ? true : undefined,
      filter_inactive_users: true,
      limit: 200,
      order: "name(asc)",
      fields: "id,name,type,visible,permission,creator{id,name,enabled}",
    });
    const calendars = response.data || [];
    return success(`Found ${calendars.length} visible Clio calendars.`, { calendars });
  }));

  server.registerTool("list_clio_calendar_entries", {
    title: toolDefinitions[3].title,
    description: toolDefinitions[3].description,
    inputSchema: {
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      calendar_id: z.number().int().positive().optional(),
      include_details: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(200),
    },
    annotations: readAnnotations,
    _meta: { securitySchemes },
  }, async ({ from, to, calendar_id, include_details, limit }, extra) => authenticated(config, extra, async (id) => {
    if (Date.parse(from) > Date.parse(to)) throw new Error("The start of the calendar window must be before its end.");
    const response = await clio.api(id, "/calendar_entries.json", {
      from,
      to,
      calendar_id,
      expanded: true,
      visible: true,
      limit,
      fields: "id,summary,start_at,end_at,all_day,start_at_time_zone,calendars{id,name},matter{id,display_number,redacted}",
    });
    const entries = (response.data || []).map((entry: any) => ({
      id: entry.id,
      summary: include_details ? entry.summary : "Busy",
      start_at: entry.start_at,
      end_at: entry.end_at,
      all_day: entry.all_day,
      time_zone: entry.start_at_time_zone,
      calendars: entry.calendars,
      ...(include_details ? { matter: entry.matter } : {}),
    }));
    return success(`Found ${entries.length} visible calendar entries. Event details ${include_details ? "are included" : "are hidden as Busy"}.`, { entries });
  }));

  server.registerTool("list_clio_tasks", {
    title: toolDefinitions[4].title,
    description: toolDefinitions[4].description,
    inputSchema: {
      status: z.enum(["pending", "complete", "all"]).default("pending"),
      due_from: z.string().datetime({ offset: true }).optional(),
      due_to: z.string().datetime({ offset: true }).optional(),
      assignee_id: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).default(100),
    },
    annotations: readAnnotations,
    _meta: { securitySchemes },
  }, async ({ status, due_from, due_to, assignee_id, limit }, extra) => authenticated(config, extra, async (id) => {
    if (due_from && due_to && Date.parse(due_from) > Date.parse(due_to)) throw new Error("The beginning of the due window must be before its end.");
    const response = await clio.api(id, "/tasks.json", {
      limit: 200,
      order: "due_at(asc)",
      fields: "id,name,status,due_at,priority,completed_at,assignee{id,name},matter{id,display_number,redacted}",
    });
    const tasks = filterTasks(response.data || [], { status, dueFrom: due_from, dueTo: due_to, assigneeId: assignee_id }).slice(0, limit);
    return success(`Found ${tasks.length} matching Clio tasks.`, { tasks });
  }));

  // The MCP SDK currently preserves OpenAI's compatibility metadata under _meta.
  // Override tools/list so modern hosts also receive the documented top-level securitySchemes field.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions as any }));
  return server;
}
