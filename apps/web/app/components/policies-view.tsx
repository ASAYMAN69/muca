'use client';

import { useMemo, useState } from 'react';

import type { Policy, ToolSummary } from '../../lib/api';

/**
 * The policies screen.
 *
 * A policy is a rule about when the agent has to ask: this tool, with
 * these arguments, is allowed / asked about / denied. The screen explains
 * the default in plain language, because the default is what most people
 * will live with.
 */

const OPERATORS = [
  'equals',
  'startsWith',
  'contains',
  'matches',
  'in',
  'notEquals',
  'endsWith',
] as const;

type Operator = (typeof OPERATORS)[number];

interface MatcherDraft {
  key: string;
  operator: Operator;
  value: string;
}

const EMPTY_DRAFT: MatcherDraft = { key: '', operator: 'startsWith', value: '' };

export function PoliciesView({
  policies,
  tools,
  available,
  sessionId,
  onCreate,
  onUpdate,
  onDelete,
  onBack,
}: {
  policies: Policy[];
  tools: ToolSummary[];
  /** False when the server does not have the routes yet. */
  available: boolean;
  sessionId: string | null;
  onCreate: (policy: {
    toolName: string;
    match: Record<string, unknown> | null;
    effect: 'allow' | 'ask' | 'deny';
    label: string;
    sessionId: string | null;
  }) => void;
  onUpdate: (policyId: string, patch: Partial<Policy>) => void;
  onDelete: (policyId: string) => void;
  onBack: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [toolName, setToolName] = useState(tools[0]?.name ?? '');
  const [effect, setEffect] = useState<'allow' | 'ask' | 'deny'>('allow');
  const [label, setLabel] = useState('');
  const [matchers, setMatchers] = useState<MatcherDraft[]>([
    { ...EMPTY_DRAFT },
  ]);
  const [scope, setScope] = useState<'session' | 'global'>('session');

  const match = useMemo(() => buildMatch(matchers), [matchers]);
  const preview = useMemo(
    () => previewEffect(toolName, effect, matchers),
    [toolName, effect, matchers],
  );

  const writableTools = tools.length > 0 ? tools : [];

  if (!available) {
    return (
      <section className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <button
          type="button"
          onClick={onBack}
          className="text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          ← Back to the timeline
        </button>
        <div className="mt-6 rounded-xl border border-line bg-surface-raised p-5">
          <h2 className="text-[15px] font-semibold text-ink">
            Policies are not available yet
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            The server has not published the policy routes yet, so there is
            nothing to list or change. Until it does, Muca asks about every
            tool that writes and allows the read-only ones.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <button
        type="button"
        onClick={onBack}
        className="text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        ← Back to the timeline
      </button>

      <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
        A policy says when the agent has to ask. The first policy that
        matches a call decides it: there is no fall-through, and a rule for
        one session always beats a global rule.
      </p>

      {/* The default, in plain language. */}
      <div className="mt-5 rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
          The default
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink">
          Tools that only read are allowed and run without asking. Tools
          that write are asked about, one call at a time.
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
          Change it per tool below: add a policy that allows{' '}
          <code className="font-mono text-[12px] text-ink">create_branch</code>{' '}
          for branches that start with{' '}
          <code className="font-mono text-[12px] text-ink">fix/</code>, and
          Muca stops asking about those.
        </p>
      </div>

      {/* The list */}
      <div className="mt-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Your policies
          </h2>
          <button
            type="button"
            onClick={() => setCreating((value) => !value)}
            aria-expanded={creating}
            className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-medium text-ink-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-surface-hover hover:text-ink active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {creating ? 'Cancel' : '+ New policy'}
          </button>
        </div>

        {policies.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-ink-faint">
            No policies yet. Muca is using the default.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {policies.map((policy) => (
              <PolicyRow
                key={policy.id}
                policy={policy}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </div>

      {/* The form */}
      {creating ? (
        <form
          className="mt-6 space-y-4 rounded-xl border border-line bg-surface-raised p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!toolName) return;
            onCreate({
              toolName,
              match,
              effect,
              label: label.trim(),
              sessionId: scope === 'session' ? sessionId : null,
            });
            setLabel('');
            setMatchers([{ ...EMPTY_DRAFT }]);
            setCreating(false);
          }}
        >
          <h2 className="text-[13px] font-semibold text-ink">New policy</h2>

          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Tool
            </span>
            <select
              id="policy-tool"
              name="tool"
              value={toolName}
              onChange={(event) => setToolName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-surface-sunken px-2.5 py-2 text-[13px] text-ink transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent focus:border-accent"
            >
              {writableTools.length === 0 ? (
                <option value="">No tools available</option>
              ) : (
                writableTools.map((tool) => (
                  <option key={tool.name} value={tool.name}>
                    {tool.name}
                    {tool.destructive ? ' (writes)' : ''}
                  </option>
                ))
              )}
            </select>
          </label>

          <fieldset>
            <legend className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Only when the arguments match
            </legend>
            <div className="mt-1.5 space-y-2">
              {matchers.map((matcher, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <input
                    name={`matcher-${index}-key`}
                    value={matcher.key}
                    onChange={(event) =>
                      setMatchers((current) =>
                        current.map((item, position) =>
                          position === index ? { ...item, key: event.target.value } : item,
                        ),
                      )
                    }
                    placeholder="argument, e.g. name"
                    aria-label={`Argument name for matcher ${index + 1}`}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5 font-mono text-[12px] text-ink transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-ink-faint focus:border-accent"
                  />
                  <select
                    name={`matcher-${index}-operator`}
                    value={matcher.operator}
                    onChange={(event) =>
                      setMatchers((current) =>
                        current.map((item, position) =>
                          position === index
                            ? { ...item, operator: event.target.value as Operator }
                            : item,
                        ),
                      )
                    }
                    aria-label={`Matcher ${index + 1} operator`}
                    className="rounded-lg border border-line bg-surface-sunken px-2 py-1.5 text-[12px] text-ink transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent focus:border-accent"
                  >
                    {OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {operator}
                      </option>
                    ))}
                  </select>
                  <input
                    name={`matcher-${index}-value`}
                    value={matcher.value}
                    onChange={(event) =>
                      setMatchers((current) =>
                        current.map((item, position) =>
                          position === index
                            ? { ...item, value: event.target.value }
                            : item,
                        ),
                      )
                    }
                    placeholder="value, e.g. fix/"
                    aria-label={`Matcher ${index + 1} value`}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5 font-mono text-[12px] text-ink transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-ink-faint focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setMatchers((current) =>
                        current.length > 1
                          ? current.filter((_, position) => position !== index)
                          : current,
                      )
                    }
                    aria-label={`Remove matcher ${index + 1}`}
                    className="rounded-md p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setMatchers((current) => [...current, { ...EMPTY_DRAFT }])}
              className="mt-2 text-[12px] text-accent underline underline-offset-2 transition-colors duration-150 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              + Add a matcher
            </button>
          </fieldset>

          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Effect
            </span>
            <select
              id="policy-effect"
              name="effect"
              value={effect}
              onChange={(event) =>
                setEffect(event.target.value as 'allow' | 'ask' | 'deny')
              }
              className="mt-1 w-full rounded-lg border border-line bg-surface-sunken px-2.5 py-2 text-[13px] text-ink transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent focus:border-accent"
            >
              <option value="allow">Allow — run it without asking</option>
              <option value="ask">Ask — check with me every time</option>
              <option value="deny">Deny — never run it</option>
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Label
            </span>
            <input
              name="label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Fix branches are safe"
              className="mt-1 w-full rounded-lg border border-line bg-surface-sunken px-2.5 py-2 text-[13px] text-ink transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-ink-faint focus:border-accent"
            />
          </label>

          <fieldset>
            <legend className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
              Applies to
            </legend>
            <div className="mt-1.5 flex gap-4">
              <label className="flex items-center gap-2 text-[12.5px] text-ink">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'session'}
                  onChange={() => setScope('session')}
                  className="accent-[var(--accent)]"
                />
                This session
              </label>
              <label className="flex items-center gap-2 text-[12.5px] text-ink">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === 'global'}
                  onChange={() => setScope('global')}
                  className="accent-[var(--accent)]"
                />
                Every session
              </label>
            </div>
          </fieldset>

          {/* The preview, in words. */}
          <p className="rounded-lg border border-accent-line bg-accent-soft px-3 py-2 text-[12.5px] leading-relaxed text-ink">
            {preview}
          </p>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!toolName}
              className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-surface transition-[transform,filter,opacity] duration-150 ease-out hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              Save policy
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-lg border border-line px-3.5 py-2 text-[13px] text-ink-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-surface-hover hover:text-ink active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function PolicyRow({
  policy,
  onUpdate,
  onDelete,
}: {
  policy: Policy;
  onUpdate: (policyId: string, patch: Partial<Policy>) => void;
  onDelete: (policyId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const enabled = policy.enabled !== false;
  const scope = policy.sessionId ? 'this session' : 'every session';

  return (
    <li className="rounded-lg border border-line bg-surface-raised px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[12.5px] text-ink">{policy.toolName}</span>
        <span
          className={`rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${
            policy.effect === 'allow'
              ? 'border-good-line bg-good-soft text-good'
              : policy.effect === 'deny'
                ? 'border-bad-line bg-bad-soft text-bad'
                : 'border-warn-line bg-warn-soft text-warn'
          }`}
        >
          {policy.effect}
        </span>
        {!enabled ? (
          <span className="rounded-full border border-line px-1.5 py-px text-[10px] uppercase tracking-wide text-ink-faint">
            disabled
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-ink-faint">{scope}</span>
      </div>

      {policy.label ? (
        <p className="mt-1 text-[12.5px] text-ink-muted">{policy.label}</p>
      ) : null}

      {policy.match ? (
        <p className="mt-1 font-mono text-[11.5px] text-ink-faint">
          when {JSON.stringify(policy.match)}
        </p>
      ) : (
        <p className="mt-1 text-[11.5px] text-ink-faint">
          for every call to this tool
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onUpdate(policy.id, { enabled: !enabled })}
          className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-surface-hover hover:text-ink active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            onDelete(policy.id);
          }}
          onBlur={() => setConfirming(false)}
          className={`rounded-md border px-2.5 py-1 text-[12px] transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            confirming
              ? 'border-bad-line bg-bad-soft text-bad'
              : 'border-line text-ink-muted hover:bg-bad-soft hover:text-bad'
          }`}
        >
          {confirming ? 'Confirm delete' : 'Delete'}
        </button>
      </div>
    </li>
  );
}

/** Turns the matcher rows into the JSON the API takes. */
function buildMatch(
  matchers: MatcherDraft[],
): Record<string, unknown> | null {
  const match: Record<string, unknown> = {};
  for (const matcher of matchers) {
    const key = matcher.key.trim();
    if (!key) continue;
    const value =
      matcher.operator === 'in'
        ? matcher.value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : matcher.value;
    match[key] = { [matcher.operator]: value };
  }
  return Object.keys(match).length > 0 ? match : null;
}

/** The preview, in words: what this policy will do. */
function previewEffect(
  toolName: string,
  effect: 'allow' | 'ask' | 'deny',
  matchers: MatcherDraft[],
): string {
  const tool = toolName || 'this tool';
  const conditions = matchers
    .filter((matcher) => matcher.key.trim())
    .map((matcher) => {
      const key = matcher.key.trim();
      const value = matcher.value.trim();
      switch (matcher.operator) {
        case 'equals':
          return `${key} is “${value}”`;
        case 'notEquals':
          return `${key} is not “${value}”`;
        case 'startsWith':
          return `${key} starts with “${value}”`;
        case 'endsWith':
          return `${key} ends with “${value}”`;
        case 'contains':
          return `${key} contains “${value}”`;
        case 'matches':
          return `${key} matches ${value}`;
        case 'in':
          return `${key} is one of ${value}`;
        default:
          return `${key} ${matcher.operator} “${value}”`;
      }
    });

  const when =
    conditions.length > 0
      ? `when ${conditions.join(' and ')}`
      : 'for every call';

  if (effect === 'allow') {
    return `If you allow this, ${tool} will run without asking you, ${when}.`;
  }
  if (effect === 'deny') {
    return `If you deny this, ${tool} will never run, ${when}. Muca will explain what it wanted to do instead.`;
  }
  return `If you ask this, Muca will check with you every time, ${when}.`;
}
