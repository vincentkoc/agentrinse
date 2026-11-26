import { locations } from "./location.js";

export const agentsLocations = [
  ...locations(
    "Codex",
    "direct",
    "Desktop application cache metadata",
    {
      "codex.desktop-cache": "Library/Caches/com.openai.codex",
      "codex.app-cache": "Library/Caches/Codex",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "Codex",
    "retained",
    "Runtime installations and temporary state may belong to live sessions",
    {
      "codex.runtimes": ".cache/codex-runtimes",
      "codex.hidden-tmp": ".codex/.tmp",
    },
  ),
  ...locations(
    "AgentRinse",
    "retained",
    "Retained audit records, plans, runs and quarantine recovery payloads",
    {
      "agentrinse.audits": ".local/state/agentrinse/audits",
      "agentrinse.plans": ".local/state/agentrinse/plans",
      "agentrinse.quarantine": ".local/state/agentrinse/quarantine",
      "agentrinse.runs": ".local/state/agentrinse/runs",
    },
  ),
  ...locations(
    "Kubernetes",
    "retained",
    "Cluster discovery metadata stays opaque",
    {
      "kubernetes.client-cache": ".kube/cache",
    },
    { optIn: true },
  ),
  ...locations(
    "AWS CLI",
    "retained",
    "Credential cache stays opaque",
    {
      "aws.cli-cache": ".aws/cli/cache",
    },
    { optIn: true },
  ),
  ...locations(
    "Google Cloud CLI",
    "retained",
    "Service logs stay opaque",
    {
      "gcloud.logs": ".config/gcloud/logs",
    },
    { optIn: true },
  ),
  ...locations(
    "Azure CLI",
    "retained",
    "Service logs stay opaque",
    {
      "azure.logs": ".azure/logs",
    },
    { optIn: true },
  ),
  ...locations(
    "Jupyter",
    "retained",
    "Runtime files and connection secrets stay opaque",
    {
      "jupyter.runtime": ".jupyter/runtime",
    },
    { optIn: true },
  ),
];
