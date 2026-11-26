import { relative } from "node:path";
import { isPathInside } from "../../core/safety.js";

export const exactProjectRegistration = {
  code: "registered-project",
  detail: "Claude retains a registration for this workspace.",
};
const ancestorRegistration = {
  code: "registered-project-ancestor",
  detail: "Claude retains a registration for a parent directory of this workspace.",
};
const descendantRegistration = {
  code: "registered-project-descendant",
  detail: "This workspace contains a project registered with Claude.",
};
export const projectRegistrationCodes = [
  exactProjectRegistration.code,
  ancestorRegistration.code,
  descendantRegistration.code,
];

// Matching is performed by the reachability index. Describe only an established overlap.
export function describeProjectRegistration(registeredPath: string, workspacePath: string) {
  if (relative(registeredPath, workspacePath) === "") return exactProjectRegistration;
  return isPathInside(registeredPath, workspacePath)
    ? ancestorRegistration
    : descendantRegistration;
}
