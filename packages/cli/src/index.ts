#!/usr/bin/env node

import { loadConfig, saveConfig, resolveDoc, parseProofUrl } from './config.js';
import * as api from './api.js';

const USAGE = `proof — CLI for Proof collaborative editor

Usage:
  proof read <doc> [--token T] [--instance I] [--url U] [--json]
  proof snapshot <doc> [--token T] [--instance I] [--url U] [--json]
  proof write <doc> <text> [--token T] [--instance I] [--url U]
  proof write <doc> --stdin [--token T] [--instance I] [--url U]
  proof replace <doc> --ref <ref> <text> [--token T] [--instance I] [--url U]
  proof comment <doc> --quote <text> <comment> [--token T] [--instance I] [--url U]
  proof suggest <doc> --quote <old> <new> [--token T] [--instance I] [--url U]
  proof create <markdown> [--title T] [--url U] [--json]
  proof health [--url U | --instance I]
  proof config add <name> --url <url> [--agent-id ID]
  proof config doc add <alias> <slug> <token> --instance <name>
  proof config doc add-url <alias> <proof-url>
  proof config list
  proof config doc list

Arguments:
  <doc>    A saved doc alias OR a document slug (with --token)

Options:
  --token T      Access token (required if <doc> is a slug, not an alias)
  --instance I   Named instance from config
  --url U        Base URL override (e.g., https://proofeditor.ai)
  --json         Output raw JSON instead of formatted text
  --ref R        Block reference for replace (e.g., b3)
  --quote Q      Text to anchor comment/suggestion on
  --title T      Document title for create
  --stdin        Read content from stdin
  --agent-id ID  Agent identifier (default: cli:proof-cli)
`;

// --- Arg parsing ---

function parseArgs(argv: string[]): { command: string[]; flags: Record<string, string | boolean> } {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      command.push(arg);
    }
  }

  return { command, flags };
}

function flag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// --- Commands ---

async function cmdRead(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const doc = args[0] ?? die('usage: proof read <doc>');
  const config = loadConfig();
  const resolved = resolveDoc(config, doc, {
    token: flag(flags, 'token'),
    instance: flag(flags, 'instance'),
    url: flag(flags, 'url'),
  });

  const state = await api.getState(resolved, resolved.slug);
  if (flags['json']) {
    console.log(JSON.stringify(state, null, 2));
  } else {
    console.log(state.content);
  }
}

async function cmdSnapshot(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const doc = args[0] ?? die('usage: proof snapshot <doc>');
  const config = loadConfig();
  const resolved = resolveDoc(config, doc, {
    token: flag(flags, 'token'),
    instance: flag(flags, 'instance'),
    url: flag(flags, 'url'),
  });

  const snap = await api.getSnapshot(resolved, resolved.slug);
  if (flags['json']) {
    console.log(JSON.stringify(snap, null, 2));
  } else {
    for (const block of snap.blocks) {
      console.log(`[${block.ref}] ${block.markdown}`);
    }
    if (snap.mutationBase?.token) {
      console.log(`\nbaseToken: ${snap.mutationBase.token}`);
    }
    if (typeof snap.revision === 'number') {
      console.log(`revision: ${snap.revision}`);
    }
  }
}

async function cmdWrite(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  let text: string;
  const doc = args[0] ?? die('usage: proof write <doc> <text>');

  if (flags['stdin']) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    text = Buffer.concat(chunks).toString('utf-8').trimEnd();
  } else {
    text = args[1] ?? die('usage: proof write <doc> <text> (or --stdin)');
  }

  const config = loadConfig();
  const resolved = resolveDoc(config, doc, {
    token: flag(flags, 'token'),
    instance: flag(flags, 'instance'),
    url: flag(flags, 'url'),
  });

  const result = await api.appendText(resolved, resolved.slug, text);
  console.log(flags['json'] ? JSON.stringify(result, null, 2) : 'Written (pending sync).');
}

