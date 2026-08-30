// DEVIATION FROM "copy verbatim from kernel" (runbook §2.4 / D.10): mc-kernel's
// verify-package.mjs (a) requires every `export * from './domain/...'` star
// re-export in src/index.ts to have a matching `./domain/<name>` subpath in
// package.json#exports, and (b) hardcodes runtime/type assertions against
// kernel's own domain (blockHardnessOf, fixedClock, resolveBedrockDiggerSpeed,
// …). Neither applies here: this package's `exports` map is deliberately just
// `"."` (docs/public-api.md §2 — the power graph and piston planner are
// re-exported for internal test/preview use, not published as subpaths; the
// repo's hard rule is "never add subpaths to satisfy a copied verify-package
// check"), and its runtime contract is stage registration plus the
// `RedstoneWorldRuntime` port, not kernel's domain. This script keeps the
// generic parts (pack, archive-content check, a clean-consumer runtime import,
// a clean-consumer TypeScript declaration check) and replaces the
// kernel-specific probe with one scoped to docs/public-api.md §5's actual
// contract list.
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packageName = manifest.name;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

const commandLabel = (command, args) => `${command} ${args.join(" ")}`;

const run = (command, args, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, ...options } = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    ...options,
  });
  if (result.error) {
    throw new Error(`${commandLabel(command, args)} failed: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`${commandLabel(command, args)} terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`${commandLabel(command, args)} exited with status ${result.status}`);
  }
  return result;
};

