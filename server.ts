/**
 * Cloud Logging Viewer MCP Server
 *
 * Provides tools for:
 * - get-logs: Fetch log entries from Cloud Logging with filters
 * - show-log-viewer: Display an interactive log viewer UI
 *
 * Uses Cloud Logging REST API directly (not @google-cloud/logging)
 * to get protoPayload as decoded JSON instead of raw protobuf Buffer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { GoogleAuth } from "google-auth-library";

const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;
const resourceUri = "ui://cloud-logging/mcp-app.html";

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/logging.read"],
});

/**
 * Extract a human-readable message from a log entry returned by the REST API.
 * REST API returns protoPayload as decoded JSON (not protobuf Buffer).
 */
function extractMessage(entry: any): string {
  // textPayload — simple string
  if (entry.textPayload) {
    return entry.textPayload;
  }

  // jsonPayload — structured JSON
  if (entry.jsonPayload) {
    const jp = entry.jsonPayload;
    if (jp.message) return jp.message;
    try {
      const json = JSON.stringify(jp);
      return json.length > 500 ? json.slice(0, 500) + "..." : json;
    } catch {
      return String(jp);
    }
  }

  // protoPayload (AuditLog) — REST API returns this as decoded JSON
  if (entry.protoPayload) {
    const pp = entry.protoPayload;
    const parts: string[] = [];

    // Principal (who did it)
    const email = pp.authenticationInfo?.principalEmail;
    if (email) parts.push(email);

    // Method (what they did)
    if (pp.methodName) parts.push(pp.methodName);

    // Service
    if (pp.serviceName) parts.push(`(${pp.serviceName})`);

    // Resource — show full path, no truncation
    if (pp.resourceName) {
      parts.push(`→ ${pp.resourceName}`);
    }

    if (parts.length > 0) {
      return parts.join(" | ");
    }

    // Fallback
    return `AuditLog: ${pp["@type"] ?? "unknown"}`;
  }

  return "(empty)";
}

/**
 * Fetch log entries using Cloud Logging REST API directly.
 * This returns protoPayload as decoded JSON, avoiding the protobuf Buffer issue.
 */
async function fetchLogEntries(options: {
  projectId: string;
  startTime: string;
  endTime: string;
  severity?: string;
  resourceType?: string;
  textFilter?: string;
  maxEntries?: number;
}): Promise<
  Array<{
    timestamp: string;
    severity: string;
    message: string;
    resource: string;
    labels: Record<string, string>;
    logName: string;
  }>
