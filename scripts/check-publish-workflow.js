import { readFileSync } from 'node:fs';

const publisher = 'laurigates/.github/.github/workflows/reusable-npm-publish.yml';
const reviewedRevision = 'aad403be1e3d72f68f6536f212ed3a0339263d22';
const publishCondition = "${{ github.repository == 'laurigates/foundryvtt-mcp' && github.ref == 'refs/heads/main' && needs.release-please.outputs.release_created == 'true' }}";
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate the parsed release workflow, including YAML aliases and flow mappings. */
export function checkPublishWorkflow(workflow) {
  const errors = [];
  if (!isObject(workflow)) return ['Expected one workflow mapping'];
  const triggers = workflow.on;
  if (!isObject(triggers) || Object.keys(triggers).some((event) => !['push', 'workflow_dispatch'].includes(event)) || !Object.hasOwn(triggers, 'push')) {
    errors.push('Release triggers must be main push and optional workflow_dispatch');
  }
  const push = triggers?.push;
  if (!isObject(push) || !Array.isArray(push.branches) || push.branches.length !== 1 || push.branches[0] !== 'main' || Object.keys(push).some((key) => !['branches', 'paths', 'paths-ignore'].includes(key))) {
    errors.push('Release push must select only the main branch, without tag triggers');
  }
  if (!isObject(workflow.permissions) || Object.hasOwn(workflow.permissions, 'id-token')) {
    errors.push('Workflow permissions must not grant OIDC');
  }
  const jobs = workflow.jobs;
  if (!isObject(jobs)) return [...errors, 'Expected release jobs'];
  for (const [name, job] of Object.entries(jobs)) {
    if (!isObject(job)) {
      errors.push(`Invalid job: ${name}`);
      continue;
    }
    if (name !== 'publish' && (job.permissions === 'write-all' || (isObject(job.permissions) && Object.hasOwn(job.permissions, 'id-token')))) {
      errors.push(`OIDC must be limited to publish: ${name}`);
    }
  }
  const release = jobs['release-please'];
  if (!isObject(release) || release.if !== "github.repository == 'laurigates/foundryvtt-mcp'") {
    errors.push('Release generation must retain the upstream repository guard');
  }
  const publish = jobs.publish;
  if (!isObject(publish)) return [...errors, 'Expected publish job'];
  if (publish.uses !== `${publisher}@${reviewedRevision}`) {
    errors.push('Publish must use the reviewed external workflow at a full commit SHA');
  }
  if (publish.needs !== 'release-please' || publish.if !== publishCondition) {
    errors.push('Publish must require a created release in the upstream main branch');
  }
  if (!isObject(publish.permissions) || publish.permissions.contents !== 'read' || publish.permissions['id-token'] !== 'write' || Object.keys(publish.permissions).some((key) => !['contents', 'id-token'].includes(key))) {
    errors.push('Publish permissions must be contents: read and id-token: write');
  }
  if (publish.secrets !== undefined) errors.push('Publish must not pass stored authentication secrets');
  return errors;
}

if (import.meta.main) {
  try {
    const workflow = Bun.YAML.parse(readFileSync(process.argv[2] ?? '.github/workflows/release-please.yml', 'utf8'));
    const errors = checkPublishWorkflow(workflow);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Publishing workflow policy passed');
  } catch (error) {
    console.error(`Publishing workflow policy failed: ${error.message}`);
    process.exitCode = 1;
  }
}
