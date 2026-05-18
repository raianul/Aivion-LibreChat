import { useEffect, useState, useMemo, memo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronDown, ClipboardList } from 'lucide-react';
import { useAuthContext, useLocalStorage } from '~/hooks';
import { cn } from '~/utils';
import type { RunStatus } from './types';

type RunSummary = {
  id: string;
  workflow_id: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  created_at: string;
};

const STATUS_DOT: Record<RunStatus, string> = {
  pending: 'bg-amber-400',
  running: 'bg-blue-400 animate-pulse',
  awaiting_user: 'bg-purple-400 animate-pulse',
  completed: 'bg-green-400',
  failed: 'bg-red-400',
  cancelled: 'bg-surface-tertiary',
};

const STATUS_LABEL: Record<RunStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  awaiting_user: 'Waiting',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function runTitle(run: RunSummary): string {
  const inputs = run.inputs ?? {};
  for (const key of ['role_title', 'title', 'name', 'query', 'topic', 'subject']) {
    const v = inputs[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return `Run ${run.id.slice(0, 8)}`;
}

type DateGroup = { label: string; runs: RunSummary[] };

function groupRunsByDate(runs: RunSummary[]): DateGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86_400_000;
  const sevenDaysAgo = today - 7 * 86_400_000;
  const thirtyDaysAgo = today - 30 * 86_400_000;

  const buckets: Record<string, RunSummary[]> = {};
  const ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days'];

  for (const run of runs) {
    const ts = new Date(run.created_at).getTime();
    let label: string;
    if (ts >= today) label = 'Today';
    else if (ts >= yesterday) label = 'Yesterday';
    else if (ts >= sevenDaysAgo) label = 'Previous 7 days';
    else if (ts >= thirtyDaysAgo) label = 'Previous 30 days';
    else {
      const d = new Date(run.created_at);
      label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    (buckets[label] ??= []).push(run);
  }

  const result: DateGroup[] = [];
  for (const label of ORDER) {
    if (buckets[label]) result.push({ label, runs: buckets[label] });
  }
  for (const [label, r] of Object.entries(buckets)) {
    if (!ORDER.includes(label)) result.push({ label, runs: r });
  }
  return result;
}

const RunRow = memo(function RunRow({
  run,
  isActive,
}: {
  run: RunSummary;
  isActive: boolean;
}) {
  return (
    <Link
      to={`/workflow/${run.workflow_id}/runs/${run.id}`}
      className={cn(
        'flex items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-surface-hover',
        isActive && 'bg-surface-hover',
      )}
    >
      <span
        className={cn(
          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
          STATUS_DOT[run.status] ?? 'bg-surface-tertiary',
        )}
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium leading-tight text-text-primary">
          {runTitle(run)}
        </p>
        <p className="mt-0.5 text-xs text-text-secondary">
          {STATUS_LABEL[run.status] ?? run.status} · {relativeTime(run.created_at)}
        </p>
      </div>
    </Link>
  );
});

export default function WorkflowRunsSection() {
  const { token } = useAuthContext();
  const navigate = useNavigate();
  const { runId } = useParams<{ runId?: string }>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useLocalStorage('workflowRunsExpanded', true);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch('/api/aivion/workflow/runs?limit=50', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [token]);

  const grouped = useMemo(() => groupRunsByDate(runs), [runs]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden pb-3"
      role="region"
      aria-label="Workflow runs"
    >
      <div className="px-3 pb-1 pt-2">
        <button
          onClick={() => navigate('/workflow')}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          type="button"
        >
          <ClipboardList className="h-4 w-4 shrink-0" />
          <span>Browse Workflows</span>
        </button>
      </div>

      <div className="px-3">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="group flex w-full items-center justify-between rounded-lg px-1 py-2 text-xs font-bold text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black dark:focus-visible:ring-white"
          type="button"
        >
          <span className="select-none">Recent Runs</span>
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform duration-200',
              isExpanded ? 'rotate-180' : '',
            )}
          />
        </button>
      </div>

      {isExpanded && (
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent text-text-secondary" />
            </div>
          )}

          {!loading && runs.length === 0 && (
            <p className="px-4 text-xs text-text-secondary">No runs yet.</p>
          )}

          {!loading &&
            grouped.map(({ label, runs: groupRuns }, gi) => (
              <div key={label}>
                <h2
                  className={cn(
                    'px-4 pt-1 text-text-secondary',
                    gi === 0 ? 'mt-0' : 'mt-2',
                  )}
                  style={{ fontSize: '0.7rem' }}
                >
                  {label}
                </h2>
                {groupRuns.map((run) => (
                  <RunRow key={run.id} run={run} isActive={run.id === runId} />
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
