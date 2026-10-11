// Turn failures into "what failed and how to fix it" (DESIGN.md section 5, Errors).
// Same rules as acp_client.py.
import type { AgentConfig } from "./config.ts";

export function exitHint(code: number | null, tail: string[], agent: AgentConfig): string | undefined {
  const low = tail.join("\n").toLowerCase();
  if (code === 127 || /command not found|no such file|executable file not found/.test(low)) {
    return agent.missingHint ?? `The agent command \`${agent.cmd[0]}\` is missing from the sandbox image.`;
  }
  if (/not ready|sandbox .*not found|no sandbox/.test(low)) {
    return "The sandbox isn't Ready. Check its phase in the list, or recreate it.";
  }
  if (/connection refused|gateway|transport error|unavailable/.test(low)) {
    return "The OpenShell gateway may be down. Check `openshell status`.";
  }
  if (code === null || tail.length === 0) return "Check `openshell status`, then start the session again.";
  return undefined;
}

export function rpcHint(message: string): string | undefined {
  const low = message.toLowerCase();
  if (/cannot connect to api|unable to connect|econnrefused|fetch failed|network/.test(low)) {
    return "The model's API host is probably blocked by the sandbox policy, or the model is wrong. Pick another model, or check the provider's network rules.";
  }
  if (/\bauth|401|403|api key|unauthorized|credential/.test(low)) {
    return "The provider credential is missing or wrong. See 'Credentials' in the openshell-configs README.";
  }
  if (/model.*not found|unknown model|no endpoints found/.test(low)) {
    return "The model isn't available from this provider. Pick another one in the model picker.";
  }
  if (/rate limit|429/.test(low)) return "The provider is rate-limiting this model. Wait a bit, or pick another model.";
  return undefined;
}
