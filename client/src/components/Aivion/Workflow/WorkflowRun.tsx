import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuthContext } from '~/hooks/AuthContext';
import type { RunStatus, Workflow, WorkflowOutput, WorkflowRun, WorkflowStep } from './types';

const STATUS_LABEL: Record<RunStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  awaiting_user: 'Awaiting User',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_BADGE: Record<RunStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  awaiting_user: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'text-text-secondary bg-surface-secondary',
};

const TERMINAL = new Set<RunStatus>(['completed', 'failed', 'cancelled']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function completedStepMap(run: WorkflowRun): Record<string, { output: unknown }> {
  return (run.outputs?.['_completed_steps'] ?? {}) as Record<string, { output: unknown }>;
}

type StepState = 'completed' | 'running' | 'awaiting' | 'pending';

function getStepState(step: WorkflowStep, run: WorkflowRun): StepState {
  const done = completedStepMap(run);
  if (step.id in done) return 'completed';
  if (run.pending_step_id === step.id) {
    return run.status === 'awaiting_user' ? 'awaiting' : 'running';
  }
  return 'pending';
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StepIcon({ state }: { state: StepState }) {
  if (state === 'completed') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
        <svg className="h-4 w-4 text-green-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      </span>
    );
  }
  if (state === 'running') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-900/20">
        <svg className="h-4 w-4 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
          <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" className="opacity-75" />
        </svg>
      </span>
    );
  }
  if (state === 'awaiting') {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/20">
        <svg className="h-3 w-3 text-amber-600" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      </span>
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-border-light dark:border-gray-700" />
  );
}

// ── Template resolver (mirrors sheru-platform resolveInterpolation) ───────────

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
    // ${stepId.field} shorthand
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
  // Flat fields fallback
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

  // user_input, unscrub, integration, template, loop — generic key-value
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

// ── Main component ────────────────────────────────────────────────────────────

