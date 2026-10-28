// Package verification keeps the generic archive, runtime-import, and
// declaration-consumer checks while probing this package's root contract and
// QA fixture subpath. The root contract includes the piston operations used by
// W5; other root-visible domain exports remain internal.
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
// packages. Resolve them from this repository's pnpm installation so its local
// sibling packages share one Effect module instance in the consumer probe.
// Fetching the `@nerima-games/*` packages would need GitHub Packages auth; npm
// still resolves Effect's transitive dependencies from its package manifest.
const runtimeDependencyEntries = await Promise.all(
  Object.entries(manifest.dependencies ?? {}).map(async ([dependencyName, declaredVersion]) => {
    if (!dependencyName.startsWith("@nerima-games/") && dependencyName !== "effect") {
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
    const qaSpecifier = packageName + '/qa/redstone-placement-items';
    const qaModule = modules[specifiers.indexOf(qaSpecifier)];
    if (
      typeof qaModule?.REDSTONE_PLACEMENT_ITEMS?.has !== 'function' ||
      !qaModule.REDSTONE_PLACEMENT_ITEMS.has('dispenser')
    ) {
      throw new Error('The QA subpath does not expose REDSTONE_PLACEMENT_ITEMS');
    }
    // docs/public-api.md §5 — the stable root contract. Other power graph and
    // piston symbols remain root-visible but are not part of this check.
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
  applyPistonPlan,
  pistonPositionAt,
  planPistonTransition,
  validatePistonPlan,
  makeRuntimeRedstoneStages,
  redstoneModule,
  type LampTransition,
  type HopperTransferEvent,
  type RedstoneWorldRuntimeService,
  type RedstoneWorldSnapshot,
  type RedstoneComponentSnapshot,
  type RedstonePosition,
  type PoweredComponentKind,
  type PoweredComponentTransition,
  type PoweredPistonTransition,
  type RedstoneHostBlock,
  type RedstoneHostLookup,
  type RedstoneHostRealm,
  type RedstoneHostWritePort,
  type RedstoneTriggerEvent,
  type TriggeredComponentKind,
  type BlockCapabilityLookup,
  type BlockRef,
  type PistonApplyPort,
  type PistonCell,
  type PistonCellRead,
  type PistonFacing,
  type PistonKind,
  type PistonMove,
  type PistonMovementOutcome,
  type PistonMovementPlan,
  type PistonPlanRefusal,
  type PistonPosition,
  type PistonState,
  type PistonTransitionRequest,
  type PistonWorldView,
} from ${JSON.stringify(packageName)}
import { REDSTONE_PLACEMENT_ITEMS } from ${JSON.stringify(`${packageName}/qa/redstone-placement-items`)}

const declaredPackageExports: readonly unknown[] = [
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  REDSTONE_STAGE_IDS,
  makeRuntimeRedstoneStages,
  redstoneModule,
  applyPistonPlan,
  pistonPositionAt,
  planPistonTransition,
  validatePistonPlan,
  REDSTONE_PLACEMENT_ITEMS,
]
if (declaredPackageExports.length !== 10) {
  throw new Error('The TypeScript consumer did not load every declared package export')
}

const lampTransition: LampTransition | undefined = undefined
const runtimeService: RedstoneWorldRuntimeService | undefined = undefined
const snapshot: RedstoneWorldSnapshot | undefined = undefined
const componentSnapshot: RedstoneComponentSnapshot | undefined = undefined
const position: RedstonePosition | undefined = undefined
type PublishedHostTypes = readonly [
  BlockCapabilityLookup,
  BlockRef,
  HopperTransferEvent,
  LampTransition,
  PistonApplyPort<unknown>,
  PistonCell,
  PistonCellRead,
  PistonFacing,
  PistonKind,
  PistonMove,
  PistonMovementOutcome,
  PistonMovementPlan,
  PistonPlanRefusal,
  PistonPosition,
  PistonState,
  PistonTransitionRequest,
  PistonWorldView,
  PoweredComponentKind,
  PoweredComponentTransition,
  PoweredPistonTransition,
  RedstoneComponentSnapshot,
  RedstoneHostBlock,
  RedstoneHostLookup,
  RedstoneHostRealm,
  RedstoneHostWritePort,
  RedstonePosition,
  RedstoneTriggerEvent,
  RedstoneWorldRuntimeService,
  RedstoneWorldSnapshot,
  TriggeredComponentKind,
]
const publishedHostTypes: PublishedHostTypes | undefined = undefined
void lampTransition
void runtimeService
void snapshot
void componentSnapshot
void position
void publishedHostTypes
`;
  await writeFile(join(consumerDirectory, "consumer.ts"), typeConsumerSource.trimStart());
  // Effect 4's declarations reference the standard disposal protocol. Keep the
  // consumer target at ES2022 while making those platform types available.
  await writeFile(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          lib: ["ES2022", "DOM", "DOM.Iterable", "DOM.AsyncIterable", "ESNext.Disposable"],
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
