// "Changes" tab of the inspector: bring a host repo (or a clone of a remote
// one) into the sandbox, send it the latest base branch, get the agent's commits
// out, review them, merge into base and push. Git with credentials only runs on
// this machine; the sandbox only ever sees bundles.
import { useEffect, useState } from "react";
import type { RepoLink, RepoOp, RepoReview, SandboxRow, ServerMessage } from "../../../shared/protocol.ts";
import { ago } from "../format.ts";
import { type RequestError, store, useStore } from "../store.ts";

type RepoResult = Extract<ServerMessage, { type: "repo_result" }>;
type Outcome = { tone: "ok" | "error"; lines: string[]; hint?: string };

const BUSY: Record<RepoOp, string> = {
  link: "Bringing it in…",
  send: "Sending…",
  get: "Getting changes…",
  review: "Loading the review…",
  merge: "Merging…",
  push: "Pushing…",
  unlink: "Unlinking…",
};

function useRepoActions(sandbox: string) {
  const [busy, setBusy] = useState<{ repo: string | null; op: RepoOp } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [reviews, setReviews] = useState<Record<string, RepoReview>>({});

  const run = async (op: RepoOp, repo: string | null, extra: { source?: string; base?: string; dest?: string } = {}) => {
    setBusy({ repo, op });
    setOutcome(null);
    try {
      const r = await store.request<RepoResult>({ type: "repo", sandbox, op, repo: repo ?? undefined, ...extra });
      if (r.review && r.repo) setReviews((v) => ({ ...v, [r.repo as string]: r.review as RepoReview }));
      if (r.log.length) setOutcome({ tone: "ok", lines: r.log });
      return r;
    } catch (e) {
      const err = e as RequestError;
      setOutcome({ tone: "error", lines: [err.message, ...(err.detail ? err.detail.split("\n") : [])], hint: err.hint });
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, outcome, reviews, setReviews, run };
}

export function Repos({ sb }: { sb: SandboxRow }) {
  const { busy, outcome, reviews, setReviews, run } = useRepoActions(sb.name);
  const [adding, setAdding] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const ready = sb.phase === "Ready";
  const repo = sb.repos.find((r) => r.name === current) ?? sb.repos[0];
  const reviewed = sb.repos.find((r) => r.name === reviewing);

  // Load the review quietly, so step 3 can say what is waiting.
  const name = repo?.name;
  const connected = useStore((s) => s.link === "open");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when something came out or was merged.
  useEffect(() => {
    if (!name || !connected) return;
    store
      .request<RepoResult>({ type: "repo", sandbox: sb.name, op: "review", repo: name })
      .then((r) => r.review && setReviews((v) => ({ ...v, [name]: r.review as RepoReview })))
      .catch(() => {});
  }, [sb.name, name, connected, repo?.fetchedAt, repo?.mergedAt, setReviews]);

  const getChanges = async (r: RepoLink) => {
    const res = await run("get", r.name);
    if (res?.review?.commits.length) setReviewing(r.name);
  };
  const openReview = async (r: RepoLink) => {
    if (await run("review", r.name)) setReviewing(r.name);
  };

  if (!repo || adding) {
    return (
      <div className="blk">
        <h5>{repo ? "Add a repository" : "Work on a repository"}</h5>
        {ready ? (
          <LinkForm
            busy={busy?.op === "link"}
            disabled={!!busy}
            canCancel={!!repo}
            onCancel={() => setAdding(false)}
            onSubmit={async (v) => {
              const r = await run("link", null, v);
              if (r) {
                setAdding(false);
                setCurrent(r.repo);
              }
            }}
          />
        ) : (
          <p className="muted">The sandbox must be Ready to bring a repository in.</p>
        )}
        {outcome && <OutcomeView outcome={outcome} />}
      </div>
    );
  }

  return (
    <div className="blk">
      <h5>
        {sb.repos.length > 1 ? (
          <select className="opt repo-pick" value={repo.name} onChange={(e) => setCurrent(e.target.value)} aria-label="Repository" disabled={!!busy}>
            {sb.repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="repo-name" title={repo.cloneUrl ?? repo.hostPath}>
            {repo.name}
          </span>
        )}
        <button
          type="button"
          className="icon-btn"
          onClick={() => setAdding(true)}
          disabled={!!busy}
          title="Bring another repository in"
          aria-label="Add a repository"
        >
          +
        </button>
      </h5>
      <RepoSteps
        repo={repo}
        review={reviews[repo.name]}
        ready={ready}
        busy={busy?.repo === repo.name ? busy.op : busy ? "other" : null}
        onSend={() => run("send", repo.name)}
        onGet={() => getChanges(repo)}
        onReview={() => openReview(repo)}
        onPush={() => run("push", repo.name)}
        onUnlink={() => run("unlink", repo.name)}
      />
      {outcome && !reviewing && <OutcomeView outcome={outcome} />}
      {reviewed && reviews[reviewed.name] && (
        <ReviewDialog
          repo={reviewed}
          review={reviews[reviewed.name]}
          busy={busy ? BUSY[busy.op] : null}
          outcome={outcome}
          onMerge={() => run("merge", reviewed.name)}
          onPush={() => run("push", reviewed.name)}
          onClose={() => !busy && setReviewing(null)}
        />
      )}
    </div>
  );
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  return (
    <div className={outcome.tone === "error" ? "repo-out err" : "repo-out"} role="status">
      {outcome.lines.map((l, i) => (
        // Lines of one message, in order.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={i} className={i === 0 && outcome.tone === "error" ? "first" : l.startsWith("warning:") ? "warn-line" : undefined}>
          {l}
        </div>
      ))}
      {outcome.hint && <div className="hint">{outcome.hint}</div>}
    </div>
  );
}

interface Step {
  key: "send" | "get" | "review" | "push";
  title: string;
  detail: string;
  action: string;
  hint: string;
  run: () => void;
  needsSandbox?: boolean;
  disabled?: boolean;
}

/** The repository as four steps, with the next one highlighted. */
function RepoSteps(props: {
  repo: RepoLink;
  review: RepoReview | undefined;
  ready: boolean;
  /** The action running on this repository, or "other" when one runs on another. */
  busy: RepoOp | "other" | null;
  onSend: () => void;
  onGet: () => void;
  onReview: () => void;
  onPush: () => void;
  onUnlink: () => void;
}) {
  const { repo: r, review: v, ready, busy } = props;
  const [armed, setArmed] = useState(false);
  const waiting = v?.commits.length ?? 0;
  const added = v?.files.reduce((n, f) => n + f.added, 0) ?? 0;
  const removed = v?.files.reduce((n, f) => n + f.removed, 0) ?? 0;
  const unpushed = !!r.mergedAt && (!r.pushedAt || r.pushedAt < r.mergedAt);
  const next: Step["key"] = !r.sentAt ? "send" : waiting ? "review" : unpushed ? "push" : "get";
  const steps: Step[] = [
    {
      key: "send",
      title: "In the sandbox",
      detail: r.sentAt ? `${r.base} sent ${ago(r.sentAt)} · ${r.sandboxPath}` : r.sandboxPath,
      action: `Send ${r.base}`,
      hint: `Pull ${r.base} from origin on this machine, then send it into the sandbox as host/${r.base}. Ask the agent to merge it.`,
      run: props.onSend,
      needsSandbox: true,
    },
    {
      key: "get",
      title: "Agent's work",
      detail: r.fetchedAt ? `last got ${ago(r.fetchedAt)}` : "Ask the agent to commit, then get it",
      action: "Get changes",
      hint: `Bring the agent's commits on ${r.branch} out to ${r.hostPath}`,
      run: props.onGet,
      needsSandbox: true,
    },
    {
      key: "review",
      title: "Review",
      detail: !v ? "…" : waiting ? `${waiting} commit${waiting === 1 ? "" : "s"} · +${added} −${removed}` : "Nothing waiting",
      action: waiting ? "Review & merge" : "Review",
      hint: `Commits and diff of ${r.branch} against ${r.base}; merge from there`,
      run: props.onReview,
    },
    {
      key: "push",
      title: `${r.base} on origin`,
      detail: unpushed ? `merged ${ago(r.mergedAt as number)}, not pushed` : r.pushedAt ? `pushed ${ago(r.pushedAt)}` : "Nothing merged yet",
      action: `Push ${r.base}`,
      hint: `git push origin ${r.base}`,
      run: props.onPush,
      disabled: !unpushed,
    },
  ];
  return (
    <>
      <ol className="steps">
        {steps.map((s, i) => {
          const running = busy !== null && busy !== "other" && (busy === s.key || (busy === "merge" && s.key === "review"));
          return (
            <li key={s.key} className={s.key === next ? "step next" : "step"}>
              <span className="step-n">{i + 1}</span>
              <div className="step-text">
                <b>{s.title}</b>
                <span title={s.detail}>{s.detail}</span>
              </div>
              <button
                type="button"
                className={`btn small${s.key === next ? " primary" : ""}`}
                onClick={s.run}
                disabled={!!busy || s.disabled || (s.needsSandbox && !ready)}
                title={s.hint}
              >
                {running ? BUSY[busy as RepoOp] : s.action}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="repo-foot">
        <span className="mono muted" title={`${r.hostPath}\nThe agent works on ${r.branch} in ${r.sandboxPath}`}>
          {/* Truncated from the left (rtl); bdi keeps the path itself left-to-right. */}
          <bdi>{r.hostPath}</bdi>
        </span>
        <button
          type="button"
          className={`linklike danger${armed ? " armed" : ""}`}
          onClick={() => (armed ? props.onUnlink() : setArmed(true))}
          onBlur={() => setArmed(false)}
          disabled={!!busy}
          title="Forget this link. No files are deleted, here or in the sandbox."
        >
          {armed ? "Unlink?" : "Unlink"}
        </button>
      </div>
    </>
  );
}

function LinkForm(props: {
  busy: boolean;
  disabled: boolean;
  canCancel: boolean;
  onCancel: () => void;
  onSubmit: (v: { source: string; base?: string; dest?: string }) => void;
}) {
  const [source, setSource] = useState("");
  const [base, setBase] = useState("");
  const [dest, setDest] = useState("");
  const [more, setMore] = useState(false);
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(source.trim()) || /^[\w.-]+@[\w.-]+:/.test(source.trim());
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit({ source, base: base || undefined, dest: isUrl && dest ? dest : undefined });
      }}
    >
      <label>
        Repository URL, or a path on this machine
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="git@github.com:you/app.git  or  ~/code/app"
          spellCheck={false}
          disabled={props.disabled}
          required
        />
      </label>
      {more ? (
        <>
          <label>
            Base branch
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="origin's default branch"
              spellCheck={false}
              disabled={props.disabled}
            />
          </label>
          {isUrl && (
            <label>
              Clone into
              <input
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder="~/sandbox-repos/<name>"
                spellCheck={false}
                disabled={props.disabled}
              />
            </label>
          )}
        </>
      ) : (
        <button type="button" className="linklike" style={{ justifySelf: "start" }} onClick={() => setMore(true)}>
          Base branch{isUrl ? ", clone location" : ""}…
        </button>
      )}
      <p className="note">
        {isUrl ? "Cloned on this machine with your git credentials, then " : "Its "}
        base branch goes into the sandbox as a git bundle. The agent works on its own branch; nothing reaches your repository until you get, review
        and merge it.
      </p>
      <div className="acts">
        {props.canCancel && (
          <button type="button" className="btn" onClick={props.onCancel} disabled={props.disabled}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn primary" disabled={props.disabled || !source.trim()}>
          {props.busy ? (isUrl ? "Cloning and sending…" : "Sending…") : "Bring into sandbox"}
        </button>
      </div>
    </form>
  );
}

function ReviewDialog(props: {
  repo: RepoLink;
  review: RepoReview;
  busy: string | null;
  outcome: Outcome | null;
  onMerge: () => void;
  onPush: () => void;
  onClose: () => void;
}) {
  const { repo: r, review: v, busy } = props;
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { onClose } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const added = v.files.reduce((n, f) => n + f.added, 0);
  const removed = v.files.reduce((n, f) => n + f.removed, 0);
  const nothing = v.hasBranch && v.commits.length === 0;
  const allOpen = v.files.length <= 8;

  return (
    // Clicking the backdrop closes the dialog; keyboard users have Esc (handled on window).
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal review" role="dialog" aria-label={`Review ${v.branch}`}>
        <div className="review-head">
          <h3>
            Review <span className="mono">{v.branch}</span> → <span className="mono">{v.base}</span>
          </h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={!!busy}>
            ×
          </button>
        </div>
        <p className="muted">
          {!v.hasBranch
            ? "Nothing has come out of the sandbox yet. Use Get changes once the agent has committed."
            : nothing
              ? `${v.base} already has everything on ${v.branch}.`
              : `${v.commits.length} commit${v.commits.length === 1 ? "" : "s"}, ${v.files.length} file${v.files.length === 1 ? "" : "s"} (+${added} −${removed}) in ${r.hostPath}.${
                  v.behind ? ` ${v.base} has ${v.behind} commit${v.behind === 1 ? "" : "s"} the branch doesn't; merging makes a merge commit.` : ""
                }`}
        </p>
        <div className="review-body">
          {v.commits.length > 0 && (
            <ul className="rows commits">
              {v.commits.map((c) => (
                <li key={c.sha}>
                  <span title={`${c.sha}\n${c.author}`}>
                    <span className="mono muted">{c.sha.slice(0, 7)}</span> {c.subject}
                  </span>
                  <span className="muted">{ago(c.time)}</span>
                </li>
              ))}
            </ul>
          )}
          {v.files.map((f) => {
            const shown = open[f.path] ?? allOpen;
            return (
              <div key={f.path} className="review-file">
                <button type="button" className="review-file-head" onClick={() => setOpen((o) => ({ ...o, [f.path]: !shown }))}>
                  <span className="mono">{shown ? "▾" : "▸"}</span>
                  <span className="mono review-path">{f.path}</span>
                  {f.binary ? (
                    <span className="muted">binary</span>
                  ) : (
                    <span>
                      <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                    </span>
                  )}
                </button>
                {shown && !f.binary && <Patch text={f.patch} />}
              </div>
            );
          })}
          {v.truncated && <p className="no">The diff is too big to show whole. See the rest with: git diff {`${v.base}...${v.branch}`}</p>}
        </div>
        {props.outcome && <OutcomeView outcome={props.outcome} />}
        <div className="acts review-acts">
          {busy && <span className="muted">{busy}</span>}
          {r.mergedAt && nothing && (
            <button type="button" className="btn" onClick={props.onPush} disabled={!!busy} title={`git push origin ${v.base}`}>
              Push {v.base} to origin
            </button>
          )}
          {!nothing && v.hasBranch && (
            <button
              type="button"
              className={`btn primary${armed ? " armed" : ""}`}
              onClick={() => {
                if (!armed) return setArmed(true);
                setArmed(false);
                props.onMerge();
              }}
              onBlur={() => setArmed(false)}
              disabled={!!busy}
            >
              {armed ? `Merge ${v.commits.length} commit${v.commits.length === 1 ? "" : "s"} into ${v.base}?` : `Merge into ${v.base}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Patch({ text }: { text: string }) {
  return (
    <div className="diff">
      {text.split("\n").map((l, i) =>
        l.startsWith("\\") ? null : (
          // A fixed patch; position is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <div key={i} className={l.startsWith("@@") ? "hunk" : `ln ${l[0] === "+" ? "add" : l[0] === "-" ? "del" : ""}`}>
            {l.startsWith("@@") ? l : `${l[0] === "-" ? "−" : (l[0] ?? " ")}${l.slice(1)}`}
          </div>
        ),
      )}
    </div>
  );
}
