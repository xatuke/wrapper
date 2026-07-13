import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { buildSandboxEnv } from "./sandbox-env.js";

const exec = promisify(execFile);

/**
 * Render an HTML report to PDF via headless Chromium's built-in print-to-PDF —
 * no extra dependencies, full CSS fidelity. Requires a chromium in the image
 * (CHROMIUM_BIN, default the agent's --no-sandbox wrapper). Output lands in the
 * workspace so it can be sent with slack_upload.
 */
export function createPdfTools(dataDir: string): AgentTool[] {
  const root = join(dataDir, "workspace");
  const chromium = process.env.CHROMIUM_BIN ?? "/usr/local/bin/chromium-nosandbox";

  function safePath(p: string): string {
    const abs = resolve(root, p.replace(/^\/+/, ""));
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`Path escapes the workspace: ${p}`);
    return abs;
  }

  const tool: AgentTool = {
    name: "html_to_pdf",
    label: "Render HTML to PDF",
    description:
      "Render an HTML report to a PDF (headless Chromium, full CSS support). Provide the HTML " +
      "either inline via `html` or as a workspace file via `htmlPath`. Reference images with " +
      "relative paths or file:// URLs (e.g. a chart PNG you saved). Output goes to `outPath` in " +
      "your workspace — then send it with slack_upload. Build a good-looking report with normal " +
      "HTML/CSS: headings, tables, <img> charts.",
    parameters: Type.Object({
      html: Type.Optional(Type.String({ description: "inline HTML (use this OR htmlPath)" })),
      htmlPath: Type.Optional(Type.String({ description: "workspace-relative path to an .html file" })),
      outPath: Type.Optional(Type.String({ description: "output PDF path in workspace (default report.pdf)" })),
    }),
    async execute(_id, params: any) {
      if (!params.html && !params.htmlPath) {
        return { content: [{ type: "text" as const, text: "Provide `html` or `htmlPath`." }], details: undefined };
      }
      mkdirSync(root, { recursive: true });
      let htmlAbs: string;
      try {
        if (params.htmlPath) {
          htmlAbs = safePath(params.htmlPath);
          if (!existsSync(htmlAbs)) return { content: [{ type: "text" as const, text: `No such file: ${params.htmlPath}` }], details: undefined };
        } else {
          htmlAbs = join(root, `.report-${Date.now()}.html`);
          writeFileSync(htmlAbs, params.html);
        }
        const outAbs = safePath(params.outPath ?? "report.pdf");
        mkdirSync(join(dataDir, "code-home"), { recursive: true });
        await exec(
          chromium,
          [
            "--headless=new",
            "--no-pdf-header-footer",
            `--user-data-dir=/tmp/chrome-pdf`,
            `--print-to-pdf=${outAbs}`,
            `file://${htmlAbs}`,
          ],
          { env: buildSandboxEnv(dataDir), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
        );
        if (!existsSync(outAbs)) {
          return { content: [{ type: "text" as const, text: "Chromium ran but produced no PDF — check the HTML." }], details: undefined };
        }
        return { content: [{ type: "text" as const, text: `Wrote ${params.outPath ?? "report.pdf"}. Send it with slack_upload.` }], details: undefined };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `PDF render failed: ${[err?.stderr, err?.message].filter(Boolean).join(" ").slice(0, 400)}` }], details: undefined };
      }
    },
  };

  return [tool];
}
