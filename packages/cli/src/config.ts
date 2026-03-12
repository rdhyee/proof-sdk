import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface InstanceConfig {
  url: string;
  agentId?: string;
}

export interface DocAlias {
  slug: string;
  token: string;
  instance: string;
}

export interface ProofConfig {
  defaultInstance?: string;
  defaultAgentId: string;
  instances: Record<string, InstanceConfig>;
  docs: Record<string, DocAlias>;
}

const CONFIG_DIR = join(homedir(), '.proof');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: ProofConfig = {
  defaultAgentId: 'cli:proof-cli',
  instances: {},
  docs: {},
};

export function loadConfig(): ProofConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: ProofConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/** Resolve a doc reference — could be an alias or a slug with --token/--instance flags */
export function resolveDoc(
  config: ProofConfig,
  ref: string,
  flags: { token?: string; instance?: string; url?: string },
): { baseUrl: string; slug: string; token: string; agentId: string } {
  // Check if it's a saved alias
  const alias = config.docs[ref];
  if (alias) {
    const inst = config.instances[alias.instance];
    if (!inst) {
      throw new Error(`Instance "${alias.instance}" not found in config. Run: proof config add ${alias.instance} --url <url>`);
    }
    return {
      baseUrl: inst.url,
      slug: alias.slug,
      token: alias.token,
      agentId: inst.agentId ?? config.defaultAgentId,
    };
  }

  // It's a raw slug — need --token and either --instance or --url
  const token = flags.token;
  if (!token) {
    throw new Error(`"${ref}" is not a saved doc alias. Provide --token (and --instance or --url), or save it: proof config doc add <alias> ${ref} <token> --instance <name>`);
  }

  let baseUrl: string;
  if (flags.url) {
    baseUrl = flags.url.replace(/\/+$/, '');
  } else if (flags.instance) {
    const inst = config.instances[flags.instance];
    if (!inst) throw new Error(`Instance "${flags.instance}" not found in config.`);
    baseUrl = inst.url;
  } else if (config.defaultInstance) {
    const inst = config.instances[config.defaultInstance];
    if (!inst) throw new Error(`Default instance "${config.defaultInstance}" not found in config.`);
    baseUrl = inst.url;
  } else {
    throw new Error('No --url, --instance, or default instance configured.');
  }

  const agentId = config.defaultAgentId;
  return { baseUrl, slug: ref, token, agentId };
}

/** Parse a full Proof URL into components: https://host/d/slug?token=xxx */
export function parseProofUrl(url: string): { baseUrl: string; slug: string; token: string } | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/^\/d\/([^/]+)/);
    if (!match) return null;
    const token = u.searchParams.get('token');
    if (!token) return null;
    return {
      baseUrl: `${u.protocol}//${u.host}`,
      slug: match[1],
      token,
    };
  } catch {
    return null;
  }
}
