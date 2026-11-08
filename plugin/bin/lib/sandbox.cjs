'use strict';
// A throwaway copy of the candidate for the mutation check, so a mutated file can never be
// left in the user's working tree. Dependency folders are linked, not copied, and the links
// are removed one by one before the copy is deleted, so deleting it can't follow them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { matchesAny } = require('./glob.cjs');

const DEPENDENCY_DIRS = ['node_modules', '.venv', 'venv'];

function copyEntry(root, dir, rel) {
  const from = path.join(root, rel);
  const to = path.join(dir, rel);
  const st = fs.lstatSync(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to);
  } else if (st.isFile()) {
    fs.copyFileSync(from, to);
  }
}

// `files` is the candidate's file list. Protected files stay out of the copy: a suite that
// needs one fails its control run in the copy, and the check reports that.
function createSandbox(root, files, protectedPatterns, checkCwd) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devgate-mutation-')));
  const box = { dir, links: [] };
  const linkFrom = new Set(['.', checkCwd || '.']);
  for (const rel of files) {
    if (matchesAny(rel, protectedPatterns)) {
      continue;
    }
    try {
      copyEntry(root, dir, rel);
    } catch (err) {
      // EPERM: Windows may refuse to create a link. A suite that needs it fails its control run.
      if (err.code !== 'ENOENT' && err.code !== 'EPERM') {
        throw err;
      }
    }
    if (path.posix.basename(rel) === 'package.json') {
      linkFrom.add(path.posix.dirname(rel));
    }
  }
  for (const folder of linkFrom) {
    for (const name of DEPENDENCY_DIRS) {
      const real = path.join(root, folder, name);
      const link = path.join(dir, folder, name);
      if (!fs.existsSync(real) || fs.existsSync(link)) {
        continue;
      }
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      box.links.push(link);
    }
  }
  return box;
}

// Returns false, leaving the copy on disk, if a link can't be removed: deleting the tree
// with a link still in it could reach the real dependency folder.
function removeSandbox(box) {
  for (const link of box.links) {
    try {
      fs.unlinkSync(link);
    } catch {
      try {
        fs.rmdirSync(link);
      } catch {
        return false;
      }
    }
  }
  try {
    fs.rmSync(box.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    return false;
  }
  return true;
}

module.exports = { DEPENDENCY_DIRS, createSandbox, removeSandbox };
