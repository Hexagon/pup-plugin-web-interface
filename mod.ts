// deno-lint-ignore-file no-explicit-any
/**
 * Main entrypoint of the Pup plugin 'plugin-web-interface'
 *
 * @file mod.ts
 */

import { Application, Router } from "@oak/oak";
import { dirname } from "@std/path";
import { Bundlee } from "@hexagon/bundlee/mod.ts";
import { PupRestClient } from "@pup/api-client";
import { type PluginConfiguration, PluginImplementation } from "@pup/plugin";
import type {
  ApiLogItem,
  ApiProcessStateChangedEvent,
} from "@pup/api-definitions";
import type { EventHandler } from "@pup/common/eventemitter";

interface Configuration {
  port: number;
}

export class PupPlugin extends PluginImplementation {
  public meta = {
    name: "WebInterfacePlugin",
    version: "1.0.0",
    api: "1.0.0",
    repository: "https://github.com/hexagon/pup-plugin-web-interface",
  };

  private config: Configuration;
  private app: Application;
  private router: Router;
  private controller: AbortController;

  private client: PupRestClient;

  constructor(
    config: PluginConfiguration,
    apiUrl: string,
    apiToken: string,
  ) {
    super(config, apiUrl, apiToken);

    this.config = config.options as Configuration;
    this.app = new Application();
    this.router = new Router();
    this.controller = new AbortController();

    // Store and validate plugin configuration
    if (!(this.config.port > 1 && this.config.port < 65535)) {
      throw new Error("Invalid port number");
    }

    // Get parameters from environment
    this.client = new PupRestClient(
      `http://${apiUrl}`,
      apiToken,
      true,
    );

    this.setupRoutes();
    this.startServer();
  }

  private setupRoutes() {
    // Set up WebSocket route
    this.router.get("/ws", async (context: any) => {
      if (!context.isUpgradable) {
        context.throw(501);
      }
      const ws = await context.upgrade();
      this.handleWebSocketConnection(ws);
    });

    // Set up endpoint to serve process data
    this.router.get("/processes", async (context: any) => {
      const ProcessStatees = await this.client.getProcesses();
      context.response.body = ProcessStatees;
    });

    // Set up endpoint to serve main process information
    this.router.get("/state", async (context: any) => {
      const ProcessStatees = await this.client.getState();
      context.response.body = ProcessStatees;
    });

    this.router.get("/start/:id", async (context: any) => {
      try {
        context.response.body = JSON.stringify({
          success: await this.client.startProcess(context.params.id),
        });
      } catch (_e) {
        context.response.code = 500;
        context.response.body = JSON.stringify({ success: false });
      }
    });
    this.router.get("/stop/:id", async (context: any) => {
      try {
        context.response.body = JSON.stringify({
          success: await this.client.stopProcess(context.params.id),
        });
      } catch (_e) {
        context.response.code = 500;
        context.response.body = JSON.stringify({ success: false });
      }
    });
    this.router.get("/restart/:id", async (context: any) => {
      try {
        context.response.body = JSON.stringify({
          success: await this.client.restartProcess(context.params.id),
        });
      } catch (_e) {
        context.response.code = 500;
        context.response.body = JSON.stringify({ success: false });
      }
    });
    this.router.get("/block/:id", async (context: any) => {
      try {
        context.response.body = JSON.stringify({
          success: await this.client.blockProcess(context.params.id),
        });
      } catch (_e) {
        context.response.code = 500;
        context.response.body = JSON.stringify({ success: false });
      }
    });
    this.router.get("/unblock/:id", async (context: any) => {
      try {
        context.response.body = JSON.stringify({
          success: await this.client.unblockProcess(context.params.id),
        });
      } catch (_e) {
        context.response.code = 500;
        context.response.body = JSON.stringify({ success: false });
      }
    });

    // Set up endpoint to redirect / to /web-interface.html
    this.router.get("/", (context: any) => {
      context.response.redirect("/web-interface.html");
    });

    this.router.get("/logs", async (context: any) => {
      try {
        const params = context.request.url.searchParams;

        const processId = params.get("processId");
        const startTimeStamp = params.get("startTimeStamp");
        const endTimeStamp = params.get("endTimeStamp");
        const severity = params.get("severity");
        let nRows = params.get("nRows");

        // Convert nRows to integer and validate
        if (nRows) {
          nRows = parseInt(nRows, 10);
          if (isNaN(nRows)) {
            context.response.status = 400;
            context.response.body = { error: "nRows should be a number" };
            return;
          }
        }

        const nRowsCapped = (!nRows || nRows > 100) ? 100 : nRows;

        const logContents = await this.client.getLogs(
          processId,
          startTimeStamp,
          endTimeStamp,
          severity,
          nRowsCapped,
        );

        context.response.body = logContents;
      } catch (error) {
        context.response.status = 500;
        context.response.body = {
          error: "Internal Server Error",
          message: error.message,
        };
      }
    });

    // Set up route to serve static files using Bundlee
    this.app.use(async (context: any, next: any) => {
      const staticFiles = await Bundlee.load(
        dirname(import.meta.url) + "/static/bundle.json",
        "fetch",
      );
      const url = "static" +
        context.request.url.pathname.replace("/proxy/8002/", "/");
      if (staticFiles.has(url)) {
        const fileData = await staticFiles.get(url);
        context.response.headers.set("Content-Type", fileData.contentType);
        context.response.body = fileData.content;
      } else {
        await next();
      }
    });

    this.app.use(this.router.routes());
    this.app.use(this.router.allowedMethods());
  }

  private async startServer() {
    try {
      await this.client.sendLog(
        "info",
        "web-interface",
        `Listening on http://localhost:${this.config.port}`,
      );
    } catch (_e) { /* Could not send log */ }
    await this.app.listen({
      port: this.config.port,
      signal: this.controller.signal,
    });
  }

  private handleWebSocketConnection(ws: WebSocket) {
    const logStreamer: EventHandler<ApiLogItem> = (d?: ApiLogItem) => {
      if (d) {
        const logRow: ApiLogItem = {
          timeStamp: new Date().getTime(),
          processId: d.processId || "core",
          category: d.category,
          severity: d.severity,
          text: d.text,
        };
        try {
          ws.send(JSON.stringify({
            type: "log",
            data: logRow,
          }));
        } catch (_e) {
          // Do not log, this will cause an infinite loop
          console.error(
            "ProcessStateStreamer: Error sending log update (not logged)",
          );
        }
      }
    };
    const processStateStreamer: EventHandler<ApiProcessStateChangedEvent> = (
      d?: ApiProcessStateChangedEvent,
    ) => {
      try {
        ws.send(JSON.stringify({
          type: "process_status_changed",
          data: d,
        }));
      } catch (_e) {
        this.client.sendLog(
          "error",
          "web-interface",
          `ProcessStateStreamer: Error sending process status update`,
        );
      }
    };
    ws.onopen = () => {
      this.client.on("log", logStreamer as EventHandler<unknown>);
      this.client.on(
        "process_status_changed",
        processStateStreamer as EventHandler<unknown>,
      );
    };
    ws.onclose = () => {
      this.client.off("log", logStreamer as EventHandler<unknown>);
      this.client.off(
        "process_status_changed",
        processStateStreamer as EventHandler<unknown>,
      );
    };
  }

  public async cleanup(): Promise<boolean> {
    this.controller.abort();
    return await true;
  }
}