async function cmdReplace(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const doc = args[0] ?? die('usage: proof replace <doc> --ref <ref> <text>');
  const ref = flag(flags, 'ref') ?? die('--ref is required');
  const text = args[1] ?? die('usage: proof replace <doc> --ref <ref> <text>');

  const config = loadConfig();
  const resolved = resolveDoc(config, doc, {
    token: flag(flags, 'token'),
    instance: flag(flags, 'instance'),
    url: flag(flags, 'url'),
  });

  const result = await api.replaceBlock(resolved, resolved.slug, ref, text);
  console.log(flags['json'] ? JSON.stringify(result, null, 2) : 'Replaced (pending sync).');
}

async function cmdComment(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const doc = args[0] ?? die('usage: proof comment <doc> --quote <text> <comment>');
  const quote = flag(flags, 'quote') ?? die('--quote is required');
  const text = args[1] ?? die('usage: proof comment <doc> --quote <text> <comment>');

  const config = loadConfig();
  const resolved = resolveDoc(config, doc, {
    token: flag(flags, 'token'),
    instance: flag(flags, 'instance'),
    url: flag(flags, 'url'),
  });

  const result = await api.addComment(resolved, resolved.slug, quote, text);
  console.log(flags['json'] ? JSON.stringify(result, null, 2) : 'Comment added.');
}

async function cmdSuggest(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const doc = args[0] ?? die('usage: proof suggest <doc> --quote <old> <new>');
  const quote = flag(flags, 'quote') ?? die('--quote is required');
  const content = args[1] ?? die('usage: proof suggest <doc> --quote <old> <new>');

  const config = loadConfig();
  const resolved = resolveDoc(config, doc, {
    token: flag(flags, 'token'),
    instance: flag(flags, 'instance'),
    url: flag(flags, 'url'),
  });

  const result = await api.addSuggestion(resolved, resolved.slug, quote, content);
  console.log(flags['json'] ? JSON.stringify(result, null, 2) : 'Suggestion added.');
}

async function cmdCreate(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  let markdown: string;
  if (flags['stdin']) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    markdown = Buffer.concat(chunks).toString('utf-8').trimEnd();
  } else {
    markdown = args[0] ?? die('usage: proof create <markdown> [--title T] [--url U]');
  }

  const baseUrl = flag(flags, 'url');
  if (!baseUrl) {
    const config = loadConfig();
    const inst = config.defaultInstance ? config.instances[config.defaultInstance] : undefined;
    if (!inst) die('Provide --url or set a default instance.');
    const result = await api.createDocument(inst.url, markdown, flag(flags, 'title'));
    outputCreateResult(result, inst.url, flags);
    return;
  }

  const result = await api.createDocument(baseUrl, markdown, flag(flags, 'title'));
  outputCreateResult(result, baseUrl, flags);
}

