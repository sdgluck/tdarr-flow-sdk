// Commands are returned from functions so lint-staged does not append staged
// filenames to them: these are whole-project gates, not per-file fixers.
export default {
  '*.ts': () => ['pnpm typecheck', 'pnpm lint', 'pnpm test'],
};
