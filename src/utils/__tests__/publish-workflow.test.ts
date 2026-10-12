import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPublishWorkflow } from '../../../scripts/check-publish-workflow.js';

const source = readFileSync('.github/workflows/release-please.yml', 'utf8');
const bun = process.env.BUN_EXECUTABLE ?? 'bun';
const parse = spawnSync(
  bun,
  ['--eval', 'process.stdout.write(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))'],
  { input: source, encoding: 'utf8' },
);
if (parse.status !== 0) {
  throw new Error(`Bun YAML parser unavailable: ${parse.stderr}`);
}
const baseline = JSON.parse(parse.stdout);

function mutated(change: (workflow: typeof baseline) => void) {
  const workflow = structuredClone(baseline);
  change(workflow);
  return checkPublishWorkflow(workflow);
}

function runYaml(yaml: string) {
  const directory = mkdtempSync(join(tmpdir(), 'publish-policy-'));
  try {
    const path = join(directory, 'release.yml');
    writeFileSync(path, yaml);
    return spawnSync(bun, ['scripts/check-publish-workflow.js', path], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('privileged publishing workflow policy', () => {
  it('accepts the repository release and manual main-branch paths', () => {
    expect(checkPublishWorkflow(baseline)).toEqual([]);
    expect(runYaml(source).status).toBe(0);
  });
  it.each([
    'main',
    'v1',
    'aad403b',
    'A'.repeat(40),
    'a'.repeat(41),
    'b'.repeat(40),
  ])('rejects mutable, malformed or unreviewed publishing ref %s', (ref) => {
    expect(
      mutated((workflow) => {
        workflow.jobs.publish.uses = `${workflow.jobs.publish.uses.split('@')[0]}@${ref}`;
      }),
    ).toContain('Publish must use the reviewed external workflow at a full commit SHA');
  });
  it('requires the reviewed publisher identity', () => {
    expect(
      mutated((workflow) => {
        workflow.jobs.publish.uses = `other/repo/.github/workflows/publish.yml@${'a'.repeat(40)}`;
      }),
    ).not.toEqual([]);
  });
  it.each([
    'pull_request',
    'pull_request_target',
    'workflow_call',
    'schedule',
  ])('rejects the %s event', (event) => {
    expect(
      mutated((workflow) => {
        workflow.on[event] = null;
      }),
    ).toContain('Release triggers must be main push and optional workflow_dispatch');
  });
  it.each([
    'permissions',
    'job permissions',
    'write-all',
    'fork guard',
    'branch guard',
    'release gate',
    'needs',
    'secrets',
    'tags',
  ])('rejects unsafe %s', (change) => {
    expect(
      mutated((workflow) => {
        const release = workflow.jobs['release-please'];
        const publish = workflow.jobs.publish;
        if (change === 'permissions') {
          workflow.permissions['id-token'] = 'write';
        }
        if (change === 'job permissions') {
          release.permissions = { 'id-token': 'write' };
        }
        if (change === 'write-all') {
          release.permissions = 'write-all';
        }
        if (change === 'fork guard') {
          release.if = 'true';
        }
        if (change === 'branch guard') {
          publish.if = publish.if.replace("github.ref == 'refs/heads/main'", 'true');
        }
        if (change === 'release gate') {
          publish.if = 'always()';
        }
        if (change === 'needs') {
          publish.needs = [];
        }
        if (change === 'secrets') {
          publish.secrets = 'inherit';
        }
        if (change === 'tags') {
          workflow.on.push.tags = ['*'];
        }
      }),
    ).not.toEqual([]);
  });
  it.each([null, [], 'push', { jobs: {} }])('fails closed on malformed documents', (workflow) => {
    expect(checkPublishWorkflow(workflow)).not.toEqual([]);
  });
  it('rejects invalid and multiple YAML documents', () => {
    expect(runYaml('on: [').status).toBe(1);
    expect(runYaml(`${source}\n---\nname: another\n`).status).toBe(1);
  });
  it('parses flow mappings, quoted keys and aliases before applying policy', () => {
    const flow = source.replace(
      '  contents: write\n  pull-requests: write\n  issues: write',
      '{ "contents": write, "pull-requests": write, "issues": write, "id-token": write }',
    );
    expect(runYaml(flow).status).toBe(1);
    const alias = source.replace(
      'permissions:\n  contents: write\n  pull-requests: write\n  issues: write',
      'permission-template: &oidc { "id-token": write }\npermissions: *oidc',
    );
    const result = runYaml(alias);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Workflow permissions must not grant OIDC');
    expect(runYaml(source.replace('on:', '"on":')).status).toBe(0);
  });
});