> {
  // Build filter string
  const filterParts: string[] = [
    `timestamp >= "${options.startTime}"`,
    `timestamp <= "${options.endTime}"`,
  ];

  if (options.severity) {
    filterParts.push(`severity >= "${options.severity.toUpperCase()}"`);
  }
  if (options.resourceType) {
    filterParts.push(`resource.type = "${options.resourceType}"`);
  }
  if (options.textFilter) {
    filterParts.push(`textPayload : "${options.textFilter}"`);
  }

  const filter = filterParts.join(" AND ");
  const maxEntries = options.maxEntries ?? 100;

  // Get access token via ADC
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse.token;

  // Call REST API
  const response = await fetch("https://logging.googleapis.com/v2/entries:list", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      resourceNames: [`projects/${options.projectId}`],
      filter,
      orderBy: "timestamp desc",
      pageSize: maxEntries,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloud Logging API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as { entries?: any[]; nextPageToken?: string };
  const entries = data.entries ?? [];

  return entries.map((entry: any) => ({
    timestamp: entry.timestamp ?? "",
    severity: entry.severity ?? "DEFAULT",
    message: extractMessage(entry),
    resource: entry.resource?.type ?? "",
    labels: entry.resource?.labels ?? {},
    logName: entry.logName ?? "",
  }));
}

/**
 * Creates a new MCP server instance.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Cloud Logging Viewer",
    version: "1.0.0",
  });

  // Register the log viewer UI resource
  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "mcp-app.html"),
        "utf-8",
      );
      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
          },
        ],
      };
    },
  );

  // show-log-viewer tool — displays the interactive log viewer UI
  registerAppTool(
    server,
    "show-log-viewer",
    {
      title: "Show Log Viewer",
      description:
        "Display an interactive log viewer for GCP Cloud Logging. " +
        "Shows log entries in a scrollable list with severity highlighting. " +
        "Users can select log entries to ask Claude about them.",
      inputSchema: {
        projectId: z.string().describe("GCP Project ID"),
        startTime: z
          .string()
          .optional()
          .describe(
            "Start time in ISO 8601 format (default: 1 hour ago). Example: 2026-03-15T00:00:00Z",
          ),
        endTime: z
          .string()
          .optional()
          .describe(
            "End time in ISO 8601 format (default: now). Example: 2026-03-15T23:59:59Z",
          ),
        severity: z
          .string()
          .optional()
          .describe(
            "Minimum severity level: DEFAULT, DEBUG, INFO, NOTICE, WARNING, ERROR, CRITICAL, ALERT, EMERGENCY",
          ),
        resourceType: z
          .string()
          .optional()
          .describe(
            "Resource type filter. Examples: cloud_run_revision, gce_instance, gae_app, k8s_container",
          ),
        textFilter: z
          .string()
          .optional()
          .describe("Text search filter for log message content"),
        maxEntries: z
          .number()
          .optional()
          .default(100)
          .describe("Maximum number of log entries to retrieve (default: 100)"),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({
      projectId,
      startTime,
      endTime,
      severity,
      resourceType,
      textFilter,
      maxEntries,
    }): Promise<CallToolResult> => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const actualStartTime = startTime ?? oneHourAgo.toISOString();
      const actualEndTime = endTime ?? now.toISOString();

      try {
        const entries = await fetchLogEntries({
          projectId,
          startTime: actualStartTime,
          endTime: actualEndTime,
          severity,
          resourceType,
          textFilter,
          maxEntries,
        });

        // Convert UTC times to JST for display
        const toJST = (iso: string) => {
          const d = new Date(iso);
          return d.toLocaleString("ja-JP", {
            timeZone: "Asia/Tokyo",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
          });
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                projectId,
                startTime: actualStartTime,
                endTime: actualEndTime,
                startTimeJST: toJST(actualStartTime),
                endTimeJST: toJST(actualEndTime),
                severity: severity ?? "ALL",
                resourceType: resourceType ?? "ALL",
                textFilter: textFilter ?? "",
                totalEntries: entries.length,
                entries,
              }),
            },
            {
              type: "text",
              text: `Retrieved ${entries.length} log entries from project "${projectId}" ` +
                `(${toJST(actualStartTime)} 〜 ${toJST(actualEndTime)} JST). ` +
                `All timestamps are in JST (Asia/Tokyo). ` +
                `The interactive log viewer is displayed above. ` +
                `The user can click on log entries to select them, then ask questions about the selected entries.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching logs: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // get-logs tool — fetches logs without UI (for Claude to analyze directly)
  server.registerTool(
    "get-logs",
    {
      title: "Get Logs",
      description:
        "Fetch log entries from GCP Cloud Logging as text. " +
        "Use this when you want Claude to analyze logs directly without the interactive viewer.",
      inputSchema: {
        projectId: z.string().describe("GCP Project ID"),
        startTime: z
          .string()
          .optional()
          .describe("Start time in ISO 8601 format (default: 1 hour ago)"),
        endTime: z
          .string()
          .optional()
          .describe("End time in ISO 8601 format (default: now)"),
        severity: z
          .string()
          .optional()
          .describe("Minimum severity level (e.g., WARNING, ERROR)"),
        resourceType: z
          .string()
          .optional()
          .describe("Resource type filter (e.g., cloud_run_revision)"),
        textFilter: z
          .string()
          .optional()
          .describe("Text search filter"),
        maxEntries: z
          .number()
          .optional()
          .default(50)
          .describe("Maximum entries (default: 50)"),
      },
    },
    async ({
      projectId,
      startTime,
      endTime,
      severity,
      resourceType,
      textFilter,
      maxEntries,
    }): Promise<CallToolResult> => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      try {
        const entries = await fetchLogEntries({
          projectId,
          startTime: startTime ?? oneHourAgo.toISOString(),
          endTime: endTime ?? now.toISOString(),
          severity,
          resourceType,
          textFilter,
          maxEntries,
        });

        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No log entries found for project "${projectId}" with the given filters.`,
              },
            ],
          };
        }

        const formatted = entries
          .map(
            (e, i) =>
              `[${i + 1}] ${e.timestamp} [${e.severity}] (${e.resource}) ${e.message}`,
          )
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${entries.length} log entries:\n\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}
