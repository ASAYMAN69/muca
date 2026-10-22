/**
 * What a tool is about to change, in plain words.
 *
 * The permission card has to say what will happen *before* it happens, in
 * a sentence a person can act on. The sentence is derived from the tool
 * definition and the exact arguments, never from the model's prose: the
 * model does not get to describe what it is about to do.
 */

export interface ToolFact {
  name: string;
  title?: string;
  description?: string;
  destructive?: boolean;
}

type Template = (args: Record<string, unknown>) => string;

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

const TEMPLATES: Record<string, Template> = {
  create_branch: (args) => {
    const name = text(args, 'name');
    const base = text(args, 'baseBranch');
    if (name && base) {
      return `This creates the branch “${name}” from “${base}”. The branch exists on the remote and anyone with write access can push to it.`;
    }
    if (name) {
      return `This creates the branch “${name}” on the remote. Anyone with write access can push to it.`;
    }
    return 'This creates a branch on the remote.';
  },
  open_pull_request: (args) => {
    const title = text(args, 'title');
    const branch = text(args, 'branch');
    const base = text(args, 'baseBranch');
    if (branch && base) {
      return `This opens a pull request from “${branch}” into “${base}”. The team can see it, review it and merge it.`;
    }
    if (title) {
      return `This opens a pull request titled “${title}”. The team can see it and merge it.`;
    }
    return 'This opens a pull request. The team can see it and merge it.';
  },
  create_issue: (args) => {
    const title = text(args, 'title');
    return title
      ? `This opens the issue “${title}” in the tracker. It is visible to everyone on the team.`
      : 'This opens an issue in the tracker.';
  },
  comment_on_issue: (args) => {
    const issue = text(args, 'issueNumber') || text(args, 'issueId');
    return issue
      ? `This posts a comment on issue ${issue}. It cannot be edited away quietly: people are notified.`
      : 'This posts a comment on an issue.';
  },
  diagnose_incident: () =>
    'This reads the incident timeline and writes a diagnosis into Muca. Nothing outside Muca changes.',
  list_deployments: () => 'This reads the deployment list. Nothing changes.',
  get_deployment: () => 'This reads one deployment. Nothing changes.',
  get_ci_failure: () => 'This reads a CI run and its logs. Nothing changes.',
  list_issues: () => 'This reads the issue tracker. Nothing changes.',
  echo: () => 'This echoes a message back. Nothing changes.',
};

/**
 * A sentence describing what the tool is about to change.
 *
 * A tool with a known shape gets a precise sentence. Anything else falls
 * back to the tool's own description, so the card is never empty.
 */
export function describeConsequence(
  tool: ToolFact | undefined,
  args: Record<string, unknown>,
): string {
  const template = tool ? TEMPLATES[tool.name] : undefined;
  if (template) return template(args);

  const description = tool?.description?.trim();
  if (description) {
    return `${description} The exact effect is up to this tool, so read the arguments below before allowing it.`;
  }
  return 'This runs a tool that changes something outside Muca. Read the arguments below before allowing it.';
}

/**
 * What "allow and remember" will remember, in words.
 *
 * The server builds the policy from the decision; the client only has to
 * say it out loud.
 */
export function describeRemembering(
  tool: ToolFact | undefined,
  args: Record<string, unknown>,
): string {
  const name = tool?.name ?? 'this tool';
  const interesting = Object.entries(args).filter(
    ([key, value]) =>
      key !== 'body' &&
      key !== 'description' &&
      (typeof value === 'string' ? value.length > 0 : value !== undefined),
  );
  if (interesting.length === 0) {
    return `Remembers: always allow ${name}, without asking.`;
  }
  const [key, value] = interesting[0];
  const shown =
    typeof value === 'string' && value.length > 24
      ? `${value.slice(0, 24)}…`
      : String(value);
  return `Remembers: always allow ${name} when ${key} is “${shown}”.`;
}
