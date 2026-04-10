import { randomUUID } from 'node:crypto';

export interface ApiContext {
  baseUrl: string;
  token: string;
  agentId: string;
}

function headers(ctx: ApiContext, extra?: Record<string, string>): Record<string, string> {
  return {
    'Authorization': `Bearer ${ctx.token}`,
    'X-Agent-Id': ctx.agentId,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Try /api/agent/ path first, fall back to /documents/ if 404. */
async function requestDoc<T>(ctx: ApiContext, slug: string, suffix: string, init: RequestInit = {}): Promise<T> {
  const encoded = encodeURIComponent(slug);
  try {
    return await request<T>(ctx, `/api/agent/${encoded}${suffix}`, init);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) {
      return request<T>(ctx, `/documents/${encoded}${suffix}`, init);
    }
    throw err;
  }
}

async function request<T>(ctx: ApiContext, path: string, init: RequestInit = {}): Promise<T> {
  const url = `${ctx.baseUrl}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...headers(ctx),
      ...(init.headers as Record<string, string> ?? {}),
    },
  });

  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
    }
    body = { raw: text } as T;
  }

  if (!response.ok) {
    const msg = typeof (body as Record<string, unknown>)?.error === 'string'
      ? String((body as Record<string, unknown>).error)
      : `${response.status} ${response.statusText}`;
    throw new Error(msg);
  }
  return body;
}

// --- Document state ---

export interface DocState {
  content: string;
  marks?: unknown[];
  revision?: number;
}

export async function getState(ctx: ApiContext, slug: string): Promise<DocState> {
  return requestDoc<DocState>(ctx, slug, '/state');
}

export interface Block {
  ref: string;
  markdown: string;
}

export interface Snapshot {
  blocks: Block[];
  revision: number;
}

export async function getSnapshot(ctx: ApiContext, slug: string): Promise<Snapshot> {
  return requestDoc<Snapshot>(ctx, slug, '/snapshot');
}

// --- Writes (edit/v2) ---

interface EditOperation {
  op: 'insert_after' | 'replace_block';
  ref: string;
  blocks?: Array<{ markdown: string }>;
  block?: { markdown: string };
}

interface EditRequest {
  by: string;
  operations: EditOperation[];
  baseRevision: number;
}

export async function editV2(
  ctx: ApiContext,
  slug: string,
  body: EditRequest,
): Promise<unknown> {
  return requestDoc(ctx, slug, '/edit/v2', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Idempotency-Key': randomUUID() },
  });
}

/** Append text after the last block. Fetches a fresh snapshot for baseRevision. */
export async function appendText(ctx: ApiContext, slug: string, markdown: string): Promise<unknown> {
  const snap = await getSnapshot(ctx, slug);
  if (!snap.blocks || snap.blocks.length === 0) {
    throw new Error('Document has no blocks — cannot append.');
  }
  const lastRef = snap.blocks[snap.blocks.length - 1].ref;

  return editV2(ctx, slug, {
    by: `ai:${ctx.agentId}`,
    baseRevision: snap.revision,
    operations: [{
      op: 'insert_after',
      ref: lastRef,
      blocks: [{ markdown }],
    }],
  });
}

/** Replace a specific block's content. */
export async function replaceBlock(ctx: ApiContext, slug: string, ref: string, markdown: string): Promise<unknown> {
  const snap = await getSnapshot(ctx, slug);

  return editV2(ctx, slug, {
    by: `ai:${ctx.agentId}`,
    baseRevision: snap.revision,
    operations: [{
      op: 'replace_block',
      ref,
      block: { markdown },
    }],
  });
}

// --- Create document ---

export interface CreateResult {
  slug: string;
  tokenUrl?: string;
  ownerSecret?: string;
  accessToken?: string;
  shareUrl?: string;
}

export async function createDocument(
  baseUrl: string,
  markdown: string,
  title?: string,
): Promise<CreateResult> {
  const response = await fetch(`${baseUrl}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, title }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Create failed: ${response.status} — ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as CreateResult;
}

// --- Health ---

export async function getHealth(baseUrl: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}/health`);
  const text = await response.text();
  return JSON.parse(text);
}

// --- Comments & Suggestions ---

export async function addComment(
  ctx: ApiContext,
  slug: string,
  quote: string,
  text: string,
): Promise<unknown> {
  return requestDoc(ctx, slug, '/ops', {
    method: 'POST',
    body: JSON.stringify({
      type: 'comment.add',
      by: `ai:${ctx.agentId}`,
      quote,
      text,
    }),
  });
}

export async function addSuggestion(
  ctx: ApiContext,
  slug: string,
  quote: string,
  content: string,
  kind: 'replace' | 'insert' | 'delete' = 'replace',
): Promise<unknown> {
  return requestDoc(ctx, slug, '/ops', {
    method: 'POST',
    body: JSON.stringify({
      type: 'suggestion.add',
      by: `ai:${ctx.agentId}`,
      kind,
      quote,
      content,
    }),
  });
}
