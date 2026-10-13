---
name: commit-for-review
description: How to commit work in a repository the Sandbox Console brought into this sandbox, so it can be taken out, reviewed and merged on the host. Use it before saying a task is done, or when asked to commit, hand over or get work ready for review.
---

# Commit work for review

Repositories under `/sandbox/<name>` were brought in by the Sandbox Console as
git bundles. There is no remote and no credentials, so nothing can be pushed
from here. The person takes your commits out from the console, reviews them and
merges them on their own machine.

## The branches

- You work on `agent/<sandbox-name>`. Only this branch comes back out.
- `host/<base>` (for example `host/main`) is the base branch as it is on the
  host. The console updates it when the person sends the latest version in.

Check with `git branch --show-current` and `git branch -r`. If you are on
another branch, switch back or merge your work into `agent/<sandbox-name>`.

## Committing

1. Run the project's tests and linters first, if there are any.
2. Commit in small steps that each make sense alone, rather than one big commit
   at the end.
3. Write the subject as what the commit does, in the imperative and under about
   70 characters ("Add a /health endpoint"), and a body saying why, when it
   isn't obvious.
4. Don't commit build output, dependencies, secrets or editor files. Add them to
   `.gitignore` instead.
5. Leave the work tree clean (`git status`): uncommitted changes don't come out.

## When the base has moved

If `git rev-list --count agent/<sandbox-name>..host/<base>` is not 0, the
person has sent in newer commits. Merge them before you hand over:

```sh
git merge host/<base>
```

Resolve conflicts, run the tests again and commit the merge.

## Handing over

Say what you committed (`git log --oneline host/<base>..HEAD`) and anything the
reviewer should look at closely. Don't try to push.