function outputCreateResult(result: api.CreateResult, baseUrl: string, flags: Record<string, string | boolean>): void {
  if (flags['json']) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Created: ${result.slug}`);
    if (result.tokenUrl) console.log(`URL: ${result.tokenUrl}`);
    else console.log(`URL: ${baseUrl}/d/${result.slug}`);
    if (result.ownerSecret) console.log(`Owner secret: ${result.ownerSecret}`);
  }
}

async function cmdHealth(flags: Record<string, string | boolean>): Promise<void> {
  let baseUrl = flag(flags, 'url');
  if (!baseUrl) {
    const config = loadConfig();
    const instName = flag(flags, 'instance') ?? config.defaultInstance;
    if (!instName) die('Provide --url or --instance.');
    const inst = config.instances[instName];
    if (!inst) die(`Instance "${instName}" not found.`);
    baseUrl = inst.url;
  }

  const health = await api.getHealth(baseUrl);
  console.log(JSON.stringify(health, null, 2));
}

async function cmdConfig(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = args[0];

  if (sub === 'add') {
    const name = args[1] ?? die('usage: proof config add <name> --url <url>');
    const url = flag(flags, 'url') ?? die('--url is required');
    const config = loadConfig();
    config.instances[name] = {
      url: url.replace(/\/+$/, ''),
      agentId: flag(flags, 'agent-id'),
    };
    if (!config.defaultInstance) config.defaultInstance = name;
    saveConfig(config);
    console.log(`Instance "${name}" saved.${!config.defaultInstance || config.defaultInstance === name ? ' (default)' : ''}`);
    return;
  }

  if (sub === 'doc') {
    const docSub = args[1];

    if (docSub === 'add') {
      const alias = args[2] ?? die('usage: proof config doc add <alias> <slug> <token> --instance <name>');
      const slug = args[3] ?? die('usage: proof config doc add <alias> <slug> <token> --instance <name>');
      const token = args[4] ?? die('usage: proof config doc add <alias> <slug> <token> --instance <name>');
      const instance = flag(flags, 'instance') ?? die('--instance is required');
      const config = loadConfig();
      if (!config.instances[instance]) die(`Instance "${instance}" not found. Run: proof config add ${instance} --url <url>`);
      config.docs[alias] = { slug, token, instance };
      saveConfig(config);
      console.log(`Doc alias "${alias}" saved.`);
      return;
    }

    if (docSub === 'add-url') {
      const alias = args[2] ?? die('usage: proof config doc add-url <alias> <proof-url>');
      const proofUrl = args[3] ?? die('usage: proof config doc add-url <alias> <proof-url>');
      const parsed = parseProofUrl(proofUrl);
      if (!parsed) die('Invalid Proof URL. Expected: https://host/d/slug?token=xxx');

      const config = loadConfig();
      // Find or create instance for this host
      let instanceName: string | undefined;
      for (const [name, inst] of Object.entries(config.instances)) {
        if (inst.url === parsed.baseUrl) {
          instanceName = name;
          break;
        }
      }
      if (!instanceName) {
        // Auto-create instance from hostname
        const hostname = new URL(parsed.baseUrl).hostname;
        instanceName = hostname.replace(/\./g, '-');
        config.instances[instanceName] = { url: parsed.baseUrl };
        if (!config.defaultInstance) config.defaultInstance = instanceName;
        console.log(`Auto-created instance "${instanceName}" → ${parsed.baseUrl}`);
      }

      config.docs[alias] = { slug: parsed.slug, token: parsed.token, instance: instanceName };
      saveConfig(config);
      console.log(`Doc alias "${alias}" saved (${parsed.slug} on ${instanceName}).`);
      return;
    }

    if (docSub === 'list') {
      const config = loadConfig();
      if (Object.keys(config.docs).length === 0) {
        console.log('No doc aliases configured.');
        return;
      }
      for (const [alias, doc] of Object.entries(config.docs)) {
        console.log(`  ${alias} → ${doc.slug} (${doc.instance})`);
      }
      return;
    }

    die(`Unknown doc subcommand: ${docSub}. Try: add, add-url, list`);
  }

  if (sub === 'list') {
    const config = loadConfig();
    const defaultMarker = (name: string) => name === config.defaultInstance ? ' (default)' : '';
    if (Object.keys(config.instances).length === 0) {
      console.log('No instances configured.');
      return;
    }
    for (const [name, inst] of Object.entries(config.instances)) {
      console.log(`  ${name} → ${inst.url}${defaultMarker(name)}`);
    }
    return;
  }

  die(`Unknown config subcommand: ${sub}. Try: add, doc, list`);
}

// --- Main ---

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command.length === 0 || flags['help']) {
    console.log(USAGE);
    process.exit(0);
  }

  const cmd = command[0];
  const rest = command.slice(1);

  try {
    switch (cmd) {
      case 'read':
        await cmdRead(rest, flags);
        break;
      case 'snapshot':
        await cmdSnapshot(rest, flags);
        break;
      case 'write':
        await cmdWrite(rest, flags);
        break;
      case 'replace':
        await cmdReplace(rest, flags);
        break;
      case 'comment':
        await cmdComment(rest, flags);
        break;
      case 'suggest':
        await cmdSuggest(rest, flags);
        break;
      case 'create':
        await cmdCreate(rest, flags);
        break;
      case 'health':
        await cmdHealth(flags);
        break;
      case 'config':
        await cmdConfig(rest, flags);
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    process.exit(1);
  }
}

main();
