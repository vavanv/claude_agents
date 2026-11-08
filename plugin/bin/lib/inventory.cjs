'use strict';
// Candidate identity: enumerate project files, hash their bytes, compare snapshots.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { matchesAny } = require('./glob.cjs');

const WALK_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '__pycache__', '.venv']);

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isGitWorkTree(root) {
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function gitFiles(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256,
  });
  if (r.status !== 0) {
    throw new Error(`git ls-files failed: ${r.stderr}`);
  }
  return r.stdout.split('\0').filter(Boolean);
}

function walkFiles(root) {
  const out = [];
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (WALK_SKIP.has(entry.name)) {
        continue;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  visit(root, '');
  return out;
}

// Returns { method, files: { relPath: sha256 } } with sorted keys.
function takeInventory(root, excludes = []) {
  const method = isGitWorkTree(root) ? 'git-ls-files' : 'walk';
  const names = method === 'git-ls-files' ? gitFiles(root) : walkFiles(root);
  const entries = [];
  for (const rel of [...new Set(names)].sort()) {
    if (matchesAny(rel, excludes)) {
      continue;
    }
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue; // tracked but deleted: absent here, so a comparison reports it as removed
    }
    if (st.isSymbolicLink()) {
      entries.push([rel, sha256(`symlink:${fs.readlinkSync(abs)}`)]);
    } else if (st.isFile()) {
      entries.push([rel, sha256(fs.readFileSync(abs))]);
    }
    // directories (for example submodules) are not candidate files
  }
  return { method, files: Object.fromEntries(entries) };
}

function diffInventories(before, after) {
  const added = [];
  const removed = [];
  const modified = [];
  for (const rel of Object.keys(after)) {
    if (!(rel in before)) {
      added.push(rel);
    } else if (before[rel] !== after[rel]) {
      modified.push(rel);
    }
  }
  for (const rel of Object.keys(before)) {
    if (!(rel in after)) {
      removed.push(rel);
    }
  }
  return { added, removed, modified, changed: [...added, ...removed, ...modified].sort() };
}

// One digest for the whole file set; paths and contents both contribute.
function fingerprint(files) {
  const lines = Object.keys(files).sort().map((rel) => `${rel}\0${files[rel]}\n`);
  return sha256(lines.join(''));
}

module.exports = { sha256, takeInventory, diffInventories, fingerprint, isGitWorkTree };
