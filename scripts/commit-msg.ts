export {};

const path = process.argv[2];
if (!path) {
  console.error('Usage: bun run commitmsg <message-file>');
  process.exit(1);
}

const header = (await Bun.file(path).text()).split(/\r?\n/, 1)[0] ?? '';
const conventionalCommit =
  /^(feat|fix|docs|test|refactor|chore|perf|build|ci|style|revert)(\([a-zA-Z0-9][a-zA-Z0-9._/-]*\))?!?: \S.*$/;

if (!conventionalCommit.test(header)) {
  console.error(
    'Use type(scope)?: description, e.g. feat(api): add health check',
  );
  console.error(
    'Allowed types: feat, fix, docs, test, refactor, chore, perf, build, ci, style, revert',
  );
  process.exit(1);
}
