#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

const BROWSERS = ["firefox", "chrome", "edge"];

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(from);
      await fs.symlink(target, to);
    }
  }
}

async function buildTarget(root, browser) {
  const sharedDir = path.join(root, "src", "shared");
  const overrideDir = path.join(root, "src", "overrides", browser);
  const distDir = path.join(root, "dist", browser);

  let sharedStats;
  try {
    sharedStats = await fs.stat(sharedDir);
  } catch {
    console.warn("Shared sources missing; aborting build.");
    return;
  }

  if (!sharedStats.isDirectory()) {
    console.warn("Shared source path is not a directory; aborting build.");
    return;
  }

  await fs.rm(distDir, { recursive: true, force: true });
  await copyDir(sharedDir, distDir);

  try {
    const overrideStats = await fs.stat(overrideDir);
    if (overrideStats.isDirectory()) {
      await copyDir(overrideDir, distDir);
    }
  } catch {
    console.warn(`No overrides found for "${browser}".`);
  }

  console.log(`Built ${browser} -> ${path.relative(root, distDir)}`);
}

async function main() {
  const root = path.resolve(__dirname);
  await fs.mkdir(path.join(root, "dist"), { recursive: true });

  const requested = process.argv.slice(2);
  const targets = requested.length ? requested : BROWSERS;

  for (const browser of targets) {
    await buildTarget(root, browser);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
