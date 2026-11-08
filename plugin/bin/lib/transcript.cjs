'use strict';
// Reads a subagent transcript for two things: which model actually ran, and the
// subagent's final message. Transcript shapes can change between versions, so any
// unrecognised shape produces "unknown" here and UNVERIFIED in the report.
const fs = require('fs');

function readRecords(transcriptPath) {
  if (!transcriptPath) {
    return [];
  }
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partial or malformed line gives no evidence.
    }
  }
  return records;
}

function assistantRecords(records) {
  return records.filter((r) => r && r.type === 'assistant' && r.message);
}

// Every model seen counts: a later match cannot hide an earlier mismatch.
function auditModel(transcriptPath, configuredModel) {
  const assistants = assistantRecords(readRecords(transcriptPath));
  const observed = [
    ...new Set(assistants.map((r) => r.message.model).filter((m) => m && m !== '<synthetic>')),
  ];
  const efforts = [...new Set(assistants.map((r) => r.effort).filter(Boolean))];
  const versions = [...new Set(assistants.map((r) => r.version).filter(Boolean))];
  let status = 'UNVERIFIED';
  let reason = 'No runtime model recorded in the subagent transcript.';
  if (observed.length > 0) {
    if (!configuredModel) {
      reason = 'Runtime model observed, but no configured model to compare it with.';
    } else if (observed.every((m) => m === configuredModel)) {
      status = 'MATCH';
      reason = `All ${assistants.length} assistant records used the configured model.`;
    } else {
      status = 'MISMATCH';
      reason = `Configured ${configuredModel}, observed ${observed.join(', ')}.`;
    }
  }
  return {
    status,
    reason,
    configuredModel: configuredModel || null,
    observedModels: observed,
    observedEfforts: efforts,
    claudeCodeVersions: versions,
    assistantRecords: assistants.length,
  };
}

function textOfMessage(message) {
  const parts = [];
  const content = message && message.content;
  if (typeof content === 'string') {
    parts.push(content);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      }
      if (block.type === 'tool_use' && block.name === 'SubagentHandback') {
        if (block.input && typeof block.input.message === 'string') {
          parts.push(block.input.message);
        }
      }
    }
  }
  return parts.join('\n');
}

function handbackOf(message) {
  const content = message && message.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block && block.type === 'tool_use' && block.name === 'SubagentHandback'
        && block.input && typeof block.input.message === 'string') {
      return block.input.message;
    }
  }
  return null;
}

// The delivered report, from one source chosen in this order: the latest
// SubagentHandback call, then last_assistant_message, then the latest assistant text.
// A handback wins because closing text after it ("Review complete.") is not the report.
// The source is picked before parsing, so a later source never rescues a bad verdict.
function finalMessage(hookInput) {
  const assistants = assistantRecords(readRecords(hookInput && hookInput.agent_transcript_path));
  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    const handback = handbackOf(assistants[i].message);
    if (handback !== null) {
      return handback;
    }
  }
  if (hookInput && typeof hookInput.last_assistant_message === 'string' && hookInput.last_assistant_message) {
    return hookInput.last_assistant_message;
  }
  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    const text = textOfMessage(assistants[i].message);
    if (text) {
      return text;
    }
  }
  return '';
}

// The reviewer's statement of how each criterion is checked. Anything malformed gives
// null, which the report shows as "not stated"; it never affects the verdict.
function parseCoverage(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const out = [];
  for (const c of value) {
    if (!c || !Number.isInteger(c.criterion) || c.criterion < 1 || !['test', 'reading'].includes(c.by)) {
      return null;
    }
    if (out.some((o) => o.criterion === c.criterion)) {
      continue;
    }
    out.push({ criterion: c.criterion, by: c.by, where: typeof c.where === 'string' && c.where ? c.where.slice(0, 300) : null });
  }
  return out;
}

// Only the final nonempty line is evidence; earlier examples cannot be a fallback.
function parseVerdict(text) {
  const line = String(text).trimEnd().split(/\r?\n/).at(-1).trim();
  try {
    const parsed = JSON.parse(line);
    if (parsed && ['APPROVE', 'REQUEST_CHANGES'].includes(parsed.verdict)
        && Array.isArray(parsed.findings)) {
      return { verdict: parsed.verdict, findings: parsed.findings, coverage: parseCoverage(parsed.coverage) };
    }
  } catch {
    // Invalid final evidence is UNVERIFIED.
  }
  return null;
}

module.exports = { auditModel, finalMessage, parseVerdict };