export default function WorkflowRunPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const { token } = useAuthContext();

  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [resumeValues, setResumeValues] = useState<Record<string, string>>({});
  const [resuming, setResuming] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/aivion/workflow/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const data: WorkflowRun = await r.json();
      setRun(data);
      if (TERMINAL.has(data.status) || data.status === 'awaiting_user') {
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } finally {
      setLoading(false);
    }
  }, [runId, token]);

  // Fetch workflow definition for step labels and output spec
  useEffect(() => {
    if (!token || !id) return;
    fetch(`/api/aivion/workflow/workflows/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((wf: Workflow | null) => {
        if (wf) setWorkflow(wf);
      })
      .catch(() => undefined);
  }, [id, token]);

  useEffect(() => {
    void fetchRun();
    pollRef.current = setInterval(fetchRun, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchRun]);

  // Seed resume form defaults
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
      // Resume accepted — restart polling
      pollRef.current = setInterval(fetchRun, 3000);
      void fetchRun();
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
  const completedCount = Math.min(Object.keys(done).length, steps.length || 1);
  const totalCount = steps.length || 1;
  const pct = steps.length === 0 ? 0 : Math.round((completedCount / totalCount) * 100);

  const currentStep = steps.find((s) => s.id === run.pending_step_id);
  const specOutput = workflow?.spec?.output;

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left sidebar ────────────────────────────────────────────── */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border-light bg-surface-primary">
        {/* Back link */}
        <div className="border-b border-border-light px-5 py-4">
          <Link
            to={`/workflow/${id}`}
            className="flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="m15 18-6-6 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {workflow?.name ?? 'Workflow'}
          </Link>
        </div>

        {/* Status + progress */}
        <div className="border-b border-border-light px-5 py-4">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGE[run.status]}`}>
            {STATUS_LABEL[run.status]}
          </span>
          {steps.length > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-text-secondary">
                <span>{completedCount}/{totalCount} steps</span>
                <span>{pct}%</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Step list */}
        <div className="flex-1 overflow-y-auto px-3 py-4">
          {steps.length === 0 ? (
            <p className="px-2 text-xs text-text-secondary">No steps defined.</p>
          ) : (
            <ul className="space-y-1">
              {steps.map((step) => {
                const state = getStepState(step, run);
                const isActive = state === 'running' || state === 'awaiting';
                return (
                  <li
                    key={step.id}
                    onClick={() => {
                      if (state === 'completed')
                        setSelectedStepId((prev) => (prev === step.id ? null : step.id));
                    }}
                    className={`flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                      selectedStepId === step.id
                        ? 'bg-amber-50 ring-1 ring-inset ring-amber-200 dark:bg-amber-900/10 dark:ring-amber-800'
                        : isActive
                          ? 'bg-surface-hover'
                          : ''
                    } ${state === 'completed' ? 'cursor-pointer hover:bg-surface-hover' : ''}`}
                  >
                    <div className="mt-0.5">
                      <StepIcon state={state} />
                    </div>
                    <div className="min-w-0">
                      <p
                        className={`text-sm font-medium leading-tight ${
                          state === 'completed'
                            ? 'text-text-primary'
                            : state === 'awaiting'
                              ? 'text-amber-700 dark:text-amber-400'
                              : state === 'running'
                                ? 'text-text-primary'
                                : 'text-text-secondary'
                        }`}
                      >
                        {step.label ?? step.id}
                      </p>
                      {state === 'running' && (
                        <p className="mt-0.5 text-xs text-blue-500">Processing…</p>
                      )}
                      {state === 'awaiting' && (
                        <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                          Your input needed
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ── Right panel ─────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {/* Step detail — shown when a completed step is selected */}
        {selectedStepId && done[selectedStepId] && (() => {
          const step = steps.find((s) => s.id === selectedStepId);
          if (!step) return null;
          return (
            <div className="p-6 lg:p-8">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{step.type}</p>
                  <h2 className="mt-0.5 text-base font-semibold text-text-primary">{step.label ?? step.id}</h2>
                </div>
                <button
                  onClick={() => setSelectedStepId(null)}
                  className="rounded-lg p-1.5 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                  aria-label="Close step detail"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="rounded-2xl border border-border-light bg-surface-primary p-5">
                <StepOutputView step={step} output={done[selectedStepId].output} />
              </div>
            </div>
          );
        })()}

        {/* Running: centred spinner */}
        {run.status === 'running' && !selectedStepId && (
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

        {/* Pending: minimal state */}
        {run.status === 'pending' && !selectedStepId && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            <p className="text-sm text-text-secondary">Queued — starting soon…</p>
          </div>
        )}

        {/* Awaiting user: expiry + outputs + form */}
        {run.status === 'awaiting_user' && !selectedStepId && (
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

            {/* Spec-driven output (AI summary before the review form) */}
            {specOutput && (
              <div className="mb-6">
                <ReportOutput
                  output={specOutput}
                  completedSteps={done}
                  inputs={run.inputs ?? {}}
                />
                <hr className="mt-6 border-border-light" />
              </div>
            )}

            {/* Resume form */}
            {run.pending_prompt && (
              <p className="mb-4 text-sm font-semibold text-text-primary">{run.pending_prompt}</p>
            )}
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
        )}

        {/* Failed */}
        {run.status === 'failed' && !selectedStepId && (
          <div className="p-6 lg:p-8">
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
              {run.error_message ?? 'The run failed without an error message.'}
            </div>
          </div>
        )}

        {/* Completed: aggregated step outputs */}
        {run.status === 'completed' && !selectedStepId && (
          <div className="p-6 lg:p-8">
            {/* Completion banner */}
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

            {/* Spec-driven output */}
            {specOutput && (
              <ReportOutput
                output={specOutput}
                completedSteps={done}
                inputs={run.inputs ?? {}}
              />
            )}

            {/* Completed steps (collapsible raw detail) */}
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
        {run.status === 'cancelled' && !selectedStepId && (
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="text-sm text-text-secondary">This run was cancelled.</p>
          </div>
        )}
      </div>
    </div>
  );
}
