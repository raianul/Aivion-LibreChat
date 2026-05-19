import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuthContext } from '~/hooks/AuthContext';
import type { RunStatus, Workflow, WorkflowOutput, WorkflowRun, WorkflowStep } from './types';

const STATUS_LABEL: Record<RunStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  awaiting_user: 'Awaiting Review',
  awaiting_oauth: 'Needs Reconnect',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_BADGE: Record<RunStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  awaiting_user: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  awaiting_oauth: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'text-text-secondary bg-surface-secondary',
};


// ── Helpers ───────────────────────────────────────────────────────────────────

function completedStepMap(run: WorkflowRun): Record<string, { output: unknown }> {
  return (run.outputs?.['_completed_steps'] ?? {}) as Record<string, { output: unknown }>;
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

// ── Template resolver ─────────────────────────────────────────────────────────

function resolveTemplate(
  template: string,
  completedSteps: Record<string, { output: unknown }>,
  inputs: Record<string, unknown> = {},
): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, path: string) => {
    if (path.startsWith('inputs.')) {
      return String(inputs[path.slice('inputs.'.length)] ?? '');
    }
    if (path.startsWith('steps.')) {
      const parts = path.slice('steps.'.length).split('.');
      let value: unknown = completedSteps;
      for (const part of parts) {
        if (value == null || typeof value !== 'object') return '';
        const m = part.match(/^([^\[]*)\[(\d+)\]$/);
        if (m) {
          const key = m[1];
          const idx = parseInt(m[2], 10);
          if (key) value = (value as Record<string, unknown>)[key];
          if (!Array.isArray(value)) return '';
          value = (value as unknown[])[idx];
        } else {
          value = (value as Record<string, unknown>)[part];
        }
      }
      if (Array.isArray(value)) return JSON.stringify(value);
      return value != null ? String(value) : '';
    }
    const [stepId, ...rest] = path.split('.');
    const out = completedSteps[stepId]?.output;
    return out ? String((out as Record<string, unknown>)[rest.join('.')] ?? '') : '';
  });
}

// ── Output renderers ──────────────────────────────────────────────────────────

function FieldValue({ raw, kind }: { raw: string; kind?: string }) {
  if (kind === 'list') {
    let items: string[] = [];
    try { items = JSON.parse(raw); } catch { items = raw.split(',').map((s) => s.trim()); }
    if (!Array.isArray(items) || !items.length) return <span className="text-text-secondary">—</span>;
    return (
      <ul className="mt-1 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-text-primary">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary" />
            {String(item)}
          </li>
        ))}
      </ul>
    );
  }
  return <span className="text-sm text-text-primary">{raw}</span>;
}

function resolveListItems(
  items: string[],
  completedSteps: Record<string, { output: unknown }>,
  inputs: Record<string, unknown>,
): string[] {
  const result: string[] = [];
  for (const tpl of items) {
    const resolved = resolveTemplate(tpl, completedSteps, inputs);
    try {
      const parsed = JSON.parse(resolved);
      if (Array.isArray(parsed)) {
        result.push(...parsed.map(String));
        continue;
      }
    } catch { /* fall through */ }
    if (resolved.trim()) result.push(resolved);
  }
  return result;
}

