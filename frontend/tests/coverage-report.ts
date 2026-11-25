// Coverage of the app's own code from the Playwright run (`npm run coverage:e2e`, which sets
// COVERAGE=1). Chromium records which code ran (V8 coverage) and monocart-coverage-reports maps it
// back through Vite's source maps to src/ and ai/. Files no test loads, lazy pages included, are
// compiled with the project's TypeScript and count as 0%, so they can't drop out of the total.
// The report is written to coverage/e2e/ when the run ends.
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import MCR, { type CoverageReportOptions } from "monocart-coverage-reports";

const isAppFile = (file: string) => /(^|\/)(src|ai)\/.+\.tsx?$/.test(file) && !file.endsWith(".d.ts");

export const coverageOptions: CoverageReportOptions = {
  name: "Frontend (Playwright)",
  outputDir: "./coverage/e2e",
  reports: ["console-summary", "html", "json-summary"],
  // The app's TypeScript modules as the Vite dev server serves them: not dependencies, Vite's own
  // client, or stylesheets (served as small JS modules).
  entryFilter: (entry) => /^\/(src|ai)\/.+\.tsx?$/.test(new URL(entry.url).pathname),
  // Vite's source maps name each source by file name alone ("ui.tsx"); entryFilter has already
  // kept only the app's modules, so this just keeps the TypeScript sources.
  sourceFilter: (sourcePath) => /\.tsx?$/.test(sourcePath) && !sourcePath.endsWith(".d.ts"),
  // A bare "ui.tsx" sits next to its module ("127.0.0.1-5175/src/workspace/ui.tsx"); either way
  // the path ends as "src/workspace/ui.tsx", the same path an untested file gets.
  sourcePath: (filePath, { distFile }) => {
    const full =
      !filePath.includes("/") && distFile ? path.posix.join(path.posix.dirname(distFile), filePath) : filePath;
    return full.replace(/^.*?(?=(src|ai)\/)/, "");
  },
  all: {
    dir: ["./src", "./ai"],
    filter: isAppFile,
    transformer: async (entry) => {
      const file = fileURLToPath(entry.url);
      const out = ts.transpileModule(entry.source, {
        fileName: file,
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          sourceMap: true,
        },
      });
      const sourceMap = JSON.parse(out.sourceMapText ?? "{}");
      sourceMap.sources = [path.basename(file)];
      sourceMap.sourcesContent = [entry.source];
      entry.source = out.outputText.replace(/\n\/\/# sourceMappingURL=.*$/, "");
      entry.sourceMap = sourceMap;
    },
  },
};

/** globalSetup under COVERAGE=1: drops the last run's data; the returned teardown writes the report. */
export default async function coverageSetup() {
  MCR(coverageOptions).cleanCache();
  return async () => {
    await MCR(coverageOptions).generate();
  };
}
