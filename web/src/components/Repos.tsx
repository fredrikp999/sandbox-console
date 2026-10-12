// "Repository" block of the inspector: bring a host repo (or a clone of a remote
// one) into the sandbox, send it the latest base branch, get the agent's commits
// out, review them, merge into base and push. Git with credentials only runs on
// this machine; the sandbox only ever sees bundles.
import { useEffect, useState } from "react";
import type { RepoLink, RepoOp, RepoReview, SandboxRow, ServerMessage } from "../../../shared/protocol.ts";
import { ago } from "../format.ts";
import { type RequestError, store } from "../store.ts";

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
  return { busy, outcome, setOutcome, reviews, run };
}

export function Repos({ sb }: { sb: SandboxRow }) {
  const { busy, outcome, reviews, run } = useRepoActions(sb.name);
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const ready = sb.phase === "Ready";
  const showForm = adding || sb.repos.length === 0;
  const reviewed = sb.repos.find((r) => r.name === reviewing);

  const getChanges = async (r: RepoLink) => {
    const res = await run("get", r.name);
    if (res?.review?.commits.length) setReviewing(r.name);
  };
  const openReview = async (r: RepoLink) => {
    if (await run("review", r.name)) setReviewing(r.name);
  };

  return (
    <div className="blk">
      <h5>Repository</h5>
      {sb.repos.map((r) => (
        <RepoCard
          key={r.name}
          repo={r}
          ready={ready}
          disabled={!!busy}
          working={busy?.repo === r.name && !reviewing ? BUSY[busy.op] : null}
          onSend={() => run("send", r.name)}
          onGet={() => getChanges(r)}
          onReview={() => openReview(r)}
          onUnlink={() => run("unlink", r.name)}
        />
      ))}
      {showForm ? (
        ready ? (
          <LinkForm
            busy={busy?.op === "link"}
            disabled={!!busy}
            canCancel={sb.repos.length > 0}
            onCancel={() => setAdding(false)}
            onSubmit={async (v) => {
              if (await run("link", null, v)) setAdding(false);
            }}
          />
        ) : (
          <p className="muted">The sandbox must be Ready to bring a repository in.</p>
        )
      ) : (
        <button type="button" className="btn small" style={{ justifySelf: "start" }} onClick={() => setAdding(true)} disabled={!!busy}>
          + Another repository
        </button>
      )}
      {outcome && <OutcomeView outcome={outcome} />}
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

function RepoCard(props: {
  repo: RepoLink;
  ready: boolean;
  disabled: boolean;
  working: string | null;
  onSend: () => void;
  onGet: () => void;
  onReview: () => void;
  onUnlink: () => void;
}) {
  const { repo: r, ready, disabled: busy, working } = props;
  const [armed, setArmed] = useState(false);
  return (
    <div className="repo">
      <div className="repo-head">
        <b title={r.cloneUrl ?? r.hostPath}>{r.name}</b>
        <span className="mono muted">
          {r.base} ← {r.branch}
        </span>
      </div>
      <dl className="kv">
        <dt>Here</dt>
        <dd className="mono" title={r.hostPath}>
          {r.hostPath}
        </dd>
        <dt>Sandbox</dt>
        <dd className="mono" title={r.sandboxPath}>
          {r.sandboxPath}
        </dd>
        {r.cloneUrl && (
          <>
            <dt>Origin</dt>
            <dd className="mono" title={r.cloneUrl}>
              {r.cloneUrl}
            </dd>
          </>
        )}
        <dt>Last</dt>
        <dd>
          {[r.sentAt && `sent ${ago(r.sentAt)}`, r.fetchedAt && `got ${ago(r.fetchedAt)}`, r.mergedAt && `merged ${ago(r.mergedAt)}`]
            .filter(Boolean)
            .join(" · ") || "–"}
        </dd>
      </dl>
      <div className="repo-acts">
        <button
          type="button"
          className="btn small"
          onClick={props.onSend}
          disabled={!!busy || !ready}
          title={`Pull ${r.base} from origin on this machine, then send it into the sandbox as host/${r.base}`}
        >
          Send latest {r.base}
        </button>
        <button
          type="button"
          className="btn small primary"
          onClick={props.onGet}
          disabled={!!busy || !ready}
          title={`Bring the agent's commits on ${r.branch} out to this machine, then review them`}
        >
          Get changes
        </button>
        <button type="button" className="btn small" onClick={props.onReview} disabled={!!busy} title={`Review ${r.branch} against ${r.base}`}>
          Review
        </button>
        <button
          type="button"
          className={`btn small danger${armed ? " armed" : ""}`}
          onClick={() => (armed ? props.onUnlink() : setArmed(true))}
          onBlur={() => setArmed(false)}
          disabled={!!busy}
          title="Forget this link. No files are deleted, here or in the sandbox."
        >
          {armed ? "Unlink?" : "Unlink"}
        </button>
      </div>
      {working && <p className="muted">{working}</p>}
    </div>
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
