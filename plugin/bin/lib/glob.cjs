'use strict';
// Small glob matcher for project-relative, forward-slash paths.
// `**` crosses directories, `*` and `?` do not. A pattern without wildcards also
// matches everything below it, so `src` and `src/` both cover `src/a.ts`.
const fs = require('fs');
const path = require('path');

const FOLD = process.platform === 'win32' ? 'i' : '';

function globToRegExp(pattern) {
  const clean = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (c === '*' && clean[i + 1] === '*') {
      if (clean[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}(?:/.*)?$`, FOLD);
}

function globMatcher(patterns) {
  const compiled = patterns.map(globToRegExp);
  return (rel) => {
    const target = rel.replace(/\\/g, '/');
    return compiled.some((re) => re.test(target));
  };
}

function matchesAny(rel, patterns) {
  return globMatcher(patterns)(rel);
}

// Real path of `target`, following links on every part that exists, so a link
// inside the project cannot lead a write outside it.
function realPathAllowMissing(target) {
  const missing = [];
  let cursor = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...missing.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return path.resolve(target);
      }
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

// Project-relative forward-slash path, or null when the path resolves outside root.
function projectRelative(root, target) {
  const realRoot = realPathAllowMissing(root);
  const abs = path.isAbsolute(target) ? target : path.join(root, target);
  const rel = path.relative(realRoot, realPathAllowMissing(abs));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join('/');
}

// First protected or outside-project path a search of `target` could reach, or null.
// Checks names and link targets and reads no file contents. Only links are resolved:
// below a real directory, a plain entry's real path is its parent's plus its name, so
// this stays cheap on large trees such as node_modules. A dangling link is skipped, since
// there is nothing behind it to reach. Throws if any other path can't be read.
function findProtected(root, target, isProtected) {
  const realRoot = fs.realpathSync.native(root);
  const visited = new Set();
  // '' for the root itself, null when outside it.
  const within = (real) => {
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return null;
    }
    return rel.split(path.sep).join('/');
  };
  const blocked = (rel) => rel !== '' && isProtected(rel);

  function walk(dir, dirRel) {
    if (visited.has(dir)) {
      return null;
    }
    visited.add(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const link = entry.isSymbolicLink();
      let real = full;
      if (link) {
        try {
          real = fs.realpathSync.native(full);
        } catch (err) {
          if (err.code === 'ENOENT') {
            continue;
          }
          throw err;
        }
      }
      let rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (link) {
        rel = within(real);
      }
      if (rel === null) {
        return full;
      }
      if (blocked(rel)) {
        return rel;
      }
      if (link ? fs.statSync(real).isDirectory() : entry.isDirectory()) {
        const found = walk(real, rel);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  const real = fs.realpathSync.native(path.resolve(root, target));
  const rel = within(real);
  if (rel === null) {
    return real;
  }
  if (blocked(rel)) {
    return rel;
  }
  return fs.statSync(real).isDirectory() ? walk(real, rel) : null;
}

module.exports = { findProtected, globMatcher, globToRegExp, matchesAny, projectRelative };
