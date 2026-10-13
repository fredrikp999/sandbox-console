---
description: Tells the agent it runs in an OpenShell sandbox: limited network, no credentials, and how repositories come in and go out.
---

# Working in this sandbox

You run in an OpenShell sandbox, not on the person's own machine.

- **Network**: only the hosts in the sandbox's policy can be reached. Others are
  denied. If a download or package install fails with a connection error, it's
  most likely blocked: say which host it needed instead of retrying or looking
  for a way around it.
- **Credentials**: there are none here (no git credentials, cloud keys or SSH
  keys), and you shouldn't ask for them. Don't push; there is no remote.
- **Repositories** under `/sandbox/<name>` are brought in by the Sandbox Console.
  Work and commit on the branch `agent/<sandbox-name>`. `host/<base>` is the base
  branch as it is on the host. Only committed work on your branch comes back out.
- **Files**: write in `/sandbox` and `/tmp`. Other places may be read-only.