function ReportOutput({
  output,
  completedSteps,
  inputs,
}: {
  output: WorkflowOutput;
  completedSteps: Record<string, { output: unknown }>;
  inputs: Record<string, unknown>;
}) {
  if ('sections' in output && output.sections?.length) {
    return (
      <div className="space-y-4">
        {output.sections.map((section, i) => {
          if (section.type === 'key_value') {
            const resolved = section.fields
              .map((f) => ({ ...f, resolved: resolveTemplate(f.value, completedSteps, inputs) }))
              .filter((f) => f.resolved.trim() !== '');
            if (!resolved.length) return null;
            return (
              <div key={i} className="rounded-2xl border border-border-light bg-surface-primary p-5">
                {section.title && (
                  <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                    {section.title}
                  </p>
                )}
                <dl className="space-y-4">
                  {resolved.map((f) => (
                    <div key={f.label}>
                      <dt className="text-xs font-medium text-text-secondary">{f.label}</dt>
                      <dd className="mt-0.5">
                        <FieldValue raw={f.resolved} kind={f.kind} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          }
          if (section.type === 'list') {
            const listItems = resolveListItems(section.items ?? [], completedSteps, inputs);
            if (!listItems.length) return null;
            return (
              <div key={i} className="rounded-2xl border border-border-light bg-surface-primary p-5">
                {section.title && (
                  <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                    {section.title}
                  </p>
                )}
                <ul className="space-y-2">
                  {listItems.map((item, j) => (
                    <li key={j} className="flex items-start gap-2 text-sm text-text-primary">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            );
          }
          return null;
        })}
      </div>
    );
  }
  const fields = ('fields' in output ? output.fields : undefined) ?? [];
  const resolved = fields
    .map((f) => ({ ...f, resolved: resolveTemplate(f.value, completedSteps, inputs) }))
    .filter((f) => f.resolved.trim() !== '');
  if (!resolved.length) return null;
  return (
    <div className="rounded-2xl border border-border-light bg-surface-primary p-5">
      {'title' in output && output.title && (
        <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-text-secondary">{output.title}</p>
      )}
      <dl className="space-y-4">
        {resolved.map((f) => (
          <div key={f.label}>
            <dt className="text-xs font-medium text-text-secondary">{f.label}</dt>
            <dd className="mt-0.5">
              <FieldValue raw={f.resolved} kind={f.kind} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── Pending prompt renderer ───────────────────────────────────────────────────

function PendingPromptView({ raw }: { raw: string }) {
  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object' && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch { /* raw string */ }

  if (!parsed) {
    return <p className="text-sm text-text-primary whitespace-pre-wrap">{raw}</p>;
  }

  return (
    <div className="space-y-3">
      {Object.entries(parsed).map(([key, value]) => {
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        return (
          <div key={key}>
            <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{label}</p>
            {Array.isArray(value) ? (
              <ul className="mt-1 space-y-1">
                {(value as unknown[]).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-text-primary">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary" />
                    {String(item)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-0.5 text-sm text-text-primary">{String(value ?? '—')}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Chat panel ────────────────────────────────────────────────────────────────

type ChatMsg = { role: 'user' | 'assistant'; content: string };

function buildOpening(run: WorkflowRun): ChatMsg {
  const done = completedStepMap(run);
  const profile = (done['unscrub_profile']?.output ?? {}) as Record<string, unknown>;
  const assessment = (done['unscrub_assessment']?.output ?? {}) as Record<string, unknown>;
  const name = String(profile.full_name ?? 'the candidate');
  const role = String(run.inputs?.role_title ?? 'the role');
  const score = String(assessment.fit_score ?? '?');
  const summary = String(assessment.fit_summary ?? '');
  const rec = String(assessment.recommended_next_step ?? '');
  const content =
    `I've reviewed ${name}'s CV for the ${role} position. ` +
    `AI fit score: ${score}/10${summary ? ' — ' + summary : ''}. ` +
    (rec ? `Recommendation: ${rec}. ` : '') +
    'Ask me anything about this assessment — specific findings, concerns, or what to probe in an interview.';
  return { role: 'assistant', content };
}

function WorkflowChatPanel({
  runId,
  run,
  token,
}: {
  runId: string;
  run: WorkflowRun;
  token: string | undefined;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load chat history from LibreChat MongoDB on mount (keyed by run_id as conversationId).
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/messages/${runId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json() as Array<{ text?: string; isCreatedByUser?: boolean }>;
          if (Array.isArray(data) && data.length > 0) {
            setMessages(data.map((m) => ({
              role: m.isCreatedByUser ? 'user' as const : 'assistant' as const,
              content: m.text ?? '',
            })));
            return;
          }
        }
      } catch { /* fall through to opening */ }
      setMessages([buildOpening(run)]);
    }
    void load().finally(() => setHistoryLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Fire-and-forget save to LibreChat MongoDB.
  function persistMessage(text: string, isCreatedByUser: boolean) {
    fetch(`/api/messages/${runId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messageId: crypto.randomUUID(),
        conversationId: runId,
        text,
        sender: isCreatedByUser ? 'User' : 'Assistant',
        isCreatedByUser,
        parentMessageId: null,
        endpoint: 'custom',
      }),
    }).catch(() => { /* best-effort */ });
  }

  async function handleSend() {
    const userMsg = input.trim();
    if (!userMsg || sending) return;
    setInput('');
    const history = [...messages];
    const withUser: ChatMsg[] = [...history, { role: 'user', content: userMsg }];
    setMessages(withUser);
    setSending(true);
    persistMessage(userMsg, true);
    try {
      const res = await fetch(`/api/aivion/workflow/runs/${runId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: history, new_message: userMsg }),
      });
      if (res.ok) {
        const data = await res.json() as { content: string };
        setMessages([...withUser, { role: 'assistant', content: data.content }]);
        persistMessage(data.content, false);
      } else {
        const errMsg = res.status === 503
          ? 'The AI is temporarily busy — please try again in a moment.'
          : 'Something went wrong. Please try again.';
        setMessages([...withUser, { role: 'assistant', content: errMsg }]);
      }
    } catch {
      setMessages([...withUser, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }]);
    } finally {
      setSending(false);
    }
  }

  if (!historyLoaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">Loading chat…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-light px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">AI Chat</p>
        <p className="mt-0.5 text-sm font-medium text-text-primary">Ask about this assessment</p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-center text-sm text-text-secondary">Loading context…</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-amber-500 text-white'
                  : 'bg-surface-secondary text-text-primary'
              }`}
            >
              {msg.role === 'user' ? (
                msg.content
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                    ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>,
                    ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>,
                    li: ({ children }) => <li className="leading-snug">{children}</li>,
                    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                    em: ({ children }) => <em className="italic">{children}</em>,
                    code: ({ children }) => (
                      <code className="rounded bg-black/10 px-1 py-0.5 font-mono text-xs dark:bg-white/10">{children}</code>
                    ),
                    h1: ({ children }) => <h1 className="mb-1 text-base font-bold">{children}</h1>,
                    h2: ({ children }) => <h2 className="mb-1 text-sm font-bold">{children}</h2>,
                    h3: ({ children }) => <h3 className="mb-1 text-sm font-semibold">{children}</h3>,
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-surface-secondary px-4 py-3">
              <div className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border-light p-4">
        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            className="flex-1 resize-none rounded-xl border border-border-light bg-surface-secondary px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
            placeholder="Ask about this assessment…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!input.trim() || sending}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
            aria-label="Send message"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Step output detail view ───────────────────────────────────────────────────

function StepOutputView({ step, output }: { step: WorkflowStep; output: unknown }) {
  const data = output as Record<string, unknown>;

  if (step.type === 'scrub') {
    const entities = (data?.entities ?? []) as Array<{ token: string; label: string; display_value: string }>;
    return (
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Masked Entities · {entities.length}
        </p>
        {entities.length === 0 ? (
          <p className="text-sm text-text-secondary">No entities masked.</p>
        ) : (
          <div className="divide-y divide-border-light rounded-xl border border-border-light">
            {entities.map((e, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <code className="shrink-0 rounded bg-surface-secondary px-1.5 py-0.5 font-mono text-xs text-text-secondary">
                  {e.token}
                </code>
                <span className="text-xs text-text-secondary">{e.label}</span>
                <span className="ml-auto text-sm text-text-primary">{e.display_value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (step.type === 'file_extract') {
    const text = String(data?.text ?? data?.content ?? '');
    return (
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Extracted Text · {text.length.toLocaleString()} chars
        </p>
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border-light bg-surface-primary p-4 text-xs text-text-primary">
          {text || '—'}
        </pre>
      </div>
    );
  }

  if (step.type === 'llm') {
    if (typeof output === 'string') {
      return <p className="whitespace-pre-wrap text-sm text-text-primary">{output}</p>;
    }
    const text = data?.result ?? data?.text ?? data?.output ?? data?.content;
    if (typeof text === 'string') {
      return <p className="whitespace-pre-wrap text-sm text-text-primary">{text}</p>;
    }
    const entries = Object.entries(data ?? {});
    return (
      <dl className="space-y-4">
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs font-medium capitalize text-text-secondary">{k.replace(/_/g, ' ')}</dt>
            <dd className="mt-0.5">
              {Array.isArray(v) ? (
                <ul className="mt-1 space-y-1">
                  {(v as unknown[]).map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-text-primary">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary" />
                      {String(item)}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-sm text-text-primary">{String(v ?? '—')}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  const entries = Object.entries(data ?? {});
  if (!entries.length) return <p className="text-sm text-text-secondary">No output recorded.</p>;
  return (
    <dl className="space-y-4">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs font-medium capitalize text-text-secondary">{k.replace(/_/g, ' ')}</dt>
          <dd className="mt-0.5">
            {Array.isArray(v) ? (
              <ul className="mt-1 space-y-1">
                {(v as unknown[]).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-text-primary">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary" />
                    {String(item)}
                  </li>
                ))}
              </ul>
            ) : typeof v === 'object' && v !== null ? (
              <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-text-secondary">
                {JSON.stringify(v, null, 2)}
              </pre>
            ) : (
              <span className="text-sm text-text-primary">{String(v ?? '—')}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── SSE hook ──────────────────────────────────────────────────────────────────

function useRunStream(
  runId: string | undefined,
  token: string | undefined,
  streamKey: number,
  onUpdate: (run: WorkflowRun) => void,
  onDone: () => void,
) {
  const abortRef = useRef<AbortController | null>(null);

  const connect = useCallback(async () => {
    if (!runId || !token) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/aivion/workflow/runs/${runId}/stream`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) { onDone(); return; }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6)) as WorkflowRun;
              onUpdate(data);
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    } finally {
      onDone();
    }
  }, [runId, token, streamKey, onUpdate, onDone]);

  useEffect(() => {
    void connect();
    return () => abortRef.current?.abort();
  }, [connect]);
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WorkflowRunPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const { token } = useAuthContext();

  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [resumeValues, setResumeValues] = useState<Record<string, string>>({});
  const [resuming, setResuming] = useState(false);
  const [streamKey, setStreamKey] = useState(0);

  const onUpdate = useCallback((data: WorkflowRun) => {
    setRun((prev) => {
      if (!prev) return data;
      // Pub/sub events only carry {run_id, status} — preserve existing outputs
      // and pending fields that the new partial event omits (null/undefined).
      const merged: WorkflowRun = { ...prev, ...data };
      if (data.outputs == null && prev.outputs != null) merged.outputs = prev.outputs;
      if (data.pending_input_schema == null && prev.pending_input_schema != null) {
        merged.pending_input_schema = prev.pending_input_schema;
      }
      if (data.pending_step_id == null && prev.pending_step_id != null) {
        merged.pending_step_id = prev.pending_step_id;
      }
      if (data.pending_prompt == null && prev.pending_prompt != null) {
        merged.pending_prompt = prev.pending_prompt;
      }
      return merged;
    });
    setLoading(false);
  }, []);

  const onDone = useCallback(() => {
    setLoading(false);
  }, []);

  useRunStream(runId, token, streamKey, onUpdate, onDone);

  // Initial REST fetch — seeds full run state (including outputs + pending fields).
  // SSE alone can deliver partial pub/sub payloads that omit these fields.
  useEffect(() => {
    if (!runId || !token) return;
    fetch(`/api/aivion/workflow/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: WorkflowRun | null) => {
        if (data) setRun(data);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [runId, token]);

  // Fetch workflow definition for step labels and output spec
  useEffect(() => {
    if (!token || !id) return;
    fetch(`/api/aivion/workflow/workflows/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((wf: Workflow | null) => { if (wf) setWorkflow(wf); })
      .catch(() => undefined);
  }, [id, token]);

  // Seed resume form defaults when awaiting_user
  useEffect(() => {
    if (run?.status !== 'awaiting_user') return;
    const fields = run.pending_input_schema?.fields ?? [];
    if (fields.length === 0) return;
    setResumeValues((prev) => {
      const seeded = { ...prev };
      for (const f of fields) {
        if (!(f.name in seeded) && f.default != null) {
          seeded[f.name] = String(f.default);
        }
      }
      return seeded;
    });
  }, [run?.status, run?.pending_input_schema]);

  async function handleResume(e: React.FormEvent) {
    e.preventDefault();
    setResuming(true);
    try {
      await fetch(`/api/aivion/workflow/runs/${runId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ input: resumeValues }),
      });
      // Reconnect SSE stream so we receive progress after resume
      setStreamKey((k) => k + 1);
    } finally {
      setResuming(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-sm text-text-secondary">Run not found.</p>
        <Link to={`/workflow/${id}`} className="text-sm text-amber-600 hover:underline">
          ← Back
        </Link>
      </div>
    );
  }

  const steps: WorkflowStep[] = workflow?.spec?.steps ?? [];
  const done = completedStepMap(run);
  const currentStep = steps.find((s) => s.id === run.pending_step_id);
  const specOutput = workflow?.spec?.output;

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Center: chat panel (only during review) ─────────────────── */}
      {run.status === 'awaiting_user' && runId && (
        <div className="flex w-[380px] shrink-0 flex-col border-r border-border-light bg-surface-primary">
          <WorkflowChatPanel runId={runId} run={run} token={token} />
        </div>
      )}

      {/* ── Right panel ─────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-y-auto">

        {/* Running */}
        {run.status === 'running' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <svg className="h-12 w-12 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" className="opacity-20" />
              <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <div>
              <p className="text-base font-semibold text-text-primary">
                {currentStep?.label ?? 'Processing…'}
              </p>
              <p className="mt-1 text-sm text-text-secondary">Running step — this may take a moment</p>
            </div>
          </div>
        )}

        {/* Pending */}
        {run.status === 'pending' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            <p className="text-sm text-text-secondary">Queued — starting soon…</p>
          </div>
        )}

        {/* awaiting_oauth — service disconnected mid-run */}
        {run.status === 'awaiting_oauth' && (
          <div className="p-6 lg:p-8">
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 dark:border-red-800 dark:bg-red-900/20">
              <div className="flex items-start gap-3">
                <svg className="mt-0.5 h-5 w-5 shrink-0 text-red-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <div>
                  <p className="font-semibold text-red-800 dark:text-red-300">Service connection required</p>
                  <p className="mt-1 text-sm text-red-700 dark:text-red-400">
                    A service this workflow needs is no longer connected. Reconnect it to resume the run.
                  </p>
                  <Link
                    to="/connections"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
                  >
                    Manage connections →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* awaiting_user — review gate */}
        {run.status === 'awaiting_user' && (
          <div className="p-6 lg:p-8">
            {/* Expiry banner */}
            {run.expires_at && (
              <div className="mb-6 flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-300">
                <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
                Expires in {daysUntil(run.expires_at)} day{daysUntil(run.expires_at) === 1 ? '' : 's'} — submit your review to continue.
              </div>
            )}

            {/* AI assessment */}
            {specOutput && (
              <div className="mb-6">
                <ReportOutput output={specOutput} completedSteps={done} inputs={run.inputs ?? {}} />
                <hr className="mt-6 border-border-light" />
              </div>
            )}

            {/* Pending prompt */}
            {run.pending_prompt && (
              <div className="mb-6">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  AI Assessment
                </p>
                <div className="rounded-2xl border border-border-light bg-surface-primary p-5">
                  <PendingPromptView raw={run.pending_prompt} />
                </div>
                <hr className="mt-6 border-border-light" />
              </div>
            )}

            {/* Resume form */}
            <div className="mt-6">
              <p className="mb-4 text-sm font-semibold text-text-primary">Your decision</p>
              <form onSubmit={handleResume} className="space-y-4">
                {(run.pending_input_schema?.fields ?? []).map((f) => (
                  <div key={f.name}>
                    <label className="mb-1 block text-sm font-medium text-text-primary">
                      {f.label}
                      {f.required && <span className="ml-1 text-red-500">*</span>}
                    </label>
                    {f.type === 'text' ? (
                      <textarea
                        rows={3}
                        className="w-full rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                        value={resumeValues[f.name] ?? ''}
                        onChange={(e) => setResumeValues((p) => ({ ...p, [f.name]: e.target.value }))}
                        placeholder={f.placeholder}
                      />
                    ) : f.type === 'select' ? (
                      <select
                        className="w-full rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                        value={resumeValues[f.name] ?? ''}
                        onChange={(e) => setResumeValues((p) => ({ ...p, [f.name]: e.target.value }))}
                      >
                        {(f.options ?? []).map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className="w-full rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                        value={resumeValues[f.name] ?? ''}
                        onChange={(e) => setResumeValues((p) => ({ ...p, [f.name]: e.target.value }))}
                        placeholder={f.placeholder}
                      />
                    )}
                  </div>
                ))}
                <button
                  type="submit"
                  disabled={resuming}
                  className="rounded-xl bg-amber-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  {resuming ? 'Submitting…' : 'Submit review'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Failed */}
        {run.status === 'failed' && (
          <div className="p-6 lg:p-8">
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
              {run.error_message ?? 'The run failed without an error message.'}
            </div>
          </div>
        )}

        {/* Completed */}
        {run.status === 'completed' && (
          <div className="p-6 lg:p-8">
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 dark:border-green-700/40 dark:bg-green-900/20">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-800/40">
                <svg className="h-4 w-4 text-green-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-semibold text-green-800 dark:text-green-300">
                  {workflow?.name ?? 'Workflow'} complete
                </p>
                {run.completed_at && (
                  <p className="text-xs text-green-700 dark:text-green-400">
                    {new Date(run.completed_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            {specOutput && (
              <ReportOutput output={specOutput} completedSteps={done} inputs={run.inputs ?? {}} />
            )}

            {Object.keys(done).length > 0 && (
              <details className="mt-8">
                <summary className="cursor-pointer text-sm font-medium text-text-secondary hover:text-text-primary">
                  Show step details ({Object.keys(done).length} steps)
                </summary>
                <div className="mt-4 space-y-3">
                  {Object.entries(done).map(([stepId, step]) => (
                    <div key={stepId} className="rounded-lg border border-border-light p-4">
                      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-text-secondary">{stepId}</p>
                      <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-text-secondary">
                        {JSON.stringify(step.output, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Cancelled */}
        {run.status === 'cancelled' && (
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="text-sm text-text-secondary">This run was cancelled.</p>
          </div>
        )}
      </div>
    </div>
  );
}