const capture = (command, args, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, ...options } = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    ...options,
  });
  if (result.error) {
    throw new Error(`${commandLabel(command, args)} failed: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`${commandLabel(command, args)} terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${commandLabel(command, args)} exited with status ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
};

const exportEntries = Object.entries(manifest.exports ?? {});
if (exportEntries.length === 0) {
  throw new Error("package.json must declare at least one export");
}

const targetPaths = new Set();
for (const [subpath, target] of exportEntries) {
  if (typeof target === "string") {
    targetPaths.add(target);
    continue;
  }
  if (typeof target !== "object" || target === null) {
    throw new Error(`Unsupported export declaration for ${subpath}`);
  }
  for (const field of ["types", "import", "default"]) {
    if (typeof target[field] === "string") {
      targetPaths.add(target[field]);
    }
  }
}
if (targetPaths.size === 0) {
  throw new Error("package.json exports do not contain any target paths");
}

const archiveEntryFor = (targetPath) => `package/${targetPath.replace(/^\.\//, "")}`;
const importSpecifiers = exportEntries.map(([subpath]) => (subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`));

// This repository's `dependencies` are the org's runtime dependency graph
// (DEPENDENCY_POLICY.md, Tier 3): `effect` plus the already-published sibling
// packages. The `@nerima-games/*` siblings are resolved as `file:` deps
// pointing at this repository's own (already `pnpm install`-resolved)
// node_modules entries, since fetching them would need GitHub Packages auth.
// `effect` is left as its declared version so npm resolves it — and its own
// transitive deps (`fast-check`, `pure-rand`) — from the public registry,
// which needs no auth and is the only way to get a *consistent* dependency
// tree without hand-walking effect's own dependency graph.
const runtimeDependencyEntries = await Promise.all(
  Object.entries(manifest.dependencies ?? {}).map(async ([dependencyName, declaredVersion]) => {
    if (!dependencyName.startsWith("@nerima-games/")) {
      return [dependencyName, declaredVersion];
    }
    const sourcePath = await realpath(join(root, "node_modules", ...dependencyName.split("/")));
    return [dependencyName, `file:${sourcePath}`];
  }),
);

const workspace = await mkdtemp(join(tmpdir(), "mx-redstone-package-"));
const packDirectory = join(workspace, "pack");
const consumerDirectory = join(workspace, "consumer");
await mkdir(packDirectory);
await mkdir(consumerDirectory);

try {
  run("pnpm", ["pack", "--pack-destination", packDirectory], { timeoutMs: 60_000 });

  const { readdir } = await import("node:fs/promises");
  const archives = (await readdir(packDirectory)).filter((entry) => entry.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one package archive, found ${archives.length}`);
  }
  const archivePath = join(packDirectory, archives[0]);
  const archiveStat = await stat(archivePath);
  if (archiveStat.size === 0) {
    throw new Error("Package archive is empty");
  }

  const archiveEntries = new Set(
    capture("tar", ["-tzf", archivePath], { cwd: root, timeoutMs: 30_000 }).trim().split("\n").filter(Boolean),
  );
  for (const targetPath of targetPaths) {
    const archiveEntry = archiveEntryFor(targetPath);
    if (!archiveEntries.has(archiveEntry)) {
      throw new Error(`Package archive is missing export target ${archiveEntry}`);
    }
  }

  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "mx-redstone-package-consumer",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(runtimeDependencyEntries),
      },
      null,
      2,
    )}\n`,
  );
  // The `@nerima-games/*` deps above are already `file:` paths, so this
  // install never actually queries GitHub Packages for them (that is the
  // whole point of resolving them locally — see the comment above). This
  // .npmrc is written anyway per the Wave 0 org decision (verify-package.mjs
  // must be able to authenticate to GitHub Packages, since most repos in the
  // org do need it here): `${NODE_AUTH_TOKEN}` is the literal placeholder
  // npm expands from its own environment, never the token value itself.
  await writeFile(
    join(consumerDirectory, ".npmrc"),
    `@nerima-games:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n`,
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archivePath], {
    cwd: consumerDirectory,
    timeoutMs: 180_000,
    env: { ...process.env, NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN ?? "" },
  });

  const probe = `
    const packageName = ${JSON.stringify(packageName)};
    const specifiers = ${JSON.stringify(importSpecifiers)};
    const modules = await Promise.all(specifiers.map((specifier) => import(specifier)));
    if (modules.some((module) => Object.keys(module).length === 0)) {
      throw new Error('An exported package module has no runtime exports');
    }
    const rootModule = modules[specifiers.indexOf(packageName)];
    // docs/public-api.md §5 — the actual contract, not everything the barrel
    // makes visible (the power graph and piston planner are visible-but-not-
    // public and are intentionally left unchecked here).
    if (rootModule.RedstoneWorldRuntime === undefined) {
      throw new Error('The root export does not expose RedstoneWorldRuntime');
    }
    if (rootModule.RedstoneWorldRuntimeLayer === undefined) {
      throw new Error('The root export does not expose RedstoneWorldRuntimeLayer');
    }
    if (typeof rootModule.REDSTONE_STAGE_IDS !== 'object' || rootModule.REDSTONE_STAGE_IDS === null) {
      throw new Error('The root export does not expose REDSTONE_STAGE_IDS');
    }
    if (rootModule.makeRuntimeRedstoneStages === undefined) {
      throw new Error('The root export does not expose makeRuntimeRedstoneStages');
    }
    if (typeof rootModule.redstoneModule !== 'object' || rootModule.redstoneModule === null) {
      throw new Error('The root export does not expose the redstoneModule GameModule');
    }
    if (rootModule.redstoneModule.layers === undefined || rootModule.redstoneModule.frameStages === undefined) {
      throw new Error('redstoneModule is missing the GameModule layers/frameStages shape');
    }
    console.log('verified ' + packageName + ' exports: ' + specifiers.join(', '));
  `;
  run("node", ["--input-type=module", "--eval", probe], { cwd: consumerDirectory, timeoutMs: 30_000 });

  const typeConsumerSource = `
import {
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  REDSTONE_STAGE_IDS,
  makeRuntimeRedstoneStages,
  redstoneModule,
  type LampTransition,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshot,
  type RedstoneComponentSnapshot,
  type RedstonePosition,
} from ${JSON.stringify(packageName)}

const declaredPackageExports: readonly unknown[] = [
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  REDSTONE_STAGE_IDS,
  makeRuntimeRedstoneStages,
  redstoneModule,
]
if (declaredPackageExports.length !== 5) {
  throw new Error('The TypeScript consumer did not load every declared package export')
}

const lampTransition: LampTransition | undefined = undefined
const runtimeService: RedstoneWorldRuntimeService | undefined = undefined
const snapshot: RedstoneWorldSnapshot | undefined = undefined
const componentSnapshot: RedstoneComponentSnapshot | undefined = undefined
const position: RedstonePosition | undefined = undefined
void lampTransition
void runtimeService
void snapshot
void componentSnapshot
void position
`;
  await writeFile(join(consumerDirectory, "consumer.ts"), typeConsumerSource.trimStart());
  await writeFile(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const typeScriptCompiler = await realpath(join(root, "node_modules", "typescript", "bin", "tsc"));
  run(process.execPath, [typeScriptCompiler, "--project", join(consumerDirectory, "tsconfig.json"), "--pretty", "false"], {
    cwd: consumerDirectory,
    timeoutMs: 30_000,
  });
  console.log(`verified ${packageName} declaration consumer typecheck`);

  console.log(`verified package archive ${archivePath}`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
